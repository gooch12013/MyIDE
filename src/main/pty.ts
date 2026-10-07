import { app, ipcMain, type WebContents } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename } from 'node:path';
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
// Recent output, split wherever the size changed: replaying each piece at the size it was drawn for
// keeps full-screen programs and prompt redraws from garbling.
export interface OutputSegment { cols: number; rows: number; data: string }
interface Entry { p: pty.IPty; owner: WebContents; cwd: string; proc: string; tail: OutputSegment[]; tailLen: number; stale: boolean; onEnter?(): void }
const ptys = new Map<string, Entry>();
const TAIL = 256 * 1024; // output kept for a re-created xterm (reload, project switch) to replay
const watched = new WeakSet<WebContents>();

export interface PtySpawnOptions { cwd?: string; cols: number; rows: number }
export interface PtyInfo { cwd: string; process: string; replay?: OutputSegment[] }

const info = (e: Entry): PtyInfo => ({ cwd: e.cwd, process: e.proc === basename(shell) ? '' : e.proc });

// The foreground process name is cheap to read, so it is checked on output (at most once a second).
// The cwd needs lsof, so it is read only after the user presses Enter (e.g. a `cd`).
function track(id: string, e: Entry): { onData(): void; onEnter(): void } {
  let procTimer: NodeJS.Timeout | undefined;
  let cwdTimer: NodeJS.Timeout | undefined;
  const send = () => { if (ptys.get(id) === e && !e.owner.isDestroyed()) e.owner.send('pty:info', id, info(e)); };
  const checkProc = () => {
    procTimer = undefined;
    let proc = '';
    try { proc = e.p.process; } catch { return; }
    if (proc === e.proc) return;
    e.proc = proc;
    send();
    if (proc === basename(shell)) checkCwd(); // back at the prompt, e.g. after a script that cd'd
  };
  const checkCwd = () => {
    execFile('lsof', ['-a', '-p', String(e.p.pid), '-d', 'cwd', '-Fn'], { timeout: 3000 }, (_err, out) => {
      const cwd = /^n(.+)$/m.exec(out ?? '')?.[1];
      if (cwd && cwd !== e.cwd) { e.cwd = cwd; send(); }
    });
  };
  return {
    onData: () => { procTimer ??= setTimeout(checkProc, 1000); },
    onEnter: () => {
      clearTimeout(cwdTimer);
      cwdTimer = setTimeout(() => { checkCwd(); checkProc(); }, 400);
    },
  };
}

// A reloaded renderer reattaches its panels by id. Whatever it doesn't reclaim within 15 s
// belonged to a panel that no longer exists, so it is killed.
function watchReload(wc: WebContents): void {
  if (watched.has(wc)) return;
  watched.add(wc);
  wc.on('did-start-navigation', (ev) => {
    if (!ev.isMainFrame || ev.isSameDocument) return;
    const mine = [...ptys.values()].filter((e) => e.owner === wc);
    mine.forEach((e) => { e.stale = true; });
    setTimeout(() => mine.forEach((e) => e.stale && e.p.kill()), 15_000);
  });
}

// ponytail: the tail is cut by length, so replay may start mid escape sequence.
function keep(e: Entry, d: string): void {
  let last = e.tail.at(-1);
  if (!last || last.cols !== e.p.cols || last.rows !== e.p.rows) e.tail.push((last = { cols: e.p.cols, rows: e.p.rows, data: '' }));
  last.data += d;
  e.tailLen += d.length;
  while (e.tailLen > TAIL) {
    const first = e.tail[0];
    const cut = Math.min(first.data.length, e.tailLen - TAIL);
    first.data = first.data.slice(cut);
    e.tailLen -= cut;
    if (!first.data) e.tail.shift();
  }
}

export function registerPtyIpc(): void {
  ipcMain.handle('pty:spawn', async (e, id: string, opts: PtySpawnOptions): Promise<PtyInfo> => {
    if (typeof id !== 'string' || !id) throw new Error('pty:spawn needs an id');
    watchReload(e.sender);
    const existing = ptys.get(id);
    if (existing) {
      existing.owner = e.sender;
      existing.stale = false;
      return { ...info(existing), replay: existing.tail }; // a new xterm: give it the screen history
    }
    const env = await spawnEnv({ TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'MyIDE', TERM_PROGRAM_VERSION: app.getVersion() });
    const cwd = opts.cwd && existsSync(opts.cwd) ? opts.cwd : homedir();
    const p = pty.spawn(shell, ['-l'], { name: 'xterm-256color', cols: opts.cols || 80, rows: opts.rows || 24, cwd, env });
    const entry: Entry = { p, owner: e.sender, cwd, proc: basename(shell), tail: [], tailLen: 0, stale: false };
    const t = track(id, entry);
    entry.onEnter = t.onEnter;
    ptys.set(id, entry);
    p.onData((d) => {
      keep(entry, d);
      t.onData();
      if (!entry.owner.isDestroyed()) entry.owner.send('pty:data', id, d);
    });
    p.onExit(({ exitCode }) => {
      ptys.delete(id);
      if (!entry.owner.isDestroyed()) entry.owner.send('pty:exit', id, exitCode);
    });
    return info(entry);
  });
  ipcMain.on('pty:write', (_e, id: string, data: string) => {
    if (typeof data !== 'string') return;
    ptys.get(id)?.p.write(data);
    if (data.includes('\r')) ptys.get(id)?.onEnter?.();
  });
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => {
    if (cols > 0 && rows > 0) ptys.get(id)?.p.resize(Math.floor(cols), Math.floor(rows));
  });
  ipcMain.on('pty:kill', (_e, id: string) => ptys.get(id)?.p.kill());
}

export function killAllPtys(): void {
  for (const { p } of ptys.values()) p.kill();
  ptys.clear();
}
