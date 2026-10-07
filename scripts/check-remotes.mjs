// Checks src/main/remotes.ts: git remote URL parsing, ssh alias resolution (stubbed `ssh -G`), the provider
// decision with a stubbed fetch, and detect() on temp repos (real git, stubbed network). Offline; no tokens.
// Usage: node scripts/check-remotes.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

const tmp = mkdtempSync(join(tmpdir(), 'myide-remotes-'));
const outfile = join(tmp, 'remotes.cjs');
await build({ entryPoints: ['src/main/remotes.ts'], bundle: true, outfile, platform: 'node', format: 'cjs', logLevel: 'error' });
const { parseRemotes, parseRemoteUrl, sshHost, decide, detect } = createRequire(import.meta.url)(outfile);

// ---- URL parsing ----
const P = (u) => parseRemoteUrl(u);
assert.deepEqual(P('https://github.com/gooch12013/MyIDE.git'), { host: 'github.com', repo: 'gooch12013/MyIDE', ssh: false, base: 'https://github.com' });
assert.deepEqual(P('https://github.com/gooch12013/MyIDE'), { host: 'github.com', repo: 'gooch12013/MyIDE', ssh: false, base: 'https://github.com' });
assert.deepEqual(P('https://GitHub.COM/Owner/Repo.GIT/'), { host: 'github.com', repo: 'Owner/Repo', ssh: false, base: 'https://github.com' });
assert.deepEqual(P('https://user:secret@git.example.dev:3000/o/r.git'), { host: 'git.example.dev', repo: 'o/r', ssh: false, base: 'https://git.example.dev:3000' });
assert.deepEqual(P('http://127.0.0.1:8080/o/r'), { host: '127.0.0.1', repo: 'o/r', ssh: false, base: 'http://127.0.0.1:8080' });
assert.deepEqual(P('git@github.com:gooch12013/MyIDE.git'), { host: 'github.com', repo: 'gooch12013/MyIDE', ssh: true, base: undefined });
assert.deepEqual(P('gh-work:acme/widgets'), { host: 'gh-work', repo: 'acme/widgets', ssh: true, base: undefined });
assert.deepEqual(P('ssh://git@git.example.dev:2222/owner/repo.git'), { host: 'git.example.dev', repo: 'owner/repo', ssh: true, base: undefined });
assert.deepEqual(P('ssh://git@Git.Example.dev/owner/repo/'), { host: 'git.example.dev', repo: 'owner/repo', ssh: true, base: undefined });
assert.deepEqual(P('git+ssh://git@host/o/r.git'), { host: 'host', repo: 'o/r', ssh: true, base: undefined });
assert.deepEqual(P('https://gitlab.com/group/sub/repo.git'), { host: 'gitlab.com', repo: 'group/sub/repo', ssh: false, base: 'https://gitlab.com' });
assert.deepEqual(P('git@gitlab.com:group/sub/repo.git'), { host: 'gitlab.com', repo: 'group/sub/repo', ssh: true, base: undefined });
for (const bad of ['/srv/git/repo.git', 'file:///srv/repo.git', '../other', 'https://github.com/justowner', 'git@host:', 'C:\\repo', '', 'https://']) assert.equal(P(bad), null, bad);

// ---- git remote -v ----
assert.deepEqual(parseRemotes('origin\thttps://github.com/a/b.git (fetch)\norigin\thttps://github.com/a/b.git (push)\nfork\tgit@github.com:me/b.git (fetch)\nfork\tgit@github.com:me/b.git (push)\n'),
  [{ name: 'origin', url: 'https://github.com/a/b.git' }, { name: 'fork', url: 'git@github.com:me/b.git' }]);
assert.deepEqual(parseRemotes(''), []);

// ---- ssh -G alias resolution (stubbed, never connects) ----
const sshG = (map) => async (bin, args) => {
  assert.equal(bin, 'ssh');
  assert.equal(args[0], '-G');
  return `user git\nhostname ${map[args[1]] ?? args[1]}\nport 22\n`;
};
assert.equal(await sshHost('gh-work', sshG({ 'gh-work': 'GitHub.com' })), 'github.com');
assert.equal(await sshHost('plain.example.dev', sshG({})), 'plain.example.dev');
assert.equal(await sshHost('-oProxyCommand=x', async () => { throw new Error('must not run'); }), '-oProxyCommand=x');
assert.equal(await sshHost('broken', async () => { throw new Error('no ssh'); }), 'broken');

