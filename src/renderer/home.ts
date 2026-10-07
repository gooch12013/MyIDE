// The dashboard as small panels (Home's console, but they go on any tab): NEEDS YOU keys, project pages of
// executor cells, usage meters, slots, macro keys and the command line. Plus the + key's list of every panel type.
import type { Button, PaletteItem } from '../main/buttons';
import type { Project } from '../main/projects';
import type { Usage } from '../main/org';
import type { OrgState } from '../preload/preload';
import { buttonForm, runButton } from './buttons';
import { byName, complete, parse, USAGE, type Command } from './command';
import { h, key, sheet } from './dom';
import { chip, cueOf, gauge, led, meterBar, needCard, openEmployee, projectLine, steps, type Employee } from './employees';
import { draftCard } from './issues';
import { activeTab, allProjects, scopeOf } from './projects';
import { addableTypes, openPanel, registerPanel } from './registry';

const api = window.myide;
type Approval = Awaited<ReturnType<typeof api.approvals.list>>[number];
type Scope = ReturnType<typeof scopeOf>;
const MAC = { id: 'mac', name: 'This Mac', colour: '#8fa3b8' };
const projectOf = (id?: string) => allProjects().find((p) => p.id === id) ?? (id === MAC.id ? MAC : undefined);
const inScope = (s: Scope, projectId?: string) => s.all || (!!s.project && projectId === s.project.id);
const shown = (s: Scope): Project[] => (s.all ? allProjects() : s.project ? [s.project] : []);
const none = (text: string) => h('p', { className: 'files-note', textContent: text });
/** Subscriptions to drop when the panel closes. */
const disposer = (offs: (() => void)[]) => ({ dispose: () => offs.forEach((off) => off()) });

/** GO: approve what the employee waits on, or pick a stopped turn back up. Resolves to what to tell David. */
async function go(e: Employee, pending: Approval[]): Promise<string> {
  const a = pending.find((x) => x.employeeId === e.id);
  if (a?.kind === 'question') return `${e.name} asks a question: answer it in Needs you.`;
  if (a) { await api.approvals.resolve(a.id, true); return `GO ${e.name}: approved ${a.kind === 'plan' ? 'the plan' : a.tool}.`; }
  if (e.state !== 'failed' && e.state !== 'interrupted') return `${e.name} is ${e.state}; GO has nothing to start.`;
  await api.employees.send(e.id, 'Continue.');
  return `GO ${e.name}: continuing.`;
}
const canGo = (e: Employee, pending: Approval[]) => pending.some((a) => a.employeeId === e.id && a.kind !== 'question') || e.state === 'failed' || e.state === 'interrupted';

// NEEDS YOU: one lit key per approval, question, plan and drafted issue; a key opens its card to act on inline.
const KIND = { permission: 'Approve', plan: 'Approve plan', question: 'Question' };
registerPanel('needs', {
  title: 'Needs you',
  description: 'A key for each approval, question, plan and drafted issue; answer inline.',
  scoped: true,
  create(el, params) {
    const s = scopeOf(params);
    el.classList.add('home-panel');
    const row = h('div', { className: 'go-row' });
    row.setAttribute('aria-label', 'Needs you');
    const detail = h('div', { className: 'go-detail' });
    el.append(row, detail);
    const cards = new Map<string, HTMLElement>(); // kept across redraws, so a half-typed answer survives
    let open = '';
    let seq = 0;
    const draw = async () => {
      const n = ++seq;
      const [pending, everyone, forges] = await Promise.all([api.approvals.list(), api.employees.list(), api.forge.issues().catch(() => [])]);
      if (n !== seq) return;
      const items: { id: string; state: string; label: string; who: string; why: string; card: () => HTMLElement }[] = [];
      for (const a of pending) {
        const e = everyone.find((x) => x.id === a.employeeId);
        if (!inScope(s, e?.projectId)) continue;
        const who = `${projectOf(e?.projectId)?.name ?? '?'} / ${e?.name ?? a.employeeId}`;
        items.push({ id: a.id, state: 'needs-you', label: KIND[a.kind], who, why: a.text ?? `Wants to use ${a.tool}`, card: () => needCard(a, who, projectOf(e?.projectId)?.colour) });
      }
      for (const f of forges) {
        if (!inScope(s, f.projectId)) continue;
        for (const d of f.drafts) items.push({ id: d.id, state: 'done', label: 'Drafted issue', who: `${projectOf(f.projectId)?.name ?? '?'} / ${d.employeeName}`, why: d.title, card: () => draftCard(f, d) });
      }
      for (const k of cards.keys()) if (!items.some((i) => i.id === k)) cards.delete(k);
      if (!items.some((i) => i.id === open)) open = '';
      row.replaceChildren(...items.map((i) => {
        const b = h('button', { type: 'button', className: 'go-key is-flashing', onclick: () => { open = open === i.id ? '' : i.id; void draw(); } },
          led(i.state, i.label), h('span', { className: 'go-who', textContent: i.who }), h('span', { className: 'go-why', textContent: i.why }));
        b.dataset.kind = i.state === 'done' ? 'done' : 'needs';
        b.setAttribute('aria-expanded', String(open === i.id));
        return b;
      }), h('p', { className: 'go-empty', textContent: 'Nothing needs you. A key lights here when an employee asks, has a plan, or drafts an issue.' }));
      const item = items.find((i) => i.id === open);
      if (item && !cards.has(item.id)) cards.set(item.id, item.card());
      detail.replaceChildren(...(item ? [cards.get(item.id)!] : []));
    };
    void draw();
    return disposer([api.approvals.onChange(() => void draw()), api.forge.onChange(() => void draw()), api.employees.onChange(() => void draw())]);
  },
});

