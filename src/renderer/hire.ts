import type { Mode, Pick } from '../main/org';
import { accountPicker } from './accounts';
import { attachBox } from './attach';
import { h } from './dom';
import { activeProject } from './projects';

const api = window.myide;

const MODELS = [['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']];
const EFFORTS = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'XHigh'], ['max', 'Max']];

function select(options: string[][], value: string): HTMLSelectElement {
  const s = h('select', { className: 'input select' }, ...options.map(([v, label]) => new Option(label, v)));
  setValue(s, value);
  return s;
}
/** Selects `value`, adding it first if it isn't one of the options (e.g. a full model id). */
function setValue(s: HTMLSelectElement, value: string): void {
  if (![...s.options].some((o) => o.value === value)) s.add(new Option(value, value));
  s.value = value;
}

/** Pinned model and effort dropdowns; effort is greyed for Haiku. */
export function modelPicker(model: string, effort: string | undefined, onchange?: () => void) {
  const m = select(MODELS, model || 'sonnet');
  const ef = select(EFFORTS, effort || 'medium');
  m.setAttribute('aria-label', 'Model');
  ef.setAttribute('aria-label', 'Effort');
  const sync = () => { ef.disabled = /haiku/i.test(m.value); };
  m.onchange = () => { sync(); onchange?.(); };
  ef.onchange = () => onchange?.();
  sync();
  const field = (label: string, ctl: HTMLElement) => h('label', { className: 'field' }, h('span', { className: 'legend', textContent: label }), ctl);
  return {
    el: h('div', { className: 'pick' }, field('Model', m), field('Effort', ef)),
    get: () => ({ model: m.value, effort: ef.disabled ? undefined : ef.value }),
    set(model: string, effort?: string) { setValue(m, model); setValue(ef, effort || 'medium'); sync(); },
  };
}

// ---- mode: pinned, manager picks, auto ----

export const MODE_TEXT: Record<Mode, string> = { pinned: 'Pinned', manager: 'Manager picks', auto: 'Auto' };
const MODE_HINT: Record<Mode, string> = {
  pinned: 'You pick the exact model and effort.',
  manager: 'Its lead picks per task when it assigns work.',
  auto: 'MyIDE picks from each task: lint, rename, format to Haiku; architecture, design, plan to Opus; else Sonnet.',
};
export const fmtPick = (p: Pick): string => `${p.model[0].toUpperCase()}${p.model.slice(1)}${p.effort ? ` · ${p.effort}` : ''}`;

/** "Ceiling Sonnet · high": what a lead or auto may pick without asking. */
export function ceilingNote(ceiling?: Pick): string {
  return ceiling
    ? `Ceiling ${fmtPick(ceiling)}: a lead or auto mode picking above it waits for your approval.`
    : 'No project ceiling: a lead picking above its own model waits for your approval.';
}

/** Mode dropdown with its one-line hint; the model picker is only used in Pinned. */
export function modePicker(mode: Mode, onchange?: () => void) {
  const s = select(Object.entries(MODE_TEXT), mode);
  s.setAttribute('aria-label', 'Mode');
  const hint = h('p', { className: 'pref-hint' });
  const sync = () => { hint.textContent = MODE_HINT[s.value as Mode]; };
  s.onchange = () => { sync(); onchange?.(); };
  sync();
  return {
    el: h('div', { className: 'mode-pick' }, h('label', { className: 'field' }, h('span', { className: 'legend', textContent: 'Mode' }), s), hint),
    get: () => s.value as Mode,
    set(m: Mode) { s.value = m; sync(); },
  };
}

let sheet: HTMLDialogElement | undefined;

/** The hire sheet: role, task, model and effort (defaults from the role). */
/** `o.task` prefills the task (a promoted to-do); `o.onHired` hears the new employee. */
export async function openHire(o: { task?: string; onHired?: (e: { id: string; role: string }) => void } = {}): Promise<void> {
  const project = activeProject();
  if (!project) return;
  sheet?.remove();
  const [roles, org] = await Promise.all([api.employees.roles(project.id), api.org.get()]);
  const po = org.projects.find((p) => p.id === project.id);
  const role = select(roles.map((r) => [r.name, `${r.name}${r.source === 'project' ? ' (project)' : ''}`]), roles[0]?.name ?? '');
  role.id = 'hire-role';
  const desc = h('p', { className: 'pref-hint' });
  const task = h('textarea', { id: 'hire-task', className: 'input', rows: 4, required: true, placeholder: 'What should this employee do?', value: o.task ?? '' });
  const pick = modelPicker('', '');
  const acct = await accountPicker(pick.el); // the AI account is fixed at hire
  const mode = modePicker('pinned', () => { pick.el.hidden = mode.get() === 'auto'; });
  const lead = h('input', { type: 'checkbox', className: 'switch', id: 'hire-lead' });
  const leadRow = h('label', { className: 'check', htmlFor: 'hire-lead' }, lead, h('span', { textContent: `Lead: can hire reports (up to ${org.caps.maxReports} at once, ${po?.maxDepth ?? org.caps.maxDepth} levels deep)` }));
  const ceiling = h('p', { className: 'pref-hint', textContent: ceilingNote(po?.ceiling) });
  const status = h('p', { className: 'pref-warn' });
  status.setAttribute('aria-live', 'polite');
  const attach = attachBox(task, (t) => { status.textContent = t; });
  const fromRole = () => {
    const r = roles.find((x) => x.name === role.value);
    desc.textContent = r?.description ?? '';
    pick.set(po?.model || r?.model || 'sonnet', po?.effort || r?.effort);
    mode.set(po?.mode || r?.mode || 'pinned');
    pick.el.hidden = mode.get() === 'auto';
  };
  role.onchange = fromRole;
  role.addEventListener('change', () => void acct.sync());
  fromRole();
  const hire = h('button', { className: 'btn btn--primary', value: 'hire', textContent: 'Hire' });
  const form = h('form', { method: 'dialog' },
    h('h2', { className: 'legend', textContent: `Hire into ${project.name}` }),
    roles.length
      ? h('label', { className: 'field', htmlFor: 'hire-role' }, h('span', { className: 'legend', textContent: 'Role' }), role)
      : h('p', { className: 'pref-hint', textContent: 'No roles found. A role is an agent file in ~/.claude/agents or this project\'s .claude/agents.' }),
    desc,
    h('label', { className: 'field', htmlFor: 'hire-task' }, h('span', { className: 'legend', textContent: 'Task' }), task),
    attach.el,
    acct.el,
    mode.el,
    pick.el,
    leadRow,
    ceiling,
    status,
    h('div', { className: 'sheet-keys' }, h('button', { className: 'btn', value: 'cancel', formNoValidate: true, textContent: 'Cancel' }), hire));
  hire.disabled = !roles.length;
  form.onsubmit = async (ev) => {
    if (ev.submitter !== hire) return;
    ev.preventDefault();
    hire.disabled = true;
    try {
      const hired = await api.employees.hire({ projectId: project.id, role: role.value, task: task.value.trim(), ...acct.get(), mode: mode.get(), lead: lead.checked, ...(mode.get() === 'auto' ? {} : pick.get()), images: attach.payload() });
      attach.clear();
      o.onHired?.(hired);
      sheet?.close();
    } catch (e) {
      status.textContent = (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      hire.disabled = false;
    }
  };
  sheet = h('dialog', { className: 'sheet hire' }, form);
  sheet.setAttribute('aria-label', 'Hire an employee');
  document.body.append(sheet);
  sheet.showModal();
  task.focus();
}

window.myide.onCommand((name) => { if (name === 'hire-employee') void openHire(); });
