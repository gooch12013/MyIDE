import type { Project } from '../main/projects';
import { moveBefore, moveBy, openTabs } from '../main/tabs';
import { h } from './dom';

let projects: Project[] = [];
let active: Project | null = null;

/** Every project, closed tabs included, in tab order. */
export const allProjects = (): Project[] => projects;
/** The projects with a tab in the top bar. */
export const openProjects = (): Project[] => openTabs(projects);
export const activeProject = (): Project | null => active;
/** Reloads the project list; the active project is looked up again (null if it was removed) and the keys redrawn. */
export async function loadProjects(): Promise<Project[]> {
  projects = await window.myide.projects.list();
  setActiveProject(projects.find((p) => p.id === active?.id) ?? null);
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

/** One page key per open project in its colour (Cmd+1..9), the active one lit, then the add key.
 *  Keys drag to reorder (or Alt+Left/Right), close on their ×, and have a context menu. */
export function setActiveProject(p: Project | null, on = handlers): void {
  active = p;
  handlers = on;
  nav.replaceChildren(...openProjects().map((proj, i) => {
    const close = h('span', { className: 'proj-close', textContent: '×', title: `Close ${proj.name}'s tab` });
    close.setAttribute('aria-hidden', 'true'); // keyboard: Cmd+Shift+W or the context menu
    close.onclick = (ev) => { ev.stopPropagation(); handlers.close(proj); };
    const b = h('button', {
      type: 'button', className: 'key proj-key', title: `${proj.path}\nDrag or Alt+Left/Right to reorder`, draggable: true,
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
      const open = openProjects();
      const before = ev.offsetX > b.offsetWidth / 2 ? (open[open.indexOf(proj) + 1]?.id ?? null) : proj.id;
      if (id) void reorder(moveBefore(projects, id, before), id);
    };
    return b;
  }));
  nav.append(h('button', {
    type: 'button', className: 'key key--new', textContent: projects.length ? '+ Project' : 'Add a project',
    title: 'Add a project folder', onclick: () => handlers.add(),
  }));
}