/** One executor cell: scribble strip, LED and model chip, the current cue with n of m, then GO and Pause. */
function cell(e: Employee, num: string, everyone: Employee[], pending: Approval[], say: (t: string) => void): HTMLElement {
  const lamp = led(pending.some((a) => a.employeeId === e.id) ? 'needs-you' : e.state);
  const { count, text } = cueOf(e, everyone);
  const parent = everyone.find((x) => x.id === e.parentId);
  const rank = e.contractor ? 'Contractor' : e.lead ? 'Lead' : parent ? 'Report' : '';
  const goKey = key('GO', () => void go(e, pending).then(say, (x) => say(String(x))), { className: `key${canGo(e, pending) ? ' key--go' : ''}`, disabled: !canGo(e, pending) });
  goKey.setAttribute('aria-label', `GO ${e.name}`);
  const pause = key('Pause', () => void api.employees.interrupt(e.id).then(() => say(`Paused ${e.name}.`)), { className: 'key', disabled: e.state !== 'working' });
  pause.setAttribute('aria-label', `Pause ${e.name}`);
  const c = h('article', { className: `exec${e.contractor ? ' exec--contractor' : ''}` },
    h('header', { className: 'scribble' }, h('span', { className: 'scribble-num', textContent: num }),
      h('button', { type: 'button', className: 'scribble-name', textContent: e.name, title: `Open ${e.name}`, onclick: () => void openEmployee(e.id) }),
      h('span', { className: 'scribble-role' }, ...(rank ? [h('span', { className: 'rank', textContent: rank })] : []), e.role, parent ? ` · to ${parent.name}` : '')),
    h('div', { className: 'exec-body' },
      h('div', { className: 'exec-row' }, lamp, chip(e)),
      h('div', { className: 'cue-now' }, h('span', { className: 'cue-count', textContent: count || (e.progress ? '' : 'No cue list') }), h('span', { className: 'cue-text', textContent: text || 'Assign a task or run a macro to start' })),
      ...(e.progress?.total ? [steps(e)] : []),
      ...(e.progress?.next.length ? [h('ol', { className: 'cue-left' }, ...e.progress.next.slice(0, 2).map((t) => h('li', { textContent: t })))] : [])),
    h('div', { className: 'exec-keys' }, goKey, pause));
  c.dataset.state = lamp.dataset.state!;
  return c;
}

