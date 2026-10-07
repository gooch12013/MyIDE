// One entry point for a turn on any AI: Claude through `claude -p`, Codex and Gemini through ACP. Both take the
// same TurnOpts and report the same ClaudeEvents; the account decides the env (which login is used).
import { ipcMain } from 'electron';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { account, DEFAULT_ACCOUNT, registerAccountsIpc, reportUsage, type Account } from './accounts';
import { codexInfo, onAcpPermission, runCodexTurn, type AcpPermission } from './acp/codex';
import { geminiInfo, KEY_SERVICE, runGeminiTurn } from './acp/gemini';
import { getToken } from './keychain';
import { runTurn, type Turn, type TurnOpts } from './claude/transport';
import { addApproval, employeeMcpConfig, resolveApproval } from './mcp';
import { spawnEnv } from './pty';
import { writePrivate } from './store';

export { onAcpPermission, type AcpPermission };
type Emp = { id?: string; provider?: string; accountId?: string };

/** Capability table shipped with the app (build/providers.json). */
export type Providers = Record<string, { label: string; models: string[][]; efforts: string[][]; testModel: string } & Record<string, unknown>>;
let providerTable: Providers | undefined;
export const providers = (): Providers => (providerTable ??= JSON.parse(readFileSync(join(__dirname, 'providers.json'), 'utf8')));
/** `v` if it is one of the provider's listed values, else undefined. */
const known = (list: string[][], v?: string) => (list.some(([m]) => m === v) ? v : undefined);

function accountFor(emp: Emp): Account {
  const a = account(emp.accountId || DEFAULT_ACCOUNT);
  if (!a) throw new Error(`The AI account "${emp.accountId}" no longer exists. Fire and rehire on another account.`);
  if (emp.provider && emp.provider !== a.provider) throw new Error(`Account ${a.name} is ${a.provider}, not ${emp.provider}.`);
  return a;
}

/** Runs one turn for an employee on its own account. Never moves it to another account. */
export function runTurnFor(emp: Emp, o: TurnOpts): Turn {
  const a = accountFor(emp);
  const onEvent: TurnOpts['onEvent'] = (e) => {
    if (e.type === 'rate') reportUsage(a.id, e);
    o.onEvent?.(e);
  };
  if (a.provider === 'claude') return runTurn({ ...o, onEvent, env: a.env });
  if (a.provider === 'codex') {
    // A Claude model name (a role default, a lead's pick) means nothing to Codex: use Codex's own default instead of failing.
    const p = providers().codex;
    return runCodexTurn({ ...o, model: known(p.models, o.model) ?? '', effort: known(p.efforts, o.effort), onEvent, env: a.env, employeeId: emp.id });
  }
  if (a.provider === 'gemini') {
    // Same rule as Codex: a model name Gemini does not list ('auto', 'pro', ...) leaves its own default.
    return runGeminiTurn({ ...o, model: known(providers().gemini.models, o.model) ?? '', effort: undefined, onEvent, env: a.env, employeeId: emp.id, accountId: a.id });
  }
  throw new Error(`${providers()[a.provider]?.label ?? a.provider} employees are not supported yet.`);
}

// ACP permission and plan prompts become NEEDS YOU cards, like Claude's approve tool calls.
onAcpPermission((p) => new Promise((resolve) => {
  const card = addApproval({ employeeId: p.employeeId, tool: p.kind === 'plan' ? 'ExitPlanMode' : p.title, input: p.input, kind: p.kind, text: p.text },
    (allow, message) => resolve({ allow, message }));
  p.signal.addEventListener('abort', () => resolveApproval(card.id, false, 'The turn was interrupted'));
}));

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
// `env -u` as well: a shell rc that exports one of these must not switch accounts.
const envPrefix = (name: string, value?: string) => (value ? `env ${name}=${shq(value)}` : `env -u ${name}`);

