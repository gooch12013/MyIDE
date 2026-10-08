// Issues given to employees, tracked for the Issue panel's dashboard: who held each one and since when, every employee's
// part of its conversation (session ids and a time window, so it still reads once the employee is fired), and what happened.
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { claudeConfigDir } from './accounts';
import { broadcast, readJSON, STATE_DIR, writeJSON } from './store';
import { chat, parseTranscript, type ChatLine, type Entry, type Said } from './thread';

/** to: when this employee's part ended (fired, or the issue moved on); endAfterTurn: it ends when the running turn does. */
export interface Thread {
  employeeId: string; name: string; role: string; lead?: string; provider: string; accountId: string; worktree: string;
  sessions: string[]; from: number; to?: number; endAfterTurn?: boolean; mine: Said[];
}
export interface TrackEvent { at: number; text: string }
/** closedAt: when MyIDE last saw the issue closed (the forge list holds only recent issues, so this keeps it). */
export interface Track { number: number; title: string; url: string; assignedAt: number; holderId: string; threads: Thread[]; events: TrackEvent[]; closedAt?: number }
/** What tracking needs from an employee. */
export type Who = { id: string; projectId: string; name: string; role: string; provider: string; accountId: string; worktree: string; sessionId?: string };

const file = (projectId: string) => join('projects', projectId, 'tracks.json');
const frozen = (projectId: string, sid: string) => join(STATE_DIR, 'projects', projectId, 'threads', `${sid}.jsonl`);
export const listTracks = (projectId: string): Track[] => readJSON<{ tracks?: Track[] }>(file(projectId), {}).tracks ?? [];

/** Read-modify-write; `fn` returns false when it changed nothing. */
function edit(projectId: string, fn: (ts: Track[]) => boolean | void): void {
  try {
    const ts = listTracks(projectId);
    if (fn(ts) === false) return;
    writeJSON(file(projectId), { tracks: ts });
    broadcast('tracks:change', projectId);
  } catch (e) { console.error('tracks', e); } // the dashboard's record; never worth failing a fire, a turn's end or an approval
}
const openOf = (t: Track, id: string) => t.threads.find((x) => x.employeeId === id && x.to === undefined);
function event(t: Track, text: string, at = Date.now()): void {
  t.events.push({ at, text });
  if (t.events.length > 500) t.events.splice(0, t.events.length - 500);
}
function enter(t: Track, w: Who, at: number, lead?: string): void {
  const open = openOf(t, w.id);
  if (open) { open.endAfterTurn = undefined; return; } // given back in the turn that let it go: it stays on
  t.threads.push({ employeeId: w.id, name: w.name, role: w.role, lead, provider: w.provider, accountId: w.accountId, worktree: w.worktree,
    sessions: w.sessionId ? [w.sessionId] : [], from: at, mine: [] });
}

/** `w` now holds issue `i` (from David, or from a lead handing it down): tracked from `at`, with `w` as its holder. */
export function assigned(w: Who, i: { number: number; title: string; url: string }, text: string, at = Date.now(), lead?: string): void {
  edit(w.projectId, (ts) => {
    let t = ts.find((x) => x.number === i.number);
    if (!t) ts.push(t = { number: i.number, title: i.title, url: i.url, assignedAt: at, holderId: w.id, threads: [], events: [] });
    Object.assign(t, { title: i.title || t.title, url: i.url || t.url, holderId: w.id });
    enter(t, w, at, lead);
    event(t, text, at);
  });
}

/** Issue `n` moved on from `w` (a lead handed it to a report): `w`'s part ends with the turn it is in, or now. */
export function released(w: Who, n: number, running: boolean): void {
  edit(w.projectId, (ts) => {
    const t = ts.find((x) => x.number === n);
    const th = t && openOf(t, w.id);
    if (!th) return false;
    if (running) th.endAfterTurn = true; else th.to = Date.now();
  });
}

/** Report `r` got a task from `lead`: it joins every issue its lead is on now, and leaves the ones its lead has left. */
export function tasked(r: Who, lead: Who, text?: string, at = Date.now()): void {
  edit(r.projectId, (ts) => {
    let changed = false;
    for (const t of ts) {
      const mine = openOf(t, r.id);
      if (openOf(t, lead.id)) {
        if (!mine) { enter(t, r, at, lead.name); changed = true; }
        if (text) { event(t, text, at); changed = true; }
      } else if (mine && t.holderId !== r.id) { mine.to = at; changed = true; } // the issue's holder stays on it
    }
    return changed;
  });
}

/** An event on every issue `w` is on now. */
export function note(w: Pick<Who, 'id' | 'projectId'>, text: string): void {
  edit(w.projectId, (ts) => {
    const on = ts.filter((t) => openOf(t, w.id));
    on.forEach((t) => event(t, text));
    return on.length > 0;
  });
}

/** The forge's latest poll: tracked issues in `closed` are marked closed, and ones it lists open again are not. */
export function forgeStates(projectId: string, closed: Set<number>, open: Set<number>): void {
  edit(projectId, (ts) => {
    let changed = false;
    for (const t of ts) {
      // No event: the forge's own timeline shows the close and the reopen.
      if (closed.has(t.number) && !t.closedAt) { t.closedAt = Date.now(); changed = true; }
      else if (open.has(t.number) && t.closedAt) { t.closedAt = undefined; changed = true; }
    }
    return changed;
  });
}