// Project pages: one fold per project with staff, an executor cell per employee.
registerPanel('pages', {
  title: 'Pages',
  description: 'A page per project with an executor cell per employee: cue, model, GO and Pause.',
  scoped: true,
  create(el, params) {
    const s = scopeOf(params);
    el.classList.add('home-panel');
    const status = h('p', { className: 'btn-status' });
    status.setAttribute('aria-live', 'polite');
    const pages = h('div', { className: 'xpages' });
    el.append(status, pages);
    const shut = new Set<string>();
    let org: OrgState | undefined;
    let everyone: Employee[] = [];
    let pending: Approval[] = [];
    const say = (t: string) => { status.textContent = t; };
    const draw = () => {
      const ps = shown(s).filter((p) => !s.all || everyone.some((e) => e.projectId === p.id));
      pages.replaceChildren(...ps.map((p) => {
        const page = allProjects().indexOf(p) + 1;
        const staff = everyone.filter((e) => e.projectId === p.id).sort((a, b) => a.depth - b.depth || Number(!!b.lead) - Number(!!a.lead) || a.name.localeCompare(b.name));
        const po = org?.projects.find((x) => x.id === p.id);
        const running = staff.filter((e) => e.state === 'working').length;
        const needs = staff.filter((e) => pending.some((a) => a.employeeId === e.id) || e.state === 'needs-you' || e.state === 'failed').length;
        const d = h('details', { className: 'xpage', open: !shut.has(p.id) },
          h('summary', { className: 'xpage-head' }, h('span', { className: 'xpage-name', textContent: p.name }),
            h('span', { className: 'xpage-meta', textContent: `Page ${page} · priority ${po?.priority ?? 0}` }),
            po?.paused ? led('interrupted', 'Paused') : needs ? led('needs-you', `${needs} need${needs === 1 ? 's' : ''} you`) : running ? led('working', `${running} working`) : led('idle', 'Idle'),
            h('span', { className: 'xpage-roll', textContent: `${staff.length} employee${staff.length === 1 ? '' : 's'} · ${running} of ${org?.caps.perProject ?? '?'} slots` })),
          h('div', { className: 'exec-grid' }, ...staff.map((e, i) => cell(e, `${page}.${String(i + 1).padStart(2, '0')}`, everyone, pending, say))));
        if (!staff.length) d.append(none('No employees yet. Hire one, or type hire in the command line.'));
        d.style.setProperty('--proj', p.colour);
        d.addEventListener('toggle', () => { if (d.open) shut.delete(p.id); else shut.add(p.id); });
        return d;
      }));
      if (!ps.length) pages.append(none(s.all ? 'No employees in any project yet.' : 'No project in this scope.'));
    };
    void Promise.all([api.employees.list(), api.approvals.list(), api.org.get()]).then(([e, a, o]) => { everyone = e; pending = a; org = o; draw(); });
    const reload = () => void api.employees.list().then((e) => { everyone = e; draw(); });
    window.addEventListener('myide:projects', draw);
    return disposer([
      api.employees.onChange(reload), api.employees.onRemoved(reload),
      api.approvals.onChange((a) => { pending = a; draw(); }),
      api.org.onChange((o) => { org = o; draw(); }),
      () => window.removeEventListener('myide:projects', draw),
    ]);
  },
});

// Usage: one meter per AI account. Accounts are not per project, so this panel has no scope.
registerPanel('usage', {
  title: 'Usage',
  description: 'Five-hour usage per AI account, with the slow-down mark.',
  create(el) {
    el.classList.add('home-panel');
    const table = h('div', { className: 'cap-table gauge' });
    table.setAttribute('aria-label', 'AI usage, five-hour window');
    el.append(h('h2', { className: 'legend box-title', textContent: 'AI accounts · five-hour window' }), table);
    const readings = new Map<string, Usage>();
    const draw = async () => {
      const accounts = await api.accounts.list().catch(() => []);
      table.replaceChildren(...accounts.flatMap((a) => gauge({ ...a, usage: readings.get(a.id) ?? a.usage })));
      if (!accounts.length) table.append(none('No AI accounts yet. Add one in Preferences > AI accounts.'));
    };
    void draw();
    return disposer([api.accounts.onUsage((id, u) => { readings.set(id, u); void draw(); })]);
  },
});

