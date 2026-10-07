import { app, BrowserWindow, dialog, ipcMain, shell, webContents, type WebContents } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { loadLayouts, saveLayouts, type LayoutsFile } from './layouts';
import { isDir } from './openers';
import { PALETTE, readConfig, writeConfig, type Config } from './projects';
import { STATE_DIR } from './store';

/** terminalFontFamily '' and terminalFontSize 0 mean "as imported from Ghostty". */
export interface Prefs { uiFontSize: number; terminalFontFamily: string; terminalFontSize: number; reduceMotion: boolean; restoreLast: boolean }
const DEFAULTS: Prefs = { uiFontSize: 14, terminalFontFamily: '', terminalFontSize: 0, reduceMotion: false, restoreLast: true };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Keeps only known keys whose type matches the default. */
function clean(p: unknown): Partial<Prefs> {
  if (!isObj(p)) return {};
  return Object.fromEntries(Object.entries(p).filter(([k, v]) => k in DEFAULTS && typeof v === typeof DEFAULTS[k as keyof Prefs]));
}
export const getPrefs = (): Prefs => ({ ...DEFAULTS, ...clean(readConfig().prefs) });

// UI text size and reduced motion reach every app window, pop-outs included, as inserted CSS:
// pop-outs run no script of their own and only get a one-off copy of the main window's styles.
const inserted = new WeakMap<WebContents, string>();
async function style(wc: WebContents): Promise<void> {
  if (wc.isDestroyed() || !wc.getURL().startsWith('app://')) return;
  const p = getPrefs();
  const css = `:root{--ui-font-size:${p.uiFontSize}px}`
    + (p.reduceMotion ? '*,*::before,*::after{transition:none!important;animation:none!important;scroll-behavior:auto!important}' : '');
  const old = inserted.get(wc);
  inserted.set(wc, await wc.insertCSS(css));
  if (old) await wc.removeInsertedCSS(old);
}

/** Checks an exported settings file before it replaces anything; returns what is wrong, or ''. */
export function checkSettings(x: unknown): string {
  if (!isObj(x) || x.myide !== 'settings' || !isObj(x.config) || !isObj(x.layouts)) return 'This is not a MyIDE settings file.';
  const { projects = [], prefs = {} } = x.config;
  const projOk = (p: unknown) => isObj(p) && ['id', 'name', 'path', 'colour'].every((k) => typeof p[k] === 'string') && /^#[0-9a-f]{6}$/i.test(p.colour as string);
  if (!Array.isArray(projects) || !projects.every(projOk)) return 'Its project list is malformed.';
  if (new Set(projects.map((p) => p.id)).size !== projects.length) return 'Its project list has duplicate ids.';
  const missing = projects.find((p) => !isDir(p.path));
  if (missing) return `Project folder ${missing.path} is not an existing absolute folder on this Mac.`;
  if (!isObj(prefs)) return 'Its preferences are malformed.';
  const { perProject = {}, named = {}, last = null } = x.layouts;
  if (!isObj(perProject) || !isObj(named) || !(last === null || isObj(last))) return 'Its layouts are malformed.';
  return '';
}

const win = (wc: WebContents) => BrowserWindow.fromWebContents(wc)!;

export function registerPrefsIpc(): void {
  app.on('web-contents-created', (_e, wc) => wc.on('dom-ready', () => void style(wc)));

  ipcMain.handle('prefs:get', () => ({
    prefs: getPrefs(), palette: PALETTE, dataDir: STATE_DIR, openAtLogin: app.getLoginItemSettings().openAtLogin,
  }));
  ipcMain.handle('prefs:set', (_e, patch: unknown) => {
    const c = readConfig();
    writeConfig({ ...c, prefs: { ...clean(c.prefs), ...clean(patch) } });
    for (const wc of webContents.getAllWebContents()) void style(wc);
    return getPrefs();
  });
  ipcMain.handle('prefs:login', (_e, on: boolean) => app.setLoginItemSettings({ openAtLogin: !!on }));

  ipcMain.handle('data:reveal', () => shell.openPath(STATE_DIR));

  // Export is config.json plus layouts.json. Secrets never live in either (they go to the Keychain).
  ipcMain.handle('settings:export', async (e) => {
    const opts = { title: 'Export Settings', defaultPath: 'myide-settings.json', filters: [{ name: 'JSON', extensions: ['json'] }] };
    const r = await dialog.showSaveDialog(win(e.sender), opts);
    if (r.canceled || !r.filePath) return null;
    const data = { myide: 'settings', version: 1, config: readConfig(), layouts: loadLayouts() };
    await writeFile(r.filePath, JSON.stringify(data, null, 2) + '\n');
    return r.filePath;
  });
  // Resolves to null (cancelled) or an error message; on success MyIDE restarts with the imported settings.
  ipcMain.handle('settings:import', async (e) => {
    const opts = { title: 'Import Settings', properties: ['openFile' as const], filters: [{ name: 'JSON', extensions: ['json'] }] };
    const r = await dialog.showOpenDialog(win(e.sender), opts);
    const file = r.filePaths[0];
    if (r.canceled || !file) return null;
    let data: unknown;
    try { data = JSON.parse(await readFile(file, 'utf8')); } catch (err) { return `Could not read ${file}: ${(err as Error).message}`; }
    const problem = checkSettings(data);
    if (problem) return problem;
    const { config: c, layouts: l } = data as { config: Config; layouts: Partial<LayoutsFile> };
    const { response } = await dialog.showMessageBox(win(e.sender), {
      type: 'warning', buttons: ['Replace and Restart', 'Cancel'], defaultId: 1, cancelId: 1,
      message: 'Replace all MyIDE settings?',
      detail: `Projects, preferences and layouts are replaced by the ones in ${file} (${c.projects?.length ?? 0} projects, ${Object.keys(l.named ?? {}).length} named layouts). MyIDE restarts and open terminals close.`,
    });
    if (response !== 0) return null;
    writeConfig(c);
    saveLayouts(l);
    // Quitting stops the closing windows from saving their layouts over the imported ones.
    app.relaunch();
    app.quit();
    return '';
  });
}
