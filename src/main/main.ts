import { app, BrowserWindow, net, protocol } from 'electron';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { killAllPtys, registerPtyIpc } from './pty';
import { registerLayoutIpc, savedPanelIds } from './layouts';
import { buildMenu, registerMenu } from './menu';
import { registerProjectIpc } from './projects';
import './ghostty';
import { registerOpenerIpc } from './openers';
import './mic';
import { registerPrefsIpc } from './prefs';
import { STATE_DIR } from './store';
import { registerEmployeesIpc, stopAllTurns } from './employees';
import { registerAiIpc } from './transports';
import { registerForgeIpc } from './forge';
import { allowed, registerGitIpc } from './git';
import { registerComponentsIpc } from './components';
import { registerSpeechIpc, stop as stopSpeech } from './speech';
import { registerButtonsIpc } from './buttons';
import { refreshTray, startTray } from './tray';
import { registerAssetsIpc } from './assets';
import { registerTodosIpc } from './todos';
import { registerWizardIpc } from './wizard';

// One MyIDE at a time. The lock lives in userData, so a dev or test run with its own MYIDE_HOME
// gets its own userData and runs beside the installed app.
if (process.env.MYIDE_HOME) app.setPath('userData', join(STATE_DIR, 'electron'));
if (!app.requestSingleInstanceLock()) app.exit(0);

// The renderer is served from app://myide/ rather than file:// because dockview only opens
// same-origin pop-out windows.
const RENDERER = join(__dirname, 'renderer');
const ORIGIN = 'app://myide';
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

let mainWindow: BrowserWindow | null = null;
// Closing the main window hides it (and its pop-outs) so schedules keep firing; Cmd+Q and the tray's Quit really quit.
let quitting = false;
// Unsaved editor files: the first quit is held while the main window asks Save / Don't save / Cancel (src/renderer/editor.ts).
// Every other before-quit listener checks defaultPrevented, so a cancelled quit changes nothing.
let quitAsked = false;
app.on('before-quit', (e) => {
  const wc = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
  if (quitAsked || !wc) return;
  e.preventDefault();
  quitAsked = true;
  void (async () => {
    const n = await Promise.race([wc.executeJavaScript('window.myideDirty ? window.myideDirty() : 0').catch(() => 0), new Promise((r) => setTimeout(() => r(0), 2000))]); // a hung renderer does not block quitting
    if (n) showAll();
    const ok = !n || await wc.executeJavaScript('window.myideQuitCheck()').catch(() => true);
    if (ok) app.quit(); else quitAsked = false;
  })();
});
app.on('before-quit', (e) => { if (!e.defaultPrevented) quitting = true; });
function showAll(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  for (const w of BrowserWindow.getAllWindows()) w.show();
  mainWindow.focus();
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 640,
    minHeight: 400,
    title: 'MyIDE',
    backgroundColor: '#111317',
    titleBarStyle: 'hiddenInset',
    // plugins: Chromium's PDF viewer, for PDFs opened in the editor (app://myide/view below).
    webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, plugins: true },
  });
  mainWindow.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    mainWindow!.webContents.send('command', 'flush-layout'); // what a close would have saved
    for (const w of BrowserWindow.getAllWindows()) w.hide();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    app.quit(); // pop-outs belong to the main window
  });
  mainWindow.loadURL(`${ORIGIN}/index.html`);
}

app.on('second-instance', showAll);
app.on('activate', showAll); // the Dock icon

// Keyboard commands go through main so they work in pop-out windows too; the renderer that owns
// the layout (the main window) handles them.
const COMMANDS: Record<string, string> = { t: 'new-terminal' };
// Cmd+W closes the active tab; Cmd+1..9 switch project.
COMMANDS.w = 'close-tab';
for (let i = 1; i <= 9; i++) COMMANDS[i] = `project:${i}`;

