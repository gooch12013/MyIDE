import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { TerminalSettings } from '../main/ghostty';
import type { TerminalMenuAction } from '../main/openers';
import type { PtyInfo, PtySpawnOptions } from '../main/pty';
import type { MenuState } from '../main/menu';
import type { LayoutsFile } from '../main/layouts';
import type { Project } from '../main/projects';
import type { Prefs } from '../main/prefs';

/** Subscribes to a main-to-renderer channel; returns the unsubscribe function. */
function on<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const handler = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...(args as A));
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api = {
  pty: {
    /** Starts the user's login shell for panel `id`, or reattaches if that id already has one. */
    spawn: (id: string, opts: PtySpawnOptions): Promise<PtyInfo> => ipcRenderer.invoke('pty:spawn', id, opts),
    write: (id: string, data: string): void => ipcRenderer.send('pty:write', id, data),
    resize: (id: string, cols: number, rows: number): void => ipcRenderer.send('pty:resize', id, cols, rows),
    kill: (id: string): void => ipcRenderer.send('pty:kill', id),
    /** Resolves true if none of these terminals runs a program other than the shell, or the user agrees to end it. */
    confirmKill: (ids: string[]): Promise<boolean> => ipcRenderer.invoke('pty:confirm-kill', ids),
    onData: (cb: (id: string, data: string) => void) => on('pty:data', cb),
    onExit: (cb: (id: string, exitCode: number) => void) => on('pty:exit', cb),
    /** The shell's cwd or foreground process changed. */
    onInfo: (cb: (id: string, info: PtyInfo) => void) => on('pty:info', cb),
  },
  // Terminal: Ghostty-derived settings, clipboard, context menu and "Open in".
  terminal: {
    /** Ghostty's settings with the Preferences font overrides. */
    settings: (): TerminalSettings => ipcRenderer.sendSync('terminal:settings'),
    menu: (hasSelection: boolean, cwd: string): Promise<TerminalMenuAction> => ipcRenderer.invoke('terminal:menu', hasSelection, cwd),
    copy: (text: string): void => ipcRenderer.send('clipboard:write', text),
    paste: (): Promise<string> => ipcRenderer.invoke('clipboard:read'),
    openUrl: (url: string): Promise<void> => ipcRenderer.invoke('open:url', url),
  },
  // Projects, per-project and named layouts, the files panel and the app menu.
  projects: {
    list: (): Promise<Project[]> => ipcRenderer.invoke('projects:list'),
    /** Opens the folder picker; resolves to the new (or already added) project, or null if cancelled. */
    add: (): Promise<Project | null> => ipcRenderer.invoke('projects:add'),
    /** Asks for confirmation; resolves true if the project was removed. */
    remove: (id: string): Promise<boolean> => ipcRenderer.invoke('projects:remove', id),
  },
  layouts: {
    get: (): Promise<LayoutsFile> => ipcRenderer.invoke('layouts:get'),
    putProject: (project: string | null, layout: unknown): void => ipcRenderer.send('layouts:put-project', project, layout),
    saveNamed: (name: string, layout: unknown): Promise<void> => ipcRenderer.invoke('layouts:save-named', name, layout),
  },
  files: {
    list: (dir: string): Promise<{ name: string; dir: boolean }[]> => ipcRenderer.invoke('files:list', dir),
    /** Opens in the default app; resolves to '' or an error message. */
    open: (path: string): Promise<string> => ipcRenderer.invoke('files:open', path),
  },
  // Preferences panel.
  prefs: {
    get: (): Promise<{ prefs: Prefs; palette: string[]; dataDir: string; openAtLogin: boolean }> => ipcRenderer.invoke('prefs:get'),
    set: (patch: Partial<Prefs>): Promise<Prefs> => ipcRenderer.invoke('prefs:set', patch),
    setOpenAtLogin: (on: boolean): Promise<void> => ipcRenderer.invoke('prefs:login', on),
    updateProject: (id: string, patch: { name?: string; colour?: string }): Promise<void> => ipcRenderer.invoke('projects:update', id, patch),
    revealProject: (id: string): Promise<void> => ipcRenderer.invoke('projects:reveal', id),
    renameLayout: (from: string, to: string): Promise<void> => ipcRenderer.invoke('layouts:rename', from, to),
    /** Asks for confirmation first. */
    deleteLayout: (name: string): Promise<void> => ipcRenderer.invoke('layouts:delete', name),
    resetLayout: (projectId: string): Promise<void> => ipcRenderer.invoke('layouts:reset', projectId),
    revealData: (): Promise<string> => ipcRenderer.invoke('data:reveal'),
    /** Resolves to the written path, or null if cancelled. */
    exportSettings: (): Promise<string | null> => ipcRenderer.invoke('settings:export'),
    /** Resolves to null (cancelled) or an error message; on success the app restarts. */
    importSettings: (): Promise<string | null> => ipcRenderer.invoke('settings:import'),
  },
  menuState: (state: MenuState): void => ipcRenderer.send('menu:state', state),
  /** App commands from keyboard shortcuts, e.g. 'new-terminal' (Cmd+T). */
  onCommand: (cb: (name: string) => void) => on('command', cb),
};

contextBridge.exposeInMainWorld('myide', api);

export type MyIDEApi = typeof api;
declare global {
  interface Window { myide: MyIDEApi }
}
