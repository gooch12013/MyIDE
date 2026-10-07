// Checks schedule timing in src/main/schedules.ts: next run, weekdays, missed-run policy, DST.
// Usage: TZ=America/New_York node scripts/check-schedules.mjs (re-runs itself in that zone if TZ is unset)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, due, GRACE_MS, nextRun, prevRun, WEEKDAYS } from '../src/main/schedules.ts';

if (process.env.TZ !== 'America/New_York') {
  const r = spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: { ...process.env, TZ: 'America/New_York' } });
  process.exit(r.status ?? 1);
}

const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);
const fmt = (d) => d && `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
const wk = { days: WEEKDAYS, time: '07:00' };

// 2026-10-07 is a Wednesday.
assert.equal(at(2026, 10, 7).getDay(), 3);
assert.equal(fmt(nextRun(wk, at(2026, 10, 7, 6, 59))), '2026-10-7 7:00');
assert.equal(fmt(nextRun(wk, at(2026, 10, 7, 7, 0))), '2026-10-8 7:00'); // strictly after
// Friday evening -> Monday, skipping the weekend.
assert.equal(fmt(nextRun(wk, at(2026, 10, 9, 8))), '2026-10-12 7:00');
assert.equal(fmt(prevRun(wk, at(2026, 10, 11, 12))), '2026-10-9 7:00');
// Only Sunday, asked on Sunday after the time: a week later.
assert.equal(fmt(nextRun({ days: [0], time: '09:30' }, at(2026, 10, 11, 10))), '2026-10-18 9:30');
assert.equal(nextRun({ days: [], time: '09:30' }, at(2026, 10, 11)), null);
assert.throws(() => nextRun({ days: [1], time: '25:00' }, at(2026, 10, 11)));

// DST, New York: spring forward 2026-03-08 (02:00 -> 03:00), fall back 2026-11-01 (02:00 -> 01:00).
const daily = (time) => ({ days: [0, 1, 2, 3, 4, 5, 6], time });
assert.equal(fmt(nextRun(daily('07:00'), at(2026, 3, 7, 8))), '2026-3-8 7:00'); // 23-hour day: still 07:00 local
assert.equal(fmt(nextRun(daily('07:00'), at(2026, 3, 8, 8))), '2026-3-9 7:00');
assert.equal(fmt(nextRun(daily('07:00'), at(2026, 10, 31, 8))), '2026-11-1 7:00'); // 25-hour day
assert.equal(nextRun(daily('07:00'), at(2026, 10, 31, 8)) - at(2026, 10, 31, 7), 25 * 3600_000);
assert.equal(fmt(nextRun(daily('02:30'), at(2026, 3, 7, 12))), '2026-3-8 3:30'); // 02:30 does not exist that day
// 01:30 happens twice on fall-back day; it runs once.
const fb = { ...daily('01:30'), id: 'x', buttonId: 'b', projectId: 'p', missed: 'run', enabled: true, handled: at(2026, 10, 31, 12).getTime() };
const first = due(fb, new Date(at(2026, 11, 1, 1, 31)));
assert.equal(first?.action, 'run');
fb.handled = first.slot;
assert.equal(due(fb, new Date(first.slot + 3600_000 + 60_000)), null); // the second 01:31, an hour later

// Missed-run policy.
const s = (o = {}) => ({ id: 's', buttonId: 'b', projectId: 'p', ...wk, missed: 'run', enabled: true, handled: at(2026, 10, 6, 12).getTime(), ...o });
assert.equal(due(s(), at(2026, 10, 7, 6, 59)), null); // not yet
assert.deepEqual(due(s(), at(2026, 10, 7, 7, 1)), { slot: at(2026, 10, 7, 7).getTime(), action: 'run', late: false }); // on time
assert.equal(due(s({ handled: at(2026, 10, 7, 7).getTime() }), at(2026, 10, 7, 7, 2)), null); // already ran
// Asleep from Tue night to Thu 09:00: the latest missed slot (Thu 07:00) runs once, Wed's is folded in.
const late = due(s(), at(2026, 10, 8, 9));
assert.deepEqual(late, { slot: at(2026, 10, 8, 7).getTime(), action: 'run', late: true });
assert.equal(due(s({ handled: late.slot }), at(2026, 10, 8, 9, 1)), null);
assert.equal(due(s({ missed: 'skip' }), at(2026, 10, 8, 9)).action, 'skip');
assert.equal(due(s({ missed: 'skip' }), new Date(at(2026, 10, 7, 7).getTime() + GRACE_MS)).action, 'run'); // within grace is on time
assert.equal(due(s(), at(2026, 10, 7, 7, 1), true).action, 'skip'); // paused
assert.equal(due(s({ enabled: false }), at(2026, 10, 7, 7, 1)).action, 'skip');
// Weekend wake: nothing missed since Friday's run.
assert.equal(due(s({ handled: at(2026, 10, 9, 7).getTime() }), at(2026, 10, 11, 10)), null);

assert.equal(describe(wk), 'Weekdays 07:00');
assert.equal(describe(daily('09:30')), 'Daily 09:30');
assert.equal(describe({ days: [0, 4, 1], time: '18:00' }), 'Mon, Thu, Sun 18:00');
console.log('check-schedules: ok');
