import { ipcMain, type WebContents } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { installedIdes, openAtLine } from './openers';
import { listProjects } from './projects';
import { STATE_DIR } from './store';
import { branchExists, git } from './worktree';

const run = promisify(execFile);

// Files the editor and tree may touch: inside a registered project or a MyIDE worktree.
const real = (p: string): string => { try { return realpathSync(p); } catch { return resolve(p); } };
export function allowed(path: unknown): path is string {
  if (typeof path !== 'string' || !path.startsWith('/')) return false;
  // A file that does not exist yet is checked through its folder.
  const p = existsSync(path) ? real(path) : join(real(dirname(path)), basename(path));
  return [...listProjects().map((x) => x.path), join(STATE_DIR, 'worktrees')].map(real).some((root) => p === root || p.startsWith(root + sep));
}
function check(path: unknown): string {
  if (!allowed(path)) throw new Error('Not inside a project or a MyIDE worktree');
  return path;
}
const project = (id: string) => {
  const p = listProjects().find((x) => x.id === id);
  if (!p) throw new Error('No such project');
  return p;
};
const employeeBranch = (b: unknown): string => {
  if (typeof b !== 'string' || !/^myide\/[\w.-]+$/.test(b)) throw new Error('Not a MyIDE employee branch');
  return b;
};

/** Porcelain v1 -z: one status letter per path (index side first, `?` untracked). */
export function parseStatus(z: string): Record<string, string> {
  const out: Record<string, string> = {};
  const parts = z.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    const xy = e.slice(0, 2);
    out[e.slice(3)] = xy === '??' ? '?' : xy === '!!' ? 'I' : (xy[0] !== ' ' ? xy[0] : xy[1]);
    if (xy[0] === 'R' || xy[0] === 'C') i++; // the next entry is the old name
  }
  return out;
}

