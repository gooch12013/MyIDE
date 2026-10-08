// ACP employees (Codex here, Gemini in gemini.ts) share runAcpTurn. Codex: one turn = one run of the Codex ACP adapter (@agentclientprotocol/codex-acp) driving
// the user's own `codex` (CODEX_PATH), in an Electron utility process. The ACP session id is the codex
// thread id, so the next turn loads it, and `codex resume <id>` opens the same session in a terminal.
// ponytail: a fresh adapter process per turn (start-up plus a session/load replay each time). Keep one
// alive per employee if that latency shows.
import { utilityProcess, type UtilityProcess } from 'electron';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readImage } from '../attach';
import type { ClaudeEvent } from '../claude/parse';
import type { Turn, TurnOpts } from '../claude/transport';
import { cliVersion, findOnPath, spawnEnv } from '../pty';
import { MCP_TOOL_TIMEOUT_MS, ownTool } from '../mcp';
import { hardDenied, makeAcpMapper, parseCodexStatus, permissionCommand, pickOption, rpcClient } from './client';

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
export const findCodex = (path = ''): string | null => findOnPath('codex', path)[0] ?? null;

let info: Promise<{ path: string | null; version: string | null; tested: boolean; testedVersion: string }> | undefined;
export function codexInfo(): NonNullable<typeof info> {
  return (info ??= (async () => {
    const env = await spawnEnv();
    const path = findCodex(env.PATH);
    const version = await cliVersion(path, env);
    return { path, version, tested: version === TESTED, testedVersion: TESTED };
  })());
}

/** The http entries of a --mcp-config file, as Codex config: given to the adapter as CODEX_CONFIG rather than as
 *  ACP mcpServers, because ACP has no field for tool_timeout_sec and Codex otherwise drops an MCP call (an
 *  approval or ask_human waiting on David) after 60 s. The user's own ~/.codex/config.toml is never edited. */
function mcpServers(file: string): Record<string, { url: string; tool_timeout_sec: number }> {
  const servers = JSON.parse(readFileSync(file, 'utf8')).mcpServers ?? {};
  return Object.fromEntries(Object.entries(servers).map(([name, s]: [string, any]) => [name, { url: String(s.url), tool_timeout_sec: MCP_TOOL_TIMEOUT_MS / 1000 }]));
}

/** A running ACP agent process: `send` writes one JSON-RPC line to its stdin. */
export type AcpProc = { send(line: string): void; kill(): void };
/** What differs between ACP agents; the session runner below is shared. */
export interface AcpLaunch {
  name: string; // in messages: "Codex", "Gemini"
  /** Starts the agent in o.cwd. Feed each stdout chunk to `data`, and call `exit` once when it ends. Throws if it cannot start. */
  spawn(o: AcpTurnOpts, io: { data(chunk: string): void; stderr(chunk: string): void; exit(code: number | null): void }): Promise<{ proc: AcpProc; servers: string[] }>;
  /** After session/new or session/load, before the prompt (model, effort). */
  configure?(call: (method: string, params: unknown) => Promise<any>, sessionId: string, o: AcpTurnOpts): Promise<void>;
  /** After the prompt: `ask` sends a prompt and returns the agent's reply text (Codex's /status). */
  after?(ask: (text: string) => Promise<string>, emit: (e: ClaudeEvent) => void): Promise<void>;
}
export type AcpTurnOpts = TurnOpts & { env: Record<string, string>; employeeId?: string; accountId?: string };

