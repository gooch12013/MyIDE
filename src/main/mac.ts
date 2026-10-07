// This Mac employees: the commands a plan names, and the change journal (a git repo of file snapshots).
// No Electron here, so scripts/check-journal.mjs and scripts/check-plan.mjs run it under node.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

// A heading or label line that starts the plan's Undo section ("## Undo", "**Undo**", "Undo:"); a later heading ends it.
const UNDO = /^\s*(?:#{1,6}\s*|\*\*\s*)?undo\b/i;
const HEADING = /^\s*(?:#{1,6}\s+\S|\*\*[^*]+\*\*:?\s*$)/;

/** The commands in the plan's first ```bash block outside its Undo section: the exact commands a GO allows once each.
 *  A line ending in \ continues the command; a heredoc (<<WORD, <<-WORD, <<'WORD') runs to its terminator, body kept as written. */
export function planCommands(plan: string): string[] {
  let undo = false;
  const kept = plan.split('\n').filter((l) => {
    if (UNDO.test(l)) undo = true;
    else if (HEADING.test(l)) undo = false;
    return !undo;
  }).join('\n');
  const block = /```bash[^\S\n]*\n([\s\S]*?)```/.exec(kept)?.[1];
  if (!block) return [];
  const out: string[] = [];
  const add = (c: string) => { if (c && !c.startsWith('#') && !out.includes(c)) out.push(c); };
  let cont = '';
  let here: { end: string; strip: boolean; text: string } | null = null;
  for (const raw of block.split('\n')) {
    if (here) {
      here.text += '\n' + raw;
      if ((here.strip ? raw.replace(/^\t+/, '') : raw).trim() === here.end) { add(here.text); here = null; }
      continue;
    }
    const line = cont + raw.trim().replace(/^\$\s+/, '');
    if (line.endsWith('\\')) { cont = line + '\n'; continue; } // a continued command is one command
    cont = '';
    const h = /<<(-?)\s*(['"]?)([\w.-]+)\2/.exec(line);
    if (h && !line.startsWith('#')) here = { end: h[3], strip: !!h[1], text: line };
    else add(line);
  }
  if (here) add(here.text); // unterminated: still one command
  return out;
}

/** One snapshot: `path` as it was just before an edit (`existed: false` means it did not exist yet), with its mode. */
export interface Snap { path: string; commit: string; existed: boolean; at: number; mode?: number }

// The journal is private and local: no user identity, signing, hooks, global ignores or attributes from David's git config.
const G = ['-c', 'user.name=MyIDE', '-c', 'user.email=journal@myide.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.excludesFile=/dev/null', '-c', 'core.attributesFile=/dev/null', '-c', 'core.autocrlf=false'];
const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, ...G, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
// cat-file: the raw blob, never a textconv or filter of it.
const stored = (journal: string, s: Snap) => execFileSync('git', ['-C', journal, 'cat-file', 'blob', `${s.commit}:files${s.path}`], { stdio: ['ignore', 'pipe', 'pipe'] });

/** True when a `.git` sits in the file's folder or any folder above it. */
export function inGitRepo(path: string): boolean {
  for (let d = dirname(resolve(path)); ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return true;
    if (d === dirname(d)) return false;
  }
}

/** True when git already tracks the file: an ignored or untracked file in a repo is not in git, so it is journaled. */
export function gitTracked(path: string): boolean {
  if (!inGitRepo(path)) return false;
  try { execFileSync('git', ['-C', dirname(path), 'ls-files', '--error-unmatch', '--', basename(path)], { stdio: 'ignore' }); return true; } catch { return false; }
}

/** Copies `file` into the journal and commits it, before it is edited. Null for a file git already tracks, unless `force`
 *  (a rollback always journals what it overwrites). Throws if the snapshot is not in the commit as the file's exact bytes.
 *  ponytail: synchronous git in the main process, a few ms per edit; go async if journals get big. */
export function snapshot(journal: string, file: string, note: string, force = false): Snap | null {
  file = resolve(file);
  if (!force && gitTracked(file)) return null;
  if (!existsSync(join(journal, '.git'))) { mkdirSync(journal, { recursive: true, mode: 0o700 }); git(journal, 'init', '-q'); }
  chmodSync(journal, 0o700);
  const dst = join(journal, 'files', file);
  const existed = existsSync(file);
  if (existed) { mkdirSync(dirname(dst), { recursive: true }); copyFileSync(file, dst); } else rmSync(dst, { force: true });
  git(journal, 'add', '-f', '-A', '.'); // -f: a snapshotted .gitignore (or a name the journal would ignore) is still stored
  git(journal, 'commit', '-q', '--allow-empty', '-m', `${note}: ${file}`);
  const commit = git(journal, 'rev-parse', 'HEAD');
  if (existed) {
    let blob = '';
    try { blob = git(journal, 'rev-parse', `${commit}:files${file}`); } catch { /* missing: thrown below */ }
    if (!blob || blob !== git(journal, 'hash-object', '--no-filters', dst)) throw new Error(`The change journal did not store ${file}`);
  }
  return { path: file, commit, existed, at: Date.now(), mode: existed ? statSync(file).mode & 0o7777 : undefined };
}

/** Unified diff from the snapshot to the file as it is now ('' when unchanged). */
export function diffSnap(journal: string, s: Snap): string {
  const tmp = mkdtempSync(join(tmpdir(), 'myide-journal-'));
  try {
    const before = s.existed ? join(tmp, 'before') : '/dev/null';
    if (s.existed) writeFileSync(before, stored(journal, s));
    const now = existsSync(s.path) ? s.path : '/dev/null';
    let out = '';
    try { execFileSync('git', ['diff', '--no-index', '--no-color', before, now], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { if ((e as { status?: number }).status !== 1) throw e; out = (e as { stdout: string }).stdout; }
    return out.split('\n').filter((l) => !/^(diff --git|index |new file|deleted file|old mode|new mode)/.test(l))
      .map((l) => (l.startsWith('--- ') ? '--- snapshot' : l.startsWith('+++ ') ? '+++ now' : l)).join('\n');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

/** Puts the file back as the snapshot had it, mode included (deletes it if it did not exist). The current state is
 *  snapshotted first, even inside a repo, and returned: rolling back to it undoes the rollback. */
export function rollback(journal: string, s: Snap, note: string): Snap {
  const before = snapshot(journal, s.path, `${note}, before rollback`, true)!;
  if (s.existed) {
    mkdirSync(dirname(s.path), { recursive: true });
    writeFileSync(s.path, stored(journal, s));
    if (s.mode !== undefined) chmodSync(s.path, s.mode);
  } else rmSync(s.path, { force: true });
  return before;
}
