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

let sheet: HTMLDialogElement | undefined;

/** The hire sheet: role, task, model and effort (defaults from the role). */
export async function openHire(): Promise<void> {
  const project = activeProject();
  if (!project) return;
  sheet?.remove();
  const roles = await api.employees.roles(project.id);
  const role = select(roles.map((r) => [r.name, `${r.name}${r.source === 'project' ? ' (project)' : ''}`]), roles[0]?.name ?? '');
  role.id = 'hire-role';
  const desc = h('p', { className: 'pref-hint' });
  const task = h('textarea', { id: 'hire-task', className: 'input', rows: 4, required: true, placeholder: 'What should this employee do?' });
  const pick = modelPicker('', '');
  const status = h('p', { className: 'pref-warn' });
  status.setAttribute('aria-live', 'polite');
  const fromRole = () => {
    const r = roles.find((x) => x.name === role.value);
    desc.textContent = r?.description ?? '';
    pick.set(r?.model || 'sonnet', r?.effort);
  };
  role.onchange = fromRole;
  fromRole();
  const hire = h('button', { className: 'btn btn--primary', value: 'hire', textContent: 'Hire' });
  const form = h('form', { method: 'dialog' },
    h('h2', { className: 'legend', textContent: `Hire into ${project.name}` }),
    roles.length
      ? h('label', { className: 'field', htmlFor: 'hire-role' }, h('span', { className: 'legend', textContent: 'Role' }), role)
      : h('p', { className: 'pref-hint', textContent: 'No roles found. A role is an agent file in ~/.claude/agents or this project\'s .claude/agents.' }),
    desc,
    h('label', { className: 'field', htmlFor: 'hire-task' }, h('span', { className: 'legend', textContent: 'Task' }), task),
    pick.el,
    status,
    h('div', { className: 'sheet-keys' }, h('button', { className: 'btn', value: 'cancel', formNoValidate: true, textContent: 'Cancel' }), hire));
  hire.disabled = !roles.length;
  form.onsubmit = async (ev) => {
    if (ev.submitter !== hire) return;
    ev.preventDefault();
    hire.disabled = true;
    try {
      await api.employees.hire({ projectId: project.id, role: role.value, task: task.value.trim(), ...pick.get() });
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
