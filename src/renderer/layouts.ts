import type { DockviewApi, SerializedDockview } from 'dockview-core';
import type { Project } from '../main/projects';
import { activeProject, allProjects, loadProjects, setActiveProject } from './projects';
import { openPanel, panelTypes, park } from './registry';

const api = window.myide;
let dock: DockviewApi;
let perProject: Record<string, unknown> = {}; // mirror of layouts.json perProject, so a switch is synchronous

const projectKey = (): string => activeProject()?.id ?? '';
const cwd = (): string | undefined => activeProject()?.path;

// With "restore at launch" off the launch layout is the default one. It is not saved over the
// project's own layout until the user opens or closes a panel or switches project.
let pristine: string | null = null;
const panelIds = (): string => dock.panels.map((p) => p.id).sort().join();

function save(force = false): void {
  clearTimeout(saveTimer);
  if (!force && pristine === panelIds()) return;
  pristine = null;
  const layout = dock.toJSON();
  perProject[projectKey()] = layout;
  api.layouts.putProject(activeProject()?.id ?? null, layout);
}
let saveTimer: ReturnType<typeof setTimeout> | undefined;
const EMPLOYEES_WIDTH = 340;

function preset(name: string): void {
  dock.clear();
  if (!activeProject()) return;
  const term = openPanel('terminal', { cwd: cwd() });
  if (name === 'default') { // a project with no saved layout: the team beside its terminal
    openPanel('employees', {}, { position: { referencePanel: term.id, direction: 'left' }, initialWidth: EMPLOYEES_WIDTH });
    term.api.setActive();
  }
  if (name === 'files') {
    openPanel('files', {}, { position: { referencePanel: term.id, direction: 'left' }, initialWidth: 260 });
    term.api.setActive();
  }
  if (name === 'review') {
    openPanel('diff', {}, { position: { referencePanel: term.id, direction: 'above' } });
    openPanel('files', {}, { position: { direction: 'left' }, initialWidth: 260 });
  }
}

// A named layout can be restored in any project: panels get fresh ids (so no terminal reattaches
// to another panel's shell) and terminals start in the active project.
/** Drops any `command` param: a terminal never runs a program from saved state. */
function noCommands(layout: SerializedDockview): SerializedDockview {
  for (const p of Object.values(layout.panels ?? {})) if (p.params && 'command' in p.params) delete p.params.command;
  return layout;
}

function fresh(layout: SerializedDockview): SerializedDockview {
  let s = JSON.stringify(layout);
  for (const [id, p] of Object.entries(layout.panels)) {
    s = s.split(JSON.stringify(id)).join(JSON.stringify(`${p.contentComponent}-${crypto.randomUUID().slice(0, 8)}`));
  }
  const out = noCommands(JSON.parse(s) as SerializedDockview);
  for (const p of Object.values(out.panels)) if (p.contentComponent === 'terminal') p.params = { ...p.params, cwd: cwd() };
  return out;
}

function restore(layout: unknown): void {
  if (layout) {
    try { dock.fromJSON(noCommands(layout as SerializedDockview)); return; } catch (e) { console.error('Layout restore failed', e); }
  }
  preset('default');
}

/** Saves the current project's layout and shows `p` with its own layout (default: one terminal). */
function switchTo(p: Project | null, keepOld = true): void {
  if (keepOld) save(true);
  setActiveProject(p);
  // Parking keeps the old project's shells running for when it comes back.
  const show = () => restore(perProject[p?.id ?? '']);
  if (keepOld) park(show); else show();
  sync();
}

async function addProject(): Promise<void> {
  const p = await api.projects.add();
  if (!p) return;
  await loadProjects();
  if (p.id !== projectKey()) switchTo(p);
}

/** Removes a project after confirmation; removing the active one switches to the first left. */
export async function removeProject(p = activeProject()): Promise<void> {
  if (!p) return;
  const wasActive = p.id === projectKey();
  if (!(await api.projects.remove(p.id))) return; // main also ends a parked project's shells
  delete perProject[p.id];
  const rest = await loadProjects();
  if (wasActive) switchTo(rest[0] ?? null, false); // ends the removed project's shells
  else sync();
}

/** Forgets a project's saved layout; the active project goes back to the default layout now. */
export async function resetLayout(id: string): Promise<void> {
  delete perProject[id];
  await api.prefs.resetLayout(id);
  if (id === projectKey()) preset('default');
}

