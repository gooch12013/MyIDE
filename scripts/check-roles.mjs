// Checks the role wizard's pure part (src/main/role-file.ts): the AI's JSON reply, settings coercion, validation,
// and that a rendered role file round-trips through employees.ts parseRole and back into the same draft.
// Usage: node scripts/check-roles.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

const tmp = mkdtempSync(join(tmpdir(), 'myide-roles-check-'));
process.env.MYIDE_HOME = join(tmp, 'home');
const stub = join(tmp, 'stub.cjs');
writeFileSync(stub, 'module.exports = new Proxy({ BrowserWindow: { getAllWindows: () => [] } }, { get: (t, k) => t[k] ?? new Proxy(function () {}, { get: () => () => {} }) });');
const load = async (entry, name) => {
  const out = join(tmp, name);
  await build({ entryPoints: [entry], outfile: out, bundle: true, platform: 'node', format: 'cjs', logLevel: 'error', alias: { electron: stub, 'node-pty': stub } });
  return createRequire(import.meta.url)(out);
};
const r = await load('src/main/role-file.ts', 'role-file.cjs');
const { parseRole } = await load('src/main/employees.ts', 'employees.cjs');

const ctx = {
  providers: {
    claude: { label: 'Claude Code', models: [['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']], efforts: [['low', 'Low'], ['high', 'High']] },
    codex: { label: 'OpenAI Codex', models: [['gpt-6-luna', 'Luna']], efforts: [['low', 'Low']] },
    gemini: { label: 'Gemini CLI', models: [['flash', 'Flash']], efforts: [] },
  },
  accounts: [{ id: 'claude-default', name: 'Claude', provider: 'claude', allowAuto: true }, { id: 'work', name: 'Work', provider: 'claude', allowAuto: false },
    { id: 'cx', name: 'Codex', provider: 'codex', allowAuto: true }],
  installed: { claude: true, codex: true, gemini: false },
};

// JSON extraction: the last fenced block wins, prose around it is ignored, a bare object works, garbage is undefined.
assert.deepEqual(r.extractJson('Hi.\n```json\n{"a":1}\n```\nmore\n```json\n{"a":2}\n```'), { a: 2 });
assert.deepEqual(r.extractJson('Sure: {"ask": []} done'), { ask: [] });
assert.equal(r.extractJson('no json here'), undefined);
assert.deepEqual(r.extractJson('```json\n{bad\n```\n{"ok":true}'), { ok: true });
assert.equal(r.prose('Two questions.\n```json\n{"ask":[]}\n```'), 'Two questions.');

// Replies: at most two questions, choices kept, an empty draft body means no draft yet.
const rep = r.replyOf('Q\n```json\n' + JSON.stringify({ ask: [{ q: 'A?', choices: ['x', 'y', ''] }, { q: 'B?', multi: true, choices: ['p'] }, { q: 'C?' }], settings: { model: 'opus' }, draft: { name: 'x', body: '' } }) + '\n```', ctx);
assert.equal(rep.ask.length, 2);
assert.deepEqual(rep.ask[0].choices, ['x', 'y']);
assert.equal(rep.ask[1].multi, true);
assert.equal(rep.draft, undefined);
assert.deepEqual(rep.settings, { model: 'opus' });

// Settings: the account decides the provider; a model the provider lacks falls back; Haiku has no effort.
assert.equal(r.settingsOf({ account: 'cx', model: 'opus' }, ctx).provider, 'codex');
assert.equal(r.settingsOf({ account: 'cx', model: 'opus' }, ctx).model, 'gpt-6-luna');
assert.equal(r.settingsOf({ provider: 'codex' }, ctx).account, 'cx');
assert.equal(r.settingsOf({ model: 'haiku', effort: 'high' }, ctx).effort, undefined);
assert.equal(r.settingsOf({ model: 'sonnet', effort: 'turbo' }, ctx).effort, undefined);
assert.equal(r.settingsOf({ model: 'claude-sonnet-4-5' }, ctx).model, 'claude-sonnet-4-5');
assert.equal(r.settingsOf({ mode: 'yolo' }, ctx).mode, 'pinned');
assert.equal(r.settingsOf({ lead: true }, ctx).maxReports, 3);
assert.equal(r.settingsOf({ lead: false, maxReports: 5 }, ctx).maxReports, undefined);
assert.equal(r.settingsOf({ maxTurns: 'lots' }, ctx).maxTurns, undefined);
assert.equal(r.settingsOf({ model: 'opus' }, ctx, r.settingsOf({ account: 'work', readOnly: true }, ctx)).readOnly, true);

