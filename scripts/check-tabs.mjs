// Checks the project tab rules in src/main/tabs.ts: reorder, keyboard moves, close, reopen, neighbour.
// Usage: node scripts/check-tabs.mjs
import assert from 'node:assert/strict';
import { lastClosed, moveBefore, moveBy, neighbour, openTabs, sameIds, setClosed } from '../src/main/tabs.ts';

const ids = (ps) => ps.map((p) => p.id).join('');
const ps = [{ id: 'a' }, { id: 'b' }, { id: 'c', closed: 5 }, { id: 'd' }];

// Drag: before another tab, to the end, onto itself, unknown ids.
assert.equal(ids(moveBefore(ps, 'd', 'a')), 'dabc');
assert.equal(ids(moveBefore(ps, 'a', null)), 'bcda');
assert.equal(ids(moveBefore(ps, 'b', 'b')), 'abcd');
assert.equal(ids(moveBefore(ps, 'x', 'a')), 'abcd');

// Alt+Left/Right step over closed tabs and stop at the ends.
assert.equal(ids(openTabs(moveBy(ps, 'b', 1))), 'adb');
assert.equal(ids(openTabs(moveBy(ps, 'd', -1))), 'adb');
assert.equal(ids(openTabs(moveBy(ps, 'a', 1))), 'bad');
assert.equal(moveBy(ps, 'a', -1), ps);
assert.equal(moveBy(ps, 'd', 1), ps);
assert.equal(moveBy(ps, 'c', 1), ps); // a closed tab has no place in the bar

// Close keeps the project and its place; reopen clears the stamp; the newest close reopens first.
const closed = setClosed(ps, 'a', true, 9);
assert.equal(ids(closed), 'abcd');
assert.equal(ids(openTabs(closed)), 'bd');
assert.equal(lastClosed(closed).id, 'a');
assert.equal(lastClosed(setClosed(closed, 'a', false)).id, 'c');
assert.ok(!('closed' in setClosed(closed, 'a', false)[0]));
assert.equal(lastClosed([{ id: 'a' }]), undefined);

// Closing the active tab shows the open one to its right, else its left, else nothing.
assert.equal(neighbour(ps, 'b').id, 'd'); // c is closed
assert.equal(neighbour(ps, 'd').id, 'b');
assert.equal(neighbour([{ id: 'a' }, { id: 'b', closed: 1 }], 'a'), null);

// A reorder from the renderer must name every project exactly once.
assert.ok(sameIds(ps, ['d', 'c', 'b', 'a']));
assert.ok(!sameIds(ps, ['a', 'b', 'c']));
assert.ok(!sameIds(ps, ['a', 'a', 'b', 'c']));
assert.ok(!sameIds(ps, 'abcd'));

console.log('check-tabs: ok');