// Slots: the global cap, then each project's slots, priority and pause.
registerPanel('slots', {
  title: 'Slots',
  description: 'Running slots against the caps, with each project\'s priority and pause.',
  scoped: true,
  create(el, params) {
    const s = scopeOf(params);
    el.classList.add('home-panel');
    const total = h('div', { className: 'cap-table gauge' });
    const lines = h('div', { className: 'proj-lines' });
    el.append(total, lines);
    let org: OrgState | undefined;
    let everyone: Employee[] = [];
    const draw = () => {
      if (!org) return;
      const running = everyone.filter((e) => e.state === 'working').length;
      const max = org.caps.global;
      total.replaceChildren(h('span', { className: 'cap-name', textContent: 'All projects' }),
        meterBar(Math.min(100, (running / max) * 100), 'Concurrent employees, global cap', { now: running, max, segs: max, cls: `meter--slots${running >= max ? ' is-full' : ''}` }),
        h('span', { className: 'cap-val', textContent: `${running}/${max}` }));
      lines.replaceChildren(...shown(s).map((p) => projectLine(p, everyone.filter((e) => e.projectId === p.id), org!, p.id === activeTab()?.id)));
      if (!lines.children.length) lines.append(none('No project in this scope.'));
    };
    void Promise.all([api.employees.list(), api.org.get()]).then(([e, o]) => { everyone = e; org = o; draw(); });
    const reload = () => void api.employees.list().then((e) => { everyone = e; draw(); });
    window.addEventListener('myide:projects', draw);
    return disposer([api.employees.onChange(reload), api.employees.onRemoved(reload), api.org.onChange((o) => { org = o; draw(); }),
      () => window.removeEventListener('myide:projects', draw)]);
  },
});

// Macros: the scope's buttons as keys. All projects: the global buttons, which need a project to run in.
const targetText = (b: Button, p: Project | null) => `${b.target === 'lead' ? 'lead' : b.target === 'selected' ? 'selected' : `new ${b.target.role}`}${p ? ` · ${p.name}` : ''}`;
registerPanel('macros', {
  title: 'Macros',
  description: 'The scope\'s buttons as macro keys.',
  scoped: true,
  create(el, params) {
    const { project } = scopeOf(params);
    el.classList.add('home-panel');
    const row = h('div', { className: 'macro-row' });
    row.setAttribute('aria-label', 'Macro keys');
    const status = h('p', { className: 'btn-status' });
    status.setAttribute('aria-live', 'polite');
    el.append(row, status);
    let palette: PaletteItem[] = [];
    const load = async () => {
      const r = await api.buttons.list(project?.id);
      palette = r.palette;
      row.replaceChildren(...r.buttons.map((b) => {
        const k = h('button', { type: 'button', className: 'key key--macro', title: b.command,
          onclick: async () => { const t = await runButton(b, project); if (t) status.textContent = t; } },
        h('span', { className: 'macro-cmd', textContent: b.label }), h('span', { className: 'macro-target', textContent: targetText(b, project) }));
        if (b.scope === 'project' && project) k.style.setProperty('--proj', project.colour);
        return k;
      }), h('button', { type: 'button', className: 'key key--macro key--new', textContent: '+ New macro', onclick: () => void buttonForm({}, palette, () => void load(), project) }));
    };
    void load();
    return {};
  },
});

