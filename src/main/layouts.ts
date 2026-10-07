import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { killPty } from './pty';
import { readJSON, writeJSON } from './store';

/** perProject: dockview layout per project id ('' = no project). last: what to reopen at launch. */
export interface LayoutsFile { perProject: Record<string, unknown>; named: Record<string, unknown>; last: { project: string | null } | null }
type Panels = { panels?: Record<string, { contentComponent?: string }> } | undefined;

const FILE = 'layouts.json';
const EMPTY = (): LayoutsFile => ({ perProject: {}, named: {}, last: null });
export const loadLayouts = (): LayoutsFile => ({ ...EMPTY(), ...readJSON<Partial<LayoutsFile>>(FILE, {}) });
export const saveLayouts = (f: Partial<LayoutsFile>): void => writeJSON(FILE, { ...EMPTY(), ...f });

export const namedLayouts = (): string[] => Object.keys(loadLayouts().named).sort((a, b) => a.localeCompare(b));

/** Every panel id in a saved layout (a parked project's terminals live only there). */
export function savedPanelIds(): Set<string> {
  const f = loadLayouts();
  return new Set([...Object.values(f.perProject), ...Object.values(f.named)].flatMap((l) => Object.keys((l as Panels)?.panels ?? {})));
}

/** Forgets a project's layout and ends the shells of its terminals (parked ones would otherwise run on). */
export function dropProjectLayout(id: string): void {
  const f = loadLayouts();
  for (const [panel, p] of Object.entries((f.perProject[id] as Panels)?.panels ?? {})) if (p.contentComponent === 'terminal') killPty(panel);
  delete f.perProject[id];
  saveLayouts(f);
}

export async function deleteNamedLayout(name: string, onChange: () => void, win?: BrowserWindow | null): Promise<void> {
  const { response } = await dialog.showMessageBox((win ?? BrowserWindow.getFocusedWindow())!, {
    type: 'warning', buttons: ['Delete', 'Cancel'], defaultId: 1, cancelId: 1, message: `Delete the layout "${name}"?`,
  });
  if (response !== 0) return;
  const f = loadLayouts();
  delete f.named[name];
  saveLayouts(f);
  onChange();
}

export function registerLayoutIpc(onChange: () => void): void {
  ipcMain.handle('layouts:get', loadLayouts);
  // Sent on every (debounced) layout change of the active project, so it also records `last`.
  // Quitting closes pop-out windows, which docks their groups back; that layout is not the one to keep.
  let quitting = false;
  app.on('before-quit', (e) => { if (!e.defaultPrevented) quitting = true; }); // a quit held for unsaved files may be cancelled
  ipcMain.on('layouts:put-project', (_e, project: string | null, layout: unknown) => {
    if (quitting) return;
    const f = loadLayouts();
    f.perProject[project ?? ''] = layout;
    f.last = { project };
    saveLayouts(f);
  });
  ipcMain.handle('layouts:save-named', (_e, name: string, layout: unknown) => {
    if (typeof name !== 'string' || !name.trim()) throw new Error('A layout needs a name');
    const f = loadLayouts();
    f.named[name.trim()] = layout;
    saveLayouts(f);
    onChange();
  });
  ipcMain.handle('layouts:rename', (_e, from: string, to: unknown) => {
    const f = loadLayouts();
    const name = typeof to === 'string' ? to.trim() : '';
    if (!(from in f.named)) throw new Error(`No layout called "${from}"`);
    if (!name) throw new Error('A layout needs a name');
    if (name === from) return;
    if (name in f.named) throw new Error(`There is already a layout called "${name}"`);
    f.named = Object.fromEntries(Object.entries(f.named).map(([k, v]) => [k === from ? name : k, v]));
    saveLayouts(f);
    onChange();
  });
  ipcMain.handle('layouts:delete', (e, name: string) => deleteNamedLayout(name, onChange, BrowserWindow.fromWebContents(e.sender)));
  ipcMain.handle('layouts:reset', (_e, id: string) => dropProjectLayout(id));
}