const codexLaunch: AcpLaunch = {
  name: 'Codex',
  async spawn(o, io) {
    const env = { ...(await spawnEnv()), ...o.env };
    const codex = findCodex(env.PATH);
    if (!codex) throw new Error('Codex is not installed (no codex on your PATH).');
    const servers = mcpServers(o.mcpConfigPath);
    // workspace-write: on-request approvals reviewed by the user (David, via NEEDS YOU), not Codex's own auto review.
    // Live web search, and network inside the sandbox so curl and package installs fetch without asking (David's call).
    const config = { mcp_servers: servers, web_search: 'live', sandbox_workspace_write: { network_access: true } };
    const adapterEnv = { ...env, CODEX_PATH: codex, INITIAL_AGENT_MODE: 'workspace-write', CODEX_CONFIG: JSON.stringify(config) };
    const child: UtilityProcess = utilityProcess.fork(HOST, [ADAPTER], { env: adapterEnv, cwd: o.cwd, stdio: ['ignore', 'ignore', 'pipe'], serviceName: 'Codex ACP' });
    child.stderr?.on('data', (d) => io.stderr(String(d)));
    child.once('exit', (code) => io.exit(code));
    child.on('message', (chunk: unknown) => io.data(String(chunk)));
    return { proc: { send: (line) => child.postMessage(line), kill: () => child.kill() }, servers: Object.keys(servers) };
  },
  async configure(call, sessionId, o) {
    if (o.model) await call('session/set_config_option', { sessionId, configId: 'model', value: o.model }); // '' keeps Codex's own default
    if (o.effort) await call('session/set_config_option', { sessionId, configId: 'reasoning_effort', value: o.effort });
  },
  // Rate limits only arrive as /status text; it makes no model call.
  async after(ask, emit) {
    const u = parseCodexStatus(await Promise.race([ask('/status'), new Promise<string>((ok) => setTimeout(() => ok(''), 15_000))]));
    if (u) emit({ type: 'rate', ...u });
  },
};

export const runCodexTurn = (o: AcpTurnOpts): Turn => runAcpTurn(o, codexLaunch);