/** `w`'s running turn ended: a part waiting on it ends now. */
export function turnEnded(w: Pick<Who, 'id' | 'projectId'>): void {
  edit(w.projectId, (ts) => {
    let changed = false;
    for (const t of ts) {
      const th = openOf(t, w.id);
      if (th?.endAfterTurn) { th.to = Date.now(); th.endAfterTurn = undefined; changed = true; }
    }
    return changed;
  });
}

/** A new session id for `w` (its first turn, or a fresh session), so its part reads after it is fired. */
export function sessionSeen(w: Who): void {
  if (!w.sessionId) return;
  const sid = w.sessionId;
  edit(w.projectId, (ts) => {
    const on = ts.map((t) => openOf(t, w.id)).filter((th): th is Thread => !!th && !th.sessions.includes(sid));
    on.forEach((th) => th.sessions.push(sid));
    return on.length > 0;
  });
}

/** David sent `w` a message: kept so the dashboard labels it his, and shows it queued until its turn runs. */
export function said(w: Pick<Who, 'id' | 'projectId'>, text: string): void {
  edit(w.projectId, (ts) => {
    const on = ts.map((t) => openOf(t, w.id)).filter((th): th is Thread => !!th);
    for (const th of on) { th.mine.push({ at: Date.now(), text: text.trim().slice(0, 300) }); if (th.mine.length > 50) th.mine.shift(); }
    return on.length > 0;
  });
}

/** `w` was fired: its parts end, and its session files are copied into MyIDE's state, out of reach of the CLI's clean-up. */
export function fired(w: Who): void {
  edit(w.projectId, (ts) => {
    const sids = new Set<string>([...(w.sessionId ? [w.sessionId] : []), ...ts.flatMap((t) => t.threads.filter((x) => x.employeeId === w.id).flatMap((x) => x.sessions))]);
    for (const sid of sids) {
      const src = sessionFile(w.accountId, w.worktree, sid);
      try { if (src) { mkdirSync(join(STATE_DIR, 'projects', w.projectId, 'threads'), { recursive: true, mode: 0o700 }); copyFileSync(src, frozen(w.projectId, sid)); } } catch (e) { console.error('thread copy', e); }
    }
    const on = ts.filter((t) => openOf(t, w.id));
    for (const t of on) { openOf(t, w.id)!.to = Date.now(); event(t, `${w.name} fired`); }
    return on.length > 0;
  });
}

/** Where Claude Code keeps a session: the account's projects folder, in a folder named after the cwd with every
 *  non-alphanumeric character as '-'; scanned for when that guess misses. Undefined if it is gone. */
const found = new Map<string, string>(); // session id -> the file a scan found
export function sessionFile(accountId: string, worktree: string, sid: string): string | undefined {
  const root = join(claudeConfigDir(accountId), 'projects');
  const name = `${sid}.jsonl`;
  const guess = join(root, worktree.replace(/[^a-zA-Z0-9]/g, '-'), name);
  if (existsSync(guess)) return guess;
  const known = found.get(sid);
  if (known && existsSync(known)) return known;
  let dirs: string[] = [];
  try { dirs = readdirSync(root); } catch { return undefined; }
  const d = dirs.find((x) => existsSync(join(root, x, name)));
  if (d) found.set(sid, join(root, d, name));
  return d ? join(root, d, name) : undefined;
}

// Parsed sessions by file. A session only grows, so a read parses just the whole lines added since the last one.
// ponytail: 30 files kept, oldest dropped first; a byte cap if long sessions with images use too much memory.
const parsed = new Map<string, { ino: number; size: number; entries: Entry[] }>();
function readSession(f: string): Entry[] {
  const st = statSync(f);
  let c = parsed.get(f);
  if (!c || c.ino !== st.ino || st.size < c.size) c = { ino: st.ino, size: 0, entries: [] }; // replaced or rewritten: start over
  if (st.size > c.size) {
    const buf = Buffer.alloc(st.size - c.size);
    const fd = openSync(f, 'r');
    try { readSync(fd, buf, 0, buf.length, c.size); } finally { closeSync(fd); }
    const cut = buf.lastIndexOf(10) + 1; // up to the last newline: a line still being written waits for the next read
    c.entries.push(...parseTranscript(buf.subarray(0, cut).toString('utf8')));
    c.size += cut;
  }
  parsed.delete(f);
  parsed.set(f, c);
  if (parsed.size > 30) parsed.delete(parsed.keys().next().value!);
  return c.entries;
}

/** A session as lines: MyIDE's copy once the employee is fired, else the live file. */
export function sessionLines(projectId: string, accountId: string, worktree: string, sid: string): Entry[] {
  const f = existsSync(frozen(projectId, sid)) ? frozen(projectId, sid) : sessionFile(accountId, worktree, sid);
  if (!f) return [];
  try { return readSession(f); } catch { return []; }
}

/** One employee's part of issue `n`, labelled. `liveSession` is its current session when it is still hired. */
export function threadOf(projectId: string, n: number, employeeId: string, liveSession?: string): ChatLine[] {
  const t = listTracks(projectId).find((x) => x.number === n);
  // The latest part, open or not: an employee that left and came back has more than one.
  const th = t?.threads.filter((x) => x.employeeId === employeeId).at(-1);
  if (!th) return [];
  if (th.provider !== 'claude') return [{ role: 'tool', text: `The conversation is not readable for ${th.provider} yet.`, who: 'myide' }];
  const sids = [...new Set([...th.sessions, ...(liveSession && th.to === undefined ? [liveSession] : [])])];
  const entries = sids.flatMap((sid) => sessionLines(projectId, th.accountId, th.worktree, sid));
  return chat(entries, { from: th.from, to: th.to, mine: th.mine, lead: th.lead });
}
