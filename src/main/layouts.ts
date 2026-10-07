import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { readJSON, writeJSON } from './store';

/** perProject: dockview layout per project id ('' = no project). last: what to reopen at launch. */
export interface LayoutsFile { perProject: Record<string, unknown>; named: Record<string, unknown>; last: { project: string | null } | null }

const FILE = 'layouts.json';
const load = (): LayoutsFile => ({ perProject: {}, named: {}, last: null, ...readJSON<Partial<LayoutsFile>>(FILE, {}) });

export const namedLayouts = (): string[] => Object.keys(load().named).sort((a, b) => a.localeCompare(b));

export function dropProjectLayout(id: string): void {
  const f = load();
  delete f.perProject[id];
  writeJSON(FILE, f);
}

export async function deleteNamedLayout(name: string, onChange: () => void): Promise<void> {
  const box = { type: 'warning' as const, buttons: ['Delete', 'Cancel'], defaultId: 1, cancelId: 1, message: `Delete the layout "${name}"?` };
  const win = BrowserWindow.getFocusedWindow();
  const { response } = await (win ? dialog.showMessageBox(win, box) : dialog.showMessageBox(box));
  if (response !== 0) return;
  const f = load();
  delete f.named[name];
  writeJSON(FILE, f);
  onChange();
}

export function registerLayoutIpc(onChange: () => void): void {
  ipcMain.handle('layouts:get', load);
  // Sent on every (debounced) layout change of the active project, so it also records `last`.
  // Quitting closes pop-out windows, which docks their groups back; that layout is not the one to keep.
  let quitting = false;
  app.on('before-quit', () => { quitting = true; });
  ipcMain.on('layouts:put-project', (_e, project: string | null, layout: unknown) => {
    if (quitting) return;
    const f = load();
    f.perProject[project ?? ''] = layout;
    f.last = { project };
    writeJSON(FILE, f);
  });
  ipcMain.handle('layouts:save-named', (_e, name: string, layout: unknown) => {
    if (typeof name !== 'string' || !name.trim()) throw new Error('A layout needs a name');
    const f = load();
    f.named[name.trim()] = layout;
    writeJSON(FILE, f);
    onChange();
  });
}
