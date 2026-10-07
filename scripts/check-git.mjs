// Checks src/main/git.ts: git output parsing and the editor's path check. Usage: node scripts/check-git.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { build } from 'esbuild';

// A temp MyIDE home with one project; git.ts is bundled with a do-nothing electron.
const home = realpathSync(mkdtempSync(join(tmpdir(), 'myide-check-git-')));
const proj = join(home, 'proj');
mkdirSync(join(proj, 'src'), { recursive: true });
mkdirSync(join(home, 'worktrees', 'p1', 'emp'), { recursive: true });
writeFileSync(join(home, 'config.json'), JSON.stringify({ projects: [{ id: 'p1', name: 'proj', path: proj, colour: '#000000' }, { id: 'p2', name: 'sub', path: join(home, 'repo', 'sub'), colour: '#000000' }] }));
symlinkSync('/etc', join(proj, 'escape'));
symlinkSync(join(home, 'nowhere', 'x'), join(proj, 'dangling'));
symlinkSync(join(home, 'config.json'), join(proj, 'cfg-link'));
process.env.MYIDE_HOME = home;
const electron = 'const n = () => {}; export const ipcMain = {}, dialog = {}, shell = {}, clipboard = {}, BrowserWindow = {}, Menu = {}; export const app = { whenReady: () => new Promise(n), on: n };';
const outfile = join(home, 'git.cjs');
await build({
  entryPoints: ['src/main/git.ts'], bundle: true, outfile, platform: 'node', format: 'cjs', logLevel: 'error',
  plugins: [{ name: 'stubs', setup(b) {
    b.onResolve({ filter: /^(electron|node-pty)$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: electron, loader: 'js' }));
  } }],
});
const { allowed, discard, merge, parseNameStatus, parseStatus, parseWorktrees, readText, tree, worktrees, writeText } = createRequire(import.meta.url)(outfile);

// status --porcelain -z: index letter first, untracked ?, renames skip their old name.
assert.deepEqual(parseStatus(' M a.ts\0?? new.txt\0R  b2.ts\0b.ts\0A  c.ts\0MM d.ts\0UU e.ts\0'),
  { 'a.ts': 'M', 'new.txt': '?', 'b2.ts': 'R', 'c.ts': 'A', 'd.ts': 'M', 'e.ts': 'U' });
assert.deepEqual(parseStatus(''), {});
assert.deepEqual(parseStatus(' M sub/a.ts\0?? sub/n.txt\0', 'sub/'), { 'a.ts': 'M', 'n.txt': '?' });
// worktree list --porcelain: main first; a detached worktree has no branch.
assert.deepEqual(parseWorktrees('worktree /r\nHEAD abc\nbranch refs/heads/main\n\nworktree /w/emp\nHEAD def\nbranch refs/heads/myide/emp\n\nworktree /w/x\nHEAD 123\ndetached\n'),
  [{ path: '/r', branch: 'main' }, { path: '/w/emp', branch: 'myide/emp' }, { path: '/w/x', branch: '' }]);
// diff --name-status -z.
assert.deepEqual(parseNameStatus('M\0src/a.ts\0R100\0old.ts\0new.ts\0A\0n.txt\0D\0gone.c\0'),
  [{ status: 'M', path: 'src/a.ts' }, { status: 'R', old: 'old.ts', path: 'new.ts' }, { status: 'A', path: 'n.txt' }, { status: 'D', path: 'gone.c' }]);
// Path check: inside a project or a MyIDE worktree, including files not created yet; nothing else.
assert.equal(allowed(join(proj, 'src', 'a.ts')), true);
assert.equal(allowed(join(proj, 'src', 'new-file.ts')), true);
assert.equal(allowed(join(home, 'worktrees', 'p1', 'emp', 'x.c')), true);
assert.equal(allowed(join(proj, '..', 'config.json')), false);
assert.equal(allowed(join(proj, 'escape', 'hosts')), false); // a symlink out of the project
assert.equal(allowed(`${proj}-other/x`), false);
assert.equal(allowed('src/a.ts'), false);
assert.equal(allowed(42), false);
assert.equal(allowed(join(proj, 'dangling')), false); // a dangling link: a write would land outside
assert.equal(allowed(join(proj, 'cfg-link')), false); // a link to a file outside

