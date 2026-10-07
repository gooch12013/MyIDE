// Schedule timing: pure functions, no Electron, so scripts/check-schedules.mjs can run them under node.
// Times are local wall-clock: every slot is built from date parts (new Date(y, m, d, hh, mm)), never by adding
// 24 h of milliseconds, so a DST change moves nothing. A time that does not exist on a spring-forward day
// (02:30) runs at the shifted time JS gives it (03:30); a repeated time on a fall-back day runs once (the first).

export interface Schedule {
  id: string; buttonId: string; projectId: string;
  days: number[]; // 0 = Sunday .. 6 = Saturday
  time: string; // 'HH:MM', local
  missed: 'run' | 'skip'; // a slot that passed while the Mac slept or MyIDE was closed
  enabled: boolean;
  input?: string; // the button's input, fixed for scheduled runs
  handled: number; // the last slot (ms) that ran or was skipped; slots at or before it are done
  last?: { at: number; status: string; report?: string };
  fingerprint?: string; // the button's command and target when the schedule was saved (see fingerprint)
}

/** What a run of the button does: its command and who runs it. A schedule runs only while this matches what was saved. */
export const fingerprint = (b: { command: string; target: unknown }): string => JSON.stringify([b.command, b.target]);

/** How late a slot may be noticed and still count as on time. The timer ticks once a minute. */
export const GRACE_MS = 5 * 60_000;

const hm = (time: string): [number, number] => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!m || +m[1] > 23 || +m[2] > 59) throw new Error(`Bad time "${time}", use HH:MM`);
  return [+m[1], +m[2]];
};

/** The slot on `day`'s calendar date (offset by `off` days), at the schedule's time. */
function slotOn(day: Date, off: number, time: string): Date {
  const [h, m] = hm(time);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + off, h, m);
}

/** The nearest slot from `from` going `dir` days at a time (1: strictly after, -1: at or before), or null if no day is set. */
function scan(s: Pick<Schedule, 'days' | 'time'>, from: Date, dir: 1 | -1): Date | null {
  for (let off = 0; off <= 7; off++) {
    const d = slotOn(from, off * dir, s.time);
    if ((dir > 0 ? d > from : d <= from) && s.days.includes(d.getDay())) return d;
  }
  return null;
}
/** The first slot strictly after `after`, or null if no day is set. */
export const nextRun = (s: Pick<Schedule, 'days' | 'time'>, after: Date): Date | null => scan(s, after, 1);
/** The latest slot at or before `now`, or null. */
export const prevRun = (s: Pick<Schedule, 'days' | 'time'>, now: Date): Date | null => scan(s, now, -1);

/** What a tick at `now` does with `s`: run, skip (a missed slot under 'skip', or everything while paused), or nothing.
 *  Several missed slots collapse into one: only the latest is run or skipped. */
export function due(s: Schedule, now: Date, paused = false): { slot: number; action: 'run' | 'skip'; late: boolean } | null {
  const p = prevRun(s, now);
  if (!p || p.getTime() <= s.handled) return null;
  const late = now.getTime() - p.getTime() > GRACE_MS;
  const action = paused || !s.enabled || (late && s.missed === 'skip') ? 'skip' : 'run';
  return { slot: p.getTime(), action, late };
}

export const WEEKDAYS = [1, 2, 3, 4, 5];
const NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** "Weekdays 07:00", "Daily 09:30", "Mon, Thu 18:00". */
export function describe(s: Pick<Schedule, 'days' | 'time'>): string {
  const d = [...s.days].sort();
  const days = d.length === 7 ? 'Daily' : d.join() === WEEKDAYS.join() ? 'Weekdays' : d.join() === '0,6' ? 'Weekends'
    : [...d.filter((x) => x), ...d.filter((x) => !x)].map((x) => NAMES[x]).join(', ') || 'Never';
  return `${days} ${s.time}`;
}