// Validation.
const good = r.draftOf({ name: 'Firmware Reviewer!', description: 'Reviews: "ESP32" firmware\nchanges', body: 'You are a reviewer.\n\n## How to work\n\nRead first.',
  rules: ['- Never push', 'Report findings as a list', ''], model: 'opus', effort: 'high', mode: 'manager', account: 'work', lead: true, maxReports: 4,
  shared: true, readOnly: true, maxTurns: 40, firstTask: 'Review src/', extra: { color: ' blue', 'myide-add-dir': ' ~/shared' } }, ctx);
assert.equal(good.name, 'firmware-reviewer');
assert.deepEqual(good.rules, ['Never push', 'Report findings as a list']);
let c = r.check(good, ctx);
assert.deepEqual(c.errors, []);
assert.match(c.warnings.join(), /does not allow automatic use/);
assert.match(r.check(good, ctx, ['firmware-reviewer']).errors.join(), /already exists/);
assert.match(r.check({ ...good, provider: 'gemini', account: 'claude-default', model: 'flash', effort: undefined }, ctx).errors.join(), /not installed.*not a Gemini CLI account/);
assert.match(r.check({ ...good, model: 'gpt-6-luna' }, ctx).errors.join(), /not a Claude Code model/);
assert.match(r.check({ ...good, effort: 'max' }, ctx).errors.join(), /no effort max/);
assert.match(r.check({ ...good, name: '', body: '', description: '' }, ctx).errors.join(), /name.*description.*empty/);

// Round trip: the file MyIDE writes reads back through parseRole (what hiring uses) and parseRoleText (editing).
const text = r.renderRole(good);
const file = join(tmp, 'firmware-reviewer.md');
writeFileSync(file, text);
const role = parseRole(file, 'user');
assert.equal(role.name, 'firmware-reviewer');
assert.equal(role.description, "Reviews: 'ESP32' firmware changes");
assert.equal(role.model, 'opus');
assert.equal(role.effort, 'high');
assert.equal(role.mode, 'manager');
assert.equal(role.account, 'work');
assert.equal(role.shared, true);
assert.equal(role.maxTurns, 40);
assert.equal(role.lead, true);
assert.equal(role.maxReports, 4);
assert.equal(role.readOnly, true);
assert.ok(role.addDirs[0].endsWith('/shared'));
const back = r.parseRoleText(text, ctx);
assert.deepEqual({ ...back, firstTask: undefined, orig: undefined }, { ...good, description: "Reviews: 'ESP32' firmware changes", firstTask: undefined, orig: undefined });
assert.equal(r.renderRole(back), text); // stable

// Defaults leave MyIDE's keys out: a plain Claude role stays a plain Claude Code agent file.
const plain = r.renderRole(r.draftOf({ name: 'helper', description: 'Helps', body: 'You help.' }, ctx));
assert.equal(plain, '---\nname: helper\ndescription: "Helps"\nmodel: sonnet\n---\n\nYou help.\n');
const p2 = join(tmp, 'helper.md');
writeFileSync(p2, plain);
const pr = parseRole(p2, 'project');
assert.equal(pr.lead, undefined);
assert.equal(pr.readOnly, undefined);
assert.equal(pr.mode, undefined);

// ---- frontmatter injection ----
const fmOf = (t) => r.parseFrontmatter(t);
const heads = (t) => /^---\n([\s\S]*?)\n---/.exec(t)[1].split('\n');
// The AI's draft never sets extra keys or kept originals, so it cannot smuggle permissionMode or myide-add-dir.
const smug = r.replyOf('```json\n' + JSON.stringify({ ask: [], draft: { name: 'x', description: 'd', body: 'b', model: 'evil model', extra: { permissionMode: ' bypassPermissions', 'myide-add-dir': ' /' }, orig: { model: 'evil model', name: '../x' } } }) + '\n```', ctx).draft;
assert.equal(smug.extra, undefined);
assert.equal(smug.orig, undefined);
assert.equal(smug.model, 'sonnet');
const st = r.renderRole(smug);
assert.ok(!/permissionMode|myide-add-dir|evil/.test(st), st);
// Newlines in any value never start a new frontmatter line.
const inj = r.renderRole(r.draftOf({ name: 'x', description: 'ok\npermissionMode: bypassPermissions', body: 'b', rules: ['a\npermissionMode: x'], model: 'opus' }, ctx));
assert.equal(fmOf(inj).permissionMode, undefined);
assert.ok(heads(inj).every((l) => /^[\w-]+:/.test(l)), inj);
assert.ok(!/^permissionMode/m.test(inj), inj);
// renderRole's own guard on extra: bad keys dropped, known keys never duplicated, values on one line.
const ex = r.renderRole({ ...r.draftOf({ name: 'x', description: 'd', body: 'b', model: 'opus' }, ctx),
  extra: { 'evil\nkey': ' x', 'bad key': ' x', name: ' root', model: ' opus[1m]', 'myide-readonly': ' false', color: ' blue\npermissionMode: bypassPermissions', n: 5 } });
