// AI accounts: accounts[] in config.json. An account is a provider plus the env that points its CLI at
// one login (CLAUDE_CONFIG_DIR, CODEX_HOME). MyIDE never sees a credential: logins happen in the CLI's
// own flow and stay in the CLI's own store.
import { BrowserWindow, ipcMain } from 'electron';
import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { geminiHome, KEY_SERVICE } from './acp/gemini';
import { removeToken, setToken } from './keychain';
import type { Usage } from './org';
import { readConfig, writeConfig } from './projects';
import { slug, STATE_DIR, writePrivate } from './store';

export type Provider = 'claude' | 'codex' | 'gemini';
export type Account = { id: string; name: string; provider: Provider; env: Record<string, string>; cap: number; allowAuto: boolean };
export type { Usage };

export const DEFAULT_ACCOUNT = 'claude-default';
// The default Claude login is only found with CLAUDE_CONFIG_DIR unset; even pointing it at ~/.claude reads as logged out (spike L).
const DEFAULT: Account = { id: DEFAULT_ACCOUNT, name: 'Claude', provider: 'claude', env: {}, cap: 3, allowAuto: true };
const PROVIDERS: Provider[] = ['claude', 'codex', 'gemini'];

const stored = (): Account[] => ((readConfig() as { accounts?: Account[] }).accounts ?? [])
  .filter((a) => a && typeof a.id === 'string' && PROVIDERS.includes(a.provider));
const save = (accounts: Account[]) => writeConfig({ ...readConfig(), accounts } as ReturnType<typeof readConfig>);

/** Every account, the default Claude one first. */
export function listAccounts(): Account[] {
  const list = stored();
  const d = list.find((a) => a.id === DEFAULT_ACCOUNT);
  return [{ ...DEFAULT, ...d, provider: 'claude', env: {} }, ...list.filter((a) => a.id !== DEFAULT_ACCOUNT)];
}
export const account = (id: string): Account | undefined => listAccounts().find((a) => a.id === id);

/** Where an account's Claude sessions (transcripts) live. */
export const claudeConfigDir = (id: string): string => account(id)?.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');

// ---- usage gauges ----

const usage = new Map<string, Usage>();
const listeners: ((accountId: string, u: Usage) => void)[] = [];
export function onUsage(cb: (accountId: string, u: Usage) => void): void { listeners.push(cb); }
/** Latest numbers the CLI reported for an account: used fractions 0..1, like rate_limit_event. */
export function reportUsage(accountId: string, u: Usage): void {
  const v: Usage = { ...usage.get(accountId) };
  if (typeof u.fiveHour === 'number') v.fiveHour = u.fiveHour;
  if (typeof u.sevenDay === 'number') v.sevenDay = u.sevenDay;
  if (u.resetsAt) v.resetsAt = u.resetsAt;
  usage.set(accountId, v);
  for (const cb of listeners) { try { cb(accountId, v); } catch (e) { console.error(e); } }
  for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send('accounts:usage', accountId, v);
}
export const usageOf = (accountId: string): Usage | undefined => usage.get(accountId);

// ---- add, change, remove ----

/** A second Claude dir starts empty: share roles, skills, commands and CLAUDE.md by symlink, and copy
 *  only enabledPlugins and permissions.defaultMode (plugins/ holds install state the CLI writes, so it is never shared). */
function claudeDir(dir: string): void {
  const home = join(homedir(), '.claude');
  for (const name of ['agents', 'skills', 'commands', 'CLAUDE.md']) {
    if (existsSync(join(home, name)) && !existsSync(join(dir, name))) symlinkSync(join(home, name), join(dir, name));
  }
  if (existsSync(join(dir, 'settings.json'))) return;
  try {
    const { enabledPlugins, permissions } = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
    const out: Record<string, unknown> = {};
    if (enabledPlugins && typeof enabledPlugins === 'object') out.enabledPlugins = enabledPlugins;
    if (typeof permissions?.defaultMode === 'string') out.permissions = { defaultMode: permissions.defaultMode };
    if (Object.keys(out).length) writePrivate(join(dir, 'settings.json'), JSON.stringify(out, null, 2));
  } catch { /* no settings to copy */ }
}

