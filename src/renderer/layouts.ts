import type { DockviewApi, SerializedDockview } from 'dockview-core';
import type { Project } from '../main/projects';
import { activeProject, allProjects, loadProjects, setActiveProject } from './projects';
import { openPanel, panelTypes, park } from './registry';

const api = window.myide;
let dock: DockviewApi;
let perProject: Record<string, unknown> = {}; // mirror of layouts.json perProject, so a switch is synchronous

const projectKey = (): string => activeProject()?.id ?? '';
const cwd = (): string | undefined => activeProject()?.path;

function save(): void {
  clearTimeout(saveTimer);
  const layout = dock.toJSON();
  perProject[projectKey()] = layout;
  api.layouts.putProject(activeProject()?.id ?? null, layout);
}
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function preset(name: string): void {
  dock.clear();
  if (!activeProject()) return;
  const term = openPanel('terminal', { cwd: cwd() });
  if (name === 'files') {
    openPanel('files', {}, { position: { referencePanel: term.id, direction: 'left' }, initialWidth: 260 });
    term.api.setActive();
  }
}

// A named layout can be restored in any project: panels get fresh ids (so no terminal reattaches
// to another panel's shell) and terminals start in the active project.
function fresh(layout: SerializedDockview): SerializedDockview {
  let s = JSON.stringify(layout);
  for (const [id, p] of Object.entries(layout.panels)) {
    s = s.split(JSON.stringify(id)).join(JSON.stringify(`${p.contentComponent}-${crypto.randomUUID().slice(0, 8)}`));
  }
  const out = JSON.parse(s) as SerializedDockview;
  for (const p of Object.values(out.panels)) if (p.contentComponent === 'terminal') p.params = { ...p.params, cwd: cwd() };
  return out;
}

function restore(layout: unknown): void {
  if (layout) {
    try { dock.fromJSON(layout as SerializedDockview); return; } catch (e) { console.error('Layout restore failed', e); }
  }
  preset('terminal');
}

/** Saves the current project's layout and shows `p` with its own layout (default: one terminal). */
function switchTo(p: Project | null, keepOld = true): void {
  if (keepOld) save();
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
  if (p.id === projectKey()) setActiveProject(p); else switchTo(p);
}

/** Removes a project after confirmation; removing the active one switches to the first left. */
export async function removeProject(p = activeProject()): Promise<void> {
  if (!p || !(await api.projects.remove(p.id))) return;
  delete perProject[p.id];
  const rest = await loadProjects();
  if (p.id !== projectKey()) { setActiveProject(rest.find((x) => x.id === projectKey()) ?? null); sync(); return; }
  switchTo(rest[0] ?? null, false); // ends the removed project's shells
}

/** Forgets a project's saved layout; the active project goes back to one terminal now. */
export async function resetLayout(id: string): Promise<void> {
  delete perProject[id];
  await api.prefs.resetLayout(id);
  if (id === projectKey()) preset('terminal');
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
  if (layout) restore(fresh(layout as SerializedDockview));
}

function showPanel(type: string): void {
  const open = dock.panels.find((p) => p.api.component === type);
  if (open) open.api.setActive();
  else if (type === 'files') openPanel('files', {}, { position: { direction: 'left' }, initialWidth: 260 });
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
  'close-tab': () => dock.activePanel?.api.close(),
  'open-preferences': () => { if (panelTypes().some((t) => t.id === 'preferences')) showPanel('preferences'); },
  project: (n) => { const p = allProjects()[Number(n) - 1]; if (p && p.id !== projectKey()) switchTo(p); },
  preset,
  layout: (name) => void restoreNamed(name),
  panel: showPanel,
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
  dock.onDidLayoutChange(() => {
    clearTimeout(saveTimer);
    // A pop-out reopened by fromJSON is only in toJSON once its window is up.
    saveTimer = setTimeout(() => void dock.popoutRestorationPromise.then(save), 400);
    sync();
  });
  addEventListener('beforeunload', save);
  api.onCommand((name) => {
    const i = name.indexOf(':');
    commands[i < 0 ? name : name.slice(0, i)]?.(i < 0 ? '' : name.slice(i + 1));
  });
  sync();
}
