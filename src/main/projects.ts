import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import { dropProjectLayout } from './layouts';
import { readJSON, writeJSON } from './store';

export interface Project { id: string; name: string; path: string; colour: string }

// Page colours handed out in order to new projects; amber is the live colour, so it is never one.
export const PALETTE = ['#ff7eb6', '#3cd2da', '#b590ff', '#7fd96c', '#62a8ff', '#ff9b6b', '#e2df6a', '#c7a0ff', '#4fd1a5'];

// config.json is shared with other settings, so every write keeps the keys it does not own.
export const listProjects = (): Project[] => readJSON<{ projects?: Project[] }>('config.json', {}).projects ?? [];
function saveProjects(projects: Project[]): void {
  writeJSON('config.json', { ...readJSON<object>('config.json', {}), projects });
}

// Only paths inside a registered project are listed or opened. ponytail: symlinks are not resolved,
// so a link inside a project can point out of it; realpath both sides if that matters.
function inProject(path: unknown): path is string {
  if (typeof path !== 'string') return false;
  const p = resolve(path);
  return listProjects().some((proj) => p === proj.path || p.startsWith(proj.path + sep));
}

const SKIP = new Set(['.git', 'node_modules', 'dist', 'out']);

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
  ipcMain.handle('files:open', (_e, path: unknown) => (inProject(path) ? shell.openPath(path) : 'Not inside a project'));
  ipcMain.handle('projects:remove', async (e, id: string) => {
    const project = listProjects().find((p) => p.id === id);
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
