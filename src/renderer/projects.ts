import type { Project } from '../main/projects';
import { moveBefore, moveBy, openTabs } from '../main/tabs';
import { h } from './dom';
import { HOME_ID, resolveScope } from './command';

let projects: Project[] = [];
let active: Project | null = null;
// Home: a tab that is not a project (no folder, no repo), always first, closable, never removed.
// Its empty path means terminals opened there start in the home folder.
const HOME: Project = { id: HOME_ID, name: 'Home', path: '', colour: '#aeb6c0' };
let homeClosed: number | null = null;

/** Every project, closed tabs included, in tab order. Home is not one. */
export const allProjects = (): Project[] => projects;
/** Home, then every project: the tabs, closed ones included. */
export const allTabs = (): Project[] => [{ ...HOME, ...(homeClosed ? { closed: homeClosed } : {}) }, ...projects];
/** The tabs in the top bar (Home first while it is open). */
export const openProjects = (): Project[] => openTabs(allTabs());
/** The shown tab's project; null on Home or with no tab open. */
export const activeProject = (): Project | null => (active?.id === HOME_ID ? null : active);
/** The shown tab, Home included. */
export const activeTab = (): Project | null => active;
/** The project a panel shows (params.scope, see resolveScope): `all` for every project, else `project` (null if it is gone). */
export function scopeOf(params: Record<string, unknown>): { all: boolean; project: Project | null } {
  const id = resolveScope(params.scope, active?.id ?? null);
  return { all: id === null, project: id === null ? null : projects.find((p) => p.id === id) ?? null };
}
/** Reloads the project list; the active project is looked up again (null if it was removed) and the keys redrawn. */
export async function loadProjects(): Promise<Project[]> {
  [projects, homeClosed] = await Promise.all([window.myide.projects.list(), window.myide.projects.homeClosed()]);
  setActiveProject(allTabs().find((p) => p.id === active?.id) ?? null);
  window.dispatchEvent(new Event('myide:projects'));
  return projects;
}

const nav = document.getElementById('project-keys')!;
let handlers: { pick(p: Project): void; add(): void; close(p: Project): void };

async function reorder(next: Project[], focus: string): Promise<void> {
  if (next === projects) return;
  projects = next;
  setActiveProject(active);
  (nav.querySelector(`[data-id="${focus}"]`) as HTMLElement | null)?.focus();
  await window.myide.projects.reorder(next.map((p) => p.id));
}

/** Home (Cmd+0), then one page key per open project in its colour (Cmd+1..9), the active one lit with
 *  a + key after it for adding panels, then the add-project key. Project keys drag to reorder (or Alt+Left/Right),
 *  close on their ×, and have a context menu. */
export function setActiveProject(p: Project | null, on = handlers): void {
  active = p;
  handlers = on;
  const home = homeClosed ? [] : [HOME];
  nav.replaceChildren(...[...home, ...openTabs(projects)].flatMap((proj, n) => {
    const i = n - home.length;
    const isHome = proj.id === HOME_ID;
    const close = h('span', { className: 'proj-close', textContent: '×', title: `Close ${proj.name}'s tab` });
    close.setAttribute('aria-hidden', 'true'); // keyboard: Cmd+Shift+W or the context menu
    close.onclick = (ev) => { ev.stopPropagation(); handlers.close(proj); };
    const b = h('button', {
      type: 'button', className: `key proj-key${isHome ? ' proj-key--home' : ''}`, title: isHome ? 'Home: every project at a glance' : `${proj.path}\nDrag or Alt+Left/Right to reorder`, draggable: !isHome,
      onclick: () => handlers.pick(proj),
    }, h('span', { className: 'proj-name', textContent: proj.name }));
    b.dataset.id = proj.id;
    b.style.setProperty('--proj', proj.colour);
    b.setAttribute('aria-current', String(proj.id === p?.id));
    if (i < 9) {
      b.setAttribute('aria-keyshortcuts', `Meta+${i + 1}`);
      b.append(h('kbd', { textContent: `⌘${i + 1}` }));
    }
    b.append(close);
    b.oncontextmenu = (ev) => { ev.preventDefault(); window.myide.projects.menu(proj.id); };
    // The active tab's + key: add any panel to this tab.
    const add = proj.id === p?.id ? [h('button', { type: 'button', className: 'key proj-add-panel', textContent: '+', title: `Add a panel to ${proj.name}`,
      onclick: () => window.dispatchEvent(new Event('myide:add-panel')) })] : [];
    add[0]?.setAttribute('aria-label', `Add a panel to ${proj.name}`);
    if (isHome) return [b, ...add];
    b.onkeydown = (ev) => {
      if (!ev.altKey || (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight')) return;
      ev.preventDefault();
      void reorder(moveBy(projects, proj.id, ev.key === 'ArrowLeft' ? -1 : 1), proj.id);
    };
    b.ondragstart = (ev) => { ev.dataTransfer!.setData('application/x-myide-project', proj.id); ev.dataTransfer!.effectAllowed = 'move'; b.classList.add('is-dragging'); };
    b.ondragend = () => b.classList.remove('is-dragging');
    b.ondragover = (ev) => {
      if (!ev.dataTransfer?.types.includes('application/x-myide-project')) return;
      ev.preventDefault();
      const after = ev.offsetX > b.offsetWidth / 2;
      b.classList.toggle('drop-before', !after);
      b.classList.toggle('drop-after', after);
    };
    b.ondragleave = () => b.classList.remove('drop-before', 'drop-after');
    b.ondrop = (ev) => {
      ev.preventDefault();
      b.classList.remove('drop-before', 'drop-after');
      const id = ev.dataTransfer!.getData('application/x-myide-project');
      const open = openTabs(projects);
      const before = ev.offsetX > b.offsetWidth / 2 ? (open[open.indexOf(proj) + 1]?.id ?? null) : proj.id;
      if (id) void reorder(moveBefore(projects, id, before), id);
    };
    return [b, ...add];
  }));
  nav.append(h('button', {
    type: 'button', className: 'key key--new', textContent: projects.length ? '+ Project' : 'Add a project',
    title: 'Add a project folder', onclick: () => handlers.add(),
  }));
}