// Every window, pop-outs included: dockview pop-outs call window.open on popout.html; nothing else
// may open a window or navigate away from the app.
app.on('web-contents-created', (_e, wc) => {
  wc.setWindowOpenHandler(({ url }) =>
    url.startsWith(`${ORIGIN}/popout.html`)
      ? { action: 'allow', overrideBrowserWindowOptions: { backgroundColor: '#111317', title: 'MyIDE' } }
      : { action: 'deny' },
  );
  wc.on('will-navigate', (e, url) => { if (!url.startsWith(`${ORIGIN}/`)) e.preventDefault(); });
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || !input.meta || input.control || input.alt || input.shift) return;
    const command = COMMANDS[input.key.toLowerCase()];
    if (!command || !mainWindow) return;
    e.preventDefault();
    mainWindow.webContents.send('command', command);
  });
});

// What the editor views rather than edits: images and PDFs, served as /view?path=<absolute path> from inside a project
// or a MyIDE worktree only (git.ts allowed, the same rule as the editor's reads).
const VIEW: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml', pdf: 'application/pdf', heic: 'image/heic', heif: 'image/heif',
};
// Chromium can't decode HEIC, so macOS's own sips turns it into a JPEG, kept in the temp folder until the file changes.
const heicRuns = new Map<string, Promise<string>>();
function heicJpeg(path: string): Promise<string> {
  const st = statSync(path);
  const out = join(app.getPath('temp'), 'myide-heic', `${createHash('sha256').update(`${path}\0${st.size}\0${st.mtimeMs}`).digest('hex')}.jpg`);
  if (existsSync(out)) return Promise.resolve(out);
  let run = heicRuns.get(out); // one conversion per file, however many ask at once
  if (!run) {
    mkdirSync(join(app.getPath('temp'), 'myide-heic'), { recursive: true, mode: 0o700 });
    run = promisify(execFile)('/usr/bin/sips', ['-s', 'format', 'jpeg', path, '--out', `${out}.part.jpg`], { timeout: 60_000 })
      .then(() => { renameSync(`${out}.part.jpg`, out); return out; })
      .finally(() => heicRuns.delete(out));
    heicRuns.set(out, run);
  }
  return run;
}
async function view(url: URL): Promise<Response> {
  const path = url.searchParams.get('path');
  const type = VIEW[path?.split('.').pop()?.toLowerCase() ?? ''];
  if (!type || !allowed(path)) return new Response('Not found', { status: 404 });
  const heic = type === 'image/heic' || type === 'image/heif';
  const file = heic ? await heicJpeg(path).catch(() => null) : path;
  const r = file ? await net.fetch(pathToFileURL(file).toString()).catch(() => null) : null;
  if (!r?.ok) return new Response('Not found', { status: 404 });
  // An SVG runs no script, even if something loads it as a page.
  const headers: Record<string, string> = { 'content-type': heic ? 'image/jpeg' : type, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' };
  if (type === 'image/svg+xml') headers['content-security-policy'] = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";
  return new Response(r.body, { headers });
}

app.whenReady().then(() => {
  protocol.handle('app', (req) => {
    if (new URL(req.url).pathname === '/view') return view(new URL(req.url));
    const file = normalize(join(RENDERER, decodeURIComponent(new URL(req.url).pathname)));
    if (!file.startsWith(RENDERER + sep)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  registerPtyIpc(savedPanelIds);
  registerProjectIpc(buildMenu);
  registerLayoutIpc(buildMenu);
  registerMenu((command) => mainWindow?.webContents.send('command', command));
  registerOpenerIpc();
  registerPrefsIpc();
  registerEmployeesIpc(() => mainWindow);
  registerAiIpc();
  registerForgeIpc();
  registerGitIpc();
  registerComponentsIpc();
  registerSpeechIpc();
  registerButtonsIpc({ onPaused: refreshTray });
  registerAssetsIpc();
  registerTodosIpc();
  registerWizardIpc();
  createMainWindow();
  void startTray({ open: showAll, showNeeds: () => { showAll(); mainWindow?.webContents.send('command', 'employees-all'); } });
});

app.on('before-quit', (e) => {
  if (e.defaultPrevented) return;
  killAllPtys();
  stopAllTurns();
  stopSpeech();
});
