// Checks src/main/mac.ts: plan commands, and the change journal's snapshot, diff and rollback, all in a temp dir.
// Usage: node scripts/check-journal.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffSnap, inGitRepo, planCommands, rollback, snapshot } from '../src/main/mac.ts';

assert.deepEqual(planCommands([
  'Plan', '```bash', 'ls -la', '# a comment', '$ touch notes.txt', '', 'touch notes.txt', 'brew upgrade \\', '  --greedy', '```',
  '```', 'not a command block', '```', '```sh', 'mkdir -p ~/x', '```',
].join('\n')), ['ls -la', 'touch notes.txt', 'brew upgrade \\\n--greedy', 'mkdir -p ~/x']);
assert.deepEqual(planCommands('no blocks here'), []);

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'myide-check-journal-')));
try {
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

  // Inside a git repo: not journaled.
  const repo = join(tmp, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  assert.equal(inGitRepo(join(repo, 'src', 'a.ts')), true);
  assert.equal(snapshot(journal, join(repo, 'src', 'a.ts'), 'x'), null);
  assert.equal(inGitRepo(rc), false);

  assert.ok(Number(execFileSync('git', ['-C', journal, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' })) >= 5);
} finally { rmSync(tmp, { recursive: true, force: true }); }
console.log('check-journal: ok');
