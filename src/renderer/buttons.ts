// Buttons panel: saved buttons as keys, the installed commands and skills, the button and schedule forms, and the schedules list.
import type { Button, PaletteItem, Schedule, Target } from '../main/buttons';
import { describe, nextRun, WEEKDAYS } from '../main/schedules';
import { errText, h, key, sheet as modal } from './dom';
import { activeProject, allProjects } from './projects';
import { registerPanel } from './registry';
import { micButton, speakButton } from './speech';

const api = window.myide;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ORDER = [1, 2, 3, 4, 5, 6, 0];

const targetText = (t: Target) => (t === 'lead' ? 'project lead' : t === 'selected' ? 'selected employee' : `new ${t.role}`);
const field = (label: string, ctl: HTMLElement, hint?: string) =>
  h('label', { className: 'field' }, h('span', { className: 'legend', textContent: label }), ctl, ...(hint ? [h('span', { className: 'pref-hint', textContent: hint })] : []));
/** A delete key that acts on the second press. */
const sure = (label: string, act: () => void) => {
  const k = key(label, () => { if (k.dataset.armed) act(); else { k.dataset.armed = '1'; k.textContent = 'Press again'; } }, { className: 'key key--sm rm' });
  k.onblur = () => { delete k.dataset.armed; k.textContent = label; };
  return k;
};
const when = (ms?: number) => (ms ? new Date(ms).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

/** A modal sheet; `submit` returns an error message or '' to close. */
function sheet(title: string, body: HTMLElement[], submit: () => Promise<string>, ok = 'Save'): HTMLDialogElement {
  const status = h('p', { className: 'pref-warn' });
  status.setAttribute('aria-live', 'polite');
  const go = h('button', { className: 'btn btn--primary', value: 'ok', textContent: ok });
  const form = h('form', { method: 'dialog' }, h('h2', { className: 'legend', textContent: title }), ...body, status,
    h('div', { className: 'sheet-keys' }, h('button', { className: 'btn', value: 'cancel', formNoValidate: true, textContent: 'Cancel' }), go));
  const dlg = modal(title, form, 'btn-sheet');
  form.onsubmit = async (ev) => {
    if (ev.submitter !== go) return;
    ev.preventDefault();
    go.disabled = true;
    status.textContent = await submit().catch(errText);
    go.disabled = false;
    if (!status.textContent) dlg.close();
  };
  return dlg;
}

async function buttonForm(b: Partial<Button>, palette: PaletteItem[], onSaved: () => void): Promise<void> {
  const project = activeProject();
  const label = h('input', { className: 'input', required: true, value: b.label ?? '', placeholder: 'Code review' });
  const command = h('input', { className: 'input mono', required: true, value: b.command ?? '', placeholder: '/code-review high' });
  const list = h('datalist', { id: 'btn-palette' }, ...palette.map((p) => new Option(p.description.slice(0, 80), `/${p.name}`)));
  command.setAttribute('list', list.id);
  const roles = project ? await api.employees.roles(project.id).catch(() => []) : [];
  const t = b.target ?? 'lead';
  const target = h('select', { className: 'input select' }, new Option('Project lead', 'lead'), new Option('Selected employee', 'selected'),
    ...roles.map((r) => new Option(`New hire: ${r.name}`, `role:${r.name}`)));
  target.value = typeof t === 'object' ? `role:${t.role}` : t;
  if (typeof t === 'object' && target.value !== `role:${t.role}`) { target.add(new Option(`New hire: ${t.role}`, `role:${t.role}`)); target.value = `role:${t.role}`; }
  const input = h('input', { className: 'input', value: b.input ?? '', placeholder: 'e.g. PR URL (leave empty for none)' });
  const scope = h('select', { className: 'input select' }, new Option('Global, every project', 'global'));
  if (project) scope.add(new Option(`${project.name} only (saved in the repo)`, 'project'));
  scope.value = b.scope === 'project' ? 'project' : 'global';
  const body: HTMLElement[] = [field('Label', label), field('Command', command, 'A slash command or any prompt; it runs as a normal turn.'), list,
    field('Who runs it', target), field('Asks for input', input, 'Asked when you press it; added after the command.'), field('Scope', scope)];
  if (b.id) body.push(h('div', { className: 'sheet-keys btn-del' }, sure('Delete button and its schedules', () => {
    void api.buttons.delete(b.id!).then(() => { document.querySelector<HTMLDialogElement>('.btn-sheet')?.close(); onSaved(); });
  })));
  sheet(b.id ? 'Edit button' : 'New button', body, async () => {
    const tv = target.value;
    await api.buttons.save({
      id: b.id, label: label.value, command: command.value, input: input.value, scope: scope.value as Button['scope'], projectId: scope.value === 'project' ? project?.id : undefined,
      target: tv.startsWith('role:') ? { role: tv.slice(5) } : (tv as 'lead' | 'selected'),
    });
    onSaved();
    return '';
  });
  label.focus();
}

export function scheduleForm(s: Partial<Schedule>, buttons: Button[], onSaved: () => void): void {
  const usable = buttons.filter((b) => b.target !== 'selected');
  const button = h('select', { className: 'input select' }, ...usable.map((b) => new Option(`${b.label} · ${b.command}`, b.id)));
  if (s.buttonId) button.value = s.buttonId;
  const project = h('select', { className: 'input select' }, ...allProjects().map((p) => new Option(p.name, p.id)));
  project.value = s.projectId ?? activeProject()?.id ?? '';
  const days = new Set(s.days ?? WEEKDAYS);
  const dayKeys = ORDER.map((d) => {
    const k = key(DAYS[d], () => { if (!days.delete(d)) days.add(d); sync(); });
    k.dataset.day = String(d);
    return k;
  });
  const time = h('input', { className: 'input', type: 'time', required: true, value: s.time ?? '07:00' });
  const run = h('input', { type: 'radio', name: 'missed', value: 'run', checked: s.missed !== 'skip' });
  const skip = h('input', { type: 'radio', name: 'missed', value: 'skip', checked: s.missed === 'skip' });
  const input = h('input', { className: 'input', value: s.input ?? '', placeholder: 'Input for the button, if it asks for one' });
  const summary = h('p', { className: 'pref-hint' });
  const sync = () => {
    for (const k of dayKeys) k.setAttribute('aria-pressed', String(days.has(Number(k.dataset.day))));
    const pick = { days: [...days], time: time.value || '00:00' };
    const next = days.size && time.value ? nextRun(pick, new Date()) : null;
    summary.textContent = `${describe(pick)}${next ? ` · next ${when(next.getTime())}` : ''}`;
  };
  time.oninput = sync;
  sync();
  const quick = (label: string, set: number[]) => key(label, () => { days.clear(); set.forEach((d) => days.add(d)); sync(); });
  const body = usable.length ? [
    field('Button', button), field('Project', project),
    h('div', { className: 'field' }, h('span', { className: 'legend', textContent: 'Days' }),
      h('div', { className: 'day-keys' }, ...dayKeys, quick('Weekdays', WEEKDAYS), quick('Daily', [0, 1, 2, 3, 4, 5, 6]))),
    field('At', time), summary,
    h('fieldset', { className: 'field missed' }, h('legend', { className: 'legend', textContent: 'If the Mac was asleep or MyIDE closed' }),
      h('label', { className: 'toggle' }, run, 'Run on wake'), h('label', { className: 'toggle' }, skip, 'Skip')),
    field('Input', input),
    h('p', { className: 'pref-hint', textContent: 'Scheduled runs wait in the same queue and caps as everything else. The Mac stays awake only while one runs.' }),
  ] : [h('p', { className: 'pref-hint', textContent: 'Make a button first. Buttons for the selected employee cannot be scheduled.' })];
  sheet(s.id ? 'Edit schedule' : 'New schedule', body, async () => {
    if (!usable.length) return '';
    await api.schedules.save({ id: s.id, buttonId: button.value, projectId: project.value, days: [...days], time: time.value, missed: skip.checked ? 'skip' : 'run', enabled: s.enabled ?? true, input: input.value });
    onSaved();
    return '';
  });
}

function askInput(b: Pick<Button, 'label' | 'input'>): Promise<string | null> {
  return new Promise((resolve) => {
    const input = h('input', { className: 'input', required: true });
    let value: string | null = null;
    sheet(b.label, [field(b.input!, input), micButton(input)], async () => { value = input.value; return ''; }, 'Run').addEventListener('close', () => resolve(value));
    input.focus();
  });
}

registerPanel('buttons', {
  title: 'Buttons',
  create(el) {
    el.classList.add('btns');
    const project = activeProject();
    const runOn = h('select', { className: 'input select' }, new Option('Project lead', ''));
    runOn.setAttribute('aria-label', 'Selected employee');
    runOn.title = 'Who runs installed commands, and buttons set to "selected employee"';
    let editing = false;
    const editKey = key('Edit', () => { editing = !editing; editKey.setAttribute('aria-pressed', String(editing)); draw(); }, { title: 'Press a button to change it' });
    editKey.setAttribute('aria-pressed', 'false');
    const status = h('p', { className: 'btn-status' });
    status.setAttribute('aria-live', 'polite');
    const grid = h('div', { className: 'btn-grid' });
    const filter = h('input', { className: 'input', type: 'search', placeholder: 'Filter' });
    const installed = h('div', { className: 'btn-installed' });
    const instTitle = h('summary', { className: 'legend' });
    const pauseBox = h('input', { type: 'checkbox', className: 'switch' });
    const schedNote = h('span', { className: 'pref-hint' });
    const rows = h('div', { className: 'sched-rows' });
    el.append(
      h('div', { className: 'emps-bar' }, h('label', { className: 'org-ceiling-field' }, h('span', { className: 'legend', textContent: 'Run on' }), runOn), editKey,
        key('New button', () => void buttonForm({}, pal, () => void load()))),
      status, grid,
      h('details', { className: 'btn-inst' }, instTitle, filter, installed),
      h('section', { className: 'sched' },
        h('div', { className: 'sched-head' }, h('h2', { className: 'legend box-title', textContent: 'Schedules' }), schedNote,
          h('label', { className: 'toggle' }, pauseBox, 'Pause all'), key('New schedule', () => scheduleForm({}, buttons, () => void loadScheds()))),
        rows));
    pauseBox.onchange = () => void api.schedules.pause(pauseBox.checked);

    let buttons: Button[] = [];
    let pal: PaletteItem[] = [];
    const say = (text: string) => { status.textContent = text; };

    async function run(b: Pick<Button, 'command' | 'target' | 'label' | 'input'>): Promise<void> {
      if (!project) return say('Open a project first.');
      const input = b.input ? await askInput(b) : undefined;
      if (input === null) return;
      try {
        const id = await api.buttons.run(b, project.id, { employeeId: runOn.value || undefined, input });
        const e = (await api.employees.list(project.id)).find((x) => x.id === id);
        say(`${b.command} sent to ${e?.name ?? 'the employee'}.`);
      } catch (err) { say(errText(err)); }
    }

    function draw(): void {
      grid.replaceChildren(...buttons.map((b) => {
        const k = h('button', { type: 'button', className: 'key btn-key', title: `${b.command} · ${targetText(b.target)}${b.scope === 'project' ? ' · this project' : ''}`,
          onclick: () => (editing ? void buttonForm(b, pal, () => void load()) : void run(b)) },
        h('span', { className: 'btn-label', textContent: b.label }), h('span', { className: 'btn-sub', textContent: `${b.command} · ${targetText(b.target)}` }));
        if (b.scope === 'project' && project) k.style.setProperty('--proj', project.colour);
        return k;
      }));
      if (!buttons.length) grid.append(h('p', { className: 'files-note', textContent: 'No buttons yet. Add one, or run an installed command below.' }));
      const f = filter.value.toLowerCase();
      const shown = pal.filter((p) => !f || p.name.toLowerCase().includes(f) || p.description.toLowerCase().includes(f));
      instTitle.textContent = `Installed commands and skills · ${pal.length}`;
      installed.replaceChildren(...shown.map((p) => h('div', { className: 'inst-row' },
        key(`/${p.name}`, () => void run({ command: `/${p.name}`, target: runOn.value ? 'selected' : 'lead', label: p.name }), { title: `Run on ${runOn.selectedOptions[0]?.text ?? 'the lead'}` }),
        h('span', { className: 'inst-desc', textContent: p.description, title: `${p.source}: ${p.description}` }),
        key('+', () => void buttonForm({ label: p.name, command: `/${p.name}` }, pal, () => void load()), { title: 'Save as a button' }))));
    }
    filter.oninput = draw;

    async function load(): Promise<void> {
      const r = await api.buttons.list(project?.id);
      buttons = r.buttons;
      pal = r.palette;
      draw();
      void loadScheds();
    }

    const known = new Set<string>();
    async function loadRunOn(): Promise<void> {
      if (!project) return;
      const keep = runOn.value;
      const emps = await api.employees.list(project.id);
      known.clear();
      emps.forEach((e) => known.add(e.id));
      runOn.replaceChildren(new Option('Project lead', ''), ...emps.map((e) => new Option(`${e.name}${e.lead ? ' (lead)' : ''}`, e.id)));
      runOn.value = emps.some((e) => e.id === keep) ? keep : '';
    }

    async function loadScheds(): Promise<void> {
      const r = await api.schedules.list();
      pauseBox.checked = r.paused;
      const on = r.schedules.filter((s) => s.enabled).length;
      schedNote.textContent = `${on} on${r.paused ? ', all paused' : ''}${r.awake ? ' · keeping the Mac awake for a run' : ''}`;
      // Buttons of other projects are not in `buttons`; show their id until that project is open.
      rows.replaceChildren(...r.schedules.map((s) => {
        const b = buttons.find((x) => x.id === s.buttonId);
        const p = allProjects().find((x) => x.id === s.projectId);
        const enabled = h('input', { type: 'checkbox', className: 'switch', checked: s.enabled, title: 'On' });
        enabled.onchange = () => void api.schedules.save({ ...s, enabled: enabled.checked });
        const last = s.last
          ? h('span', {}, `${s.last.status} · ${when(s.last.at)} `, ...(s.last.report ? [key('Report', () => void api.files.open(s.last!.report!))] : []),
            speakButton(() => `${b?.label ?? 'Schedule'} in ${p?.name ?? 'another project'}: ${s.last!.status}, ${when(s.last!.at)}.`, 'Read result aloud'))
          : h('span', { className: 'pref-hint', textContent: 'Not run yet' });
        const row = h('div', { className: 'sched-row' }, enabled,
          h('span', { className: 'sched-what' }, h('b', { textContent: b?.label ?? 'Button in another project' }), ` ${p?.name ?? '?'}`),
          h('span', { textContent: describe(s) }), h('span', { className: 'pref-hint', textContent: s.missed === 'run' ? 'Run on wake' : 'Skip if missed' }),
          last, h('span', { className: 'pref-hint', textContent: `Next ${r.paused || !s.enabled ? 'paused' : when(s.next)}` }),
          key('Edit', () => scheduleForm(s, buttons, () => void loadScheds())),
          sure('Delete', () => void api.schedules.delete(s.id)));
        if (p) row.style.setProperty('--proj', p.colour);
        return row;
      }));
      if (!r.schedules.length) rows.append(h('p', { className: 'files-note', textContent: 'No schedules. A schedule is a button, the days and a time.' }));
    }

    void load();
    void loadRunOn();
    const offs = [api.schedules.onChange(() => void loadScheds()), api.employees.onChange((e) => { if (e.projectId === project?.id && !known.has(e.id)) void loadRunOn(); }), api.employees.onRemoved(() => void loadRunOn())];
    return { dispose: () => offs.forEach((off) => off()) };
  },
});
