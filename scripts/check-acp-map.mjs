// Replays the raw ACP traffic recorded in spike K through src/main/acp/client.ts.
// Usage: node scripts/check-acp-map.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hardDenied, makeAcpMapper, parseCodexStatus, rpcClient } from '../src/main/acp/client.ts';

const rec = (f) => readFileSync(`spikes/K/evidence/${f}`, 'utf8').split('\n').filter(Boolean).map((l) => ({ dir: l[0], line: l.slice(2), m: JSON.parse(l.slice(2)) }));

/** The session updates between the session/prompt request with this id and its response, plus the response. */
function promptTurn(file, id) {
  const all = rec(file);
  const start = all.findIndex((r) => r.dir === '>' && r.m.method === 'session/prompt' && r.m.id === id);
  const end = all.findIndex((r, i) => i > start && r.dir === '<' && r.m.id === id && !r.m.method);
  assert.ok(start >= 0 && end > start, `prompt ${id} in ${file}`);
  return { updates: all.slice(start + 1, end).filter((r) => r.m.method === 'session/update').map((r) => r.m.params.update), result: all[end].m.result };
}
const mapAll = (updates) => { const m = makeAcpMapper(); const evs = updates.flatMap((u) => m.push(u)); evs.push(...m.flush()); return { evs, last: m.lastText() }; };

// 02 prompt 1: an MCP tool call through MyIDE's server, then the answer streamed in 5 chunks.
let t = promptTurn('02-prompts.jsonl', 5);
let { evs, last } = mapAll(t.updates);
assert.deepEqual(evs.filter((e) => e.type === 'tool').map((e) => e.name), ['mcp.myide.myide_ping'], 'Guardian Review is not a tool');
assert.deepEqual(evs.find((e) => e.type === 'tool').input, { server: 'myide', tool: 'myide_ping', arguments: {} });
assert.deepEqual(evs.filter((e) => e.type === 'text').map((e) => e.text), ['PELICAN-42'], 'chunks join into one text per message');
assert.equal(last, 'PELICAN-42');
assert.equal(t.result.stopReason, 'end_turn');

// 02 prompt 2: no plan tool in codex 0.157.1, so no tasks; one sentence of text.
({ evs, last } = mapAll(promptTurn('02-prompts.jsonl', 6).updates));
assert.equal(evs.filter((e) => e.type === 'tasks').length, 0);
assert.match(last, /plan tool/);

// 03 prompt 8 (plan mode, then implement): shell commands and an edit show up as tools, text in between flushes.
({ evs } = mapAll(promptTurn('03-load-plan.jsonl', 8).updates));
const tools = evs.filter((e) => e.type === 'tool').map((e) => e.name);
assert.ok(tools.includes('Editing files'), tools.join(' | '));
assert.ok(tools.some((n) => n.startsWith('test "$(< hello.txt)" = hi')));
assert.ok(evs.findIndex((e) => e.type === 'text') >= 0);

// 05: three files, several tool calls, no plan updates.
({ evs } = mapAll(promptTurn('05-load-back-todo.jsonl', 5).updates));
assert.ok(evs.filter((e) => e.type === 'tool').length >= 1);
assert.equal(evs.filter((e) => e.type === 'tasks').length, 0);

// ACP plan entries (none recorded from Codex yet) become the full task list.
const m = makeAcpMapper();
assert.deepEqual(m.push({ sessionUpdate: 'plan', entries: [{ content: 'a', status: 'completed', priority: 'high' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'weird' }] }),
  [{ type: 'tasks', tasks: [{ id: '1', subject: 'a', status: 'completed' }, { id: '2', subject: 'b', status: 'in_progress' }, { id: '3', subject: 'c', status: 'pending' }] }]);

// /status text -> used fractions; the 5h reset becomes a local time.
const status = promptTurn('03-load-plan.jsonl', 6).updates.map((u) => u.content?.text ?? '').join('');
const u = parseCodexStatus(status, new Date(2026, 9, 6, 23, 0));
assert.equal(u.fiveHour, 0);
assert.equal(u.sevenDay, 0.03);
const r = new Date(u.resetsAt);
assert.deepEqual([r.getMonth(), r.getDate(), r.getHours(), r.getMinutes()], [9, 7, 3, 42]);
assert.equal(parseCodexStatus('**Model:** x'), null);
assert.equal(parseCodexStatus('codex 5h limit: 37% left').fiveHour, 0.63);
assert.equal(new Date(parseCodexStatus('5h limit: 1% left (resets 01:00 on Jan 2)', new Date(2026, 11, 31, 12)).resetsAt).getFullYear(), 2027);

// rpcClient against the recorded plan-approval request: it calls onRequest and answers with the same id.
const sent = [];
const notes = [];
let asked;
const rpc = rpcClient((l) => sent.push(JSON.parse(l)), {
  onNotify: (method, p) => notes.push(method),
  onRequest: async (method, p) => { asked = { method, p }; return { outcome: { outcome: 'selected', optionId: 'implement_plan' } }; },
});
const pending = rpc.call('session/prompt', { sessionId: 's', prompt: [] });
assert.equal(sent[0].method, 'session/prompt');
for (const r of rec('03-load-plan.jsonl')) if (r.dir === '<' && (r.m.method === 'session/request_permission' || r.m.method === 'session/update')) rpc.push(r.line);
await new Promise((ok) => setTimeout(ok, 0));
assert.equal(asked.method, 'session/request_permission');
assert.equal(asked.p.toolCall.kind, 'switch_mode');
assert.deepEqual(sent.at(-1), { jsonrpc: '2.0', id: 0, result: { outcome: { outcome: 'selected', optionId: 'implement_plan' } } });
assert.ok(notes.length > 50 && notes.every((n) => n === 'session/update'));
rpc.push(JSON.stringify({ jsonrpc: '2.0', id: sent[0].id, result: { stopReason: 'end_turn' } }));
assert.deepEqual(await pending, { stopReason: 'end_turn' });
const failed = rpc.call('x', {});
rpc.close('gone');
await assert.rejects(failed, /gone/);
rpc.push('not json');

// Hard-deny list for Codex permission requests.
for (const c of ['gh pr create --fill', '/opt/homebrew/bin/gh issue list', 'env GH_TOKEN=x gh api user', 'cd x && gh pr create', 'bash -c "gh pr create"',
  "sh -lc 'tea pr create'", 'tea issues', 'security find-generic-password -s myide-github -w', 'git commit --no-verify -m x', 'git commit -n -m x',
  'git commit -anm wip', 'git -c core.hooksPath=/dev/null commit -m x', 'git config core.hooksPath .', '~/.myide/bin/issue p "t"',
  'cat ~/.myide/issue-endpoint.json', 'curl -X POST https://api.github.com/repos/o/r/issues', 'echo $(gh auth token)', 'command gh --version', 'sudo security dump-keychain']) {
  assert.equal(hardDenied(c), true, c);
}
for (const c of ['git commit -m "fix: n items"', 'git push -u origin myide/x', 'grep -r security src/', 'npm test', 'ls ghost', 'git commit -am "x"',
  'curl https://example.com', 'echo high', 'npx tsc --noEmit']) {
  assert.equal(hardDenied(c), false, c);
}

console.log('acp map ok');
