// This Mac employees: the commands a plan names, and the change journal (a git repo of file snapshots).
// No Electron here, so scripts/check-journal.mjs runs it under node.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** Every line of the plan's ```bash (sh, shell, zsh, console) blocks: the exact commands a GO allows once each. */
export function planCommands(plan: string): string[] {
  const out: string[] = [];
  for (const m of plan.matchAll(/```(?:bash|sh|shell|zsh|console)[^\n]*\n([\s\S]*?)```/g)) {
    let cont = '';
    for (const raw of m[1].split('\n')) {
      const line = cont + raw.trim().replace(/^\$\s+/, '');
      if (line.endsWith('\\')) { cont = line + '\n'; continue; } // a continued command is one command
      cont = '';
      if (line && !line.startsWith('#') && !out.includes(line)) out.push(line);
    }
  }
  return out;
}

/** One snapshot: `path` as it was just before an edit (`existed: false` means it did not exist yet). */
export interface Snap { path: string; commit: string; existed: boolean; at: number }

// The journal is private and local: no user identity, signing or hooks from David's git config.
const G = ['-c', 'user.name=MyIDE', '-c', 'user.email=journal@myide.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];
const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, ...G, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const stored = (journal: string, s: Snap) => execFileSync('git', ['-C', journal, 'show', `${s.commit}:files${s.path}`], { stdio: ['ignore', 'pipe', 'pipe'] });

/** True when a `.git` sits in the file's folder or any folder above it. */
export function inGitRepo(path: string): boolean {
  for (let d = dirname(resolve(path)); ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return true;
    if (d === dirname(d)) return false;
  }
}

/** Copies `file` into the journal and commits it, before it is edited. Null for a file inside a git repo (git already has it).
 *  ponytail: synchronous git in the main process, a few ms per edit; go async if journals get big. */
export function snapshot(journal: string, file: string, note: string): Snap | null {
  file = resolve(file);
  if (inGitRepo(file)) return null;
  if (!existsSync(join(journal, '.git'))) { mkdirSync(journal, { recursive: true, mode: 0o700 }); git(journal, 'init', '-q'); }
  chmodSync(journal, 0o700);
  const dst = join(journal, 'files', file);
  const existed = existsSync(file);
  if (existed) { mkdirSync(dirname(dst), { recursive: true }); copyFileSync(file, dst); } else rmSync(dst, { force: true });
  git(journal, 'add', '-A', '.');
  git(journal, 'commit', '-q', '--allow-empty', '-m', `${note}: ${file}`);
  return { path: file, commit: git(journal, 'rev-parse', 'HEAD'), existed, at: Date.now() };
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
    return out.split('\n').filter((l) => !/^(diff --git|index |new file|deleted file)/.test(l))
      .map((l) => (l.startsWith('--- ') ? '--- snapshot' : l.startsWith('+++ ') ? '+++ now' : l)).join('\n');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

/** Puts the file back as the snapshot had it (deletes it if it did not exist). The current state is snapshotted first, so a rollback can be undone. */
export function rollback(journal: string, s: Snap, note: string): Snap | null {
  const before = snapshot(journal, s.path, `${note}, before rollback`);
  if (s.existed) { mkdirSync(dirname(s.path), { recursive: true }); writeFileSync(s.path, stored(journal, s)); }
  else rmSync(s.path, { force: true });
  return before;
}
