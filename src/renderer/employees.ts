import { h, key } from './dom';
import { openHire } from './hire';
import { activeProject, allProjects } from './projects';
import { openPanel, registerPanel } from './registry';
import type { DockviewPanelApi } from 'dockview-core';
import type { Employee, EmployeeState } from '../main/employees';
import { rollup, SLOW_AT, type Usage } from '../main/org';
import { draftCard } from './issues';
import type { OrgState } from '../preload/preload';
import { fmtPick, MODE_TEXT } from './hire';

export type { Employee, EmployeeState };
type Approval = Awaited<ReturnType<typeof api.approvals.list>>[number];
export const api = window.myide;

// State is LED colour, LED shape and a label together.
const LED: Record<EmployeeState, [string, string]> = {
  idle: ['idle', 'Idle'], queued: ['queued', 'Queued'], working: ['working', 'Working'], 'needs-you': ['needs', 'Needs you'],
  done: ['done', 'Done'], failed: ['failed', 'Failed'], interrupted: ['blocked', 'Interrupted'], talking: ['talking', 'Talking'],
};
export function led(state: string, label?: string): HTMLSpanElement {
  const [s, text] = LED[state as EmployeeState] ?? [state, state];
  const el = h('span', { className: 'led', textContent: label ?? text });
  el.dataset.state = s;
  return el;
}

export const cap = (s?: string): string => (s ? s[0].toUpperCase() + s.slice(1) : '');
export const hasEffort = (model: string): boolean => !/haiku/i.test(model);
export function chip(e: Pick<Employee, 'model' | 'effort'> & { provider?: string; mode?: Employee['mode'] }): HTMLSpanElement {
  const c = h('span', { className: 'chip', title: 'Model · effort' }, h('span', { className: 'chip-model', textContent: cap(e.model) }));
  if (e.provider && e.provider !== 'claude') c.append(h('span', { className: 'chip-ai', textContent: cap(e.provider) })); // the AI, so the bill is visible
  if (e.effort && hasEffort(e.model)) c.append(h('span', { className: 'chip-effort', textContent: e.effort === 'xhigh' ? 'XHigh' : cap(e.effort) }));
  // Manager picks and auto show which mode chose the model.
  if (e.mode && e.mode !== 'pinned') c.append(h('span', { className: 'chip-mode', textContent: e.mode === 'auto' ? 'Auto' : 'Mgr', title: MODE_TEXT[e.mode] }));
  return c;
}

/** "Cue n of m" and the cue text. */
export function cue(e: Employee): { count: string; text: string } {
  const p = e.progress;
  if (e.state === 'failed') return { count: 'Failed', text: e.error ?? e.task ?? '' };
  if (!p?.total) return { count: e.state === 'queued' ? 'Waiting for a slot' : '', text: p?.current ?? e.task ?? '' };
  const complete = p.done >= p.total;
  return { count: `Cue ${complete ? p.total : p.done + 1} of ${p.total}${complete ? ' · complete' : ''}`, text: p.current ?? e.task ?? '' };
}

/** Segmented bar: done cues, the current one in amber, the rest unlit. */
export function steps(e: Employee): HTMLSpanElement {
  const p = e.progress;
  const el = h('span', { className: 'cue-steps' });
  el.setAttribute('aria-hidden', 'true');
  const cur = p && p.done < p.total && e.state !== 'done' ? 1 : 0;
  el.style.cssText = `--done:${p?.done ?? 0};--cur:${cur};--total:${p?.total || 1}`;
  return el;
}

/** Open employee panels by employee id, so a second open focuses the first. */
export const openEmployees = new Map<string, DockviewPanelApi>();
export function openEmployee(id: string): void {
  const open = openEmployees.get(id);
  if (open) open.setActive();
  else openPanel('employee', { id });
}

const inputSummary = (input: unknown): string => {
  const o = (input ?? {}) as Record<string, unknown>;
  const s = typeof o.command === 'string' ? o.command : typeof o.file_path === 'string' ? o.file_path : JSON.stringify(input);
  return s.length > 400 ? `${s.slice(0, 400)}…` : s;
};
const KIND = { permission: 'Permission', plan: 'Approve plan', question: 'Question' };

