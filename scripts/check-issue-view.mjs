// Checks the Issues panel's filter, sort, group and custom order (src/renderer/issue-view.ts).
// Usage: node scripts/check-issue-view.mjs
import assert from 'node:assert/strict';
import { arrange, DEFAULT_VIEW, fullOrder, grouped, matches, move, viewOf } from '../src/renderer/issue-view.ts';

const row = (n, o = {}) => ({
  key: String(n), number: n, title: `Issue ${n}`, body: '', labels: [], state: 'open', assignees: [],
  updatedAt: `2026-10-0${n}T00:00:00Z`, createdAt: `2026-09-0${n}T00:00:00Z`, comments: 0, pr: false, ...o,
});
const rows = [
  row(1, { labels: ['bug'], comments: 5, assignees: ['david'], me: 'david' }),
  row(2, { labels: ['ui', 'bug'], title: 'Leaderboard flickers', body: 'when a match ends', employee: 'Ada' }),
  row(3, { state: 'closed', pr: true, updatedAt: '2026-10-09T00:00:00Z' }),
  row(4, { assignees: ['sam'], comments: 2, title: 'alpha first' }),
];
const keys = (rs) => rs.map((r) => r.key).join();
const V = (o) => ({ ...DEFAULT_VIEW, ...o });

// viewOf: junk falls back, good fields survive.
assert.deepEqual(viewOf(null), DEFAULT_VIEW);
assert.deepEqual(viewOf({ sort: 'nope', state: 'closed', labels: ['a', 3], desc: false }), V({ state: 'closed', labels: ['a'], desc: false }));

// Filters.
assert.equal(keys(arrange(V({}), rows)), '4,2,1'); // open only, updated desc
assert.equal(keys(arrange(V({ state: 'closed' }), rows)), '3');
assert.equal(keys(arrange(V({ state: 'all' }), rows)), '3,4,2,1');
assert.equal(keys(arrange(V({ labels: ['bug'] }), rows)), '2,1');
assert.equal(keys(arrange(V({ labels: ['bug', 'ui'] }), rows)), '2');
assert.equal(keys(arrange(V({ who: 'me' }), rows)), '1');
assert.equal(keys(arrange(V({ who: 'none' }), rows)), '2');
assert.equal(keys(arrange(V({ who: 'sam' }), rows)), '4');
assert.equal(keys(arrange(V({ emp: 'yes' }), rows)), '2');
assert.equal(keys(arrange(V({ emp: 'no' }), rows)), '4,1');
assert.equal(keys(arrange(V({ state: 'all', pr: 'yes' }), rows)), '3');
assert.equal(keys(arrange(V({ q: 'MATCH' }), rows)), '2'); // body
assert.equal(keys(arrange(V({ q: 'ui' }), rows)), '2'); // label
assert.equal(keys(arrange(V({ q: '#4' }), rows)), '4'); // number
assert.equal(matches(V({ q: '4' }), rows[3]), true);
assert.equal(matches(V({ who: 'me' }), { ...rows[0], me: undefined }), false); // no token: nobody is "me"

// Sorts.
assert.equal(keys(arrange(V({ sort: 'number', desc: false }), rows)), '1,2,4');
assert.equal(keys(arrange(V({ sort: 'comments' }), rows)), '1,4,2');
assert.equal(keys(arrange(V({ sort: 'title', desc: false }), rows)), '4,1,2');
assert.equal(keys(arrange(V({ sort: 'created', desc: true }), rows)), '4,2,1');

// Custom order: unseen rows go on top, newest first; move before/after.
assert.deepEqual(fullOrder(['1', '2'], rows), ['4', '3', '1', '2']);
assert.deepEqual(move(['a', 'b', 'c', 'd'], 'd', 'b'), ['a', 'd', 'b', 'c']);
assert.deepEqual(move(['a', 'b', 'c', 'd'], 'a', 'c', true), ['b', 'c', 'a', 'd']);
assert.deepEqual(move(['a', 'b'], 'a', 'zz'), ['a', 'b']);
assert.equal(keys(arrange(V({ sort: 'custom', order: ['1', '4', '2'] }), rows)), '1,4,2');
assert.equal(keys(arrange(V({ sort: 'custom', desc: false, order: ['1', '4', '2'] }), rows)), '1,4,2'); // desc ignored
assert.equal(keys(arrange(V({ sort: 'custom', order: ['1', '2'] }), rows)), '4,1,2'); // #4 is new: top

// Groups keep the arranged order inside each.
assert.deepEqual(grouped(V({ group: 'label', state: 'all' }), rows).map((g) => `${g.name}:${keys(g.rows)}`), ['No label:3,4', 'ui:2', 'bug:1']);
assert.deepEqual(grouped(V({ group: 'state', state: 'all', sort: 'number', desc: false }), rows).map((g) => `${g.name}:${keys(g.rows)}`), ['open:1,2,4', 'closed:3']);
assert.deepEqual(grouped(V({ group: 'employee' }), rows).map((g) => `${g.name}:${keys(g.rows)}`), ['No employee:4,1', 'Ada:2']);
assert.deepEqual(grouped(V({ group: 'none' }), rows).map((g) => g.name), ['']);

// Employee status: filter by it, group by it most urgent first, no employee last.
const st = [row(1, { employee: 'A', status: 'done' }), row(2), row(3, { employee: 'B', status: 'needs-you' }), row(4, { employee: 'C', status: 'working' }), row(5, { employee: 'D', status: 'needs-you' })];
assert.deepEqual(grouped(V({ group: 'status', sort: 'number', desc: false }), st).map((g) => `${g.name}:${keys(g.rows)}`), ['needs-you:3,5', 'working:4', 'done:1', 'none:2']);
assert.equal(keys(arrange(V({ emp: 'needs-you', sort: 'number', desc: false }), st)), '3,5');
assert.equal(keys(arrange(V({ emp: 'yes', sort: 'number', desc: false }), st)), '1,3,4,5');
assert.equal(viewOf({ emp: 'paused', group: 'status' }).emp, 'paused');
assert.equal(viewOf({ emp: 'bogus' }).emp, '');

console.log('check-issue-view: ok');
