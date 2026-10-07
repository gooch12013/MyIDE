import type { Project } from '../main/projects';

let projects: Project[] = [];
let active: Project | null = null;

export const allProjects = (): Project[] => projects;
export const activeProject = (): Project | null => active;
export async function loadProjects(): Promise<Project[]> {
  projects = await window.myide.projects.list();
  return projects;
}

const nav = document.getElementById('project-keys')!;
let handlers: { pick(p: Project): void; add(): void };

/** One page key per project in its colour (Cmd+1..9), the active one lit, then the add key. */
export function setActiveProject(p: Project | null, on = handlers): void {
  active = p;
  handlers = on;
  nav.replaceChildren(...projects.map((proj, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'key proj-key';
    b.style.setProperty('--proj', proj.colour);
    b.title = proj.path;
    b.setAttribute('aria-current', String(proj.id === p?.id));
    const name = document.createElement('span');
    name.className = 'proj-name';
    name.textContent = proj.name;
    b.append(name);
    if (i < 9) {
      b.setAttribute('aria-keyshortcuts', `Meta+${i + 1}`);
      const k = document.createElement('kbd');
      k.textContent = `⌘${i + 1}`;
      b.append(k);
    }
    b.onclick = () => handlers.pick(proj);
    return b;
  }));
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'key key--new';
  add.textContent = projects.length ? '+ Project' : 'Add a project';
  add.title = 'Add a project folder';
  add.onclick = () => handlers.add();
  nav.append(add);
}