async function saveNamed(): Promise<void> {
  const dialog = document.getElementById('layout-name') as HTMLDialogElement;
  const input = dialog.querySelector('input')!;
  input.value = '';
  dialog.showModal();
  await new Promise((r) => dialog.addEventListener('close', r, { once: true }));
  if (dialog.returnValue === 'save' && input.value.trim()) await api.layouts.saveNamed(input.value.trim(), dock.toJSON());
}

async function restoreNamed(name: string): Promise<void> {
  const layout = (await api.layouts.get()).named[name];
  if (layout && (await okToClose())) restore(fresh(layout as SerializedDockview));
}

/** Asks main to confirm before panels close whose terminals run something besides the shell. */
const okToClose = (panels = dock.panels): Promise<boolean> =>
  api.pty.confirmKill(panels.filter((p) => p.api.component === 'terminal').map((p) => p.id));

// The group holding focus, which may be in a pop-out window; dockview's active group need not follow it.
async function closeTab(): Promise<void> {
  const group = dock.groups.find((g) => { const d = g.element.ownerDocument; return d.hasFocus() && g.element.contains(d.activeElement); }) ?? dock.activeGroup;
  const panel = group?.activePanel;
  if (panel && (await okToClose([panel]))) panel.api.close();
}

function showPanel(type: string): void {
  const open = dock.panels.find((p) => p.api.component === type);
  if (open) open.api.setActive();
  else if (type === 'files') openPanel('files', {}, { position: { direction: 'left' }, initialWidth: 260 });
  else if (type === 'employees') openPanel('employees', {}, { position: { direction: 'left' }, initialWidth: EMPLOYEES_WIDTH });
  else openPanel(type, type === 'terminal' ? { cwd: cwd() } : {});
}

// The menu shows which panel types are open; the empty state shows when there is nothing at all.
let lastMenu = '';
function sync(): void {
  const open = new Set(dock.panels.map((p) => p.api.component));
  const state = { active: activeProject()?.id ?? null, panels: panelTypes().map((t) => ({ ...t, open: open.has(t.id) })) };
  const json = JSON.stringify(state);
  if (json !== lastMenu) { lastMenu = json; api.menuState(state); }
  const empty = !allProjects().length && !dock.panels.length;
  document.getElementById('empty-state')!.hidden = !empty;
  document.getElementById('dock')!.hidden = empty;
}

const commands: Record<string, (arg: string) => void> = {
  'add-project': () => void addProject(),
  'remove-project': () => void removeProject(),
  'save-layout': () => void saveNamed(),
  'close-tab': () => void closeTab(),
  'open-preferences': () => showPanel('preferences'),
  project: (n) => { const p = allProjects()[Number(n) - 1]; if (p && p.id !== projectKey()) switchTo(p); },
  preset: (name) => void okToClose().then((ok) => ok && preset(name)),
  layout: (name) => void restoreNamed(name),
  panel: showPanel,
  'flush-layout': () => save(), // the main window was hidden (closed while MyIDE keeps running)
};

/** Restores the last project and its layout, then keeps layouts saved as they change. */
export async function startWorkspace(d: DockviewApi): Promise<void> {
  dock = d;
  const [projects, file, { prefs }] = await Promise.all([loadProjects(), api.layouts.get(), api.prefs.get()]);
  perProject = file.perProject;
  // With "restore at launch" off, start on the first project with the default layout.
  const last = (prefs.restoreLast && projects.find((p) => p.id === file.last?.project)) || projects[0] || null;
  setActiveProject(last, { pick: (p) => { if (p.id !== projectKey()) switchTo(p); }, add: () => void addProject() });
  document.getElementById('empty-add')!.onclick = () => void addProject();
  if (last) restore(prefs.restoreLast ? perProject[last.id] : null); // no project: the empty state, not a terminal in ~
  if (last && !prefs.restoreLast) pristine = panelIds();
  dock.onDidLayoutChange(() => {
    clearTimeout(saveTimer);
    // A pop-out reopened by fromJSON is only in toJSON once its window is up.
    saveTimer = setTimeout(() => void dock.popoutRestorationPromise.then(() => save()), 400);
    sync();
  });
  addEventListener('beforeunload', () => save());
  api.onCommand((name) => {
    const i = name.indexOf(':');
    commands[i < 0 ? name : name.slice(0, i)]?.(i < 0 ? '' : name.slice(i + 1));
  });
  sync();
}
