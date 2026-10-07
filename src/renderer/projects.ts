import type { Project } from '../main/projects';
import { h } from './dom';

let projects: Project[] = [];
let active: Project | null = null;

export const allProjects = (): Project[] => projects;
export const activeProject = (): Project | null => active;
/** Reloads the project list; the active project is looked up again (null if it was removed) and the keys redrawn. */
export async function loadProjects(): Promise<Project[]> {
  projects = await window.myide.projects.list();
  setActiveProject(projects.find((p) => p.id === active?.id) ?? null);
  return projects;
}

const nav = document.getElementById('project-keys')!;
let handlers: { pick(p: Project): void; add(): void };

/** One page key per project in its colour (Cmd+1..9), the active one lit, then the add key. */
export function setActiveProject(p: Project | null, on = handlers): void {
  active = p;
  handlers = on;
  nav.replaceChildren(...projects.map((proj, i) => {
    const b = h('button', { type: 'button', className: 'key proj-key', title: proj.path, onclick: () => handlers.pick(proj) },
      h('span', { className: 'proj-name', textContent: proj.name }));
    b.style.setProperty('--proj', proj.colour);
    b.setAttribute('aria-current', String(proj.id === p?.id));
    if (i < 9) {
      b.setAttribute('aria-keyshortcuts', `Meta+${i + 1}`);
      b.append(h('kbd', { textContent: `⌘${i + 1}` }));
    }
    return b;
  }));
  nav.append(h('button', {
    type: 'button', className: 'key key--new', textContent: projects.length ? '+ Project' : 'Add a project',
    title: 'Add a project folder', onclick: () => handlers.add(),
  }));
}
