import { h, key } from './dom';
import { openHire } from './hire';
import { activeProject, allProjects } from './projects';
import { openPanel, registerPanel } from './registry';
import type { DockviewPanelApi } from 'dockview-core';
import type { Employee, EmployeeState } from '../main/employees';

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
export function chip(e: Pick<Employee, 'model' | 'effort'>): HTMLSpanElement {
  const c = h('span', { className: 'chip', title: 'Model · effort' }, h('span', { className: 'chip-model', textContent: cap(e.model) }));
  if (e.effort && hasEffort(e.model)) c.append(h('span', { className: 'chip-effort', textContent: e.effort === 'xhigh' ? 'XHigh' : cap(e.effort) }));
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

function row(e: Employee): HTMLElement {
  const r = h('div', { className: 'o-row' });
  r.dataset.state = e.state;
  r.dataset.id = e.id;
  const { count, text } = cue(e);
  r.append(
    h('span', { className: 'o-strip' }, h('button', { type: 'button', className: 'o-name', textContent: e.name, title: `Open ${e.name}`, onclick: () => openEmployee(e.id) })),
    h('span', { className: 'o-role', textContent: e.role }),
    h('span', { className: 'o-chip' }, chip(e)),
    h('span', { className: 'o-cue', title: text }, h('span', { className: 'o-cue-count', textContent: count }), ' ', h('span', { className: 'o-cue-text', textContent: text })),
    h('span', { className: 'o-steps' }, steps(e)),
    h('span', { className: 'o-state' }, led(e.state)),
  );
  return r;
}

const ATTENTION: EmployeeState[] = ['needs-you', 'failed', 'interrupted'];

registerPanel('employees', {
  title: 'Employees',
  create(el) {
    el.classList.add('emps');
    const project = activeProject();
    const needs = h('section', { className: 'needs' });
    needs.setAttribute('aria-label', 'Needs you');
    el.append(needs);
    if (!project) { el.append(h('p', { className: 'files-note', textContent: 'No project open.' })); return {}; }

    const roll = h('span', { className: 'xpage-roll' });
    const list = h('div', { className: 'o-list' });
    const page = h('details', { className: 'xpage', open: true },
      h('summary', { className: 'xpage-head' }, h('span', { className: 'xpage-name', textContent: project.name }), roll), list);
    page.style.setProperty('--proj', project.colour);
    el.append(h('div', { className: 'emps-bar' }, key('Hire', () => void openHire(), { title: 'Hire an employee into this project' })), page);

    const emps = new Map<string, Employee>();
    const draw = () => {
      const all = [...emps.values()].sort((a, b) => a.name.localeCompare(b.name));
      list.replaceChildren(...all.map(row));
      if (!all.length) list.append(h('p', { className: 'files-note', textContent: 'No employees yet. Hire one to give it a task in its own worktree.' }));
      const working = all.filter((e) => e.state === 'working').length;
      const attention = all.filter((e) => ATTENTION.includes(e.state)).length;
      roll.textContent = [`${all.length} employee${all.length === 1 ? '' : 's'}`, working && `${working} working`, attention && `${attention} need${attention === 1 ? 's' : ''} you`].filter(Boolean).join(' · ');
    };

    let seq = 0;
    const drawNeeds = async () => {
      const n = ++seq;
      const [pending, everyone] = await Promise.all([api.approvals.list(), api.employees.list()]);
      if (n !== seq) return;
      needs.hidden = !pending.length;
      needs.replaceChildren(h('h2', { className: 'needs-title', textContent: `Needs you · ${pending.length}` }), ...pending.map((a) => {
        const e = everyone.find((x) => x.id === a.employeeId);
        const p = allProjects().find((x) => x.id === e?.projectId);
        return needCard(a, `${p?.name ?? '?'} / ${e?.name ?? a.employeeId}`, p?.colour);
      }));
    };

    void api.employees.list(project.id).then((all) => { all.forEach((e) => emps.set(e.id, e)); draw(); });
    void drawNeeds();
    const offs = [
      api.employees.onChange((e) => {
        if (e.projectId !== project.id) return;
        emps.set(e.id, e);
        draw();
      }),
      api.employees.onRemoved((id) => { emps.delete(id); draw(); }),
      api.approvals.onChange(() => void drawNeeds()),
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
