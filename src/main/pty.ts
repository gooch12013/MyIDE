import { app, ipcMain, type WebContents } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import * as pty from 'node-pty';

const shell = process.env.SHELL || '/bin/zsh';

// MyIDE is often launched from a terminal running Claude Code. Inherited CLAUDE* vars make a child
// `claude` run as a child session (transcript saving off) or override its effort, so none are passed on.
const baseEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('CLAUDE')) baseEnv[k] = v;

// A GUI-launched app gets launchd's minimal PATH, so ask the user's login shell once.
const loginPath = new Promise<string>((resolve) => {
  const cmd = 'printf "\\n__MYIDE_PATH__%s__MYIDE_PATH__" "$PATH"';
  const child = execFile(shell, ['-ilc', cmd], { env: baseEnv, timeout: 10_000 }, (_err, stdout) => {
    resolve(/__MYIDE_PATH__(.*)__MYIDE_PATH__/.exec(stdout ?? '')?.[1] || baseEnv.PATH || '/usr/bin:/bin:/usr/sbin:/sbin');
  });
  child.stdin?.end(); // an rc file that reads stdin gets EOF instead of hanging until the timeout
});

/** Environment for every child MyIDE spawns: inherited env minus CLAUDE*, the login shell's PATH, then `extra`. */
export async function spawnEnv(extra: Record<string, string> = {}): Promise<Record<string, string>> {
  return { ...baseEnv, PATH: await loginPath, LANG: baseEnv.LANG || 'en_US.UTF-8', ...extra };
}

// One PTY per panel id. PTYs live here, so a panel can move between windows (or the renderer reload)
// and reattach by id without losing the shell.
const ptys = new Map<string, { p: pty.IPty; owner: WebContents }>();

export interface PtySpawnOptions { cwd?: string; cols: number; rows: number }

export function registerPtyIpc(): void {
  ipcMain.handle('pty:spawn', async (e, id: string, opts: PtySpawnOptions) => {
    if (typeof id !== 'string' || !id) throw new Error('pty:spawn needs an id');
    const env = await spawnEnv({ TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'MyIDE', TERM_PROGRAM_VERSION: app.getVersion() });
    const existing = ptys.get(id);
    if (existing) { existing.owner = e.sender; return; }
    const cwd = opts.cwd && existsSync(opts.cwd) ? opts.cwd : homedir();
    const p = pty.spawn(shell, ['-l'], { name: 'xterm-256color', cols: opts.cols || 80, rows: opts.rows || 24, cwd, env });
    const entry = { p, owner: e.sender };
    ptys.set(id, entry);
    p.onData((d) => { if (!entry.owner.isDestroyed()) entry.owner.send('pty:data', id, d); });
    p.onExit(({ exitCode }) => {
      ptys.delete(id);
      if (!entry.owner.isDestroyed()) entry.owner.send('pty:exit', id, exitCode);
    });
  });
  ipcMain.on('pty:write', (_e, id: string, data: string) => { if (typeof data === 'string') ptys.get(id)?.p.write(data); });
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => {
    if (cols > 0 && rows > 0) ptys.get(id)?.p.resize(Math.floor(cols), Math.floor(rows));
  });
  ipcMain.on('pty:kill', (_e, id: string) => ptys.get(id)?.p.kill());
}

export function killAllPtys(): void {
  for (const { p } of ptys.values()) p.kill();
  ptys.clear();
}
