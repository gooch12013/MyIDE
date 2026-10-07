// Checks src/main/forge.ts against a local fake Forgejo (node http): list, URL fallback with the 5 s
// timeout, comment/label/assignee/PR/create/assets, attribution strip on every body, the outbox
// replaying in order after an outage, drafts, quick-add and assign. Then one read-only anonymous list
// of gooch12013/MyIDE on GitHub. Never writes to a real forge; tokens go in a temp keychain.
// Usage: node scripts/check-forge.mjs   (add --offline-only to skip the GitHub read)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

const tmp = mkdtempSync(join(tmpdir(), 'myide-forge-'));
const home = join(tmp, 'home');
const kc = join(tmp, 'test.keychain-db');
const sec = (...a) => execFileSync('/usr/bin/security', a, { encoding: 'utf8' });
const searchList = sec('list-keychains', '-d', 'user').split('\n').map((l) => l.trim().replace(/^"|"$/g, '')).filter(Boolean);
sec('create-keychain', '-p', 'pw', kc);
sec('list-keychains', '-d', 'user', '-s', ...searchList); // create-keychain adds itself to the search list; take it back out
sec('unlock-keychain', '-p', 'pw', kc);
process.env.MYIDE_HOME = home;
process.env.MYIDE_KEYCHAIN = kc;

// ---- fake Forgejo ----
const log = [];
let down = false;
let nextIssue = 10, nextPr = 50, nextLabel = 1;
const labels = [{ id: 99, name: 'bug' }];
const issues = new Map([[1, { number: 1, title: 'Sync teardown', body: '', state: 'open', labels: [], assignees: [], user: { login: 'david' } }]]);
const withUrl = (i) => ({ ...i, html_url: `http://forge/o/r/issues/${i.number}`, updated_at: '2026-10-07T00:00:00Z', pull_request: null });
const fake = createServer((req, res) => {
  if (down) return req.socket.destroy();
  let raw = Buffer.alloc(0);
  req.on('data', (c) => { raw = Buffer.concat([raw, c]); });
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname.replace('/api/v1', '');
    const ct = req.headers['content-type'] ?? '';
    const body = ct.includes('json') ? JSON.parse(raw.toString() || 'null') : raw.toString('latin1');
    if (req.method !== 'GET') log.push({ m: req.method, path, body, ct });
    const json = (s, o) => res.writeHead(s, { 'content-type': 'application/json' }).end(JSON.stringify(o));
    const authed = req.headers.authorization === 'token fj-token-123';
    if (req.method !== 'GET' && !authed) return json(401, { message: 'token required' });
    let m;
    if (path === '/user') return authed ? json(200, { login: 'david' }) : json(401, { message: 'no' });
    if (path === '/repos/o/r' ) return json(200, { default_branch: 'main' });
    if (path === '/repos/o/r/issues' && req.method === 'GET') return json(200, [...issues.values()].map(withUrl));
    if (path === '/repos/o/r/issues' && req.method === 'POST') {
      const i = { number: nextIssue++, title: body.title, body: body.body, state: 'open', labels: (body.labels ?? []).map((id) => labels.find((l) => l.id === id)), assignees: [], user: { login: 'david' } };
      issues.set(i.number, i);
      return json(201, withUrl(i));
    }
    if ((m = /^\/repos\/o\/r\/issues\/(\d+)$/.exec(path))) {
      const i = issues.get(+m[1]);
      if (req.method === 'PATCH') { if (body.body !== undefined) i.body = body.body; if (body.assignees) i.assignees = body.assignees.map((login) => ({ login })); }
      return json(200, withUrl(i));
    }
    if ((m = /^\/repos\/o\/r\/issues\/(\d+)\/comments$/.exec(path))) return json(201, { id: 1, body: body.body });
    if ((m = /^\/repos\/o\/r\/issues\/(\d+)\/labels$/.exec(path))) return json(200, body.labels.map((id) => labels.find((l) => l.id === id)));
    if ((m = /^\/repos\/o\/r\/issues\/(\d+)\/assets$/.exec(path))) {
      assert.match(ct, /^multipart\/form-data/);
      assert.match(body, /name="attachment"; filename="shot.png"/);
      return json(201, { name: 'shot.png', browser_download_url: `http://forge/attachments/${m[1]}-shot` });
    }
    if (path === '/repos/o/r/labels' && req.method === 'GET') return json(200, labels);
    if (path === '/repos/o/r/labels') { const l = { id: nextLabel++, name: body.name }; labels.push(l); return json(201, l); }
    if (path === '/repos/o/r/pulls' && req.method === 'POST') {
      if (body.head === 'unpushed') return json(422, { message: 'head branch does not exist' });
      const n = nextPr++;
      return json(201, { number: n, html_url: `http://forge/o/r/pulls/${n}` });
    }
    if ((m = /^\/repos\/o\/r\/pulls\/(\d+)$/.exec(path))) return json(200, { number: +m[1], state: 'closed', merged: true });
    json(404, { message: `fake has no ${req.method} ${path}` });
  });
});
// Accepts and never answers: the timeout case.
const hang = createServer(() => {});
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const [livePort, hangPort] = [await listen(fake), await listen(hang)];
const LIVE = `http://127.0.0.1:${livePort}`, HANG = `http://127.0.0.1:${hangPort}`;