// ---- provider decision (stubbed fetch; records that no credentials go out) ----
const seen = [];
const fake = (table) => async (url, init) => {
  seen.push({ url, init });
  const r = table[new URL(url).host];
  if (!r) { const e = new TypeError('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; }
  return new Response(r.body ?? '', { status: r.status, headers: r.headers ?? {} });
};
const net = fake({
  'git.example.dev': { status: 200, body: '{"version":"11.0.1+gitea-1.22.0"}' },
  'locked.example.dev': { status: 403, body: 'Forbidden' },
  'login.example.dev': { status: 302, headers: { location: '/user/login' } },
  'cf.example.dev': { status: 302, headers: { location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login/cf.example.dev' } },
  'gitlab.com': { status: 404, body: '{"error":"404 Not Found"}' },
  'html.example.dev': { status: 200, body: '<html>' },
  'other.example.dev': { status: 302, headers: { location: '/somewhere' } },
  'ghe.github.com': { status: 200, body: '{}' },
  'git.example.dev:3000': { status: 200, body: '{"version":"12.0.0"}' },
});
const D = async (host, base = `https://${host}`) => { const d = await decide(host, base, net); return [d.provider, !!d.signIn, d.base]; };
assert.deepEqual(await D('github.com'), ['github', false, 'https://github.com']);
assert.deepEqual(await D('ssh.github.com'), ['github', false, 'https://github.com']);
assert.equal(seen.length, 0, 'github.com is decided without a request');
assert.deepEqual(await D('git.example.dev'), ['forgejo', false, 'https://git.example.dev']);
assert.equal(seen[0].url, 'https://git.example.dev/api/v1/version');
assert.deepEqual(await D('locked.example.dev'), ['forgejo', true, 'https://locked.example.dev']);
assert.deepEqual(await D('login.example.dev'), ['forgejo', true, 'https://login.example.dev']);
assert.deepEqual(await D('cf.example.dev'), ['forgejo', true, 'https://cf.example.dev']);
assert.deepEqual(await D('gitlab.com'), [null, false, 'https://gitlab.com']);
assert.match((await decide('gitlab.com', 'https://gitlab.com', net)).note, /GitLab: not supported yet/);
assert.deepEqual(await D('html.example.dev'), [null, false, 'https://html.example.dev']);
assert.deepEqual(await D('other.example.dev'), [null, false, 'https://other.example.dev']);
assert.deepEqual(await D('nowhere.example.dev'), [null, false, 'https://nowhere.example.dev']);
assert.deepEqual(await D('ghe.github.com'), ['github', false, 'https://ghe.github.com/api/v3']);
assert.deepEqual(await D('gone.github.com'), [null, false, 'https://gone.github.com']);
for (const { init } of seen) {
  assert.equal(init.redirect, 'manual');
  assert.ok(!Object.keys(init.headers).some((k) => /authorization|cookie/i.test(k)), 'no credentials during detection');
}

// ---- detect() on temp repos: real git, stubbed ssh and network ----
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
const exec = async (bin, args) => (bin === 'ssh' ? sshG({ 'gh-work': 'github.com', 'myforge': 'git.example.dev' })(bin, args) : execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
const repo = join(tmp, 'repo');
execFileSync('git', ['init', '-q', repo]);
assert.deepEqual(await detect(repo, exec, net), { found: [], reason: 'This repository has no remotes.' });
assert.match((await detect(tmp, exec, net)).reason, /not a git repository/);
git(repo, 'remote', 'add', 'alt', 'myforge:team/app.git');
git(repo, 'remote', 'add', 'origin', 'git@gh-work:Acme/Widgets.git');
git(repo, 'remote', 'add', 'lab', 'https://gitlab.com/group/sub/repo.git');
git(repo, 'remote', 'add', 'disk', '/srv/git/x.git');
const d = await detect(repo, exec, net);
assert.deepEqual(d.found.map((f) => [f.remote, f.host, f.repo, f.provider]),
  [['origin', 'github.com', 'Acme/Widgets', 'github'], ['alt', 'git.example.dev', 'team/app', 'forgejo'], ['lab', 'gitlab.com', 'group/sub/repo', null]]);
assert.deepEqual(d.found[0].link, { provider: 'github', repo: 'Acme/Widgets', urls: [] });
assert.deepEqual(d.found[1].link, { provider: 'forgejo', repo: 'team/app', urls: ['https://git.example.dev'] });
assert.equal(d.found[2].link, undefined);
const ported = join(tmp, 'ported');
execFileSync('git', ['init', '-q', ported]);
git(ported, 'remote', 'add', 'origin', 'https://git.example.dev:3000/Team/Port.git/');
const dp = (await detect(ported, exec, net)).found[0];
assert.deepEqual([dp.host, dp.repo, dp.note, dp.link], ['git.example.dev:3000', 'Team/Port', 'Forgejo 12.0.0', { provider: 'forgejo', repo: 'Team/Port', urls: ['https://git.example.dev:3000'] }]);
const only = join(tmp, 'disk-only');
execFileSync('git', ['init', '-q', only]);
git(only, 'remote', 'add', 'origin', '/srv/git/x.git');
assert.deepEqual(await detect(only, exec, net), { found: [], reason: 'No remote URL points at a forge MyIDE can read.' });

console.log('check-remotes: ok');
