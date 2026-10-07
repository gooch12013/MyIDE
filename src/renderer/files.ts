import { activeProject } from './projects';
import { registerPanel } from './registry';

const { files } = window.myide;

// Read-only tree of the active project's folder. Folders load their children when first opened.
registerPanel('files', {
  title: 'Files',
  create(el) {
    const project = activeProject();
    el.classList.add('files');
    if (!project) {
      el.innerHTML = '<p class="files-note">No project open.</p>';
      return {};
    }
    const head = document.createElement('header');
    head.className = 'files-head';
    head.innerHTML = '<span class="legend"></span><span class="files-root"></span>';
    head.children[0].textContent = project.name;
    head.children[1].textContent = `\u200e${project.path}`; // LRM keeps the leading / at the start under rtl
    const status = document.createElement('p');
    status.className = 'files-note';
    status.setAttribute('aria-live', 'polite');
    const tree = document.createElement('ul');
    tree.className = 'tree';
    el.append(head, tree, status);

    const say = (text: string) => { status.textContent = text; };

    async function fill(ul: HTMLUListElement, dir: string): Promise<void> {
      let entries: { name: string; dir: boolean }[];
      try { entries = await files.list(dir); } catch (e) { say(`Could not read ${dir}: ${(e as Error).message}`); return; }
      ul.replaceChildren(...entries.map(({ name, dir: isDir }) => {
        const path = `${dir}/${name}`;
        const li = document.createElement('li');
        if (isDir) {
          const details = document.createElement('details');
          const summary = document.createElement('summary');
          summary.className = 'tr-row tr-dir';
          summary.textContent = name;
          const sub = document.createElement('ul');
          details.append(summary, sub);
          details.addEventListener('toggle', () => { if (details.open && !sub.childElementCount) void fill(sub, path); });
          li.append(details);
        } else {
          const row = document.createElement('div');
          row.className = 'tr-row';
          const open = document.createElement('button');
          open.type = 'button';
          open.className = 'tr-name';
          open.textContent = name;
          open.title = `Open ${name} in its default app`;
          open.onclick = async () => { const err = await files.open(path); say(err ? `Could not open ${name}: ${err}` : ''); };
          const copy = document.createElement('button');
          copy.type = 'button';
          copy.className = 'key key--sm tr-copy';
          copy.textContent = 'Copy path';
          copy.setAttribute('aria-label', `Copy path of ${name}`);
          copy.onclick = () => { window.myide.terminal.copy(path); say(`Copied ${path}`); };
          row.append(open, copy);
          li.append(row);
        }
        return li;
      }));
      if (ul === tree && !entries.length) say('This folder is empty.');
    }
    void fill(tree, project.path);
    return {};
  },
});
