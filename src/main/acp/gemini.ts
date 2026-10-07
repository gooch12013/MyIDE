// Gemini employees: one turn = one run of the user's own `gemini --acp` (Gemini CLI's built-in ACP mode).
// API-key accounts only (features.md #24): the key lives in the Keychain (service myide-ai, account = the account id)
// and reaches the CLI only as GEMINI_API_KEY in its env. GEMINI_CLI_HOME gives each account its own ~/.gemini
// (settings, sessions), so the user's own Google login there is never used.
// Written from Gemini CLI's docs and source (v0.63.0) without a local install: see providers.json for what is unchecked.
import { execFile, spawn } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import type { Turn } from '../claude/transport';
import { getToken } from '../keychain';
import { MCP_TOOL_TIMEOUT_MS } from '../mcp';
import { spawnEnv } from '../pty';
import { writePrivate } from '../store';
import { runAcpTurn, type AcpLaunch, type AcpTurnOpts } from './codex';

export const KEY_SERVICE = 'myide-ai';
export const NOT_INSTALLED = 'Install Gemini CLI to use this (no gemini on your login PATH).';

export function findGemini(path = ''): string | null {
  for (const dir of path.split(delimiter)) {
    try { accessSync(join(dir, 'gemini'), constants.X_OK); return join(dir, 'gemini'); } catch { /* next */ }
  }
  return null;
}

let info: Promise<{ path: string | null; version: string | null }> | undefined;
/** Where the user's gemini is and its version; checked once per launch. */
export function geminiInfo(): NonNullable<typeof info> {
  return (info ??= (async () => {
    const env = await spawnEnv();
    const path = findGemini(env.PATH);
    let version: string | null = null;
    try { if (path) version = /\d+\.\d+\.\d+/.exec((await promisify(execFile)(path, ['--version'], { env, timeout: 15_000 })).stdout)?.[0] ?? null; } catch { /* broken install */ }
    return { path, version };
  })());
}

/** The account's own ~/.gemini: API-key auth, so neither the ACP session nor Talk ever offers a Google login; folder
 *  trust off, since the worktrees are MyIDE's own and an untrusted folder forces the default approval mode;
 *  CLAUDE.md and AGENTS.md read as context files beside GEMINI.md. Written once; David may edit it afterwards. */
export function geminiHome(dir: string): void {
  const file = join(dir, '.gemini', 'settings.json');
  if (existsSync(file)) return;
  writePrivate(file, JSON.stringify({
    security: { auth: { selectedType: 'gemini-api-key' }, folderTrust: { enabled: false } },
    context: { fileName: ['GEMINI.md', 'CLAUDE.md', 'AGENTS.md'] },
  }, null, 2));
}

/** MyIDE's MCP server as Gemini settings, written per turn and passed as GEMINI_CLI_SYSTEM_SETTINGS_PATH (ACP mcpServers
 *  has no timeout or trust field): trusted, so MyIDE's own tools never ask; a 15 min timeout, so a NEEDS YOU card can
 *  wait on David; `approve` hidden, it is Claude's permission hook. Same file as the --mcp-config, plus ".gemini.json". */
function systemSettings(mcpConfigPath: string): { file: string; servers: string[] } {
  const servers = JSON.parse(readFileSync(mcpConfigPath, 'utf8')).mcpServers ?? {};
  const mcpServers = Object.fromEntries(Object.entries(servers).map(([name, s]: [string, any]) =>
    [name, { httpUrl: String(s.url), timeout: MCP_TOOL_TIMEOUT_MS, trust: true, excludeTools: ['approve'] }]));
  const file = `${mcpConfigPath}.gemini.json`;
  writePrivate(file, JSON.stringify({ mcpServers }));
  return { file, servers: Object.keys(mcpServers) };
}

const geminiLaunch: AcpLaunch = {
  name: 'Gemini',
  async spawn(o, io) {
    const base = await spawnEnv();
    const gemini = findGemini(base.PATH);
    if (!gemini) throw new Error(NOT_INSTALLED);
    const key = o.accountId ? await getToken(KEY_SERVICE, o.accountId) : null;
    if (!key) throw new Error('This Gemini account has no API key: add one in Preferences > AI accounts.');
    if (o.env.GEMINI_CLI_HOME) geminiHome(o.env.GEMINI_CLI_HOME);
    const { file, servers } = systemSettings(o.mcpConfigPath);
    const env = { ...base, ...o.env, GEMINI_API_KEY: key, GEMINI_CLI_SYSTEM_SETTINGS_PATH: file };
    // auto_edit: file edits run without asking; shell commands and other tools come to NEEDS YOU (hard denies refused
    // first). The model goes on the command line: a fresh process each turn, so a change applies from the next turn.
    const args = ['--acp', '--approval-mode', 'auto_edit', ...(o.model ? ['--model', o.model] : [])];
    const child = spawn(gemini, args, { cwd: o.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8').on('data', io.data);
    child.stderr.setEncoding('utf8').on('data', io.stderr);
    child.stdin.on('error', () => { /* it exited; the exit handler reports it */ });
    child.once('error', (e) => { io.stderr(e.message); io.exit(null); });
    child.once('exit', (code) => io.exit(code));
    return { proc: { send: (line) => { child.stdin.write(line); }, kill: () => { child.kill(); } }, servers };
  },
};

export const runGeminiTurn = (o: AcpTurnOpts): Turn => runAcpTurn(o, geminiLaunch);