/** One turn of any ACP agent: initialize, session/new or session/load, the prompt, then the launch's `after`. */
export function runAcpTurn(o: AcpTurnOpts, launch: AcpLaunch): Turn {
  const emit = (e: ClaudeEvent) => { try { o.onEvent?.(e); } catch (err) { console.error(err); } };
  const mapper = makeAcpMapper();
  let child: AcpProc | undefined;
  let rpc: ReturnType<typeof rpcClient> | undefined;
  let sessionId = o.sessionId ?? '';
  let phase: 'start' | 'prompt' | 'status' | 'done' = 'start';
  let cancelled = false;
  let statusText = '';
  let refused = ''; // a command MyIDE turned down; Codex offers no "decline" for an escalation, so refusing ends the turn
  const asking = new Set<() => void>();
  const mcpCalls = new Map<string, { server?: string; tool?: string }>(); // tool call id -> MCP server and tool, for its approval // permission prompts waiting on David; answered "cancelled" on interrupt

  let lastUpdate = 0; // when the last session/update arrived (Gemini replays a loaded session after answering session/load)
  const onNotify = (method: string, p: any) => {
    if (method !== 'session/update' || p?.sessionId !== sessionId) return;
    lastUpdate = Date.now();
    const u = p.update;
    if (u?.sessionUpdate === 'tool_call' && u.rawInput?.server) mcpCalls.set(u.toolCallId, { server: String(u.rawInput.server), tool: String(u.rawInput.tool ?? '') });
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
    const pickOf = (want: 'allow' | 'reject') => pickOption(options, want);
    const command = permissionCommand(tc);
    // Never asked: the forge goes through MyIDE's forge tool, commits through the attribution hook.
    if (command && hardDenied(command)) {
      console.warn(`${launch.name} employee ${o.employeeId}: refused ${command.slice(0, 200)}`);
      refused = command.slice(0, 200);
      const no = pickOf('reject');
      return no ? { outcome: { outcome: 'selected', optionId: no.optionId } } : cancel;
    }
    // In workspace-write Codex asks before every MCP tool call; MyIDE's own tools (exact names) never need David.
    const mcp = p?._meta?.is_mcp_tool_approval ? mcpCalls.get(tc.toolCallId) : undefined;
    if (mcp?.server === 'myide' && ownTool(mcp.tool ?? '')) {
      const yes = options.find((x) => x.optionId === 'allow_once') ?? pickOf('allow');
      return yes ? { outcome: { outcome: 'selected', optionId: yes.optionId } } : cancel;
    }
    const ask = { employeeId: o.employeeId ?? '', kind: plan ? 'plan' as const : 'permission' as const, title: String(tc.title ?? (mcp ? `mcp.${mcp.server}.${mcp.tool}` : 'Permission')),
      text: plan ? String(tc.rawInput?.plan ?? tc.title ?? '') : String(tc.rawInput?.command ?? tc.title ?? ''), input: tc.rawInput ?? {} };
    const abort = new AbortController();
    const answer = await new Promise<{ allow: boolean } | null>((resolve) => {
      const stop = () => { abort.abort(); resolve(null); };
      asking.add(stop);
      approver!({ ...ask, signal: abort.signal }).then(resolve, () => resolve({ allow: false })).finally(() => asking.delete(stop));
    });
    if (!answer || cancelled) return cancel;
    const pick = pickOf(answer.allow ? 'allow' : 'reject');
    return pick ? { outcome: { outcome: 'selected', optionId: pick.optionId } } : cancel;
  };

  const done = (async (): Promise<Result> => {
    let stderr = '';
    try {
      if (cancelled) throw new Error('Interrupted before start');
      let buf = '';
      let onExit: (code: number | null) => void = () => {};
      const exited = new Promise<never>((_, reject) => { onExit = (code) => {
        rpc?.close('exited');
        reject(new Error(cancelled ? 'Interrupted' : stderr.trim().split('\n').slice(-5).join('\n') || `The ${launch.name} agent exited (${code}).`));
      }; });
      exited.catch(() => {});
      const started = await launch.spawn(o, {
        data: (chunk) => {
          buf += chunk;
          for (let i; (i = buf.indexOf('\n')) >= 0;) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) rpc?.push(line); }
        },
        stderr: (d) => { stderr = (stderr + d).slice(-4000); },
        exit: (code) => onExit(code),
      });
      child = started.proc;
      if (cancelled) throw new Error('Interrupted before start');
      rpc = rpcClient((line) => child!.send(line), { onNotify, onRequest });
      const call = (method: string, params: unknown) => Promise.race([rpc!.call(method, params), exited]);

      await call('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'MyIDE', version: '0' } });
      if (o.sessionId) {
        await call('session/load', { sessionId, cwd: o.cwd, mcpServers: [] });
        // ponytail: replayed history is told apart from the new turn by timing (quiet for 300 ms). Gemini streams the replay
        // after answering session/load; Codex before. Ceiling: a replay that stalls longer leaks old lines into the turn.
        lastUpdate = Date.now();
        while (Date.now() - lastUpdate < 300) await new Promise((ok) => setTimeout(ok, 100));
      } else sessionId = (await call('session/new', { cwd: o.cwd, mcpServers: [] })).sessionId;
      await launch.configure?.(call, sessionId, o);
      emit({ type: 'init', sessionId, model: o.model, tools: [], mcpServers: started.servers.map((name) => ({ name, status: 'connected' })) });
      if (cancelled) throw new Error('Interrupted');

      // The role prompt goes in as the start of the first turn; resumed sessions already have it.
      const text = !o.sessionId && o.appendSystemPrompt ? `${o.appendSystemPrompt}\n\n---\n\n${o.prompt}` : o.prompt;
      phase = 'prompt';
      const images = (o.images ?? []).map((f) => { const i = readImage(f); return { type: 'image', mimeType: i.mediaType, data: i.data }; });
      const r = await call('session/prompt', { sessionId, prompt: [...images, { type: 'text', text }] });
      mapper.flush().forEach(emit);
      const stop = String(r?.stopReason ?? '');

      if (!cancelled && launch.after) {
        phase = 'status';
        const ask = async (q: string) => { statusText = ''; await call('session/prompt', { sessionId, prompt: [{ type: 'text', text: q }] }); return statusText; };
        try { await launch.after(ask, emit); } catch { /* e.g. the gauge just stays where it was */ }
      }
      const ok = stop === 'end_turn';
      if (stop === 'cancelled' && refused && !cancelled) {
        return { type: 'result', ok: false, interrupted: false, sessionId, text: `MyIDE refused \`${refused}\` (forge writes go through the forge tool, commits through the hook), and ${launch.name} ends its turn on a refusal. Send it a message to continue.` };
      }
      return { type: 'result', ok, interrupted: stop === 'cancelled', sessionId, text: mapper.lastText() || (ok ? '' : `${launch.name} stopped: ${stop || 'no reason given'}`) };
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
