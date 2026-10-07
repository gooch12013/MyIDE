import { BrowserWindow, clipboard, ipcMain, Menu, shell, type MenuItemConstructorOptions } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

// "Open in" targets. Terminal always exists; the others are offered only when installed.
const APPS: Record<string, string> = { Terminal: 'com.apple.Terminal', Ghostty: 'com.mitchellh.ghostty', WebStorm: 'com.jetbrains.WebStorm' };

const found = (name: string): Promise<boolean> => {
  if (name === 'Terminal') return Promise.resolve(true);
  if ([`/Applications/${name}.app`, join(homedir(), 'Applications', `${name}.app`)].some(existsSync)) return Promise.resolve(true);
  return new Promise((resolve) =>
    execFile('mdfind', [`kMDItemCFBundleIdentifier == "${APPS[name]}"`], { timeout: 5000 }, (_err, out) => resolve(!!out?.trim())),
  );
};
const installed: Promise<string[]> = Promise.all(Object.keys(APPS).map(async (n) => ((await found(n)) ? n : ''))).then((a) => a.filter(Boolean));

export const isDir = (p: unknown): p is string => {
  try {
    return typeof p === 'string' && isAbsolute(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Opens `dir` in one of the known apps; args go straight to `open`, never through a shell. */
async function openIn(app: string, dir: unknown): Promise<void> {
  if (!(await installed).includes(app) || !isDir(dir)) return;
  execFile('open', ['-a', app, dir]); // dir is absolute, so it can't be read as a flag
}

export type TerminalMenuAction = 'copy' | 'paste' | 'clear' | null;

export function registerOpenerIpc(): void {
  ipcMain.handle('open:url', (_e, url: string) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) return shell.openExternal(url);
  });
  ipcMain.on('clipboard:write', (_e, text: string) => { if (typeof text === 'string' && text) clipboard.writeText(text); });
  ipcMain.handle('clipboard:read', () => clipboard.readText());

  // The terminal context menu. Menu actions that need xterm come back to the renderer; "Open in" runs here.
  ipcMain.handle('terminal:menu', async (e, hasSelection: boolean, cwd: string) => {
    const apps = await installed;
    return new Promise<TerminalMenuAction>((resolve) => {
      const items: MenuItemConstructorOptions[] = [
        { label: 'Copy', accelerator: 'Cmd+C', enabled: !!hasSelection, click: () => resolve('copy') },
        { label: 'Paste', accelerator: 'Cmd+V', click: () => resolve('paste') },
        { label: 'Clear', accelerator: 'Cmd+K', click: () => resolve('clear') },
        { type: 'separator' },
        ...apps.map((app): MenuItemConstructorOptions => ({ label: `Open in ${app}`, enabled: isDir(cwd), click: () => void openIn(app, cwd) })),
      ];
      // ponytail: the close callback can run before the click on macOS, so it waits a beat before resolving null.
      Menu.buildFromTemplate(items).popup({
        window: BrowserWindow.getFocusedWindow() ?? BrowserWindow.fromWebContents(e.sender) ?? undefined,
        callback: () => setTimeout(() => resolve(null), 100),
      });
    });
  });
}
