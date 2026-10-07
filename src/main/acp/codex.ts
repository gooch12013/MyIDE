// Codex employees: one turn = one run of the Codex ACP adapter (@agentclientprotocol/codex-acp) driving
// the user's own `codex` (CODEX_PATH), in an Electron utility process. The ACP session id is the codex
// thread id, so the next turn loads it, and `codex resume <id>` opens the same session in a terminal.
// ponytail: a fresh adapter process per turn (start-up plus a session/load replay each time). Keep one
// alive per employee if that latency shows.
import { utilityProcess, type UtilityProcess } from 'electron';
import { execFile } from 'node:child_process';
import { accessSync, constants, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import type { ClaudeEvent } from '../claude/parse';
import type { Turn, TurnOpts } from '../claude/transport';
import { spawnEnv } from '../pty';
import { makeAcpMapper, parseCodexStatus, rpcClient } from './client';

type Result = Extract<ClaudeEvent, { type: 'result' }>;
const ADAPTER = join(__dirname, '..', 'node_modules', '@agentclientprotocol', 'codex-acp', 'dist', 'index.js');
const HOST = join(__dirname, 'acp-host.js');
const TESTED = '0.157.1';

/** A permission or plan prompt from an ACP agent, for the approve flow (NEEDS YOU). */
export type AcpPermission = { employeeId: string; kind: 'plan' | 'permission'; title: string; text: string; input: unknown; signal: AbortSignal };
let approver: ((p: AcpPermission) => Promise<{ allow: boolean; message?: string }>) | undefined;
/** Routes ACP permission prompts (transports.ts sends them to NEEDS YOU); without a handler every prompt is declined.
 *  `signal` aborts when the turn is interrupted, so the handler can drop its card. */
export function onAcpPermission(fn: (p: AcpPermission) => Promise<{ allow: boolean; message?: string }>): void { approver = fn; }

/** The user's own codex on the login PATH; never the copy the adapter package carries. */
export function findCodex(path = ''): string | null {
  for (const dir of path.split(delimiter)) {
    try { accessSync(join(dir, 'codex'), constants.X_OK); return join(dir, 'codex'); } catch { /* next */ }
  }
  return null;
}

let info: Promise<{ path: string | null; version: string | null; tested: boolean; testedVersion: string }> | undefined;
export function codexInfo(): NonNullable<typeof info> {
  return (info ??= (async () => {
    const env = await spawnEnv();
    const path = findCodex(env.PATH);
    let version: string | null = null;
    try { if (path) version = /\d+\.\d+\.\d+/.exec((await promisify(execFile)(path, ['--version'], { env, timeout: 15_000 })).stdout)?.[0] ?? null; } catch { /* broken install */ }
    return { path, version, tested: version === TESTED, testedVersion: TESTED };
  })());
}

/** The http entries of a --mcp-config file, in ACP's shape. */
function mcpServers(file: string): { type: 'http'; name: string; url: string; headers: [] }[] {
  const servers = JSON.parse(readFileSync(file, 'utf8')).mcpServers ?? {};
  return Object.entries(servers).map(([name, s]: [string, any]) => ({ type: 'http' as const, name, url: String(s.url), headers: [] as [] }));
}

export function runCodexTurn(o: TurnOpts & { env: Record<string, string>; employeeId?: string }): Turn {
  const emit = (e: ClaudeEvent) => { try { o.onEvent?.(e); } catch (err) { console.error(err); } };
  const mapper = makeAcpMapper();
  let child: UtilityProcess | undefined;
  let rpc: ReturnType<typeof rpcClient> | undefined;
  let sessionId = o.sessionId ?? '';
  let phase: 'start' | 'prompt' | 'status' | 'done' = 'start';
  let cancelled = false;
  let statusText = '';
  const asking = new Set<() => void>(); // permission prompts waiting on David; answered "cancelled" on interrupt

  const onNotify = (method: string, p: any) => {
    if (method !== 'session/update' || p?.sessionId !== sessionId) return;
    if (phase === 'prompt') mapper.push(p.update).forEach(emit); // session/load replays history before this: ignored
    else if (phase === 'status' && p.update?.sessionUpdate === 'agent_message_chunk') statusText += p.update.content?.text ?? '';
  };

  const onRequest = async (method: string, p: any): Promise<unknown> => {
    if (method !== 'session/request_permission') throw new Error(`${method} is not supported`);
    const tc = p?.toolCall ?? {};
    const options: { optionId: string; kind: string }[] = p?.options ?? [];
    const cancel = { outcome: { outcome: 'cancelled' } };
    if (!approver || phase !== 'prompt' || cancelled) return cancel;
    const plan = tc.kind === 'switch_mode';
    const ask = { employeeId: o.employeeId ?? '', kind: plan ? 'plan' as const : 'permission' as const, title: String(tc.title ?? 'Permission'),
      text: plan ? String(tc.rawInput?.plan ?? tc.title ?? '') : String(tc.rawInput?.command ?? tc.title ?? ''), input: tc.rawInput ?? {} };
    const abort = new AbortController();
    const answer = await new Promise<{ allow: boolean } | null>((resolve) => {
      const stop = () => { abort.abort(); resolve(null); };
      asking.add(stop);
      approver!({ ...ask, signal: abort.signal }).then(resolve, () => resolve({ allow: false })).finally(() => asking.delete(stop));
    });
    if (!answer || cancelled) return cancel;
    const want = answer.allow ? 'allow' : 'reject';
    const pick = options.find((x) => x.kind === `${want}_once`) ?? options.find((x) => x.kind.startsWith(want));
    return pick ? { outcome: { outcome: 'selected', optionId: pick.optionId } } : cancel;
  };

  const done = (async (): Promise<Result> => {
    let stderr = '';
    try {
      const env = { ...(await spawnEnv()), ...o.env };
      const codex = findCodex(env.PATH);
      if (!codex) throw new Error('Codex is not installed (no codex on your PATH).');
      if (cancelled) throw new Error('Interrupted before start');
      child = utilityProcess.fork(HOST, [ADAPTER], { env: { ...env, CODEX_PATH: codex }, cwd: o.cwd, stdio: ['ignore', 'ignore', 'pipe'], serviceName: 'Codex ACP' });
      child.stderr?.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
      const exited = new Promise<never>((_, reject) => child!.once('exit', (code) => {
        rpc?.close('exited');
        reject(new Error(cancelled ? 'Interrupted' : stderr.trim().split('\n').slice(-5).join('\n') || `The Codex adapter exited (${code}).`));
      }));
      exited.catch(() => {});
      rpc = rpcClient((line) => child!.postMessage(line), { onNotify, onRequest });
      let buf = '';
      child.on('message', (chunk: unknown) => {
        buf += String(chunk);
        for (let i; (i = buf.indexOf('\n')) >= 0;) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) rpc!.push(line); }
      });
      const call = (method: string, params: unknown) => Promise.race([rpc!.call(method, params), exited]);

      await call('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'MyIDE', version: '0' } });
      const servers = mcpServers(o.mcpConfigPath);
      if (o.sessionId) await call('session/load', { sessionId, cwd: o.cwd, mcpServers: servers });
      else sessionId = (await call('session/new', { cwd: o.cwd, mcpServers: servers })).sessionId;
      if (o.model) await call('session/set_config_option', { sessionId, configId: 'model', value: o.model }); // '' keeps Codex's own default
      if (o.effort) await call('session/set_config_option', { sessionId, configId: 'reasoning_effort', value: o.effort });
      emit({ type: 'init', sessionId, model: o.model, tools: [], mcpServers: servers.map((s) => ({ name: s.name, status: 'connected' })) });
      if (cancelled) throw new Error('Interrupted');

      // The role prompt goes in as the start of the first turn; resumed sessions already have it.
      const text = !o.sessionId && o.appendSystemPrompt ? `${o.appendSystemPrompt}\n\n---\n\n${o.prompt}` : o.prompt;
      phase = 'prompt';
      const r = await call('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
      mapper.flush().forEach(emit);
      const stop = String(r?.stopReason ?? '');

      // Rate limits only arrive as /status text; it makes no model call.
      if (!cancelled) {
        phase = 'status';
        try {
          await Promise.race([call('session/prompt', { sessionId, prompt: [{ type: 'text', text: '/status' }] }), new Promise((ok) => setTimeout(ok, 15_000))]);
          const u = parseCodexStatus(statusText);
          if (u) emit({ type: 'rate', ...u });
        } catch { /* the gauge just stays where it was */ }
      }
      const ok = stop === 'end_turn';
      return { type: 'result', ok, interrupted: stop === 'cancelled', sessionId, text: mapper.lastText() || (ok ? '' : `Codex stopped: ${stop || 'no reason given'}`) };
    } catch (err) {
      return { type: 'result', ok: false, interrupted: cancelled, sessionId, text: (err as Error).message };
    } finally {
      phase = 'done';
      child?.kill();
    }
  })();
  void done.then(emit);

  return {
    done,
    interrupt: () => {
      if (cancelled) return;
      cancelled = true;
      asking.forEach((stop) => stop());
      if (phase === 'prompt' && rpc) {
        rpc.notify('session/cancel', { sessionId });
        setTimeout(() => child?.kill(), 10_000); // the adapter normally ends the prompt as "cancelled" at once
      } else child?.kill();
    },
  };
}
