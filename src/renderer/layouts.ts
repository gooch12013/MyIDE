import type { DockviewApi, SerializedDockview } from 'dockview-core';
import type { Project } from '../main/projects';
import { lastClosed, neighbour, openTabs } from '../main/tabs';
import { HOME_ID } from './command';
import { h } from './dom';
import { activeProject, activeTab, allProjects, allTabs, loadProjects, openProjects, setActiveProject } from './projects';
import { openPanel, panelTypes, park } from './registry';

const api = window.myide;
let dock: DockviewApi;
let perProject: Record<string, unknown> = {}; // mirror of layouts.json perProject, so a switch is synchronous

const projectKey = (): string => activeTab()?.id ?? '';
const cwd = (): string | undefined => activeTab()?.path || undefined; // Home: the home folder

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
  api.layouts.putProject(activeTab()?.id ?? null, layout);
}
let saveTimer: ReturnType<typeof setTimeout> | undefined;
const EMPLOYEES_WIDTH = 340;

/** Home's default: the console. NEEDS YOU across the top, project pages, usage and slots on the right, macros and the command line along the bottom. */
function homePreset(): void {
  const pages = openPanel('pages');
  const usage = openPanel('usage', {}, { position: { referencePanel: pages.id, direction: 'right' }, initialWidth: 340 });
  openPanel('slots', {}, { position: { referencePanel: usage.id, direction: 'below' } });
  openPanel('needs', {}, { position: { direction: 'above' }, initialHeight: 170 });
  const macros = openPanel('macros', {}, { position: { direction: 'below' }, initialHeight: 150 });
  openPanel('cmdline', {}, { position: { referencePanel: macros.id, direction: 'right' } });
  pages.api.setActive();
}

function preset(name: string): void {
  dock.clear();
  if (!activeTab()) return;
  if (name === 'default' && activeTab()!.id === HOME_ID) return homePreset();
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
  const show = () => (p ? restore(perProject[p.id]) : dock.clear()); // no tab open: the empty state
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
  await loadProjects();
  if (wasActive) switchTo(openProjects()[0] ?? null, false); // ends the removed project's shells
  else sync();
}

const terminalIds = (layout: unknown): string[] =>
  Object.entries((layout as SerializedDockview | undefined)?.panels ?? {}).filter(([, p]) => p.contentComponent === 'terminal').map(([id]) => id);

/** Closes a project's tab: its layout is kept and its terminals end (after the running-process check);
 *  its employees keep working. Closing the shown tab shows its neighbour, or the empty state. */
export async function closeProject(p = activeTab()): Promise<boolean> {
  if (!p || p.closed) return false;
  const shown = p.id === projectKey();
  if (!(await (shown ? okToClose() : api.pty.confirmKill(terminalIds(perProject[p.id]))))) return false;
  if (shown) save(true);
  const next = neighbour(allTabs(), p.id);
  await api.projects.setClosed(p.id, true); // main ends the terminals in its saved layout
  await loadProjects();
  if (shown) switchTo(next, false);
  else sync();
  return true;
}

/** Reopens a closed tab (or shows an open one) with its saved layout. */
export async function showProject(id?: string): Promise<void> {
  const p = allTabs().find((x) => x.id === id);
  if (!p) return;
  if (p.closed) { await api.projects.setClosed(p.id, false); await loadProjects(); }
  if (p.id !== projectKey()) switchTo(allTabs().find((x) => x.id === p.id)!);
  else sync();
}

async function closeOthers(id: string): Promise<void> {
  for (const p of openProjects()) if (p.id !== id && !(await closeProject(p))) return;
  if (id !== projectKey()) await showProject(id);
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
  const open = dock.panels.find((p) => p.api.component === type && p.params?.scope !== 'all'); // a project's panel, not the all-projects view
  if (open) open.api.setActive();
  else if (type === 'files') openPanel('files', {}, { position: { direction: 'left' }, initialWidth: 260 });
  else if (type === 'employees') openPanel('employees', {}, { position: { direction: 'left' }, initialWidth: EMPLOYEES_WIDTH });
  else openPanel(type, type === 'terminal' ? { cwd: cwd() } : {});
}

