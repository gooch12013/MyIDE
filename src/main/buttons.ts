// Action buttons and their schedules. A button sends a slash command as an ordinary turn: Claude Code 2.1.292
// expands user, project and plugin commands and skills inside `claude -p` (checked with a project command and
// a plugin skill), so no command file is read or inlined here.
import { Notification, powerMonitor, powerSaveBlocker } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Employee } from './employees';
import { hireEmployee, listEmployees, onEmployeeChange, sendToEmployee } from './employees';
import { listProjects, projectById } from './projects';
import { due, fingerprint, nextRun, type Schedule } from './schedules';
import { broadcast, handle, readJSON, slug, STATE_DIR, writeJSON, writePrivate } from './store';

export type Target = 'lead' | 'selected' | { role: string };
export interface Button { id: string; label: string; command: string; target: Target; input?: string; scope: 'global' | 'project'; projectId?: string }
export interface PaletteItem { name: string; description: string; source: string }
export type { Schedule };
type SchedFile = { paused: boolean; schedules: Schedule[] };

// ---- installed commands and skills (names and descriptions only) ----

const CLAUDE = join(homedir(), '.claude');

/** A markdown file's YAML frontmatter as flat `key: value` strings (quotes stripped); {} if it has none or cannot be read. */
export function frontmatter(file: string): Record<string, string> {
  try {
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(file, 'utf8'));
    return Object.fromEntries((m?.[1] ?? '').split('\n').map((l) => /^([\w-]+):\s*(.*)$/.exec(l)).filter((x) => !!x).map((x) => [x![1], x![2].trim().replace(/^(['"])(.*)\1$/, '$2')]));
  } catch { return {}; }
}
const ls = (dir: string) => { try { return readdirSync(dir); } catch { return []; } };

/** Commands in `dir/commands/*.md` and skills in `dir/skills/<name>/SKILL.md`, named `prefix + name`. */
function scan(dir: string, prefix: string, source: string): PaletteItem[] {
  const cmds = ls(join(dir, 'commands')).filter((f) => f.endsWith('.md'))
    .map((f) => ({ name: prefix + f.slice(0, -3), description: frontmatter(join(dir, 'commands', f)).description ?? '', source }));
  const skills = ls(join(dir, 'skills')).filter((d) => existsSync(join(dir, 'skills', d, 'SKILL.md')))
    .map((d) => { const fm = frontmatter(join(dir, 'skills', d, 'SKILL.md')); return { name: prefix + (fm.name || d), description: fm.description ?? '', source }; });
  return [...cmds, ...skills];
}

function plugins(): PaletteItem[] {
  let enabled: Record<string, boolean> = {};
  let installed: Record<string, { scope?: string; installPath: string }[]> = {};
  try { enabled = JSON.parse(readFileSync(join(CLAUDE, 'settings.json'), 'utf8')).enabledPlugins ?? {}; } catch { /* none */ }
  try { installed = JSON.parse(readFileSync(join(CLAUDE, 'plugins', 'installed_plugins.json'), 'utf8')).plugins ?? {}; } catch { /* none */ }
  return Object.entries(enabled).filter(([, on]) => on).flatMap(([id]) => {
    const entry = installed[id]?.find((x) => x.scope === 'user') ?? installed[id]?.[0];
    return entry ? scan(entry.installPath, `${id.split('@')[0]}:`, 'plugin') : [];
  });
}

export function palette(projectPath?: string): PaletteItem[] {
  const all = [...scan(CLAUDE, '', 'user'), ...plugins(), ...(projectPath ? scan(join(projectPath, '.claude'), '', 'project') : [])];
  const seen = new Set<string>();
  return all.filter((p) => !seen.has(p.name) && seen.add(p.name)).sort((a, b) => a.name.localeCompare(b.name));
}

// ---- buttons: global in ~/.myide/buttons.json, project ones in <repo>/.myide/buttons.json (committed with the repo) ----

const projectPath = (id?: string) => projectById(id)?.path;
const projectFile = (id: string) => { const p = projectPath(id); if (!p) throw new Error('No such project'); return join(p, '.myide', 'buttons.json'); };

function readProject(id: string): Button[] {
  try { return (JSON.parse(readFileSync(projectFile(id), 'utf8')) as Button[]).map((b) => ({ ...b, scope: 'project' as const, projectId: id })); } catch { return []; }
}
function writeProject(id: string, list: Button[]): void {
  const file = projectFile(id);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(list.map(({ projectId, scope, ...b }) => b), null, 2) + '\n');
}
const readGlobal = () => readJSON<Button[]>('buttons.json', []).map((b) => ({ ...b, scope: 'global' as const, projectId: undefined }));

export function listButtons(projectId?: string): Button[] {
  return [...readGlobal(), ...(projectId ? readProject(projectId) : [])];
}
const findButton = (id: string, projectId?: string) => listButtons(projectId).find((b) => b.id === id);

function validTarget(t: unknown): t is Target {
  return t === 'lead' || t === 'selected' || (!!t && typeof t === 'object' && typeof (t as { role?: unknown }).role === 'string' && !!(t as { role: string }).role);
}

function saveButton(b: Button): Button {
  if (!b || typeof b.label !== 'string' || !b.label.trim()) throw new Error('Give the button a label');
  if (typeof b.command !== 'string' || !b.command.trim()) throw new Error('Give the button a command');
  if (!validTarget(b.target)) throw new Error('Pick who runs it');
  if (b.scope === 'project' && !projectPath(b.projectId)) throw new Error('Pick a project for a project button');
  const clean: Button = { id: b.id || randomUUID(), label: b.label.trim(), command: b.command.trim(), target: b.target, scope: b.scope === 'project' ? 'project' : 'global' };
  if (b.input?.trim()) clean.input = b.input.trim();
  removeButton(clean.id); // scope may have changed
  if (clean.scope === 'global') writeJSON('buttons.json', [...readJSON<Button[]>('buttons.json', []), clean]);
  else { clean.projectId = b.projectId; writeProject(b.projectId!, [...readProject(b.projectId!), clean]); }
  return clean;
}

function removeButton(id: string): void {
  const g = readJSON<Button[]>('buttons.json', []);
  if (g.some((b) => b.id === id)) writeJSON('buttons.json', g.filter((b) => b.id !== id));
  for (const p of listProjects()) {
    const list = readProject(p.id);
    if (list.some((b) => b.id === id)) writeProject(p.id, list.filter((b) => b.id !== id));
  }
}

// ---- running a button ----

/** Sends `command` (plus input) to the button's target in `projectId`; resolves to the employee that runs it.
 *  quiet: a scheduled run, which notifies only on failure or needs-you. */
export async function runButton(b: Pick<Button, 'command' | 'target' | 'label'>, projectId: string, o: { employeeId?: string; input?: string; quiet?: boolean } = {}): Promise<Employee> {
  const project = projectById(projectId);
  if (!project) throw new Error('No such project');
  const text = [b.command.trim(), o.input?.trim()].filter(Boolean).join(' ');
  const emps = listEmployees(projectId);
  if (typeof b.target === 'object') {
    const role = b.target.role;
    // A scheduled run reuses an idle top-level employee with the role, so a daily button does not hire one a day.
    const idle = o.quiet && emps.find((x) => x.role === role && !x.parentId && (x.state === 'idle' || x.state === 'done'));
    if (!idle) return hireEmployee({ projectId, role, task: text, quiet: o.quiet });
    sendToEmployee(idle.id, text, { quiet: true });
    return idle;
  }
  const e = b.target === 'selected'
    ? emps.find((x) => x.id === o.employeeId)
    : emps.find((x) => x.lead && !x.parentId) ?? emps.find((x) => x.lead);
  if (!e) throw new Error(b.target === 'selected' ? 'Select an employee first' : `${project.name} has no lead. Hire one (tick Lead) or give the button a role.`);
  sendToEmployee(e.id, text, { quiet: o.quiet });
  return e;
}

// ---- schedules ----

let now = () => Date.now(); // tests move the clock (see registerButtonsIpc)
const readScheds = () => readJSON<SchedFile>('schedules.json', { paused: false, schedules: [] });
const writeScheds = (f: SchedFile) => { writeJSON('schedules.json', f); changed(); };
let onPausedChange: (paused: boolean) => void = () => {};
function changed(): void { broadcast('schedules:change'); onPausedChange(readScheds().paused); }

export const schedulesPaused = (): boolean => readScheds().paused;
export function pauseSchedules(paused: boolean): void { writeScheds({ ...readScheds(), paused: !!paused }); }

function saveSchedule(s: Schedule): Schedule {
  if (!s || !Array.isArray(s.days) || !s.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) throw new Error('Pick the days');
  nextRun(s, new Date()); // throws on a bad time
  const b = findButton(s.buttonId, s.projectId);
  if (!b) throw new Error('Pick a button');
  if (b.target === 'selected') throw new Error('A "selected employee" button cannot be scheduled: nobody is selected at 07:00. Give it the lead or a role.');
  if (!projectPath(s.projectId)) throw new Error('Pick a project');
  const f = readScheds();
  const old = f.schedules.find((x) => x.id === s.id);
  const timing = old && old.time === s.time && old.days.join() === [...s.days].sort().join();
  const clean: Schedule = {
    id: s.id || randomUUID(), buttonId: s.buttonId, projectId: s.projectId, days: [...new Set(s.days)].sort(), time: s.time,
    missed: s.missed === 'skip' ? 'skip' : 'run', enabled: s.enabled !== false, input: s.input?.trim() || undefined,
    handled: timing ? old.handled : now(), // a new or retimed schedule starts from now: nothing before counts as missed
    last: old?.last,
    fingerprint: fingerprint(b), // what David scheduled; a changed button pauses the schedule instead of running
  };
  writeScheds({ ...f, schedules: [...f.schedules.filter((x) => x.id !== clean.id), clean] });
  return clean;
}

// Scheduled runs in flight: schedule id -> its employee and what to report when that employee's turn ends.
const active = new Map<string, { employeeId: string; schedule: Schedule; label: string; command: string; started: number }>();
let blocker: number | null = null;
function awake(): void {
  if (active.size && blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension');
  if (!active.size && blocker !== null) { powerSaveBlocker.stop(blocker); blocker = null; }
}
export const keepingAwake = (): boolean => blocker !== null;

const ENDED: Partial<Record<Employee['state'], string>> = { done: 'Done', failed: 'Failed', 'needs-you': 'Needs you', interrupted: 'Interrupted' };
const RUN_LIMIT_MS = 6 * 3600_000; // a run that never reports back (employee fired) stops keeping the Mac awake

const day = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** Records a scheduled run's outcome on its schedule and in ~/.myide/reports/<date>-<schedule>.md. */
function record(s: Schedule, label: string, status: string, body: string): void {
  const file = join(STATE_DIR, 'reports', `${day(now())}-${slug(label, 'schedule')}.md`);
  writePrivate(file, `# ${label}\n\n${body}\n`);
  const f = readScheds();
  const cur = f.schedules.find((x) => x.id === s.id);
  if (cur) { cur.last = { at: now(), status, report: file }; writeScheds(f); }
}

function ended(e: Employee): void {
  const status = ENDED[e.state];
  const [id, run] = [...active].find(([, r]) => r.employeeId === e.id) ?? [];
  if (!run || !status) return;
  active.delete(id!);
  awake();
  const project = projectById(e.projectId)?.name ?? e.projectId;
  record(run.schedule, run.label, status, [
    `- Status: ${status}`, `- Command: \`${run.command}\``, `- Project: ${project}`, `- Employee: ${e.name} (${e.branch})`,
    `- Started: ${new Date(run.started).toLocaleString()}`, `- Ended: ${new Date(now()).toLocaleString()}`, '',
    e.state === 'failed' ? `Error: ${e.error ?? 'no detail'}` : e.lastText ?? '(no final message)',
  ].join('\n'));
  // employees.ts already notifies on failed and needs-you.
}

function fail(s: Schedule, label: string, err: unknown, status = 'Failed'): void {
  const msg = (err as Error).message;
  record(s, label, status, `- Status: ${status}\n- ${status === 'Failed' ? 'Could not start' : 'Why'}: ${msg}`);
  if (Notification.isSupported()) new Notification({ title: `Schedule "${label}" ${status === 'Failed' ? 'failed' : 'paused'}`, body: msg }).show();
}

async function fire(s: Schedule): Promise<void> {
  const b = findButton(s.buttonId, s.projectId);
  if (!b) return fail(s, s.buttonId, new Error('Its button was deleted'));
  if (s.fingerprint !== fingerprint(b)) {
    // The button's command or target changed (a project button can change with a pull): David re-saves the schedule to accept it.
    const f = readScheds();
    const cur = f.schedules.find((x) => x.id === s.id);
    if (cur) { cur.enabled = false; writeScheds(f); }
    return fail(s, b.label, new Error('Its button\'s command or target changed since the schedule was saved. Check the button, then turn the schedule back on.'), 'Paused');
  }
  if (active.has(s.id)) return record(s, b.label, 'Skipped', '- Status: Skipped, the previous run is still going');
  try {
    const e = await runButton(b, s.projectId, { input: s.input, quiet: true });
    active.set(s.id, { employeeId: e.id, schedule: s, label: b.label, command: b.command, started: now() });
    awake();
    record(s, b.label, 'Running', `- Status: Running on ${e.name}`);
  } catch (err) { fail(s, b.label, err); }
}

/** Once a minute, at launch and on wake: runs due schedules, applies the missed-run policy, times out stuck runs. */
export function tick(at = now()): void {
  for (const [id, r] of active) if (at - r.started > RUN_LIMIT_MS) { active.delete(id); record(r.schedule, r.label, 'Timed out', '- Status: no result after 6 hours'); }
  awake();
  const f = readScheds();
  const runs: Schedule[] = [];
  let dirty = false;
  for (const s of f.schedules) {
    const d = due(s, new Date(at), f.paused);
    if (!d) continue;
    s.handled = d.slot;
    dirty = true;
    if (d.action === 'run') runs.push(s);
    else if (s.enabled && !f.paused) s.last = { at, status: 'Skipped (Mac was asleep or MyIDE closed)' };
  }
  if (dirty) writeScheds(f); // handled is saved before running, so a crash never runs a slot twice
  for (const s of runs) void fire(s);
}

export function registerButtonsIpc(o: { onPaused?: (paused: boolean) => void } = {}): void {
  onPausedChange = o.onPaused ?? onPausedChange;
  onEmployeeChange(ended);
  handle('buttons:list', (projectId?: string) => ({ buttons: listButtons(projectId), palette: palette(projectPath(projectId)) }));
  handle('buttons:save', saveButton);
  handle('buttons:delete', (id: string) => {
    removeButton(id);
    const f = readScheds();
    writeScheds({ ...f, schedules: f.schedules.filter((s) => s.buttonId !== id) });
  });
  handle('buttons:run', async (b: Button, projectId: string, o: { employeeId?: string; input?: string }) => (await runButton(b, projectId, { employeeId: o?.employeeId, input: o?.input })).id);
  handle('schedules:list', () => {
    const f = readScheds();
    return { ...f, schedules: f.schedules.map((s) => ({ ...s, next: nextRun(s, new Date(Math.max(now(), s.handled)))?.getTime() })), awake: keepingAwake() };
  });
  handle('schedules:save', saveSchedule);
  handle('schedules:delete', (id: string) => { const f = readScheds(); writeScheds({ ...f, schedules: f.schedules.filter((s) => s.id !== id) }); });
  handle('schedules:pause', pauseSchedules);

  powerMonitor.on('resume', () => tick());
  setInterval(() => tick(), 60_000);
  setTimeout(() => tick(), 5_000); // launch: catch slots missed while MyIDE was closed, once employees have loaded
  // Tests drive the clock: MYIDE_TEST_CLOCK=1 exposes it on globalThis for Playwright's electronApp.evaluate.
  if (process.env.MYIDE_TEST_CLOCK) (globalThis as Record<string, unknown>).myideClock = { set: (ms: number) => { now = () => ms; }, tick: () => tick(), awake: keepingAwake };
}
