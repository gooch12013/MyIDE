import { h, key } from './dom';
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
    const head = h('header', { className: 'files-head' },
      h('span', { className: 'legend', textContent: project.name }),
      h('span', { className: 'files-root', textContent: `\u200e${project.path}` })); // LRM keeps the leading / at the start under rtl
    const status = h('p', { className: 'files-note' });
    status.setAttribute('aria-live', 'polite');
    const tree = h('ul', { className: 'tree' });
    el.append(head, tree, status);

    const say = (text: string) => { status.textContent = text; };

    async function fill(ul: HTMLUListElement, dir: string): Promise<void> {
      let entries: { name: string; dir: boolean }[];
      try { entries = await files.list(dir); } catch (e) { say(`Could not read ${dir}: ${(e as Error).message}`); return; }
      ul.replaceChildren(...entries.map(({ name, dir: isDir }) => {
        const path = `${dir}/${name}`;
        if (isDir) {
          const sub = h('ul');
          const details = h('details', {}, h('summary', { className: 'tr-row tr-dir', textContent: name }), sub);
          details.addEventListener('toggle', () => { if (details.open && !sub.childElementCount) void fill(sub, path); });
          return h('li', {}, details);
        }
        const open = h('button', {
          type: 'button', className: 'tr-name', textContent: name, title: `Open ${name} in its default app`,
          onclick: async () => { const err = await files.open(path); say(err ? `Could not open ${name}: ${err}` : ''); },
        });
        const copy = key('Copy path', () => { window.myide.terminal.copy(path); say(`Copied ${path}`); }, { className: 'key key--sm tr-copy' });
        copy.setAttribute('aria-label', `Copy path of ${name}`);
        return h('li', {}, h('div', { className: 'tr-row' }, open, copy));
      }));
      if (ul === tree && !entries.length) say('This folder is empty.');
    }
    void fill(tree, project.path);
    return {};
  },
});
