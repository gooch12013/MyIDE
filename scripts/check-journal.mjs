// Checks the change journal in src/main/mac.ts (snapshot, diff, rollback, ignored and excluded paths, modes), all in a
// temp dir with a temp global git config (scripts/check-plan.mjs covers plan commands).
// Usage: node scripts/check-journal.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chmodSync } from 'node:fs';
import { diffSnap, gitTracked, inGitRepo, rollback, snapshot } from '../src/main/mac.ts';

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'myide-check-journal-')));
try {
  // A global git config like David's: a global ignore file that ignores *.log and .env, and an attributes file.
  writeFileSync(join(tmp, 'ignore'), '*.log\n.env\n');
  writeFileSync(join(tmp, 'attrs'), '* text eol=crlf\n');
  writeFileSync(join(tmp, 'gitconfig'), `[core]\n\texcludesFile = ${join(tmp, 'ignore')}\n\tattributesFile = ${join(tmp, 'attrs')}\n`);
  process.env.GIT_CONFIG_GLOBAL = join(tmp, 'gitconfig');
  const journal = join(tmp, 'journal');
  const home = join(tmp, 'home');
  mkdirSync(home);
  const rc = join(home, '.zshrc');
  writeFileSync(rc, 'export A=1\n');

  // An edit outside any repo: snapshot, change, diff, roll back.
  const s = snapshot(journal, rc, 'todo t1');
  assert.ok(s && s.existed && /^[0-9a-f]{40}$/.test(s.commit));
  assert.equal((statSync(journal).mode & 0o777), 0o700);
  assert.equal(readFileSync(join(journal, 'files', rc), 'utf8'), 'export A=1\n');
  writeFileSync(rc, 'export A=2\n');
  const d = diffSnap(journal, s);
  assert.match(d, /^-export A=1$/m);
  assert.match(d, /^\+export A=2$/m);
  assert.match(d, /^--- snapshot$/m);
  assert.equal(diffSnap(journal, snapshot(journal, rc, 'same')), '');
  const undo = rollback(journal, s, 'todo t1');
  assert.equal(readFileSync(rc, 'utf8'), 'export A=1\n');
  rollback(journal, undo, 'undo'); // the rollback itself was journaled
  assert.equal(readFileSync(rc, 'utf8'), 'export A=2\n');

  // A file that did not exist: rollback deletes it.
  const fresh = join(home, 'new.conf');
  const n = snapshot(journal, fresh, 'todo t2');
  assert.equal(n.existed, false);
  writeFileSync(fresh, 'x\n');
  assert.match(diffSnap(journal, n), /^\+x$/m);
  rollback(journal, n, 'todo t2');
  assert.equal(existsSync(fresh), false);

  // Globally ignored names, a .gitignore that ignores everything beside it, and a global eol attribute: stored byte for byte.
  for (const [name, text] of [['debug.log', 'a\nb\n'], ['.env', 'K=v\n'], ['.gitignore', '*\n'], ['after.conf', 'c\n']]) {
    const f = join(home, name);
    writeFileSync(f, text);
    const x = snapshot(journal, f, 'ignored');
    assert.ok(x, name);
    assert.equal(execFileSync('git', ['-C', journal, 'cat-file', 'blob', `${x.commit}:files${f}`], { encoding: 'utf8' }), text, name);
    writeFileSync(f, 'changed\n');
    rollback(journal, x, 'r');
    assert.equal(readFileSync(f, 'utf8'), text, name);
  }

  // Mode: a 0600 secret rolled back is 0600 again, and the pre-rollback snapshot undoes the rollback (mode too).
  const key = join(home, 'secret.conf');
  writeFileSync(key, 'one\n');
  chmodSync(key, 0o600);
  const k = snapshot(journal, key, 'mode');
  assert.equal(k.mode, 0o600);
  writeFileSync(key, 'two\n');
  chmodSync(key, 0o644);
  const back = rollback(journal, k, 'mode');
  assert.equal(statSync(key).mode & 0o777, 0o600);
  assert.equal(back.mode, 0o644);
  rollback(journal, back, 'undo');
  assert.equal(readFileSync(key, 'utf8'), 'two\n');
  assert.equal(statSync(key).mode & 0o777, 0o644);

  // Inside a git repo: a tracked file is git's, so it is not journaled; an untracked or ignored one is.
  const repo = join(tmp, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, '.gitignore'), 'secret.txt\n');
  for (const f of ['src/a.ts', 'secret.txt', 'notes.md']) writeFileSync(join(repo, f), 'x\n');
  execFileSync('git', ['-C', repo, 'add', 'src/a.ts']);
  assert.equal(inGitRepo(join(repo, 'src', 'a.ts')), true);
  assert.equal(gitTracked(join(repo, 'src', 'a.ts')), true);
  assert.equal(snapshot(journal, join(repo, 'src', 'a.ts'), 'x'), null);
  assert.ok(snapshot(journal, join(repo, 'secret.txt'), 'ignored in repo'));
  assert.ok(snapshot(journal, join(repo, 'notes.md'), 'untracked in repo'));
  assert.ok(snapshot(journal, join(repo, 'new.md'), 'new in repo'));
  // A rollback of a file that is now tracked still journals what it overwrites.
  const t0 = snapshot(journal, join(repo, 'notes.md'), 'before tracking');
  execFileSync('git', ['-C', repo, 'add', 'notes.md']);
  writeFileSync(join(repo, 'notes.md'), 'y\n');
  const pre = rollback(journal, t0, 'tracked now');
  assert.ok(pre && pre.existed);
  assert.equal(readFileSync(join(repo, 'notes.md'), 'utf8'), 'x\n');
  assert.equal(inGitRepo(rc), false);

  assert.ok(Number(execFileSync('git', ['-C', journal, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' })) >= 5);
} finally { rmSync(tmp, { recursive: true, force: true }); }
console.log('check-journal: ok');
