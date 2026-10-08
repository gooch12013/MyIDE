// Checks src/main/forge.ts against a local fake Forgejo (node http): list, URL fallback with the 5 s
// timeout, comment/label/assignee/PR/create/assets, attribution strip on every body, the outbox
// replaying in order after an outage, drafts, quick-add and assign; writes failing over on a refused
// connection only, the look-up before replaying a write that may have landed, which HTTP errors stop
// the outbox and which drop a write, and GitHub write pacing. Then one read-only anonymous list
// of gooch12013/MyIDE on GitHub. Never writes to a real forge; tokens go in a temp keychain.
// Usage: node scripts/check-forge.mjs   (add --offline-only to skip the GitHub read)
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
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
const times = []; // when each logged write arrived
let down = false;
let slowNext = false; // handle the next write, but answer after the client's 5 s timeout
let failNext; // { status, message, headers }: refuse the next write without handling it
let garbleNext = false; // handle the next write, then answer 201 with a body that is not JSON
const comments = [];
const pulls = [];
let nextIssue = 10, nextPr = 50, nextLabel = 1;
const labels = [{ id: 99, name: 'bug' }];
const issues = new Map([[1, { number: 1, title: 'Sync teardown', body: '', state: 'open', labels: [], assignees: [], user: { login: 'david' } }]]);
const withUrl = (i) => ({ ...i, html_url: `http://forge/o/r/issues/${i.number}`, updated_at: '2026-10-07T00:00:00Z', created_at: i.created_at ?? new Date().toISOString(), pull_request: null });
const fake = createServer((req, res) => {
  if (down) return req.socket.destroy();
  let raw = Buffer.alloc(0);
  req.on('data', (c) => { raw = Buffer.concat([raw, c]); });
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname.replace('/api/v1', '');
    const ct = req.headers['content-type'] ?? '';
    const body = ct.includes('json') ? JSON.parse(raw.toString() || 'null') : raw.toString('latin1');
    if (req.method !== 'GET' && failNext) {
      const f = failNext; failNext = undefined;
      return res.writeHead(f.status, { 'content-type': 'application/json', ...f.headers }).end(JSON.stringify({ message: f.message }));
    }
    if (req.method !== 'GET') { log.push({ m: req.method, path, body, ct }); times.push(Date.now()); }
    const slow = req.method !== 'GET' && slowNext;
    if (slow) slowNext = false;
    const garble = req.method !== 'GET' && garbleNext;
    if (garble) garbleNext = false;
    const json = (s, o) => (garble ? res.writeHead(201, { 'content-type': 'text/html' }).end('<html>proxy</html>') : slow ? setTimeout(() => res.writeHead(s, { 'content-type': 'application/json' }).end(JSON.stringify(o)), 6000)
      : res.writeHead(s, { 'content-type': 'application/json' }).end(JSON.stringify(o)));
    const authed = ['token fj-token-123', 'Bearer fj-token-123'].includes(req.headers.authorization);
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
    if ((m = /^\/repos\/o\/r\/issues\/(\d+)\/comments$/.exec(path))) {
      if (req.method === 'GET') return json(200, comments.filter((c) => c.issue === +m[1]));
      const c = { id: comments.length + 1, issue: +m[1], body: body.body, user: { login: 'david' }, created_at: new Date().toISOString() };
      comments.push(c);
      return json(201, c);
    }
    if ((m = /^\/repos\/o\/r\/issues\/(\d+)\/labels$/.exec(path))) return json(200, body.labels.map((id) => labels.find((l) => l.id === id)));
    if ((m = /^\/repos\/o\/r\/issues\/(\d+)\/assets$/.exec(path))) {
      assert.match(ct, /^multipart\/form-data/);
      assert.match(body, /name="attachment"; filename="shot.png"/);
      return json(201, { name: 'shot.png', browser_download_url: `http://forge/attachments/${m[1]}-shot` });
    }
    if (path === '/repos/o/r/labels' && req.method === 'GET') return json(200, labels);
    if (path === '/repos/o/r/labels') { const l = { id: nextLabel++, name: body.name }; labels.push(l); return json(201, l); }
    if (path === '/repos/o/r/pulls' && req.method === 'GET') return json(200, pulls);
    if (path === '/repos/o/r/pulls' && req.method === 'POST') {
      if (body.head === 'unpushed') return json(422, { message: 'head branch does not exist' });
      const n = nextPr++;
      const pr = { number: n, html_url: `http://forge/o/r/pulls/${n}`, state: 'open', head: { ref: body.head } };
      pulls.push(pr);
      return json(201, pr);
    }
    if (path === '/repos/o/r/pulls/77/reviews') return json(200, [{ user: { login: 'ana' }, state: 'COMMENT' }, { user: { login: 'ana' }, state: 'APPROVED' }, { user: { login: 'bo' }, state: 'REQUEST_CHANGES' }]);
    if (path === '/repos/o/r/commits/sha77/status') return json(200, { state: 'pending', statuses: [{ state: 'success' }, { state: 'success' }, { state: 'failure' }, { state: 'pending' }] });
    if (path === '/repos/o/r/pulls/77') return json(200, { ...pulls.find((x) => x.number === 77), mergeable: true });
    if ((m = /^\/repos\/o\/r\/pulls\/(\d+)$/.exec(path))) return json(200, { number: +m[1], state: 'closed', merged: true });
    json(404, { message: `fake has no ${req.method} ${path}` });
  });
});
// Accepts and never answers: the timeout case.
const hang = createServer(() => {});
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const [livePort, hangPort] = [await listen(fake), await listen(hang)];
const LIVE = `http://127.0.0.1:${livePort}`, HANG = `http://127.0.0.1:${hangPort}`;
// A port nothing listens on: connection refused, so nothing was sent.
const closed = createServer();
const refusedPort = await listen(closed);
await new Promise((r) => closed.close(r));
const REFUSED = `http://127.0.0.1:${refusedPort}`;