export function addAccount(o: { name?: string; provider: Provider; ownLogin?: boolean }): Account {
  if (!PROVIDERS.includes(o.provider)) throw new Error('Unknown provider');
  const all = listAccounts();
  const name = (o.name ?? '').trim().slice(0, 40) || { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' }[o.provider];
  let id = slug(`${o.provider}-${name}`, 'account');
  for (let n = 2; all.some((a) => a.id === id); n++) id = slug(`${o.provider}-${name}-${n}`, 'account');
  const env: Record<string, string> = {};
  // Claude: the default login is already account one, so every extra account gets its own dir.
  // Codex: the login in ~/.codex (CODEX_HOME unset) or a dir of its own.
  // Gemini: API key only (features.md #24), and always its own home, so the user's Google login in ~/.gemini is never used.
  if (o.provider === 'claude' || o.provider === 'gemini' || o.ownLogin) {
    const dir = join(STATE_DIR, 'accounts', id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (o.provider === 'claude') { claudeDir(dir); env.CLAUDE_CONFIG_DIR = dir; } else if (o.provider === 'gemini') { geminiHome(dir); env.GEMINI_CLI_HOME = dir; } else env.CODEX_HOME = dir;
  } else if (all.some((a) => a.provider === 'codex' && !a.env.CODEX_HOME)) {
    throw new Error('An account already uses the login in ~/.codex. Give this one its own login.');
  }
  const a: Account = { id, name, provider: o.provider, env, cap: 2, allowAuto: false };
  save([...stored(), a]);
  return a;
}

export function updateAccount(id: string, patch: { name?: unknown; cap?: unknown; allowAuto?: unknown }): void {
  const list = listAccounts();
  const a = list.find((x) => x.id === id);
  if (!a) throw new Error('No such account');
  if (typeof patch.name === 'string' && patch.name.trim()) a.name = patch.name.trim().slice(0, 40);
  if (typeof patch.cap === 'number' && Number.isFinite(patch.cap)) a.cap = Math.max(0, Math.min(20, Math.round(patch.cap)));
  if (typeof patch.allowAuto === 'boolean') a.allowAuto = patch.allowAuto;
  save(list);
}

/** Forgets the account. Its folder (and the CLI's login in it) stays on disk until David deletes it. */
export function removeAccount(id: string): void {
  if (id === DEFAULT_ACCOUNT) throw new Error('The default Claude account cannot be removed.');
  if (account(id)?.provider === 'gemini') void removeToken(KEY_SERVICE, id);
  save(stored().filter((a) => a.id !== id));
  usage.delete(id);
}

/** A Gemini account's API key, into the Keychain only (never a file); the CLI gets it as GEMINI_API_KEY at spawn. */
export async function setApiKey(id: string, key: unknown): Promise<void> {
  if (account(id)?.provider !== 'gemini') throw new Error('Only Gemini accounts take an API key.');
  if (typeof key !== 'string' || !key.trim()) throw new Error('Paste the API key first.');
  await setToken(KEY_SERVICE, id, key.trim());
}

export function registerAccountsIpc(): void {
  ipcMain.handle('accounts:list', () => listAccounts().map((a) => ({ ...a, usage: usage.get(a.id) })));
  ipcMain.handle('accounts:add', async (_e, o) => {
    const a = addAccount(o);
    if (a.provider === 'gemini' && o?.key) await setApiKey(a.id, o.key).catch((e) => { removeAccount(a.id); throw e; });
    return a;
  });
  ipcMain.handle('accounts:set-key', (_e, id: string, key: unknown) => setApiKey(id, key));
  ipcMain.handle('accounts:update', (_e, id: string, patch) => updateAccount(id, patch ?? {}));
  ipcMain.handle('accounts:remove', (_e, id: string) => removeAccount(id));
}
