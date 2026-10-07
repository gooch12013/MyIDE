// To-dos panel: the personal list, This Mac assignments (plan, GO, log, journal) and promotion to an issue,
// a project employee or a schedule.
import type { Todo } from '../main/todos';
import { scheduleForm } from './buttons';
import { ask, errText, h, key } from './dom';
import { cue, led, openEmployee, type Employee } from './employees';
import { openHire } from './hire';
import { openNewIssue } from './issues';
import { activeProject } from './projects';
import { showEmployeesAll } from './layouts';
import { registerPanel } from './registry';
import { micButton } from './speech';

const api = window.myide;
type Approval = Awaited<ReturnType<typeof api.approvals.list>>[number];
const MAC_ROLES = ['sysadmin', 'lab-ops', 'assistant', 'desktop'];
const CHECKING: Record<string, string> = { desktop: 'needs checking: GUI computer use only in an interactive Talk session' };
const PRIO = ['high', 'normal', 'low'] as const;
const rank = (t: Todo) => [Number(t.done), PRIO.indexOf(t.priority), t.due ?? '9999', t.createdAt] as const;
const byRank = (a: Todo, b: Todo) => { const x = rank(a), y = rank(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return 0; };

function dueTag(due?: string): HTMLElement | '' {
  if (!due) return '';
  const days = Math.round((new Date(`${due}T00:00`).getTime() - new Date(new Date().toDateString()).getTime()) / 86_400_000);
  if (days > 3) return '';
  return h('span', { className: days < 0 ? 'td-overdue' : 'td-soon', textContent: days < 0 ? `Overdue ${-days} d` : days === 0 ? 'Today' : `In ${days} d` });
}

/** Unified diff with removed and added lines marked. */
const diffView = (text: string) => h('pre', { className: 'td-diff' }, ...(text || 'No change since the snapshot.').split('\n').flatMap((l, i) => [
  ...(i ? ['\n'] : []), h('span', { className: l.startsWith('-') && !l.startsWith('---') ? 'is-del' : l.startsWith('+') && !l.startsWith('+++') ? 'is-add' : '', textContent: l }),
]));

registerPanel('todos', {
  title: 'To-dos',
  description: 'Your personal list, and This Mac jobs that run on GO.',
  create(el) {
    el.classList.add('todos');
    const input = h('input', { className: 'input td-add-input', placeholder: 'Add a to-do', spellcheck: false, autocomplete: 'off' });
    input.setAttribute('aria-label', 'Add a to-do');
    const status = h('p', { className: 'pref-warn td-status' });
    status.setAttribute('aria-live', 'polite');
    const say = (t: string) => { status.textContent = t; };
    const add = h('form', { className: 'td-add' }, h('span', { className: 'td-add-ic', textContent: '+' }), input, micButton(input, (t) => say(t)),
      h('span', { className: 'td-add-hint' }, 'Enter adds · ', h('b', { textContent: '#tag' }), ' · ', h('b', { textContent: '@sysadmin' }), ' assigns'));
    add.onsubmit = async (ev) => {
      ev.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.disabled = true;
      try { const r = await api.todos.add(text); input.value = ''; say(r.error ?? ''); if (r.todo.employeeId) open.add(r.todo.id); }
      catch (e) { say(errText(e)); } finally { input.disabled = false; input.focus(); }
    };
    const staff = h('div', { className: 'td-staff' });
    const list = h('ul', { className: 'iss-list td-list' });
    list.setAttribute('aria-label', 'To-dos');
    el.append(add, status, staff, list);

    let todos: Todo[] = [];
    let roles: { name: string; description: string }[] = [];
    let pending: Approval[] = [];
    const emps = new Map<string, Employee>();
    const open = new Set<string>(); // to-dos with their detail showing
    const diffs = new Map<string, string>(); // `${todo} ${path}` -> diff text, while shown
    const logs = new Map<string, string>();

    const drawStaff = () => {
      const missing = MAC_ROLES.filter((r) => !roles.some((x) => x.name === r));
      staff.replaceChildren(h('span', { className: 'legend', textContent: 'This Mac' }),
        ...roles.filter((r) => MAC_ROLES.includes(r.name)).map((r) => h('span', { className: 'iss-label td-role', title: r.description, textContent: r.name }, ...(CHECKING[r.name] ? [h('span', { className: 'td-checking', title: CHECKING[r.name], textContent: 'Needs checking' })] : []))),
        ...(missing.length ? [key('Install This Mac roles', async () => { try { say(await api.todos.installRoles()); await loadRoles(); } catch (e) { say(errText(e)); } },
          { title: `Copies ${missing.join(', ')} into ~/.claude/agents (never over a file already there)` })] : []));
    };

    function detail(t: Todo, e?: Employee): HTMLElement {
      const box = h('div', { className: 'td-detail' });
      if (e) {
        const c = cue(e);
        box.append(h('p', { className: 'td-note' }, led(e.state), h('button', { type: 'button', className: 'iss-emp', textContent: e.name, onclick: () => openEmployee(e.id) }),
          h('span', { textContent: [c.count, c.text].filter(Boolean).join(' · ') })));
        if (e.lastText && e.state !== 'needs-you') box.append(h('pre', { className: 'need-plan td-last', textContent: e.lastText }));
      } else box.append(h('p', { className: 'files-note', textContent: 'On your list only. Assign it to a This Mac employee to plan it, or promote it.' }));

      const planAsk = e && pending.find((a) => a.employeeId === e.id && a.kind === 'plan');
      if (e?.plan) {
        const ready = !e.plan.approvedAt && !!planAsk;
        box.append(h('h3', { className: 'legend', textContent: e.plan.approvedAt ? `Plan · GO at ${new Date(e.plan.approvedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Plan' }),
          h('pre', { className: 'need-plan', textContent: e.plan.text }));
        if (ready) {
          box.append(h('p', { className: 'pref-hint' }, h('b', { textContent: 'On GO only these commands are allowed, once each: ' }),
            e.plan.commands.length ? e.plan.commands.join(' · ') : 'none (every command will ask you).',
            ' Anything else stops and comes back to you. Files outside a git repo are snapshotted to ~/.myide/journal before they change.'),
            h('div', { className: 'need-keys' },
              key('Run this plan', () => void api.approvals.resolve(planAsk!.id, true).catch((x) => say(errText(x))), { className: 'key key--go td-go' }),
              key('Reject', () => void api.approvals.resolve(planAsk!.id, false, 'David rejected this plan.').catch((x) => say(errText(x))))));
        }
      }
      // Other things the employee waits on (a command outside the plan, a question) answer in the Employees panel.
      const other = e ? pending.filter((a) => a.employeeId === e.id && a.kind !== 'plan') : [];
      if (other.length) box.append(h('p', { className: 'td-note' }, led('needs-you', 'Needs you'), `${other.length} waiting: ${other.map((a) => a.text ?? a.tool).join(' · ').slice(0, 300)}`,
        key('Open', showEmployeesAll)));

      box.append(h('h3', { className: 'legend', textContent: 'Log' }), h('pre', { className: 'need-input td-log', textContent: logs.get(t.id) || 'Nothing run yet.' }));
      const paths = [...new Set(t.journal.map((j) => j.path))];
      box.append(h('h3', { className: 'legend', textContent: 'Files' }));
      if (!paths.length) box.append(h('p', { className: 'files-note', textContent: 'No files changed. Any edit outside a git repo is snapshotted here first.' }));
      for (const p of paths) {
        const s = t.journal.find((j) => j.path === p)!;
        const k = `${t.id} ${p}`;
        const row = h('div', { className: 'td-file' }, h('span', { className: 'path', textContent: p }),
          h('span', { className: 'files-note', textContent: `${s.existed ? 'Snapshot' : 'New file'} ${new Date(s.at).toLocaleString()} · ${s.commit.slice(0, 8)}` }),
          h('span', { className: 'need-keys' },
            key(diffs.has(k) ? 'Hide diff' : 'Diff', async () => {
              if (diffs.has(k)) diffs.delete(k); else { try { diffs.set(k, await api.todos.diff(t.id, p)); } catch (x) { say(errText(x)); } }
              draw();
            }),
            key('Roll back', async () => {
              if (!(await ask('Roll back', `Put ${p} back as it was before this to-do? Its current state is kept in the journal.`, 'Roll back', true))) return;
              try { await api.todos.rollback(t.id, p); diffs.delete(k); say(`Rolled back ${p}.`); await loadLog(t.id); } catch (x) { say(errText(x)); }
            }),
            ...(t.undo?.some((u) => u.path === p) ? [key('Undo rollback', async () => {
              try { await api.todos.undoRollback(t.id, p); diffs.delete(k); say(`Put ${p} back as it was before the rollback.`); await loadLog(t.id); } catch (x) { say(errText(x)); }
            })] : [])));
        if (diffs.has(k)) row.append(diffView(diffs.get(k)!));
        box.append(row);
      }

      const project = activeProject();
      const macTodo = !!t.role && (MAC_ROLES.includes(t.role) || e?.projectId === 'mac');
      box.append(h('div', { className: 'need-keys td-promote' }, h('span', { className: 'legend', textContent: 'Promote' }),
        key('Make it an issue', () => void openNewIssue(project?.id, t.text)),
        key('Give to a project employee', () => void openHire({ task: t.text, onHired: (x) => void api.todos.update(t.id, { employeeId: x.id, role: x.role }) }),
          { disabled: !project, title: project ? `Hire into ${project.name}` : 'Open a project first' }),
        key('Make it recurring', async () => {
          // A schedule would run This Mac work unattended, and This Mac only acts on a plan David approved with GO.
          if (macTodo) return say('A This Mac to-do cannot be recurring: its runs need your GO on each plan. Make it recurring without the role, or give it to a project employee.');
          try {
            const b = await api.buttons.save({ label: t.text.slice(0, 40), command: t.text, target: t.role ? { role: t.role } : 'lead', scope: 'global' });
            scheduleForm({ buttonId: b.id }, (await api.buttons.list(project?.id)).buttons, () => say('Scheduled. Edit the button in the Buttons panel to change who runs it.'));
          } catch (x) { say(errText(x)); }
        }, { title: macTodo ? 'Not for This Mac to-dos: each run needs your GO' : 'A button with this to-do as its command, then a schedule for it' }),
        key('Delete', async () => { if (await ask('Delete to-do', `Delete "${t.text}"?`, 'Delete', true)) void api.todos.remove(t.id); })));
      return box;
    }

    function row(t: Todo): HTMLElement {
      const e = t.employeeId ? emps.get(t.employeeId) : undefined;
      const li = h('li', { className: `iss-row td-row${t.done ? ' is-complete' : ''}` });
      if (e?.plan && !e.plan.approvedAt && pending.some((a) => a.employeeId === e.id && a.kind === 'plan')) li.dataset.st = 'ready';
      const done = h('input', { type: 'checkbox', className: 'td-check', checked: t.done, onchange: () => void api.todos.update(t.id, { done: done.checked }) });
      done.setAttribute('aria-label', `Done: ${t.text}`);
      const title = h('button', { type: 'button', className: 'iss-title td-title', textContent: t.text, onclick: () => { if (!open.delete(t.id)) { open.add(t.id); void loadLog(t.id); } draw(); } });
      title.setAttribute('aria-expanded', String(open.has(t.id)));
      const prio = h('select', { className: 'select', onchange: () => void api.todos.update(t.id, { priority: prio.value as Todo['priority'] }) },
        ...PRIO.map((p) => new Option(p[0].toUpperCase() + p.slice(1), p, false, p === t.priority)));
      prio.setAttribute('aria-label', 'Priority');
      const due = h('input', { type: 'date', className: 'input', value: t.due ?? '', onchange: () => void api.todos.update(t.id, { due: due.value }) });
      due.setAttribute('aria-label', 'Due date');
      const assign = h('select', { className: 'select td-assign', onchange: async () => {
        assign.disabled = true;
        try { await api.todos.assign(t.id, assign.value); open.add(t.id); } catch (x) { say(errText(x)); } finally { assign.disabled = false; }
      } }, new Option(e ? 'Reassign…' : 'Assign to…', '', true, true), ...roles.filter((r) => MAC_ROLES.includes(r.name) || r.name === t.role).map((r) => new Option(`This Mac · ${r.name}${CHECKING[r.name] ? ' (needs checking)' : ''}`, r.name)));
      assign.setAttribute('aria-label', 'Assign to a This Mac employee');
      const meta = h('div', { className: 'iss-line iss-line--meta td-meta' },
        h('span', { className: 'iss-labels' }, ...t.tags.map((g) => h('span', { className: 'iss-label', textContent: g })), dueTag(t.done ? undefined : t.due)),
        ...(e ? [led(e.state, e.state === 'needs-you' && li.dataset.st === 'ready' ? 'Plan ready' : undefined), h('span', { className: 'td-cue', textContent: cue(e).count })] : []),
        e ? h('button', { type: 'button', className: 'iss-emp', textContent: e.name, onclick: () => openEmployee(e.id) })
          : h('span', { className: 'iss-emp is-none', textContent: t.employeeId ? 'Employee gone' : 'Yours' }),
        h('span', { className: 'iss-actions' }, ...(t.done ? [] : [assign])));
      li.append(h('div', { className: 'iss-line' }, done, title, h('label', { className: 'td-prio' }, prio), h('label', { className: 'td-due' }, due)), meta);
      li.dataset.prio = t.priority;
      if (open.has(t.id)) li.append(detail(t, e));
      return li;
    }

    function draw(): void {
      list.replaceChildren(...[...todos].sort(byRank).map(row));
      if (!todos.length) list.append(h('li', { className: 'iss-empty', textContent: 'Nothing on the list. Add one above.' }));
    }

    async function loadLog(id: string): Promise<void> { logs.set(id, await api.todos.log(id).catch(() => '')); draw(); }
    async function loadRoles(): Promise<void> { roles = await api.employees.roles('mac').catch(() => []); drawStaff(); draw(); }
    async function load(): Promise<void> {
      todos = await api.todos.list();
      for (const id of open) void loadLog(id);
      draw();
    }
    void Promise.all([api.employees.list(), api.approvals.list()]).then(([all, p]) => { all.forEach((x) => emps.set(x.id, x)); pending = p; return load(); });
    void loadRoles();
    const offs = [
      api.todos.onChange(() => void load()),
      api.employees.onChange((x) => { emps.set(x.id, x); if (todos.some((t) => t.employeeId === x.id)) { for (const t of todos) if (t.employeeId === x.id && open.has(t.id)) void loadLog(t.id); draw(); } }),
      api.employees.onRemoved((id) => { emps.delete(id); draw(); }),
      api.approvals.onChange((p) => { pending = p; draw(); }),
    ];
    return { dispose: () => offs.forEach((off) => off()), onShow: () => void loadRoles() };
  },
});
