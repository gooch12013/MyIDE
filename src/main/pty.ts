import { app, BrowserWindow, dialog, ipcMain, type WebContents } from 'electron';
import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import * as pty from 'node-pty';

const shell = process.env.SHELL || '/bin/zsh';

// MyIDE is often launched from a terminal running Claude Code. Inherited CLAUDE* vars make a child
// `claude` run as a child session (transcript saving off) or override its effort, so none are passed on.
const baseEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('CLAUDE')) baseEnv[k] = v;

// A GUI-launched app gets launchd's minimal PATH, so ask the user's login shell once. It resolves
// as soon as the marker is printed; a shell that lingers after that is killed.
const loginPath = new Promise<string>((resolve) => {
  const cmd = 'printf "\\n__MYIDE_PATH__%s__MYIDE_PATH__" "$PATH"';
  let out = '';
  const child = execFile(shell, ['-ilc', cmd], { env: baseEnv, timeout: 10_000 }, () => resolve(baseEnv.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'));
  child.stdout?.on('data', (d) => {
    const m = /__MYIDE_PATH__(.+)__MYIDE_PATH__/.exec((out += d));
    if (m) { resolve(m[1]); child.kill(); }
  });
  child.stdin?.end(); // an rc file that reads stdin gets EOF instead of hanging until the timeout
});

/** Env for a `claude` or `codex` child process: no inherited CLAUDE* vars, the login-shell PATH. */
export async function spawnEnv(): Promise<Record<string, string>> {
  return { ...baseEnv, PATH: await loginPath, LANG: baseEnv.LANG || 'en_US.UTF-8' };
}

/** Every executable file named `bin` on `path` (a PATH string), in PATH order. */
export function findOnPath(bin: string, path = ''): string[] {
  return path.split(':').filter(Boolean).map((d) => join(d, bin)).filter((p) => {
    try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; }
  });
}

/** The x.y.z a CLI prints for --version, or null if it is missing or broken. */
export async function cliVersion(path: string | null, env: Record<string, string>): Promise<string | null> {
  if (!path) return null;
  try { return /\d+\.\d+\.\d+/.exec((await promisify(execFile)(path, ['--version'], { env, timeout: 15_000 })).stdout)?.[0] ?? null; } catch { return null; }
}

// One PTY per panel id. PTYs live here, so a panel can move between windows (or the renderer reload)
// and reattach by id without losing the shell.
// Recent output, split wherever the size changed: replaying each piece at the size it was drawn for
// keeps full-screen programs and prompt redraws from garbling.
export interface OutputSegment { cols: number; rows: number; data: string }
interface Entry { p: pty.IPty; owner: WebContents; cwd: string; proc: string; tail: OutputSegment[]; tailLen: number; stale: boolean; onEnter?(): void }
const ptys = new Map<string, Entry>();
const pending = new Map<string, Promise<PtyInfo>>(); // spawns waiting for the login PATH
const killOnSpawn = new Set<string>();
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

// A reloaded renderer reattaches its panels by id. Whatever it doesn't reclaim within 15 s and no
// saved layout mentions (a parked project's terminals are only in its saved layout) is killed.
function watchReload(wc: WebContents, saved: () => Set<string>): void {
  if (watched.has(wc)) return;
  watched.add(wc);
  wc.on('did-start-navigation', (ev) => {
    if (!ev.isMainFrame || ev.isSameDocument) return;
    const mine = [...ptys].filter(([, e]) => e.owner === wc);
    mine.forEach(([, e]) => { e.stale = true; });
    setTimeout(() => {
      const keep = saved();
      mine.forEach(([id, e]) => e.stale && !keep.has(id) && e.p.kill());
    }, 15_000);
  });
}

let onExit: (id: string) => void = () => {};
/** `cb` runs with the panel id whenever a PTY exits (employees end Talk this way). */
export function onPtyExit(cb: (id: string) => void): void { onExit = cb; }

/** Kills panel `id`'s PTY, now or as soon as its spawn finishes. */
export function killPty(id: string): void {
  if (pending.has(id)) killOnSpawn.add(id);
  else ptys.get(id)?.p.kill();
}

/** Foreground programs other than the shell running in these PTYs. */
function busy(ids: string[]): string[] {
  return ids.flatMap((id) => {
    const e = ptys.get(id);
    let proc = '';
    try { proc = e?.p.process ?? ''; } catch { /* exited */ }
    return proc && proc !== basename(shell) ? [proc] : [];
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

async function spawn(id: string, owner: WebContents, opts: PtySpawnOptions): Promise<PtyInfo> {
  const env = {
    ...(await spawnEnv()),
    TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'MyIDE', TERM_PROGRAM_VERSION: app.getVersion(),
  };
  const cwd = opts.cwd && existsSync(opts.cwd) ? opts.cwd : homedir();
  const p = pty.spawn(shell, ['-l'], { name: 'xterm-256color', cols: opts.cols || 80, rows: opts.rows || 24, cwd, env });
  const entry: Entry = { p, owner, cwd, proc: basename(shell), tail: [], tailLen: 0, stale: false };
  const t = track(id, entry);
  entry.onEnter = t.onEnter;
  ptys.set(id, entry);
  p.onData((d) => {
    keep(entry, d);
    t.onData();
    if (!entry.owner.isDestroyed()) entry.owner.send('pty:data', id, d);
  });
  p.onExit(({ exitCode }) => {
    if (ptys.get(id) === entry) ptys.delete(id);
    onExit(id);
    if (!entry.owner.isDestroyed()) entry.owner.send('pty:exit', id, exitCode);
  });
  if (killOnSpawn.delete(id)) p.kill();
  return info(entry);
}

/** `saved` gives the panel ids in saved layouts, which a reload must not kill. */
export function registerPtyIpc(saved: () => Set<string>): void {
  ipcMain.handle('pty:spawn', (e, id: string, opts: PtySpawnOptions): Promise<PtyInfo> => {
    if (typeof id !== 'string' || !id) throw new Error('pty:spawn needs an id');
    watchReload(e.sender, saved);
    const existing = ptys.get(id);
    if (existing) {
      existing.owner = e.sender;
      existing.stale = false;
      return Promise.resolve({ ...info(existing), replay: existing.tail }); // a new xterm: give it the screen history
    }
    let p = pending.get(id);
    if (!p) {
      p = spawn(id, e.sender, opts).finally(() => pending.delete(id));
      pending.set(id, p);
    }
    return p;
  });
  // Resolves true if none of these terminals runs anything but the shell, or the user agrees to end it.
  ipcMain.handle('pty:confirm-kill', async (e, ids: string[]) => {
    const procs = Array.isArray(ids) ? busy(ids) : [];
    if (!procs.length) return true;
    const { response } = await dialog.showMessageBox((BrowserWindow.getFocusedWindow() ?? BrowserWindow.fromWebContents(e.sender))!, {
      type: 'warning', buttons: ['Close', 'Cancel'], defaultId: 1, cancelId: 1,
      message: `Close ${procs.length > 1 ? 'terminals' : 'terminal'}? ${procs.join(', ')} ${procs.length > 1 ? 'are' : 'is'} still running.`,
    });
    return response === 0;
  });
  ipcMain.on('pty:write', (_e, id: string, data: string) => {
    if (typeof data !== 'string') return;
    ptys.get(id)?.p.write(data);
    if (data.includes('\r')) ptys.get(id)?.onEnter?.();
  });
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => {
    if (cols > 0 && rows > 0) ptys.get(id)?.p.resize(Math.floor(cols), Math.floor(rows));
  });
  ipcMain.on('pty:kill', (_e, id: string) => killPty(id));
}

export function killAllPtys(): void {
  for (const { p } of ptys.values()) p.kill();
  ptys.clear();
}