// Command line: issue, todo, assign, hire, go, pause/resume, help. It runs the same calls as the panels.
registerPanel('cmdline', {
  title: 'Command line',
  description: 'Type issue, todo, assign, hire, go or pause, with Tab completion and a log.',
  scoped: true,
  create(el, params) {
    const s = scopeOf(params);
    el.classList.add('home-panel', 'cmdline');
    const log = h('ol', { className: 'cmdline-log' });
    log.setAttribute('aria-live', 'polite');
    const list = h('datalist', { id: `cmd-${crypto.randomUUID().slice(0, 8)}` });
    const input = h('input', { className: 'cmdline-input', autocomplete: 'off', spellcheck: false, placeholder: s.project ? `assign ${s.project.name}/<employee> "task"` : 'issue <project> "title" · help' });
    input.setAttribute('list', list.id);
    input.setAttribute('aria-label', 'Command');
    const form = h('form', { className: 'cmdline-row' }, h('span', { className: 'cmdline-prompt', textContent: 'MyIDE>' }), input, list, h('button', { className: 'key key--sm', type: 'submit', textContent: 'Enter' }));
    el.append(log, form);
    const out = (text: string, cls: string) => {
      log.append(h('li', { className: cls, textContent: text }));
      while (log.children.length > 50) log.firstElementChild!.remove();
      log.scrollTop = log.scrollHeight;
    };

    let everyone: Employee[] = [];
    let roles: string[] = [];
    const ctx = () => ({
      projects: shown(s).map((p) => p.name),
      employees: Object.fromEntries(shown(s).map((p) => [p.name, everyone.filter((e) => e.projectId === p.id).map((e) => e.name)])),
      roles,
    });
    const load = async () => {
      everyone = await api.employees.list();
      roles = [...new Set((await Promise.all(shown(s).map((p) => api.employees.roles(p.id).catch(() => [])))).flat().map((r) => r.name))];
    };
    void load();

    const projectFor = (name?: string): Project => {
      const p = name === undefined ? s.project : byName(allProjects(), name);
      if (!p) throw new Error(name === undefined ? 'Which project? This panel shows all of them: name one.' : `No project called "${name}".`);
      return p;
    };
    const employeeFor = (c: { project?: string; employee: string }): Employee => {
      const p = projectFor(c.project);
      const e = byName(everyone.filter((x) => x.projectId === p.id), c.employee);
      if (!e) throw new Error(`${p.name} has no employee called "${c.employee}".`);
      return e;
    };
    const run = async (c: Command): Promise<string> => {
      switch (c.cmd) {
        case 'help': return Object.values(USAGE).join('\n');
        case 'issue': {
          const p = projectFor(c.project);
          const r = await api.forge.create({ projectId: p.id, title: c.title });
          return r.warning ?? `Filed #${r.number} in ${p.name}.`;
        }
        case 'todo': {
          const r = await api.todos.add(c.text);
          if (r.error) throw new Error(r.error);
          return `Added to-do "${r.todo.text}".`;
        }
        case 'assign': {
          const e = employeeFor(c);
          await api.employees.send(e.id, c.text);
          return `Sent to ${projectOf(e.projectId)?.name}/${e.name}.`;
        }
        case 'hire': {
          const p = projectFor(c.project);
          const role = (await api.employees.roles(p.id)).find((r) => r.name.toLowerCase() === c.role.toLowerCase());
          if (!role) throw new Error(`${p.name} has no role called "${c.role}".`);
          const e = await api.employees.hire({ projectId: p.id, role: role.name, task: c.text });
          return `Hired ${e.name} (${role.name}) in ${p.name}.`;
        }
        case 'go': return go(employeeFor(c), await api.approvals.list());
        case 'pause': case 'resume': {
          const p = projectFor(c.project);
          await api.org.setProject(p.id, { paused: c.cmd === 'pause' });
          return `${p.name} ${c.cmd === 'pause' ? 'paused' : 'resumed'}.`;
        }
      }
    };
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const line = input.value.trim();
      if (!line) return;
      out(`> ${line}`, 'is-echo');
      input.value = '';
      const c = parse(line);
      if ('error' in c) return out(c.error, 'is-err');
      try { out(await run(c), 'is-ok'); } catch (e) { out((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'is-err'); }
      void load();
    };
    // Suggestions as the line changes; Tab takes their common start.
    input.oninput = () => list.replaceChildren(...complete(input.value, ctx()).slice(0, 20).map((v) => new Option(v.trim(), v)));
    input.onkeydown = (ev) => {
      if (ev.key !== 'Tab') return;
      const opts = complete(input.value, ctx());
      if (!opts.length) return;
      ev.preventDefault();
      let common = opts[0];
      for (const o of opts) while (!o.startsWith(common)) common = common.slice(0, -1);
      if (common.length > input.value.length) input.value = common;
      else out(opts.map((o) => o.trim()).join('   '), '');
    };
    return disposer([api.employees.onChange(() => void load())]);
  },
});

// The + key and View > Panels > Add Panel…: every panel type, one line each; a pick adds it to the shown tab.
function addPanel(): void {
  const tab = activeTab();
  if (!tab) return;
  const form = h('form', { method: 'dialog', className: 'add-panel' }, h('h2', { className: 'legend', textContent: `Add a panel to ${tab.name}` }));
  const d = sheet('Add a panel', form, 'add-panel-sheet');
  form.append(h('ul', { className: 'add-panel-list' }, ...addableTypes().map((t) => h('li', {}, h('button', { type: 'button', className: 'add-panel-item',
    onclick: () => { d.close(); openPanel(t.id, t.id === 'terminal' ? { cwd: tab.path || undefined } : {}); } },
  h('span', { className: 'add-panel-title', textContent: t.title }), h('span', { className: 'add-panel-desc', textContent: t.description }))))),
  h('div', { className: 'sheet-keys' }, h('button', { className: 'btn', value: 'cancel', textContent: 'Cancel' })));
  form.querySelector<HTMLButtonElement>('.add-panel-item')?.focus();
}
window.addEventListener('myide:add-panel', addPanel);
api.onCommand((c) => { if (c === 'add-panel') addPanel(); });