// ---- bundle forge.ts with electron, employees and pty stubbed ----
const ipc = new Map();
const opened = [];
const assigned = [];
globalThis.__stub = {
  electron: {
    app: { whenReady: () => new Promise(() => {}), getPath: () => tmp },
    dialog: {}, shell: { openExternal: async (u) => { opened.push(u); } },
    BrowserWindow: { getAllWindows: () => [] },
    ipcMain: { handle: (ch, fn) => ipc.set(ch, (...a) => fn({}, ...a)), on() {} },
  },
  employees: {
    assignIssue: async (o) => { assigned.push(o); return { id: 'e1', projectId: o.projectId, name: 'engineer-1', branch: 'myide/engineer-1', issue: o.issue }; },
  },
  pty: { spawnEnv: async () => ({ ...process.env }) },
};
const stubs = { electron: 'electron', './employees': 'employees', './pty': 'pty' };
const out = join(tmp, 'forge.cjs');
await build({
  entryPoints: ['src/main/forge.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'warning',
  plugins: [{
    name: 'stubs',
    setup(b) {
      b.onResolve({ filter: /^(electron|\.\/employees|\.\/pty)$/ }, (a) => ({ path: stubs[a.path], namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: `module.exports = globalThis.__stub[${JSON.stringify(a.path)}];`, loader: 'js' }));
    },
  }],
});
cpSync('build/bin', join(tmp, 'bin'), { recursive: true });
const forge = createRequire(import.meta.url)(out);

const projects = [
  { id: 'p1', name: 'Relay', path: tmp, colour: '#3cd2da', forge: { provider: 'forgejo', repo: 'o/r', urls: [HANG, LIVE] } },
  { id: 'gh', name: 'MyIDE', path: tmp, colour: '#ff7eb6', forge: { provider: 'github', repo: 'gooch12013/MyIDE', urls: [] } },
];
mkdirSync(home, { recursive: true });
writeFileSync(join(home, 'config.json'), JSON.stringify({ projects }));
const cache = (id = 'p1') => JSON.parse(readFileSync(join(home, 'projects', id, 'issues.json'), 'utf8'));

// registerForgeIpc schedules polls; keep them out of this run.
const [st, si] = [globalThis.setTimeout, globalThis.setInterval];
globalThis.setTimeout = globalThis.setInterval = () => 0;
forge.registerForgeIpc();
[globalThis.setTimeout, globalThis.setInterval] = [st, si];
const call = (ch, ...a) => ipc.get(ch)(...a);
assert.ok(existsSync(join(home, 'bin', 'issue')), 'issue script installed');

try {
  // Link validation.
  assert.throws(() => forge.cleanLink({ provider: 'gitlab', repo: 'a/b' }), /GitHub or Forgejo/);
  assert.throws(() => forge.cleanLink({ provider: 'forgejo', repo: 'a/b', urls: [] }), /at least one URL/);
  assert.throws(() => forge.cleanLink({ provider: 'forgejo', repo: 'a/b', urls: ['file:///etc'] }), /not an http/);
  assert.deepEqual(forge.cleanLink({ provider: 'github', repo: ' a/b.git ', urls: [] }), { provider: 'github', repo: 'a/b', urls: [] });

  // URL fallback: the first URL never answers, so the 5 s timeout moves on and the live one is remembered.
  let t = Date.now();
  await call('forge:refresh', 'p1', true);
  assert.ok(Date.now() - t >= 4900, 'waited for the timeout');
  let c = cache();
  assert.equal(c.via, LIVE);
  assert.equal(c.offline, false);
  assert.deepEqual(c.issues.map((i) => i.number), [1]);
  t = Date.now();
  await call('forge:refresh', 'p1', true);
  assert.ok(Date.now() - t < 1000, 'the remembered URL goes first');

  // No token: writes are refused with a pointer to Preferences, and nothing reaches the forge.
  const emp = { id: 'e1', projectId: 'p1', name: 'engineer-1', branch: 'myide/engineer-1', issue: { provider: 'forgejo', repo: 'o/r', number: 1, title: 'Sync teardown', url: '' } };
  await assert.rejects(forge.forgeAction(emp, 'comment', { body: 'hi' }), /No Forgejo token.*Preferences > Forges/);
  assert.equal(log.length, 0);
  await call('forge:set-token', 'forgejo', `127.0.0.1:${hangPort}`, 'fj-token-123');
  assert.equal((await call('forge:tokens')).rows.find((r) => r.provider === 'forgejo').has, true);
  assert.equal(await call('forge:test', 'forgejo', `127.0.0.1:${hangPort}`), 'Connected as david.');

  // Strip on every body; no close action.
  const signed = 'Fixed the teardown.\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n';
  assert.equal(await forge.forgeAction(emp, 'comment', { body: signed }), 'Commented on #1.');
  assert.deepEqual(log.at(-1), { m: 'POST', path: '/repos/o/r/issues/1/comments', body: { body: 'Fixed the teardown.' }, ct: 'application/json' });
  await assert.rejects(forge.forgeAction(emp, 'close', {}), /no close/);
  await assert.rejects(forge.forgeAction({ ...emp, issue: undefined }, 'comment', { body: 'x' }), /hold no issue/);

  // open_pr: stripped body gains "Closes #N"; the PR is linked and the next poll sees it merged.
  log.length = 0;
  assert.match(await forge.forgeAction(emp, 'open_pr', { title: 'Fix teardown', body: signed }), /^Opened PR #50/);
  assert.deepEqual(log.map((l) => l.path), ['/repos/o/r/pulls']);
  assert.deepEqual(log[0].body, { title: 'Fix teardown', body: 'Fixed the teardown.\n\nCloses #1', head: 'myide/engineer-1', base: 'main' });
  await forge.forgeAction(emp, 'open_pr', { title: 'Again', body: 'Fixes #1 properly' });
  assert.equal(log.at(-1).body.body, 'Fixes #1 properly');
  await assert.rejects(forge.forgeAction(emp, 'open_pr', { title: 'x', head: 'unpushed' }), /422.*head branch/);
  await call('forge:refresh', 'p1', true);
  assert.deepEqual(cache().prs['1'], { number: 51, url: 'http://forge/o/r/pulls/51', state: 'closed', merged: true });

  // Assign: A's assignIssue, then the start comment, assignee (the token owner) and "in progress" label.
  log.length = 0;
  assert.deepEqual(await call('forge:assign', { projectId: 'p1', number: 1, role: 'engineer', note: 'look at sync.ts' }), { employeeId: 'e1' });
  assert.deepEqual(assigned[0], { projectId: 'p1', issue: { provider: 'forgejo', repo: 'o/r', number: 1, title: 'Sync teardown', url: 'http://forge/o/r/issues/1' }, employeeId: undefined, role: 'engineer', note: 'look at sync.ts' });
  assert.deepEqual(log.map((l) => `${l.m} ${l.path}`), ['POST /repos/o/r/issues/1/comments', 'PATCH /repos/o/r/issues/1', 'POST /repos/o/r/labels', 'POST /repos/o/r/issues/1/labels']);
  assert.deepEqual(log[1].body, { assignees: ['david'] });
  assert.deepEqual(log[2].body, { name: 'in progress', color: '#ffb21a' });

  // Outage: both URLs fail, the cached list stays (stale), writes queue, the employee gets an answer at once.
  down = true;
  await call('forge:refresh', 'p1', true);
  c = cache();
  assert.equal(c.offline, true);
  assert.equal(c.issues.length, 1, 'cached list kept');
  log.length = 0;
  t = Date.now();
  assert.match(await forge.forgeAction(emp, 'comment', { body: 'first\nClaude-Session: https://claude.ai/x' }), /^Queued/);
  assert.match(await forge.forgeAction(emp, 'set_labels', { labels: ['bug', 'needs-review'] }), /^Queued/);
  assert.match(await forge.forgeAction(emp, 'comment', { body: 'second' }), /^Queued/);
  assert.ok(Date.now() - t < 1000, 'queued writes do not wait on the forge');
  assert.equal(cache().outbox.length, 3);
  down = false;
  await call('forge:refresh', 'p1', true);
  assert.deepEqual(log.map((l) => `${l.m} ${l.path}`), ['POST /repos/o/r/issues/1/comments', 'POST /repos/o/r/labels', 'PUT /repos/o/r/issues/1/labels', 'POST /repos/o/r/issues/1/comments']);
  assert.equal(log[0].body.body, 'first');
  assert.deepEqual(log[2].body.labels, [99, labels.find((l) => l.name === 'needs-review').id]);
  assert.equal(log[3].body.body, 'second');
  assert.equal(cache().outbox.length, 0);
  assert.equal(cache().offline, false);

  // Drafts never post; File does.
  log.length = 0;
  assert.match(await forge.forgeAction(emp, 'draft_issue', { title: 'Leak in pool', body: 'Seen in sync.\n\nGenerated with [Claude Code](https://x)' }), /Nothing was posted/);
  assert.equal(log.length, 0);
  const d = (await call('forge:issues', 'p1'))[0].drafts[0];
  assert.equal(d.body, 'Seen in sync.');
  const filed = await call('forge:file-draft', 'p1', d.id);
  assert.equal(filed.number, 10);
  assert.equal((await call('forge:issues', 'p1'))[0].drafts.length, 0);

  // New issue with an image: created, asset uploaded through the issue assets endpoint, body links it.
  log.length = 0;
  const img = { name: 'shot.png', type: 'image/png', data: new Uint8Array([137, 80, 78, 71]) };
  const r = await call('forge:create', { projectId: 'p1', title: 'Flicker', body: 'See image', labels: 'bug', images: [img] });
  assert.equal(r.number, 11);
  assert.deepEqual(log.map((l) => `${l.m} ${l.path}`), ['POST /repos/o/r/issues', 'POST /repos/o/r/issues/11/assets', 'PATCH /repos/o/r/issues/11']);
  assert.equal(log[2].body.body, 'See image\n\n![shot.png](http://forge/attachments/11-shot)');

  // Quick-add: project by name, case-insensitive, same path.
  assert.deepEqual(await forge.quickAddIssue('relay', 'From the shell'), { number: 12, url: 'http://forge/o/r/issues/12' });
  await assert.rejects(forge.quickAddIssue('nope', 'x'), /No project named nope/);

  // GitHub with images opens the prefilled new-issue page; nothing is posted.
  const gr = await call('forge:create', { projectId: 'gh', title: 'Crash', body: 'Trace\n\nClaude-Session: x', images: [img] });
  assert.equal(gr.opened, true);
  assert.equal(opened[0], 'https://github.com/gooch12013/MyIDE/issues/new?title=Crash&body=Trace');

  // GitHub, read-only and anonymous (the temp keychain has no GitHub token).
  if (!process.argv.includes('--offline-only')) {
    await call('forge:refresh', 'gh', true);
    const g = cache('gh');
    assert.equal(g.offline, false, g.error);
    assert.ok(Array.isArray(g.issues));
    console.log(`github: ${g.issues.length} issue(s) on gooch12013/MyIDE`);
  }
  console.log('forge ok');
} finally {
  fake.close(); hang.close(); hang.closeAllConnections();
  try { sec('delete-keychain', kc); } catch { /* gone */ }
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