/** Focuses (or opens) Employees: All Projects in this layout. */
export function showEmployeesAll(): void {
  const open = dock.panels.find((p) => p.api.component === 'employees' && p.params?.scope === 'all');
  if (open) open.api.setActive();
  else openPanel('employees', { scope: 'all' }, { position: { direction: 'left' }, initialWidth: EMPLOYEES_WIDTH * 2 }).api.setTitle('Employees: All');
}

// The menu shows which panel types are open; the empty state shows when there is nothing at all.
let lastMenu = '';
function sync(): void {
  const open = new Set(dock.panels.map((p) => p.api.component));
  const state = { active: activeTab()?.id ?? null, panels: panelTypes().map((t) => ({ ...t, open: open.has(t.id) })) };
  const json = JSON.stringify(state);
  if (json !== lastMenu) { lastMenu = json; api.menuState(state); }
  const empty = !openProjects().length && !dock.panels.length;
  document.getElementById('empty-state')!.hidden = !empty;
  if (empty) emptyState();
  document.getElementById('dock')!.hidden = empty;
}

/** No tab open: closed projects are listed to open again. */
function emptyState(): void {
  const closed = allTabs().filter((p) => p.closed);
  const list = document.getElementById('empty-closed')!;
  document.getElementById('empty-title')!.textContent = closed.length ? 'Open a project' : 'No projects yet';
  document.getElementById('empty-text')!.hidden = closed.length > 0;
  list.replaceChildren(...closed.map((p) => {
    const b = h('button', { type: 'button', className: 'key proj-key', title: p.path, onclick: () => void showProject(p.id) }, h('span', { className: 'proj-name', textContent: p.name }));
    b.style.setProperty('--proj', p.colour);
    return b;
  }));
  list.hidden = !closed.length;
}

const commands: Record<string, (arg: string) => void> = {
  'add-project': () => void addProject(),
  'remove-project': (id) => void removeProject(allProjects().find((p) => p.id === id)),
  'close-project': (id) => void closeProject(allTabs().find((p) => p.id === id)),
  'close-others': (id) => void closeOthers(id),
  'reopen-project': () => void showProject(lastClosed(allTabs())?.id),
  'project-settings': () => {
    if (window.dispatchEvent(new CustomEvent('myide:prefs-section', { detail: 'projects', cancelable: true }))) openPanel('preferences', { section: 'projects' });
  },
  'save-layout': () => void saveNamed(),
  'close-tab': () => void closeTab(),
  'open-preferences': () => showPanel('preferences'),
  // ⌘1..9 (sent by main, 'project:3') follow the open project tabs (Home is ⌘0, 'project:home'); the Projects menu sends an id.
  project: (arg) => void showProject(/^[1-9]$/.test(arg) ? openTabs(allProjects())[Number(arg) - 1]?.id : arg),
  preset: (name) => void okToClose().then((ok) => ok && preset(name)),
  layout: (name) => void restoreNamed(name),
  panel: showPanel,
  'employees-all': () => showEmployeesAll(),
  'flush-layout': () => save(), // the main window was hidden (closed while MyIDE keeps running)
};

/** Restores the last project and its layout, then keeps layouts saved as they change. */
export async function startWorkspace(d: DockviewApi): Promise<void> {
  dock = d;
  const [, file, { prefs }] = await Promise.all([loadProjects(), api.layouts.get(), api.prefs.get()]);
  perProject = file.perProject;
  // With "restore at launch" off, start on the first tab (Home, while it is open) with the default layout.
  const open = openProjects();
  const last = (prefs.restoreLast && open.find((p) => p.id === file.last?.project)) || open[0] || null;
  setActiveProject(last, { pick: (p) => { if (p.id !== projectKey()) switchTo(p); }, add: () => void addProject(), close: (p) => void closeProject(p) });
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
  // A panel's scope changed: its params are part of the layout.
  addEventListener('myide:layout-dirty', () => { pristine = null; clearTimeout(saveTimer); saveTimer = setTimeout(() => save(), 400); });
  api.onCommand((name) => {
    const i = name.indexOf(':');
    commands[i < 0 ? name : name.slice(0, i)]?.(i < 0 ? '' : name.slice(i + 1));
  });
  sync();
}