/** One NEEDS YOU card: who, what, and the keys that answer it. */
function needCard(a: Approval, who: string, colour: string | undefined): HTMLElement {
  const card = h('article', { className: 'need' });
  if (colour) card.style.setProperty('--proj', colour);
  card.setAttribute('aria-label', `${KIND[a.kind]}: ${who}`);
  const body: Node[] = [];
  if (a.kind === 'permission') {
    body.push(h('p', { className: 'need-why', textContent: a.text ?? `Wants to use ${a.tool}` }), h('pre', { className: 'need-input', textContent: inputSummary(a.input) }));
  } else if (a.kind === 'plan') {
    const plan = a.text ?? String((a.input as { plan?: unknown })?.plan ?? '');
    body.push(h('pre', { className: 'need-plan', textContent: plan }));
  } else {
    body.push(h('p', { className: 'need-why need-q', textContent: a.text ?? '' }));
  }
  const busy = (fn: () => Promise<void>) => async () => {
    const all = card.querySelectorAll('button');
    all.forEach((b) => (b.disabled = true));
    try { await fn(); } catch { all.forEach((b) => (b.disabled = false)); }
  };
  let keys: Node[];
  if (a.kind === 'question') {
    const answer = h('textarea', { className: 'input need-answer', rows: 2, placeholder: 'Your answer' });
    answer.setAttribute('aria-label', `Answer for ${who}`);
    keys = [answer, key('Answer', busy(() => api.approvals.resolve(a.id, true, answer.value.trim())), { className: 'key key--sm key--lit' })];
  } else {
    keys = [
      key(a.kind === 'plan' ? 'Approve plan' : 'Approve', busy(() => api.approvals.resolve(a.id, true)), { className: 'key key--sm key--lit' }),
      key('Deny', busy(() => api.approvals.resolve(a.id, false, 'David denied this.'))),
    ];
  }
  card.append(
    h('div', { className: 'need-head' }, led('needs-you', KIND[a.kind]), h('span', { className: 'need-who', textContent: who })),
    ...body,
    h('div', { className: 'need-keys' }, ...keys),
  );
  return card;
}

/** One tree row. A lead's cue column is its roll-up; `tag` is 'summary' when it heads a branch. */
function row(e: Employee, everyone: Employee[], tag: 'div' | 'summary' = 'div', maxReports = 3): HTMLElement {
  const r = h(tag, { className: `o-row${e.contractor ? ' is-contractor' : ''}` });
  r.dataset.state = e.state;
  r.dataset.id = e.id;
  r.style.setProperty('--depth', String(Math.max(0, e.depth - 1)));
  let { count, text } = cue(e);
  const reports = everyone.filter((x) => x.parentId === e.id);
  if (reports.length) {
    const u = rollup(everyone, e.id);
    count = u.total ? `${u.done} of ${u.total} across ${u.reports} report${u.reports === 1 ? '' : 's'}` : `${u.reports} report${u.reports === 1 ? '' : 's'}`;
  }
  if (e.held) count = `Approve ${fmtPick(e.held)}`;
  const rank = e.contractor ? 'Contractor' : e.lead ? 'Lead' : '';
  const role = h('span', { className: 'o-role', title: e.role }, e.role);
  if (e.lead) {
    const running = reports.filter((x) => x.state === 'working' || x.state === 'needs-you').length;
    const max = e.maxReports ?? maxReports;
    role.append(' ', h('span', { className: `capflag${running >= max ? ' is-full' : ''}`, textContent: `${running}/${max} reports`, title: `Max reports running at once for ${e.name}` }));
  }
  const open = h('button', { type: 'button', className: 'o-name', textContent: e.name, title: `Open ${e.name}` });
  open.onclick = (ev) => { ev.preventDefault(); openEmployee(e.id); }; // inside a summary: open, don't fold
  r.append(
    h('span', { className: 'o-strip' }, open, ...(rank ? [h('span', { className: 'rank', textContent: rank })] : [])),
    role,
    h('span', { className: 'o-chip' }, chip(e)),
    h('span', { className: 'o-cue', title: text }, h('span', { className: 'o-cue-count', textContent: count }), ' ', h('span', { className: 'o-cue-text', textContent: text })),
    h('span', { className: 'o-steps' }, steps(e)),
    h('span', { className: 'o-state' }, led(e.state)),
  );
  return r;
}