/** `git worktree list --porcelain` to [{ path, branch }]; the first is the main checkout. */
export function parseWorktrees(text: string): { path: string; branch: string }[] {
  return text.split('\n\n').filter(Boolean).map((block) => {
    const get = (k: string) => block.split('\n').find((l) => l.startsWith(k + ' '))?.slice(k.length + 1) ?? '';
    return { path: get('worktree'), branch: get('branch').replace(/^refs\/heads\//, '') };
  }).filter((w) => w.path);
}

const SKIP = new Set(['.git', 'node_modules', 'dist', 'out']);
// ponytail: a folder that is not a git repository is listed by walking it, capped at 20000 files.
function walk(root: string, dir = '', out: string[] = []): string[] {
  for (const d of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (out.length >= 20000) break;
    if (SKIP.has(d.name)) continue;
    const rel = dir ? `${dir}/${d.name}` : d.name;
    if (d.isDirectory()) walk(root, rel, out); else out.push(rel);
  }
  return out;
}

/** Every file under `root` (tracked plus untracked, not ignored) with its status letter. */
async function tree(root: string): Promise<{ git: boolean; files: [string, string][] }> {
  check(root);
  try {
    const big = { maxBuffer: 64 * 1024 * 1024 };
    const [ls, st] = await Promise.all([
      run('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], big),
      // --no-optional-locks: status must not write the index, or the watcher would refresh forever.
      run('git', ['-C', root, '--no-optional-locks', 'status', '--porcelain', '-z', '--untracked-files=all'], big),
    ]);
    const status = parseStatus(st.stdout);
    const files = [...new Set(ls.stdout.split('\0').filter(Boolean))].map((f): [string, string] => [f, status[f] ?? '']);
    return { git: true, files };
  } catch {
    return { git: false, files: walk(root).map((f): [string, string] => [f, '']) };
  }
}

async function worktrees(projectId: string) {
  const p = project(projectId);
  try { return parseWorktrees(await git(p.path, 'worktree', 'list', '--porcelain')); } catch { return [{ path: p.path, branch: '' }]; }
}

/** Files changed on the branch since it left the main checkout's current branch. */
async function diffFiles(projectId: string, branch: string) {
  const p = project(projectId);
  const base = await git(p.path, 'rev-parse', '--abbrev-ref', 'HEAD');
  return { base, files: parseNameStatus(await git(p.path, 'diff', '--name-status', '-z', `${base}...${employeeBranch(branch)}`)) };
}

/** `git diff --name-status -z`: renames and copies carry the old path first. */
export function parseNameStatus(z: string): { status: string; path: string; old?: string }[] {
  const parts = z.split('\0').filter(Boolean);
  const files: { status: string; path: string; old?: string }[] = [];
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i][0];
    if (status === 'R' || status === 'C') { files.push({ status, old: parts[i + 1], path: parts[i + 2] }); i += 2; }
    else files.push({ status, path: parts[++i] });
  }
  return files;
}

const show = (repo: string, rev: string, path: string): Promise<string> =>
  run('git', ['-C', repo, 'show', `${rev}:${path}`], { maxBuffer: 64 * 1024 * 1024 }).then((r) => r.stdout, () => '');

async function diffFile(projectId: string, branch: string, path: string, old?: string) {
  const p = project(projectId);
  const base = await git(p.path, 'rev-parse', '--abbrev-ref', 'HEAD');
  const mb = await git(p.path, 'merge-base', base, employeeBranch(branch));
  const [original, modified] = await Promise.all([show(p.path, mb, old ?? path), show(p.path, branch, path)]);
  return { original, modified };
}

/** Tracked changes in the main checkout (untracked files do not block a merge). */
const dirty = async (repo: string): Promise<string[]> =>
  (await git(repo, 'status', '--porcelain', '--untracked-files=no')).split('\n').filter(Boolean);

async function merge(projectId: string, branch: string): Promise<{ ok: boolean; message: string; conflicts?: string[] }> {
  const p = project(projectId);
  employeeBranch(branch);
  const changes = await dirty(p.path);
  if (changes.length) return { ok: false, message: `The main checkout has uncommitted changes (${changes.length} file${changes.length === 1 ? '' : 's'}). Commit or stash them first.` };
  try {
    const out = await git(p.path, 'merge', '--no-ff', '--no-edit', branch);
    return { ok: true, message: out.split('\n').pop() || 'Merged.' };
  } catch (e) {
    const conflicts = (await git(p.path, 'diff', '--name-only', '--diff-filter=U').catch(() => '')).split('\n').filter(Boolean);
    if (conflicts.length) return { ok: false, conflicts, message: `Merge stopped with ${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'}; they are left in the main checkout for you to resolve.` };
    return { ok: false, message: (e as Error).message };
  }
}

/** Deletes the branch; refuses while a worktree still has it checked out unless `removeWorktree`. */
async function discard(projectId: string, branch: string, removeWorktree: boolean): Promise<{ ok: boolean; worktree?: string; message: string }> {
  const p = project(projectId);
  employeeBranch(branch);
  const wt = (await worktrees(projectId)).find((w) => w.branch === branch);
  if (wt && !removeWorktree) return { ok: false, worktree: wt.path, message: `${branch} is checked out in ${wt.path}.` };
  if (wt) await git(p.path, 'worktree', 'remove', wt.path); // git refuses if it has uncommitted changes
  if (await branchExists(p.path, branch)) await git(p.path, 'branch', '-D', branch);
  return { ok: true, message: `Deleted ${branch}.` };
}

/** The file's text and the checkout it belongs to (for relative paths and the worktree label). */
async function read(path: unknown) {
  const file = check(path);
  const text = readFileSync(file, 'utf8');
  const info = await git(dirname(file), 'rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD').catch(() => '');
  const [root = '', branch = ''] = info.split('\n');
  return { text, root: root || dirname(file), branch };
}

// fs.watch per tree panel; changes are sent to the panel debounced.
const watchers = new Map<number, FSWatcher>();
let nextWatch = 1;
function watchTree(sender: WebContents, root: unknown): number {
  const id = nextWatch++;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const w = watch(check(root), { recursive: true }, (_ev, name) => {
    if (name && /(^|\/)(node_modules|\.git\/objects)(\/|$)/.test(String(name))) return;
    clearTimeout(timer);
    timer = setTimeout(() => { if (!sender.isDestroyed()) sender.send('git:changed', id); }, 300);
  });
  w.on('error', () => {});
  watchers.set(id, w);
  sender.once('destroyed', () => unwatch(id));
  return id;
}
const unwatch = (id: number): void => { watchers.get(id)?.close(); watchers.delete(id); };

export function registerGitIpc(): void {
  ipcMain.handle('code:read', (_e, path: unknown) => read(path));
  ipcMain.handle('code:write', (_e, path: unknown, text: unknown) => {
    if (typeof text !== 'string') throw new Error('Nothing to save');
    writeFileSync(check(path), text);
  });
  ipcMain.handle('code:ides', () => installedIdes());
  ipcMain.handle('code:open-in', (_e, ide: string, path: unknown, line: number) => openAtLine(ide, check(path), line));
  ipcMain.handle('git:tree', (_e, root: unknown) => tree(root as string));
  ipcMain.handle('git:watch', (e, root: unknown) => watchTree(e.sender, root));
  ipcMain.on('git:unwatch', (_e, id: number) => unwatch(id));
  ipcMain.handle('git:worktrees', (_e, projectId: string) => worktrees(projectId));
  ipcMain.handle('git:branches', async (_e, projectId: string) =>
    (await git(project(projectId).path, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/myide/')).split('\n').filter(Boolean));
  ipcMain.handle('git:diff', (_e, projectId: string, branch: string) => diffFiles(projectId, branch));
  ipcMain.handle('git:diff-file', (_e, projectId: string, branch: string, path: string, old?: string) => diffFile(projectId, branch, path, old));
  ipcMain.handle('git:merge', (_e, projectId: string, branch: string) => merge(projectId, branch));
  ipcMain.handle('git:discard', (_e, projectId: string, branch: string, removeWorktree: boolean) => discard(projectId, branch, !!removeWorktree));
}
