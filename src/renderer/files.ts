import { errText, h } from './dom';
import { openAt } from './editor';
import { activeProject } from './projects';
import { registerPanel } from './registry';

const { git } = window.myide;

// Git status letters: each has its own colour, and the letter itself is always shown.
export const STATUS: Record<string, string> = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', U: 'conflict', T: 'type changed', '?': 'untracked' };
export function mark(letter: string): HTMLSpanElement {
  const m = h('span', { className: 'tr-mark', textContent: letter });
  m.dataset.g = letter;
  m.title = STATUS[letter] ?? letter;
  m.setAttribute('aria-label', STATUS[letter] ?? letter);
  return m;
}

type Node = { dirs: Map<string, Node>; files: [string, string][] };
function build(files: [string, string][]): Node {
  const root: Node = { dirs: new Map(), files: [] };
  for (const [path, st] of files) {
    const parts = path.split('/');
    let n = root;
    for (const dir of parts.slice(0, -1)) {
      if (!n.dirs.has(dir)) n.dirs.set(dir, { dirs: new Map(), files: [] });
      n = n.dirs.get(dir)!;
    }
    n.files.push([parts[parts.length - 1], st]);
  }
  return root;
}
const changed = (n: Node): boolean => n.files.some(([, s]) => s) || [...n.dirs.values()].some(changed);

// The project's files from git (tracked and untracked, not ignored) with status letters, for the
// main checkout or any employee worktree. Refreshes when files change on disk.
registerPanel('files', {
  title: 'Files',
  create(el, params, panel) {
    const project = activeProject();
    el.classList.add('files');
    if (!project) {
      el.innerHTML = '<p class="files-note">No project open.</p>';
      return {};
    }
    const seg = h('fieldset', { className: 'seg wt-seg' }, h('legend', { className: 'legend', textContent: 'Worktree' }));
    const rootEl = h('span', { className: 'files-root' });
    const status = h('p', { className: 'files-note' });
    status.setAttribute('aria-live', 'polite');
    const tree = h('ul', { className: 'tree' });
    const legend = h('p', { className: 'tree-key' }, ...['M', 'A', '?', 'D'].flatMap((l) => [mark(l), ` ${STATUS[l]} `]));
    el.append(h('header', { className: 'files-head' }, h('span', { className: 'legend', textContent: project.name }), seg, rootEl), tree, status, legend);
    const say = (text: string) => { status.textContent = text; };

    let root = typeof params.root === 'string' ? params.root : project.path;
    const openDirs = new Set<string>();
    let watchId = 0;
    let disposed = false;

    function fill(ul: HTMLUListElement, n: Node, prefix: string): void {
      const dirs = [...n.dirs].sort(([a], [b]) => a.localeCompare(b)).map(([name, sub]) => {
        const path = prefix + name;
        const ulSub = h('ul');
        const summary = h('summary', { className: 'tr-row tr-dir', textContent: name });
        if (changed(sub)) summary.append(h('span', { className: 'tr-dot', title: 'Has changes', ariaLabel: 'has changes' }));
        const details = h('details', {}, summary, ulSub);
        details.open = openDirs.has(path);
        if (details.open) fill(ulSub, sub, path + '/');
        details.addEventListener('toggle', () => {
          if (details.open) { openDirs.add(path); if (!ulSub.childElementCount) fill(ulSub, sub, path + '/'); } else openDirs.delete(path);
        });
        return h('li', {}, details);
      });
      const files = [...n.files].sort(([a], [b]) => a.localeCompare(b)).map(([name, st]) => {
        const abs = `${root}/${prefix}${name}`;
        const row = h('div', { className: 'tr-row tr-file' },
          h('button', { type: 'button', className: 'tr-name', textContent: name, title: `${prefix}${name}`, onclick: () => void openAt(abs, undefined, panel.id) }));
        if (st) { row.dataset.g = st; row.append(mark(st)); }
        return h('li', {}, row);
      });
      ul.replaceChildren(...dirs, ...files);
    }

    async function refresh(): Promise<void> {
      try {
        const r = await git.tree(root);
        if (disposed) return;
        fill(tree, build(r.files), '');
        const n = r.files.filter(([, s]) => s).length;
        say(!r.files.length ? 'This folder is empty.' : !r.git ? 'Not a git repository: no status letters.' : n ? `${n} changed file${n === 1 ? '' : 's'}` : '');
      } catch (e) { say(`Could not list ${root}: ${errText(e)}`); }
    }

    async function use(path: string): Promise<void> {
      root = path;
      rootEl.textContent = `‎${path}`; // LRM keeps the leading / at the start under rtl
      panel.updateParameters({ ...params, root });
      if (watchId) git.unwatch(watchId);
      watchId = 0;
      await refresh();
      try { watchId = await git.watch(path); } catch { /* listed once, no live refresh */ }
      if (disposed && watchId) git.unwatch(watchId);
    }

    const off = git.onChanged((id) => { if (id === watchId) void refresh(); });

    void git.worktrees(project.id).then((wts) => {
      if (!wts.some((w) => w.path === root)) root = wts[0]?.path ?? project.path;
      seg.append(...wts.flatMap((w, i) => {
        const id = `wt-${crypto.randomUUID().slice(0, 8)}`;
        const label = i === 0 ? 'main' : w.branch.replace(/^myide\//, '') || w.path.slice(w.path.lastIndexOf('/') + 1);
        const r = h('input', { type: 'radio', name: `wt-${panel.id}`, id, checked: w.path === root, onchange: () => void use(w.path) });
        return [r, h('label', { className: 'key key--sm', htmlFor: id, textContent: label, title: `${w.path}${w.branch ? ` (${w.branch})` : ''}` })];
      }));
      void use(root);
    });

    return { dispose: () => { disposed = true; off(); if (watchId) git.unwatch(watchId); } };
  },
});