const ATTENTION: EmployeeState[] = ['needs-you', 'failed', 'interrupted'];

/** Outline tree: reports under their lead, each lead a fold. `closed` remembers folds across redraws. */
function tree(list: Employee[], closed: Set<string>, maxReports: number): HTMLElement[] {
  const ids = new Set(list.map((e) => e.id));
  const kids = (id?: string) => list.filter((e) => (id ? e.parentId === id : !e.parentId || !ids.has(e.parentId)))
    .sort((a, b) => Number(!!b.lead) - Number(!!a.lead) || Number(!!a.contractor) - Number(!!b.contractor) || a.name.localeCompare(b.name));
  const node = (e: Employee): HTMLElement => {
    const below = kids(e.id);
    if (!below.length) return row(e, list, 'div', maxReports);
    const d = h('details', { className: 'o-branch', open: !closed.has(e.id) }, row(e, list, 'summary', maxReports), h('div', { className: 'o-list o-sub' }, ...below.map(node)));
    d.addEventListener('toggle', () => { if (d.open) closed.delete(e.id); else closed.add(e.id); });
    return d;
  };
  return kids().map(node);
}

const pct = (f?: number) => Math.round((f ?? 0) * 100);

/** The one segmented meter (usage and slots): `v` is 0 to 100; `now` of `max` is what a screen reader hears. */
export function meterBar(v: number, label: string, o: { now?: number; max?: number; segs?: number; cls?: string } = {}): HTMLSpanElement {
  const bar = h('span', { className: `meter${o.cls ? ` ${o.cls}` : ''}` }, h('span', { className: 'meter-fill' }));
  bar.style.setProperty('--v', String(v));
  if (o.segs) bar.style.setProperty('--segs', String(o.segs));
  bar.setAttribute('role', 'meter');
  bar.setAttribute('aria-label', label);
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', String(o.max ?? 100));
  bar.setAttribute('aria-valuenow', String(o.now ?? v));
  return bar;
}

