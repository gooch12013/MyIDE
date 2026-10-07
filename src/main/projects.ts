import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import { dropProjectLayout, loadLayouts } from './layouts';
import { killPty } from './pty';
import { sameIds, setClosed } from './tabs';
import type { Prefs } from './prefs';
import { readJSON, writeJSON } from './store';

/** `closed`: when its tab was closed (the project, its layout and its employees stay). */
export interface Project { id: string; name: string; path: string; colour: string; closed?: number }

// Page colours handed out in order to new projects; amber is the live colour, so it is never one.
export const PALETTE = ['#ff7eb6', '#3cd2da', '#b590ff', '#7fd96c', '#62a8ff', '#ff9b6b', '#e2df6a', '#c7a0ff', '#4fd1a5'];

// config.json holds projects and preferences; every write keeps the keys it does not change.
export type Config = { prefs?: Partial<Prefs>; projects?: Project[] };
export const readConfig = (): Config => readJSON<Config>('config.json', {});
export const writeConfig = (c: Config): void => writeJSON('config.json', c);
export const listProjects = (): Project[] => readConfig().projects ?? [];
export const projectById = (id?: string): Project | undefined => listProjects().find((p) => p.id === id);
const saveProjects = (projects: Project[]): void => writeConfig({ ...readConfig(), projects });

// Only paths inside a registered project are listed or opened. ponytail: symlinks are not resolved,
// so a link inside a project can point out of it; realpath both sides if that matters.
function inProject(path: unknown): path is string {
  if (typeof path !== 'string') return false;
  const p = resolve(path);
  return listProjects().some((proj) => p === proj.path || p.startsWith(proj.path + sep));
}

const SKIP = new Set(['.git', 'node_modules', 'dist', 'out']);
// Opening these would run them, so the files panel only shows them in Finder.
const RUNNABLE = /\.(app|command|terminal|sh|tool|pkg)$/i;
const runnable = (path: string): boolean => {
  if (RUNNABLE.test(path)) return true;
  try { const st = statSync(path); return st.isFile() && (st.mode & 0o111) !== 0; } catch { return false; }
};

export function registerProjectIpc(onChange: () => void): void {
  ipcMain.handle('projects:list', () => listProjects());
  ipcMain.handle('projects:add', async (e) => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender)!, {
      title: 'Add Project', buttonLabel: 'Add Project', properties: ['openDirectory', 'createDirectory'],
    });
    const path = r.filePaths[0];
    if (r.canceled || !path) return null;
    const projects = listProjects();
    const existing = projects.find((p) => p.path === path);
    if (existing) return existing;
    const colour = PALETTE.find((c) => !projects.some((p) => p.colour === c)) ?? PALETTE[projects.length % PALETTE.length];
    const project = { id: randomUUID().slice(0, 8), name: basename(path), path, colour };
    saveProjects([...projects, project]);
    onChange();
    return project;
  });
  ipcMain.handle('files:list', async (_e, dir: unknown) => {
    if (!inProject(dir)) throw new Error('Not inside a project');
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((d) => !SKIP.has(d.name))
      .map((d) => ({ name: d.name, dir: d.isDirectory() }))
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  });
  // Resolves to '' on success or the OS error text.
  ipcMain.handle('files:open', (_e, path: unknown) => {
    if (!inProject(path)) return 'Not inside a project';
    if (!runnable(path)) return shell.openPath(path);
    shell.showItemInFolder(path);
    return '';
  });
  ipcMain.handle('projects:update', (_e, id: string, patch: { name?: unknown; colour?: unknown }) => {
    const projects = listProjects();
    const p = projects.find((x) => x.id === id);
    if (!p) throw new Error('No such project');
    if (typeof patch.name === 'string' && patch.name.trim()) p.name = patch.name.trim().slice(0, 60);
    if (typeof patch.colour === 'string' && /^#[0-9a-f]{6}$/i.test(patch.colour)) p.colour = patch.colour.toLowerCase();
    saveProjects(projects);
    onChange();
  });
  ipcMain.handle('projects:reveal', (_e, id: string) => {
    const p = projectById(id);
    if (p) shell.showItemInFolder(p.path);
  });
  // The array order is the tab order.
  ipcMain.handle('projects:reorder', (_e, ids: unknown) => {
    const projects = listProjects();
    if (!sameIds(projects, ids)) throw new Error('Not a reordering of the projects');
    saveProjects(ids.map((id) => projects.find((p) => p.id === id)!));
    onChange();
  });
  // Closing a tab ends its terminals (the renderer has confirmed); its saved layout reopens them as fresh shells.
  ipcMain.handle('projects:set-closed', (_e, id: string, closed: boolean) => {
    if (!projectById(id)) throw new Error('No such project');
    if (closed) {
      const panels = (loadLayouts().perProject[id] as { panels?: Record<string, { contentComponent?: string }> } | undefined)?.panels ?? {};
      for (const [panel, p] of Object.entries(panels)) if (p.contentComponent === 'terminal') killPty(panel);
    }
    saveProjects(setClosed(listProjects(), id, !!closed));
    onChange();
  });
  ipcMain.handle('projects:remove', async (e, id: string) => {
    const project = projectById(id);
    if (!project) return false;
    const { response } = await dialog.showMessageBox(BrowserWindow.fromWebContents(e.sender)!, {
      type: 'warning', buttons: ['Remove', 'Cancel'], defaultId: 1, cancelId: 1,
      message: `Remove ${project.name} from MyIDE?`, detail: `${project.path} stays on disk. Its saved layout is forgotten.`,
    });
    if (response !== 0) return false;
    saveProjects(listProjects().filter((p) => p.id !== id));
    dropProjectLayout(id);
    onChange();
    return true;
  });
}
