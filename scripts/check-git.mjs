// Checks src/main/git.ts: git output parsing and the editor's path check. Usage: node scripts/check-git.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { build } from 'esbuild';

// A temp MyIDE home with one project; git.ts is bundled with a do-nothing electron.
const home = realpathSync(mkdtempSync(join(tmpdir(), 'myide-check-git-')));
const proj = join(home, 'proj');
mkdirSync(join(proj, 'src'), { recursive: true });
mkdirSync(join(home, 'worktrees', 'p1', 'emp'), { recursive: true });
writeFileSync(join(home, 'config.json'), JSON.stringify({ projects: [{ id: 'p1', name: 'proj', path: proj, colour: '#000000' }] }));
symlinkSync('/etc', join(proj, 'escape'));
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
const { allowed, parseNameStatus, parseStatus, parseWorktrees } = createRequire(import.meta.url)(outfile);

// status --porcelain -z: index letter first, untracked ?, renames skip their old name.
assert.deepEqual(parseStatus(' M a.ts\0?? new.txt\0R  b2.ts\0b.ts\0A  c.ts\0MM d.ts\0UU e.ts\0'),
  { 'a.ts': 'M', 'new.txt': '?', 'b2.ts': 'R', 'c.ts': 'A', 'd.ts': 'M', 'e.ts': 'U' });
assert.deepEqual(parseStatus(''), {});
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
console.log('git check ok');
process.exit(0); // openers.ts leaves an mdfind lookup running