/** The command a Talk terminal runs to open the employee's session in its CLI, on its account. */
export function talkCommandFor(emp: Emp, base: { sessionId: string; model: string; effort?: string; settingsPath: string; promptFile: string }): string {
  const a = accountFor(emp);
  if (a.provider === 'codex') {
    // Only listed values reach the command line: a Claude model name means nothing to Codex, and the effort goes into a TOML string.
    const p = providers().codex;
    const model = known(p.models, base.model), effort = known(p.efforts, base.effort);
    return ['exec', envPrefix('CODEX_HOME', a.env.CODEX_HOME), 'codex resume', shq(base.sessionId), ...(model ? ['-m', shq(model)] : []),
      ...(effort ? ['-c', shq(`model_reasoning_effort="${effort}"`)] : [])].join(' ');
  }
  if (a.provider === 'gemini') {
    // The key comes from the Keychain inside the terminal's own shell, so it is never on a command line or in a file.
    const kc = process.env.MYIDE_KEYCHAIN ? ` ${shq(process.env.MYIDE_KEYCHAIN)}` : '';
    const model = known(providers().gemini.models, base.model);
    return [`GEMINI_CLI_HOME=${shq(a.env.GEMINI_CLI_HOME ?? '')}`, `GEMINI_API_KEY="$(/usr/bin/security find-generic-password -s ${KEY_SERVICE} -a ${shq(a.id)} -w${kc})"`,
      'exec gemini --resume', shq(base.sessionId), ...(model ? ['--model', shq(model)] : [])].join(' ');
  }
  if (a.provider !== 'claude') throw new Error(`Talk is not available for ${a.provider} yet.`);
  return ['exec', envPrefix('CLAUDE_CONFIG_DIR', a.env.CLAUDE_CONFIG_DIR), 'claude --resume', shq(base.sessionId), '--settings', shq(base.settingsPath),
    '--model', shq(base.model), ...(base.effort ? ['--effort', shq(base.effort)] : []),
    '--append-system-prompt-file', shq(base.promptFile), '--disallowedTools Task ScheduleWakeup CronCreate RemoteTrigger'].join(' ');
}

/** The CLI's own login, in a terminal, with the account's env. */
function loginCommand(a: Account): string {
  if (a.provider === 'codex') return `${envPrefix('CODEX_HOME', a.env.CODEX_HOME)} codex login`;
  if (a.provider === 'gemini') throw new Error('Gemini accounts use an API key: paste it into the key field instead.');
  return `${envPrefix('CLAUDE_CONFIG_DIR', a.env.CLAUDE_CONFIG_DIR)} claude auth login`;
}

/** What the CLI itself says about its login; MyIDE reads no credential. */
async function loginStatus(a: Account): Promise<{ loggedIn: boolean; detail: string }> {
  if (a.provider === 'gemini') { // API key only: "signed in" means a key is in the Keychain
    const has = !!(await getToken(KEY_SERVICE, a.id));
    return { loggedIn: has, detail: has ? 'API key in the Keychain' : 'No API key yet' };
  }
  const env = { ...(await spawnEnv()), ...a.env };
  const run = promisify(execFile);
  try {
    if (a.provider === 'codex') {
      const r = await run('codex', ['login', 'status'], { env, timeout: 15_000 });
      return { loggedIn: true, detail: (r.stdout + r.stderr).trim().split('\n').at(-1) ?? '' };
    }
    const s = JSON.parse((await run('claude', ['auth', 'status'], { env, timeout: 15_000 })).stdout);
    return { loggedIn: !!s.loggedIn, detail: s.loggedIn ? `Signed in (${s.authMethod})` : 'Not signed in' };
  } catch (e) {
    const out = `${(e as { stdout?: string }).stdout ?? ''}`;
    try { const s = JSON.parse(out); return { loggedIn: !!s.loggedIn, detail: 'Not signed in' }; } catch { /* not JSON */ }
    return { loggedIn: false, detail: out.trim().split('\n').at(-1) || 'Not signed in' };
  }
}

/** One tiny turn on the account, in a throwaway git folder. */
async function testAccount(id: string): Promise<{ ok: boolean; detail: string }> {
  const a = account(id);
  if (!a) return { ok: false, detail: 'No such account' };
  const dir = mkdtempSync(join(tmpdir(), 'myide-test-'));
  try {
    await promisify(execFile)('git', ['init', '-q'], { cwd: dir }); // Codex wants a repository
    const settingsPath = join(dir, '.settings.json');
    const mcpConfigPath = join(dir, '.mcp-config.json');
    writePrivate(settingsPath, '{}');
    writePrivate(mcpConfigPath, JSON.stringify(employeeMcpConfig('account-test')));
    const p = providers()[a.provider];
    const turn = runTurnFor({ accountId: a.id }, { cwd: dir, prompt: 'Reply with exactly: ok', model: p.testModel, effort: a.provider === 'codex' ? 'low' : undefined, settingsPath, mcpConfigPath });
    const timer = setTimeout(() => turn.interrupt(), 120_000);
    const r = await turn.done.finally(() => clearTimeout(timer));
    return { ok: r.ok, detail: r.ok ? `Replied: ${r.text.trim().slice(0, 200)}` : r.text || 'No reply' };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function registerAiIpc(): void {
  registerAccountsIpc();
  ipcMain.handle('providers:get', () => providers());
  ipcMain.handle('accounts:login', (_e, id: string) => {
    const a = account(id);
    if (!a) throw new Error('No such account');
    return { command: loginCommand(a) };
  });
  ipcMain.handle('accounts:status', (_e, id: string) => { const a = account(id); return a ? loginStatus(a) : { loggedIn: false, detail: 'No such account' }; });
  ipcMain.handle('accounts:test', (_e, id: string) => testAccount(id));
  ipcMain.handle('codex:info', () => codexInfo());
  ipcMain.handle('gemini:info', () => geminiInfo());
}