// ---- bundle forge.ts with electron, employees and pty stubbed ----
const ipc = new Map();
const opened = [];
const assigned = [];
const told = [];
globalThis.__stub = {
  electron: {
    app: { whenReady: () => new Promise(() => {}), getPath: () => tmp },
    dialog: {}, shell: { openExternal: async (u) => { opened.push(u); } },
    BrowserWindow: { getAllWindows: () => [] },
    ipcMain: { handle: (ch, fn) => ipc.set(ch, (...a) => fn({}, ...a)), on() {} },
  },
  employees: {
    assignIssue: async (o) => { assigned.push(o); return { id: 'e1', projectId: o.projectId, name: 'engineer-1', branch: 'myide/engineer-1', issue: o.issue }; },
    tell: (id, text) => told.push({ id, text }),
    // A lead with no issue, the engineer holding #1, and an employee of a project with no forge.
    listEmployees: (projectId) => [
      { id: 'lead1', projectId: 'p1', name: 'project-lead-1', branch: 'myide/project-lead-1', lead: true },
      { id: 'e1', projectId: 'p1', name: 'engineer-1', branch: 'myide/engineer-1', issue: { provider: 'forgejo', repo: 'o/r', number: 1, title: 'Sync teardown', url: '' } },
      { id: 'nf1', projectId: 'nf', name: 'writer-1', branch: 'myide/writer-1' },
    ].filter((e) => !projectId || e.projectId === projectId),
  },
  pty: { spawnEnv: async () => ({ ...process.env }) },
};
const stubs = { electron: 'electron', './employees': 'employees', './pty': 'pty' };
const out = join(tmp, 'forge.cjs');
await build({
  // forge.ts plus mcp.ts's startMcp, so the issue script can be run against the real /issue endpoint.
  stdin: { contents: "export * from './src/main/forge.ts'; export { startMcp, employeeMcpConfig } from './src/main/mcp.ts';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'warning',
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
  // Same fake forge behind other URL lists, and as a GitHub (Enterprise-style) host for the pacing check.
  { id: 'p3', name: 'Refused', path: tmp, colour: '#ffb21a', forge: { provider: 'forgejo', repo: 'o/r', urls: [REFUSED, LIVE] } },
  { id: 'p4', name: 'Hanging', path: tmp, colour: '#ffb21a', forge: { provider: 'forgejo', repo: 'o/r', urls: [HANG, LIVE] } },
  { id: 'ghf', name: 'Ghe', path: tmp, colour: '#ffb21a', forge: { provider: 'github', repo: 'o/r', urls: [LIVE] } },
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
  // Plain http only to this Mac or a private address.
  assert.throws(() => forge.cleanLink({ provider: 'forgejo', repo: 'a/b', urls: ['http://forge.example.com'] }), /use https/);
  assert.throws(() => forge.cleanLink({ provider: 'forgejo', repo: 'a/b', urls: ['http://172.32.0.1:3000'] }), /use https/);
  for (const u of ['http://127.0.0.1:3000', 'http://localhost', 'http://10.1.2.3', 'http://172.16.0.9', 'http://192.168.1.5:3000', 'https://forge.example.com']) {
    assert.equal(forge.cleanLink({ provider: 'forgejo', repo: 'a/b', urls: [u] }).urls[0], u);
  }
  // GitHub tokens are keyed by URL host: api.github.com is github.com, an Enterprise host its own.
  assert.equal(forge.tokenHost({ provider: 'github', repo: 'a/b', urls: [] }), 'github.com');
  assert.equal(forge.tokenHost({ provider: 'github', repo: 'a/b', urls: ['https://ghe.corp.example/api/v3'] }), 'ghe.corp.example');
  // Pacing: at least 1 s apart, fewer than 80 a minute and 500 an hour.
  assert.equal(forge.ghPace([], 10_000), 0);
  assert.equal(forge.ghPace([9_500], 10_000), 500);
  assert.equal(forge.ghPace(Array.from({ length: 78 }, (_, i) => 1_000_000 - 59_000 + i * 700), 1_000_000), 0);
  assert.equal(forge.ghPace(Array.from({ length: 79 }, (_, i) => 1_000_000 - 59_000 + i * 700), 1_000_000), -1);
  assert.equal(forge.ghPace(Array.from({ length: 499 }, (_, i) => 10_000_000 - 3_500_000 + i * 7000), 10_000_000), -1);
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

  // No token: the write waits in the outbox with a pointer to Preferences, and nothing reaches the forge.
  const emp = { id: 'e1', projectId: 'p1', name: 'engineer-1', branch: 'myide/engineer-1', issue: { provider: 'forgejo', repo: 'o/r', number: 1, title: 'Sync teardown', url: '' } };
  assert.match(await forge.forgeAction(emp, 'comment', { body: 'hi' }), /^Queued: comment #1: No Forgejo token.*Preferences > Forges/);
  assert.equal(log.length, 0);
  assert.equal(cache().outbox.length, 1);
  assert.match((await call('forge:issues', 'p1'))[0].blocked, /No Forgejo token/);
  await call('forge:set-token', 'forgejo', `127.0.0.1:${hangPort}`, 'fj-token-123');
  await call('forge:refresh', 'p1', true);
  assert.deepEqual(log.map((l) => l.body.body), ['hi'], 'the queued write went out once a token was there');
  assert.equal(cache().outbox.length, 0);
  assert.equal(cache().blocked, undefined);
  log.length = 0;
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
  await forge.forgeAction(emp, 'open_pr', { title: 'Part one', body: 'Refs #1, more to come' });
  assert.equal(log.at(-1).body.body, 'Refs #1, more to come', 'Refs leaves the issue open: no Closes added');

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
  // The issue script: the endpoint token goes in the request body (never argv), the reply is plain text.
  await forge.startMcp();
  const issueSh = (...a) => new Promise((resolve) => execFile(join(home, 'bin', 'issue'), a, { env: { ...process.env, MYIDE_HOME: home } },
    (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr })));
  const scriptText = readFileSync(join(home, 'bin', 'issue'), 'utf8');
  assert.doesNotMatch(scriptText, /Authorization|token=\$|\$token/, 'no token on a command line');
  let sh = await issueSh('Relay', 'From the "script" $HOME');
  assert.equal(sh.code, 0, sh.stderr);
  assert.match(sh.stdout, /^#13 http:\/\/forge\/o\/r\/issues\/13\n$/);
  assert.equal(issues.get(13).title, 'From the "script" $HOME');
  sh = await issueSh('nope', 'x');
  assert.equal(sh.code, 1);
  assert.match(sh.stderr, /No project named nope/);
  // The same script named todo posts to /todo (no to-do handler in this bundle, so MyIDE's refusal comes back as text).
  cpSync(join(home, 'bin', 'issue'), join(tmp, 'todo'));
  sh = await new Promise((resolve) => execFile(join(tmp, 'todo'), ['renew the key', '@sysadmin'], { env: { ...process.env, MYIDE_HOME: home } },
    (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr })));
  assert.equal(sh.code, 1);
  assert.match(sh.stderr, /to-dos not available/);
  const ep = JSON.parse(readFileSync(join(home, 'issue-endpoint.json'), 'utf8'));
  const bad = await fetch(ep.url, { method: 'POST', headers: { host: new URL(ep.url).host }, body: JSON.stringify({ project: 'Relay', title: 'x', token: 'wrong' }) });
  assert.equal(bad.status, 401);

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
  // ---- writes that may have landed, and which errors stop the outbox ----
  const at = (projectId) => ({ ...emp, projectId });
  // A refused connection sent nothing, so the write moves to the next URL.
  for (const id of ['p3', 'p4', 'ghf']) await call('forge:set-token', id === 'ghf' ? 'github' : 'forgejo', new URL(projects.find((x) => x.id === id).forge.urls[0]).host, 'fj-token-123');
  log.length = 0;
  assert.equal(await forge.forgeAction(at('p3'), 'comment', { body: 'via refused' }), 'Commented on #1.');
  assert.deepEqual(log.map((l) => l.body.body), ['via refused']);
  // A timeout may have landed: no failover for a write; it waits, marked, and the replay finds nothing so posts it.
  log.length = 0;
  t = Date.now();
  assert.match(await forge.forgeAction(at('p4'), 'comment', { body: 'after a hang' }), /^Queued/);
  assert.ok(Date.now() - t >= 4900);
  assert.equal(log.length, 0, 'not sent to the second URL');
  assert.equal(cache('p4').outbox[0].uncertain, true);
  await call('forge:refresh', 'p4', true); // the read fails over to the live URL, then the outbox replays there
  assert.deepEqual(log.map((l) => l.body.body), ['after a hang']);
  assert.equal(cache('p4').outbox.length, 0);
  // Landed but the answer came too late: the replay finds it and does not post again.
  for (const [action, args, check] of [
    ['comment', { body: 'slow comment' }, () => comments.filter((c) => c.body === 'slow comment').length],
    ['open_pr', { title: 'Slow PR', body: 'x', head: 'myide/slow' }, () => pulls.filter((p) => p.head.ref === 'myide/slow').length],
  ]) {
    slowNext = true;
    assert.match(await forge.forgeAction(emp, action, args), /^Queued/);
    assert.equal(cache().outbox[0].uncertain, true);
    await new Promise((r) => setTimeout(r, 1500)); // the slow answer is still on its way; the write already happened
    await call('forge:refresh', 'p1', true);
    assert.equal(cache().outbox.length, 0);
    assert.equal(check(), 1, `${action} posted once`);
  }
  slowNext = true;
  assert.deepEqual(await call('forge:create', { projectId: 'p1', title: 'Slow issue' }), { number: 0, url: '', queued: true, warning: undefined });
  await call('forge:refresh', 'p1', true);
  assert.equal([...issues.values()].filter((i) => i.title === 'Slow issue').length, 1, 'issue filed once');
  // A 5xx may have landed too: marked, looked up (not there), sent once.
  failNext = { status: 503, message: 'busy' };
  assert.match(await forge.forgeAction(emp, 'comment', { body: 'after a 503' }), /^Queued/);
  assert.equal(cache().outbox[0].uncertain, true);
  await call('forge:refresh', 'p1', true);
  assert.equal(comments.filter((c) => c.body === 'after a 503').length, 1);
  // 401, a 403 rate limit and 429 stop the outbox and keep it; the panel says why.
  for (const f of [{ status: 401, message: 'bad token' }, { status: 403, message: 'API rate limit exceeded', headers: { 'x-ratelimit-remaining': '0' } }, { status: 429, message: 'slow down' }]) {
    failNext = f;
    assert.match(await forge.forgeAction(emp, 'comment', { body: `kept ${f.status}` }), new RegExp(`^Queued: comment #1: .*${f.status}`));
    assert.equal(cache().outbox.length, 1);
    assert.match((await call('forge:issues', 'p1'))[0].blocked, new RegExp(String(f.status)));
    await call('forge:refresh', 'p1', true);
    assert.equal(cache().outbox.length, 0, 'sent on the next poll');
    assert.equal(comments.filter((c) => c.body === `kept ${f.status}`).length, 1);
  }
  // 404 and 422 drop the write; an employee that already got "Queued" hears about it on its next turn.
  down = true;
  await call('forge:refresh', 'p1', true);
  assert.match(await forge.forgeAction(emp, 'comment', { body: 'gone issue' }), /^Queued/);
  down = false;
  failNext = { status: 404, message: 'issue gone' };
  await call('forge:refresh', 'p1', true);
  assert.equal(cache().outbox.length, 0);
  assert.equal(told.length, 1);
  assert.equal(told[0].id, 'e1');
  assert.match(told[0].text, /dropped it.*404/);
  // A 2xx that is not JSON came after the forge took the write: blocked, marked uncertain, and the replay does not post twice.
  garbleNext = true;
  assert.match(await forge.forgeAction(emp, 'comment', { body: 'garbled answer' }), /^Queued/);
  assert.equal(cache().outbox[0].uncertain, true);
  await call('forge:refresh', 'p1', true);
  assert.equal(cache().outbox.length, 0);
  assert.equal(comments.filter((c) => c.body === 'garbled answer').length, 1, 'posted once');
  // Drop: by the id of the blocked write David saw, never whatever is at the front now.
  failNext = { status: 401, message: 'bad token' };
  assert.match(await forge.forgeAction(emp, 'comment', { body: 'to drop' }), /^Queued/);
  const snap = (await call('forge:issues', 'p1'))[0];
  assert.equal(snap.blockedOp, cache().outbox[0].id);
  await assert.rejects(async () => call('forge:drop-op', 'p1', 'not-an-op'), /already went out/);
  assert.equal(cache().outbox.length, 1);
  await call('forge:drop-op', 'p1', snap.blockedOp);
  assert.equal(cache().outbox.length, 0);
  assert.equal(comments.filter((c) => c.body === 'to drop').length, 0);
  // GitHub writes: one at a time, at least a second apart.
  log.length = times.length = 0;
  const gh = { ...emp, projectId: 'ghf' };
  await Promise.all([1, 2, 3].map((n) => forge.forgeAction(gh, 'comment', { body: `paced ${n}` })));
  assert.deepEqual(log.map((l) => l.body.body), ['paced 1', 'paced 2', 'paced 3']);
  for (let i = 1; i < 3; i++) assert.ok(times[i] - times[i - 1] >= 950, `GitHub writes ${times[i] - times[i - 1]} ms apart`);

  // ---- reads: any employee of a linked project, through MyIDE's MCP endpoint as a lead would call them ----
  pulls.push({ number: 77, title: 'Pool fix', body: 'Part of #1', html_url: 'http://forge/o/r/pulls/77', state: 'open', draft: false,
    user: { login: 'bo' }, head: { ref: 'myide/project-lead-1', sha: 'sha77' }, base: { ref: 'main' }, updated_at: '2026-10-07T01:00:00Z' });
  const mcpUrl = (id) => forge.employeeMcpConfig(id).mcpServers.myide.url;
  let rpcId = 0;
  const rpc = async (id, method, params) => (await (await fetch(mcpUrl(id), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) })).json()).result;
  const tool = async (id, action, args) => {
    const res = await rpc(id, 'tools/call', { name: 'forge', arguments: { action, args } });
    assert.ok(!res.isError, res.content[0].text);
    return JSON.parse(res.content[0].text);
  };
  // Offered to a lead holding no issue; not to an employee of a project without a forge.
  assert.ok((await rpc('lead1', 'tools/list')).tools.some((t) => t.name === 'forge' && t.inputSchema.properties.action.enum.includes('list_issues')));
  assert.ok(!(await rpc('nf1', 'tools/list')).tools.some((t) => t.name === 'forge'));
  log.length = 0;
  let li = await tool('lead1', 'list_issues', {});
  assert.ok(li.issues.length >= 5);
  const one = li.issues.find((i) => i.number === 1);
  assert.deepEqual(one, { number: 1, title: 'Sync teardown', labels: [], state: 'open', assignees: ['david'], employee: 'engineer-1', pr: 'merged', updated: '2026-10-07T00:00:00Z' });
  assert.deepEqual((await tool('lead1', 'list_issues', { labels: ['BUG'] })).issues.map((i) => i.number), [11]);
  assert.deepEqual((await tool('lead1', 'list_issues', { assignee: 'david' })).issues.map((i) => i.number), [1]);
  assert.ok(!(await tool('lead1', 'list_issues', { assignee: 'none' })).issues.some((i) => i.number === 1));
  assert.deepEqual((await tool('lead1', 'list_issues', { state: 'closed' })).issues, []);
  const gi = await tool('lead1', 'get_issue', { number: 1 });
  assert.equal(gi.title, 'Sync teardown');
  assert.equal(gi.employee, 'engineer-1');
  assert.ok(gi.comments.some((x) => x.body === 'Fixed the teardown.' && x.author === 'david'));
  assert.deepEqual(gi.prs.map((x) => `${x.number} ${x.state}`), [`${cache().prs['1'].number} merged`, '77 open']);
  const lp = await tool('lead1', 'list_prs', {});
  assert.deepEqual(lp.find((x) => x.number === 77), { number: 77, title: 'Pool fix', url: 'http://forge/o/r/pulls/77', author: 'bo', head: 'myide/project-lead-1', base: 'main',
    draft: false, updated: '2026-10-07T01:00:00Z', checks: '2 passed, 1 failed, 1 pending' });
  assert.deepEqual(await tool('lead1', 'pr_status', { number: 77 }), { number: 77, title: 'Pool fix', url: 'http://forge/o/r/pulls/77', state: 'open', merged: false, draft: false,
    mergeable: true, head: 'myide/project-lead-1', base: 'main', checks: '2 passed, 1 failed, 1 pending',
    reviews: [{ user: 'ana', state: 'APPROVED' }, { user: 'bo', state: 'REQUEST_CHANGES' }] });
  assert.deepEqual(log, [], 'reads never write');
  // Writes keep their rules: a lead holding no issue cannot comment; it can draft.
  const w = await rpc('lead1', 'tools/call', { name: 'forge', arguments: { action: 'comment', args: { body: 'x' } } });
  assert.ok(w.isError && /hold no issue/.test(w.content[0].text));
  assert.match((await rpc('lead1', 'tools/call', { name: 'forge', arguments: { action: 'get_issue', args: {} } })).content[0].text, /Give the issue number/);
  // Offline: get_issue falls back to the cached copy, without comments.
  down = true;
  const off = await tool('lead1', 'get_issue', { number: 1 });
  assert.equal(off.title, 'Sync teardown');
  assert.match(off.note, /cached copy/);
  down = false;

  console.log('forge ok');
} finally {
  fake.close(); hang.close(); hang.closeAllConnections();
  try { sec('delete-keychain', kc); } catch { /* gone */ }
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