/** Five-hour usage per AI account: a segmented meter with the slow-down mark, its value, and an LED once hiring slows. */
function gauge(a: { id: string; name: string; cap: number; usage?: Usage }): HTMLElement[] {
  const u = a.usage;
  const v = pct(u?.fiveHour);
  const wrap = h('span', { className: 'meter-wrap' }, meterBar(v, `${a.name}, five-hour usage`));
  wrap.style.setProperty('--mark', String(SLOW_AT * 100));
  const slow = u?.fiveHour !== undefined && u.fiveHour >= SLOW_AT;
  const title = u?.fiveHour === undefined ? 'No reading yet; it updates after the next turn on this account.'
    : `Seven-day: ${pct(u.sevenDay)}%${u.resetsAt ? ` · five-hour window resets ${new Date(u.resetsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}`;
  return [
    h('span', { className: 'cap-name', textContent: a.name }), wrap,
    h('span', { className: 'cap-val', title, textContent: u?.fiveHour === undefined ? '—' : `${v}% 5 h` }),
    slow ? led('needs-you', `Slowed: cap ${Math.max(1, a.cap - 1)}`) : led('idle', `Cap ${a.cap}`),
  ];
}

/** One line per project: page colour, what needs you, slots in use, priority and pause. */
function projectLine(p: { id: string; name: string; colour: string }, list: Employee[], o: OrgState, active: boolean): HTMLElement {
  const po = o.projects.find((x) => x.id === p.id);
  const running = list.filter((e) => e.state === 'working').length;
  const needs = list.filter((e) => ATTENTION.includes(e.state)).length;
  const queued = list.filter((e) => e.state === 'queued').length;
  const done = list.reduce((n, e) => n + (e.progress ? (e.state === 'done' ? e.progress.total : e.progress.done) : 0), 0);
  const total = list.reduce((n, e) => n + (e.progress?.total ?? 0), 0);
  const slots = o.caps.perProject;
  const meter = meterBar(Math.min(100, (running / slots) * 100), `${p.name} slots`, { now: running, max: slots, segs: slots, cls: `meter--slots${running >= slots ? ' is-full' : ''}` });
  const state = po?.paused ? led('interrupted', 'Paused') : needs ? led('needs-you', `${needs} need${needs === 1 ? 's' : ''} you`)
    : running ? led('working', `${running} working`) : queued ? led('queued', `${queued} queued`) : led('idle', 'Idle');
  const prio = po?.priority ?? 0;
  const set = (patch: { priority?: number; paused?: boolean }) => () => void api.org.setProject(p.id, patch);
  const less = key('−', set({ priority: prio - 1 }), { title: `Lower ${p.name}'s priority` });
  const more = key('+', set({ priority: prio + 1 }), { title: `Raise ${p.name}'s priority` });
  less.setAttribute('aria-label', `Lower ${p.name} priority`);
  more.setAttribute('aria-label', `Raise ${p.name} priority`);
  const line = h('div', { className: `proj-line${active ? ' is-active' : ''}` },
    h('span', { className: 'proj-line-name', textContent: p.name }), state,
    h('span', { className: 'proj-line-slots' }, meter, h('span', { className: 'cap-val', textContent: `${running}/${slots}` })),
    h('span', { className: 'proj-line-roll', textContent: [`${list.length} employee${list.length === 1 ? '' : 's'}`, queued && `${queued} queued`, total && `${done} of ${total} cues`].filter(Boolean).join(' · ') }),
    h('span', { className: 'proj-line-keys' }, less, h('span', { className: 'proj-line-prio', textContent: `P${prio}`, title: 'Priority: the queue serves higher first' }), more,
      key(po?.paused ? 'Resume' : 'Pause', set({ paused: !po?.paused }), {
        className: `key key--sm${po?.paused ? ' key--lit' : ''}`, title: po?.paused ? 'Let its turns run again' : 'Stop its running turns and free its slots',
      })));
  line.style.setProperty('--proj', p.colour);
  return line;
}

const CEILINGS = [['', 'No ceiling'], ['haiku', 'Haiku'], ['sonnet', 'Sonnet'], ['opus', 'Opus']];

registerPanel('employees', {
  title: 'Employees',
  create(el) {
    el.classList.add('emps');
    const project = activeProject();
    const needs = h('section', { className: 'needs' });
    needs.setAttribute('aria-label', 'Needs you');
    // Across projects: usage per account, then one line per project.
    const usage = h('div', { className: 'cap-table gauge' });
    usage.setAttribute('aria-label', 'AI usage');
    const lines = h('div', { className: 'proj-lines' });
    lines.setAttribute('aria-label', 'Projects');
    const top = h('section', { className: 'org-top' },
      h('h2', { className: 'legend box-title', textContent: 'Usage · five-hour window' }), usage,
      h('h2', { className: 'legend box-title', textContent: 'Projects' }), lines);
    el.append(needs, top);

    const roll = h('span', { className: 'xpage-roll' });
    const list = h('div', { className: 'o-list' });
    const ceiling = h('select', { className: 'input select org-ceiling' }, ...CEILINGS.map(([v, l]) => new Option(l, v)));
    ceiling.setAttribute('aria-label', 'Model ceiling for this project');
    ceiling.title = 'A lead or auto mode picking a model above this waits for your approval';
    const depthNote = h('span', { className: 'capflag' });
    if (project) {
      ceiling.onchange = () => void api.org.setProject(project.id, { ceiling: ceiling.value ? { model: ceiling.value } : null });
      const page = h('details', { className: 'xpage', open: true },
        h('summary', { className: 'xpage-head' }, h('span', { className: 'xpage-name', textContent: project.name }), roll), list);
      page.style.setProperty('--proj', project.colour);
      el.append(h('div', { className: 'emps-bar' },
        h('label', { className: 'org-ceiling-field' }, h('span', { className: 'legend', textContent: 'Ceiling' }), ceiling), depthNote,
        key('Hire', () => void openHire(), { title: 'Hire an employee into this project' })), page);
    } else el.append(h('p', { className: 'files-note', textContent: 'No project open.' }));

    const emps = new Map<string, Employee>();
    const closed = new Set<string>();
    let org: OrgState | undefined;
    const draw = () => {
      const everyone = [...emps.values()];
      if (org) lines.replaceChildren(...allProjects().map((p) => projectLine(p, everyone.filter((e) => e.projectId === p.id), org!, p.id === project?.id)));
      if (!project) return;
      const all = everyone.filter((e) => e.projectId === project.id);
      list.replaceChildren(...tree(all, closed, org?.caps.maxReports ?? 3));
      if (!all.length) list.append(h('p', { className: 'files-note', textContent: 'No employees yet. Hire one to give it a task in its own worktree.' }));
      const working = all.filter((e) => e.state === 'working').length;
      const attention = all.filter((e) => ATTENTION.includes(e.state)).length;
      roll.textContent = [`${all.length} employee${all.length === 1 ? '' : 's'}`, working && `${working} working`, attention && `${attention} need${attention === 1 ? 's' : ''} you`].filter(Boolean).join(' · ');
      const po = org?.projects.find((p) => p.id === project.id);
      ceiling.value = po?.ceiling?.model ?? '';
      depthNote.textContent = `Max depth ${po?.maxDepth ?? 3}`;
    };
    const readings = new Map<string, Usage>(); // newest from the usage event, which can beat accounts.list()
    const drawUsage = async () => {
      const accounts = await api.accounts.list().catch(() => []);
      usage.replaceChildren(...accounts.flatMap((a) => gauge({ ...a, usage: readings.get(a.id) ?? a.usage })));
    };

    let seq = 0;
    const drawNeeds = async () => {
      const n = ++seq;
      const [pending, everyone, forges] = await Promise.all([api.approvals.list(), api.employees.list(), api.forge.issues().catch(() => [])]);
      if (n !== seq) return;
      const drafts = forges.flatMap((f) => f.drafts.map((d) => draftCard(f, d)));
      needs.hidden = !pending.length && !drafts.length;
      needs.replaceChildren(h('h2', { className: 'needs-title', textContent: `Needs you · ${pending.length + drafts.length}` }), ...pending.map((a) => {
        const e = everyone.find((x) => x.id === a.employeeId);
        const p = allProjects().find((x) => x.id === e?.projectId);
        return needCard(a, `${p?.name ?? (e?.projectId === 'mac' ? 'This Mac' : '?')} / ${e?.name ?? a.employeeId}`, p?.colour);
      }), ...drafts);
    };

    void Promise.all([api.employees.list(), api.org.get()]).then(([all, o]) => { org = o; all.forEach((e) => emps.set(e.id, e)); draw(); });
    void drawNeeds();
    void drawUsage();
    const offs = [
      api.employees.onChange((e) => { emps.set(e.id, e); draw(); }),
      api.employees.onRemoved((id) => { emps.delete(id); draw(); }),
      api.approvals.onChange(() => void drawNeeds()),
      api.forge.onChange(() => void drawNeeds()),
      api.org.onChange((o) => { org = o; draw(); }),
      api.accounts.onUsage((id, u) => { readings.set(id, u); void drawUsage(); }),
    ];
    return { dispose: () => offs.forEach((off) => off()) };
  },
});

// Banner under the top bar when Claude Code is missing or untested.
const banner = document.getElementById('claude-banner');
if (banner) {
  void api.claude.info().then((i) => {
    banner.textContent = !i.version ? 'Install Claude Code to use employees.' : i.tested ? '' : `Untested Claude Code version ${i.version}; tested with ${i.testedVersion}.`;
    banner.hidden = !banner.textContent;
  }).catch(() => {});
}

// A notification click opens the employee.
api.employees.onOpen(openEmployee);