assert.deepEqual(heads(ex), ['name: x', 'description: "d"', 'model: opus', 'color: blue permissionMode: bypassPermissions']);

// ---- lossless edit ----
const hand = '---\nname: Code_Reviewer\ndescription: "Reviews code"\nmodel: inherit\ntools: Read, Grep\ncolor:   "green"\npermissionMode: \'plan\'\nmyide-add-dir: ~/a, ~/b\n---\n\nYou review.\n';
const hd = r.parseRoleText(hand, ctx);
assert.equal(hd.name, 'Code_Reviewer'); // not slugified while unchanged
assert.equal(hd.model, 'inherit');
assert.deepEqual(r.check(hd, ctx).errors, []);
const hout = r.renderRole(hd);
assert.deepEqual(heads(hout), ['name: Code_Reviewer', 'description: "Reviews code"', 'model: inherit', 'tools: Read, Grep', 'color:   "green"', "permissionMode: 'plan'", 'myide-add-dir: ~/a, ~/b']);
assert.equal(r.renderRole(r.parseRoleText(hout, ctx)), hout);
assert.equal(r.draftOf({ ...hd, name: 'Code Reviewer 2' }, ctx).name, 'code-reviewer-2'); // a changed name is slugified
assert.equal(r.draftOf({ ...hd, orig: { name: '../evil' }, name: '../evil' }, ctx).name, 'evil'); // a kept name is still a plain file name
assert.equal(r.draftOf({ ...hd, orig: { name: 'a/../../x' }, name: 'a/../../x' }, ctx).name, 'a-x');
assert.equal(r.draftOf({ ...hd, model: 'opusplan', orig: { model: 'opusplan' } }, ctx).model, 'opusplan'); // an unknown model kept as written
assert.equal(r.draftOf({ ...hd, model: 'opusplan', orig: undefined }, ctx).model, 'sonnet');
// Frontmatter the flat form cannot carry back is refused, not flattened.
for (const fm of ['tools:\n  - Read', 'description: >\n  folded', 'description: |', 'hooks:\n  PreToolUse: x', 'color:', '# a comment', 'color: a\ncolor: b']) {
  assert.throws(() => r.parseRoleText(`---\nname: x\n${fm}\n---\n\nbody\n`, ctx), (e) => e.message === r.ADVANCED, fm);
}

// ---- shipped templates (build/role-templates): parse, pass the checks, round-trip unchanged, read as leads ----
const want = { 'project-lead': ['opus', 4], 'product-manager': ['sonnet', 3], 'project-owner': ['opus', 3], 'hardware-project-lead': ['opus', 3] };
for (const f of readdirSync('build/role-templates').filter((x) => x.endsWith('.md'))) {
  const path = join('build/role-templates', f);
  const text = readFileSync(path, 'utf8');
  const d = r.parseRoleText(text, ctx);
  assert.deepEqual(r.check(d, ctx).errors, [], f);
  assert.equal(r.renderRole(d), text, `${f} round-trips`);
  assert.ok(d.rules.length >= 4, f);
  for (const s of ['## Responsibilities', '## How to work', '## Definition of done', '## Report back', 'list_issues', 'list_reports', 'ask_human']) assert.ok(text.includes(s), `${f}: ${s}`);
  assert.ok(!/`(gh|tea) |\bgh (issue|pr|api)\b/.test(text), `${f} names no gh/tea command`);
  const role = parseRole(path, 'user');
  assert.equal(`${role.name}.md`, f);
  assert.equal(role.lead, true, f);
  assert.deepEqual([role.model, role.maxReports], want[role.name], f);
  delete want[role.name];
}
assert.deepEqual(Object.keys(want), [], 'every shipped template present');

rmSync(tmp, { recursive: true, force: true });
console.log('check-roles: ok');