// Editor reads: 10 MB, NUL and UTF-8 limits; saves only over the hash the editor read.
const f = join(proj, 'src', 'a.ts');
writeFileSync(f, 'one');
const r0 = readText(f);
assert.equal(r0.text, 'one');
const h2 = writeText(f, 'two', r0.hash);
assert.equal(readFileSync(f, 'utf8'), 'two');
assert.throws(() => writeText(f, 'stale', r0.hash), /Changed on disk/);
assert.equal(readFileSync(f, 'utf8'), 'two');
writeFileSync(f, 'theirs');
assert.throws(() => writeText(f, 'mine', h2), /Changed on disk/);
assert.equal(writeText(f, 'mine', readText(f).hash).length, 64);
writeFileSync(join(proj, 'bin.dat'), Buffer.from([0x41, 0, 0x42]));
assert.throws(() => readText(join(proj, 'bin.dat')), /binary/);
writeFileSync(join(proj, 'latin.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
assert.throws(() => readText(join(proj, 'latin.txt')), /Not UTF-8/);
writeFileSync(join(proj, 'big.txt'), Buffer.alloc(10 * 1024 * 1024 + 1, 0x61));
assert.throws(() => readText(join(proj, 'big.txt')), /Over 10 MB/);

// A project that is a subfolder of its repository: tree paths and worktrees relative to it; merge refuses a detached HEAD;
// discard lists ignored files and keeps a worktree with changes.
const repo = join(home, 'repo');
const g = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=/dev/null', ...a], { encoding: 'utf8' });
mkdirSync(join(repo, 'sub'), { recursive: true });
writeFileSync(join(repo, 'top.txt'), 'x');
writeFileSync(join(repo, 'sub', 'a.txt'), 'a');
writeFileSync(join(repo, '.gitignore'), '*.log\n');
g(repo, 'init', '-q', '-b', 'main');
g(repo, 'add', '.');
g(repo, 'commit', '-q', '-m', 'one');
writeFileSync(join(repo, 'sub', 'a.txt'), 'changed');
writeFileSync(join(repo, 'sub', 'n.txt'), 'new');
writeFileSync(join(repo, 'top.txt'), 'changed too');
assert.deepEqual((await tree(join(repo, 'sub'))).files.sort(), [['a.txt', 'M'], ['n.txt', '?']]);
g(repo, 'worktree', 'add', '-q', join(home, 'worktrees', 'p2', 'emp'), '-b', 'myide/emp');
g(repo, 'worktree', 'add', '-q', join(home, 'elsewhere'), '-b', 'other');
assert.deepEqual(await worktrees('p2'), [{ path: join(repo, 'sub'), branch: 'main' }, { path: join(home, 'worktrees', 'p2', 'emp', 'sub'), branch: 'myide/emp' }]);
writeFileSync(join(home, 'worktrees', 'p2', 'emp', 'sub', 'run.log'), 'ignored');
let d = await discard('p2', 'myide/emp', false);
assert.equal(d.ok, false);
assert.ok(d.lost.includes('!! sub/run.log'), d.lost.join('|'));
writeFileSync(join(home, 'worktrees', 'p2', 'emp', 'sub', 'a.txt'), 'uncommitted');
await assert.rejects(discard('p2', 'myide/emp', true), /modified or untracked|contains/);
assert.ok(existsSync(join(home, 'worktrees', 'p2', 'emp', 'sub', 'a.txt')));
g(join(home, 'worktrees', 'p2', 'emp'), 'checkout', '-q', '--', '.');
d = await discard('p2', 'myide/emp', true);
assert.equal(d.ok, true);
assert.ok(!existsSync(join(home, 'worktrees', 'p2', 'emp')));
g(repo, 'stash', '-q', '-u');
g(repo, 'checkout', '-q', '--detach');
g(repo, 'branch', 'myide/x');
assert.match((await merge('p2', 'myide/x')).message, /detached HEAD/);
console.log('git check ok');
process.exit(0); // openers.ts leaves an mdfind lookup running
