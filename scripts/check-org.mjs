// Checks the org rules in src/main/org.ts: queue order, caps, auto picks, ceiling, roll-up.
// Usage: node scripts/check-org.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { aboveCeiling, autoPick, pickStarts, rollup, slowedCap } from '../src/main/org.ts';

const table = JSON.parse(readFileSync(new URL('../build/providers.json', import.meta.url), 'utf8'));
const lists = (p) => [table[p].models.map(([m]) => m), table[p].efforts.map(([e]) => e)];
const above = (want, ceiling, p = 'claude') => aboveCeiling(want, ceiling, ...lists(p));

const lim = (o = {}) => ({
  global: 3, perProject: 2, account: () => 9, maxReports: () => 2, paused: () => false, priority: () => 0, ...o,
});
const q = (id, projectId = 'a', more = {}) => ({ id, projectId, accountId: 'claude-default', queuedAt: Number(id.replace(/\D/g, '')) || 0, ...more });

// Oldest first, global and per-project caps hold.
assert.deepEqual(pickStarts([q('a3'), q('a1'), q('a2')], [], lim()), ['a1', 'a2']);
assert.deepEqual(pickStarts([q('a1'), q('b2', 'b'), q('a3'), q('b4', 'b')], [], lim()), ['a1', 'b2', 'a3']);
assert.deepEqual(pickStarts([q('a1')], [q('x', 'b'), q('y', 'b'), q('z', 'c')], lim()), []);
// Priority: the higher project goes first even when it queued later.
assert.deepEqual(pickStarts([q('a1'), q('b2', 'b')], [q('x', 'c'), q('y', 'c')], lim({ priority: (p) => (p === 'b' ? 5 : 0) })), ['b2']);
// Paused project: skipped, and the next project gets the slot.
assert.deepEqual(pickStarts([q('a1'), q('b2', 'b')], [], lim({ paused: (p) => p === 'a' })), ['b2']);
// A lead's max reports: the third report waits, but other work still starts.
const r = (id) => q(id, 'a', { parentId: 'lead' });
assert.deepEqual(pickStarts([r('r3'), q('b4', 'b')], [r('r1'), r('r2')], lim({ global: 5, perProject: 5 })), ['b4']);
assert.deepEqual(pickStarts([r('r1'), r('r2'), r('r3')], [], lim({ global: 5, perProject: 5 })), ['r1', 'r2']);
// A full account is skipped, not waited on: the codex employee behind it still starts.
const codex = q('c2', 'b', { accountId: 'codex' });
assert.deepEqual(pickStarts([q('a1'), codex], [q('x', 'c')], lim({ account: (a) => (a === 'codex' ? 2 : 1) })), ['c2']);
// Usage above 80%: cap minus one, never below one.
assert.equal(slowedCap(3, { fiveHour: 0.79 }), 3);
assert.equal(slowedCap(3, { fiveHour: 0.8 }), 2);
assert.equal(slowedCap(1, { fiveHour: 0.95 }), 1);
assert.equal(slowedCap(3), 3);

// Auto mode keyword table.
assert.equal(autoPick('Fix the lint errors in parse.ts').model, 'haiku');
assert.equal(autoPick('Rename fooBar to fooBaz').model, 'haiku');
assert.equal(autoPick('Formatting pass').model, 'haiku');
assert.equal(autoPick('Design the sync architecture').model, 'opus');
assert.equal(autoPick('Plan the migration').model, 'opus');
assert.equal(autoPick('Add a retry to the uploader').model, 'sonnet');
assert.equal(autoPick('Reformat nothing; replant trees').model, 'sonnet', 'keywords match at a word start only');
assert.deepEqual(autoPick('tidy', [{ match: ['tidy'], model: 'haiku', effort: 'low' }], 'opus'), { model: 'haiku', effort: 'low' });

// Ceiling: providers.json order, unknown names above, a missing effort is the CLI default (medium).
assert.equal(above({ model: 'opus' }, { model: 'sonnet' }), true);
assert.equal(above({ model: 'haiku' }, { model: 'sonnet', effort: 'low' }), false);
assert.equal(above({ model: 'sonnet', effort: 'high' }, { model: 'sonnet', effort: 'medium' }), true);
assert.equal(above({ model: 'sonnet', effort: 'low' }, { model: 'sonnet', effort: 'medium' }), false);
assert.equal(above({ model: 'sonnet', effort: 'max' }, { model: 'sonnet' }), true, 'no ceiling effort = default medium');
assert.equal(above({ model: 'sonnet', effort: 'medium' }, { model: 'sonnet' }), false);
assert.equal(above({ model: 'sonnet' }, { model: 'sonnet', effort: 'low' }), true, 'no effort = default medium');
assert.equal(above({ model: 'sonnet' }, { model: 'sonnet', effort: 'medium' }), false);
assert.equal(above({ model: 'claude-opus-4-1' }, { model: 'sonnet' }), true);
assert.equal(above({ model: 'claude-haiku-4-5' }, { model: 'sonnet' }), false, 'a full id ranks as its family');
assert.equal(above({ model: 'opus' }, undefined), false);
assert.equal(above({ model: 'gpt-5' }, { model: 'opus' }), true, 'unknown names count as above');
assert.equal(above({ model: 'sonnet', effort: 'ultra' }, { model: 'sonnet' }), true, 'unknown effort counts as above');
assert.equal(above({ model: 'haiku' }, { model: 'gpt-6-sol' }), true, 'a ceiling the provider does not know: above');
// Codex: providers.json order, strongest first.
assert.equal(above({ model: 'gpt-6-luna' }, { model: 'gpt-6-sol' }, 'codex'), false);
assert.equal(above({ model: 'gpt-6-astra' }, { model: 'gpt-6-sol' }, 'codex'), true);
assert.equal(above({ model: 'gpt-5.6-terra' }, { model: 'gpt-6-luna' }, 'codex'), false);
assert.equal(above({ model: 'gpt-6-sol' }, { model: 'gpt-5.6-sol' }, 'codex'), true);
assert.equal(above({ model: 'gpt-6-luna', effort: 'high' }, { model: 'gpt-6-luna', effort: 'low' }, 'codex'), true);
// Effective ceiling = the lower of the project ceiling and the lead's model: both must hold.
const effective = (want, project, lead) => above(want, project) || above(want, lead);
assert.equal(effective({ model: 'sonnet' }, { model: 'opus' }, { model: 'haiku' }), true, 'lead lower than project');
assert.equal(effective({ model: 'sonnet' }, { model: 'haiku' }, { model: 'opus' }), true, 'project lower than lead');
assert.equal(effective({ model: 'haiku' }, { model: 'sonnet' }, { model: 'opus' }), false);

// Roll-up over a lead's subtree.
const all = [
  { id: 'L', state: 'working', progress: { done: 2, total: 5 } },
  { id: 'r1', parentId: 'L', state: 'done', progress: { done: 3, total: 4 } },
  { id: 'r2', parentId: 'L', state: 'working', progress: { done: 1, total: 3 } },
  { id: 's1', parentId: 'r2', state: 'queued' },
  { id: 'x', state: 'working', progress: { done: 1, total: 1 } },
];
assert.deepEqual(rollup(all, 'L'), { done: 7, total: 12, reports: 3 });
assert.deepEqual(rollup(all, 'r2'), { done: 1, total: 3, reports: 1 });
assert.deepEqual(rollup(all, 'nope'), { done: 0, total: 0, reports: 0 });

console.log('check-org: ok');
