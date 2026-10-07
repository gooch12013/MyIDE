import { app, BrowserWindow, net, protocol } from 'electron';
import { join, normalize, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { killAllPtys, registerPtyIpc } from './pty';

// The renderer is served from app://myide/ rather than file:// because dockview only opens
// same-origin pop-out windows.
const RENDERER = join(__dirname, 'renderer');
const ORIGIN = 'app://myide';
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

let mainWindow: BrowserWindow | null = null;

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 640,
    minHeight: 400,
    title: 'MyIDE',
    backgroundColor: '#111317',
    titleBarStyle: 'hiddenInset',
    webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // dockview pop-outs call window.open on popout.html; nothing else may open a window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) =>
    url.startsWith(`${ORIGIN}/popout.html`)
      ? { action: 'allow', overrideBrowserWindowOptions: { backgroundColor: '#111317', title: 'MyIDE' } }
      : { action: 'deny' },
  );
  mainWindow.on('closed', () => {
    mainWindow = null;
    app.quit(); // pop-outs belong to the main window
  });
  mainWindow.loadURL(`${ORIGIN}/index.html`);
}

// Keyboard commands go through main so they work in pop-out windows too; the renderer that owns
// the layout (the main window) handles them.
const COMMANDS: Record<string, string> = { t: 'new-terminal' };

app.on('web-contents-created', (_e, wc) => {
  wc.on('will-navigate', (e, url) => { if (!url.startsWith(`${ORIGIN}/`)) e.preventDefault(); });
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || !input.meta || input.control || input.alt || input.shift) return;
    const command = COMMANDS[input.key.toLowerCase()];
    if (!command || !mainWindow) return;
    e.preventDefault();
    mainWindow.webContents.send('command', command);
  });
});

app.whenReady().then(() => {
  protocol.handle('app', (req) => {
    const file = normalize(join(RENDERER, decodeURIComponent(new URL(req.url).pathname)));
    if (!file.startsWith(RENDERER + sep)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  registerPtyIpc();
  createMainWindow();
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', killAllPtys);
