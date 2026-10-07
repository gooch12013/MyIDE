import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

/** Subscribes to a main-to-renderer channel; returns the unsubscribe function. */
function on<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const handler = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...(args as A));
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api = {
  pty: {
    /** Starts the user's login shell for panel `id`, or reattaches if that id already has one. */
    spawn: (id: string, opts: { cwd?: string; cols: number; rows: number }): Promise<void> => ipcRenderer.invoke('pty:spawn', id, opts),
    write: (id: string, data: string): void => ipcRenderer.send('pty:write', id, data),
    resize: (id: string, cols: number, rows: number): void => ipcRenderer.send('pty:resize', id, cols, rows),
    kill: (id: string): void => ipcRenderer.send('pty:kill', id),
    onData: (cb: (id: string, data: string) => void) => on('pty:data', cb),
    onExit: (cb: (id: string, exitCode: number) => void) => on('pty:exit', cb),
  },
  /** App commands from keyboard shortcuts, e.g. 'new-terminal' (Cmd+T). */
  onCommand: (cb: (name: string) => void) => on('command', cb),
};

contextBridge.exposeInMainWorld('myide', api);

export type MyIDEApi = typeof api;
declare global {
  interface Window { myide: MyIDEApi }
}
