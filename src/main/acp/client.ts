// The protocol half of the ACP transport: newline-delimited JSON-RPC, and ACP session updates mapped
// onto the ClaudeEvent shapes employees already understand. No Electron or Node imports, so
// scripts/check-acp-map.mjs runs it against the spike K recordings.
import type { ClaudeEvent, TaskState } from '../claude/parse';

type Msg = { jsonrpc?: string; id?: number | string; method?: string; params?: any; result?: any; error?: { code: number; message: string } };

/** JSON-RPC over a line channel. `send` writes one line; feed every received line to `push`.
 *  Requests from the agent (permission prompts) go to `onRequest`, whose return value is the result. */
export function rpcClient(send: (line: string) => void, o: { onNotify(method: string, params: any): void; onRequest(method: string, params: any): Promise<unknown> }) {
  let seq = 0;
  const waiting = new Map<number, { resolve(v: any): void; reject(e: Error): void }>();
  const write = (m: Msg) => send(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  return {
    call(method: string, params: unknown): Promise<any> {
      const id = ++seq;
      return new Promise((resolve, reject) => { waiting.set(id, { resolve, reject }); write({ id, method, params }); });
    },
    notify(method: string, params: unknown): void { write({ method, params }); },
    push(line: string): void {
      let m: Msg;
      try { m = JSON.parse(line); } catch { return; }
      if (!m || typeof m !== 'object') return;
      if (m.method && m.id !== undefined) {
        const id = m.id;
        o.onRequest(m.method, m.params).then(
          (result) => write({ id, result }),
          (e: Error) => write({ id, error: { code: -32603, message: e.message } }));
      } else if (m.method) o.onNotify(m.method, m.params);
      else if (typeof m.id === 'number' && waiting.has(m.id)) {
        const w = waiting.get(m.id)!;
        waiting.delete(m.id);
        if (m.error) w.reject(new Error(m.error.message)); else w.resolve(m.result);
      }
    },
    /** Fails every call still waiting, e.g. when the agent process died. */
    close(why: string): void {
      for (const w of waiting.values()) w.reject(new Error(why));
      waiting.clear();
    },
  };
}

// A command word at the start of the line, after ; & | ( $( ` a quote (so `bash -c "gh ..."` is caught) or find's
// -exec/-execdir/-ok, behind optional env/command/exec/sudo/xargs wrappers, VAR=value prefixes and a path (/opt/homebrew/bin/gh).
const AT = String.raw`(?:^|[;&|(\x60'"\n]|\$\(|\s-(?:exec|execdir|ok|okdir)\s)\s*(?:(?:env|command|exec|sudo|nohup|time|xargs)\s+(?:-\S+\s+)*)*(?:\w+=\S*\s+)*(?:[^\s;&|'"]*\/)?`;
const HARD_DENY = [
  new RegExp(`${AT}(?:gh|tea|security)(?=$|[\\s;&|)'"\\x60])`), // forge CLIs and the keychain
  // skipping the attribution hook: --no-verify or any abbreviation git accepts (--no-v, --no-ver...), or -n in a short-flag group
  new RegExp(`${AT}git\\s[^;&|\\n]*\\bcommit\\b[^;&|\\n]*\\s(?:--no-v[a-z-]*|-[a-zA-Z]*n[a-zA-Z]*)(?=$|[\\s=;&|])`),
  /core\.hookspath/i, // git -c core.hooksPath=…, git config core.hooksPath
  /\.myide\/bin\/(?:issue|todo)\b/, /issue-endpoint\.json/,
  /api\.github\.com/,
];
/** Commands a Codex employee may never run, whatever David would answer: forge access goes through the forge tool,
 *  commits through the attribution hook. ponytail: regexes over the command text; a deliberately obfuscated command
 *  (eval, base64) gets past them, and since the sandbox has network (for web fetches) nothing else stops it. */
export const hardDenied = (command: string): boolean => HARD_DENY.some((r) => r.test(command));

/** The command line a permission prompt is about: Codex sends it as rawInput.command (string or argv); Gemini sends
 *  no rawInput, and a shell call's title is its command line. '' for anything that is not a command. */
export function permissionCommand(tc: any): string {
  const cmd = tc?.rawInput?.command;
  return Array.isArray(cmd) ? cmd.join(' ') : typeof cmd === 'string' ? cmd : tc?.kind === 'execute' ? String(tc.title ?? '') : '';
}

/** The option that means allow-once or deny. Codex offers two reject_once options: "decline" (carry on without it)
 *  and "cancel" (which ends the turn), and deny means decline. Gemini's only reject is "cancel" (the tool fails, the turn goes on). */
export function pickOption<T extends { optionId: string; kind: string }>(options: T[], want: 'allow' | 'reject'): T | undefined {
  return (want === 'reject' ? options.find((x) => x.optionId === 'decline') : undefined)
    ?? options.find((x) => x.kind === `${want}_once`) ?? options.find((x) => x.kind.startsWith(want));
}

/** Maps `session/update` payloads to ClaudeEvents. Message chunks are joined per message and emitted
 *  as one 'text' when the message ends (a tool call, another message, or flush() at turn end).
 *  Plan updates become 'tasks' (Codex 0.157.1 sends none; the code is ready for when it does). */
export function makeAcpMapper() {
  let msgId: string | undefined;
  let msg = '';
  let last = '';
  const flush = (): ClaudeEvent[] => {
    if (!msg.trim()) { msg = ''; return []; }
    last = msg;
    msg = '';
    return [{ type: 'text', text: last }];
  };
  function push(u: any): ClaudeEvent[] {
    if (!u || typeof u !== 'object') return [];
    if (u.sessionUpdate === 'agent_message_chunk') {
      const out = u.messageId !== msgId ? flush() : [];
      msgId = u.messageId;
      if (u.content?.type === 'text' && typeof u.content.text === 'string') msg += u.content.text;
      return out;
    }
    if (u.sessionUpdate === 'tool_call') {
      if (u.kind === 'think') return flush(); // Codex's own "Guardian Review" of a call, not a tool
      return [...flush(), { type: 'tool', name: String(u.title ?? u.kind ?? 'tool'), input: u.rawInput ?? {} }];
    }
    if (u.sessionUpdate === 'plan' && Array.isArray(u.entries)) {
      const ok = new Set(['pending', 'in_progress', 'completed']);
      const tasks: TaskState = u.entries.map((e: any, i: number) => ({
        id: String(i + 1), subject: String(e.content ?? ''), status: ok.has(e.status) ? e.status : 'pending',
      }));
      return [...flush(), { type: 'tasks', tasks }];
    }
    return [];
  }
  return { push, flush, lastText: () => last };
}

/** Codex's `/status` reply, e.g. "**codex 5h limit:** 100% left (resets 03:42 on Oct 7)", as used
 *  fractions like Claude's rate_limit_event. ponytail: parses display text; switch to app-server's
 *  structured account/rateLimits if a Codex update rewords it. */
export function parseCodexStatus(text: string, now = new Date()): { fiveHour?: number; sevenDay?: number; resetsAt?: string } | null {
  const grab = (label: string) => new RegExp(`${label} limit:\\**\\s*(\\d+(?:\\.\\d+)?)% left(?: \\(resets ([^)]+)\\))?`, 'i').exec(text);
  const five = grab('5h');
  const week = grab('weekly');
  if (!five && !week) return null;
  const used = (m: RegExpExecArray | null) => (m ? Math.round(100 - Number(m[1])) / 100 : undefined);
  return { fiveHour: used(five), sevenDay: used(week), resetsAt: five?.[2] ? resetDate(five[2], now) : undefined };
}

// "03:42 on Oct 7" or "03:42" (today, or tomorrow if already past), local time.
function resetDate(s: string, now: Date): string | undefined {
  const m = /^(\d{1,2}):(\d{2})(?: on (\w{3}) (\d{1,2}))?$/.exec(s.trim());
  if (!m) return undefined;
  const d = new Date(now);
  d.setSeconds(0, 0);
  d.setHours(Number(m[1]), Number(m[2]));
  if (m[3]) {
    const month = 'janfebmaraprmayjunjulaugsepoctnovdec'.indexOf(m[3].toLowerCase()) / 3;
    if (month < 0 || !Number.isInteger(month)) return undefined;
    d.setMonth(month, Number(m[4]));
    if (d.getTime() < now.getTime() - 86_400_000) d.setFullYear(d.getFullYear() + 1); // "Jan 2" seen on Dec 31
  } else if (d < now) d.setDate(d.getDate() + 1);
  return d.toISOString();
}
