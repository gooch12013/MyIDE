import * as monaco from 'monaco-editor';
import { ask, errText, h, key } from './dom';
import { EDITOR_OPTIONS, openAt } from './editor';
import { mark } from './files';
import { activeProject } from './projects';
import { registerPanel } from './registry';

const api = window.myide;

// Review an employee's branch: what changed since it left the main checkout's branch
// (`git diff <base>...myide/<name>`), then merge it there or discard it.
registerPanel('diff', {
  title: 'Review',
  description: "An employee branch's changes, to merge or discard.",
  create(el, params, panel) {
    const project = activeProject();
    el.classList.add('review');
    if (!project) {
      el.append(h('p', { className: 'files-note', textContent: 'No project open.' }));
      return {};
    }
    let branch = typeof params.branch === 'string' ? params.branch : '';
    let current: { path: string; old?: string } | null = null;

    const pick = h('select', { className: 'select', onchange: () => void choose(pick.value) });
    pick.setAttribute('aria-label', 'Employee branch');
    const baseEl = h('span', { className: 'rv-base' });
    const status = h('p', { className: 'ed-status rv-status' });
    status.setAttribute('aria-live', 'polite');
    const say = (t: string, ...kids: Node[]) => { status.replaceChildren(t, ...kids); };
    const openKey = key('Open at line', () => void openCurrent(), { title: 'Open this file in the editor at the cursor line', disabled: true });
    const merge = key('Merge…', () => void doMerge(), { className: 'key key--sm key--go', disabled: true });
    const discard = h('button', { type: 'button', className: 'btn btn--quiet rm', textContent: 'Discard…', disabled: true, onclick: () => void doDiscard() });
    const list = h('ul', { className: 'rv-files' });
    list.setAttribute('aria-label', 'Changed files');
    const body = h('div', { className: 'rv-diff' });
    el.append(
      h('header', { className: 'ed-head' }, pick, baseEl, h('span', { className: 'ed-keys' }, openKey, key('Refresh', () => void load()), merge, discard)),
      h('div', { className: 'rv-body' }, list, body), status);

    const diff = monaco.editor.createDiffEditor(body, { ...EDITOR_OPTIONS, readOnly: true, originalEditable: false, renderSideBySide: true });
    diff.getModifiedEditor().addAction({
      id: 'myide.open-at-line', label: 'Open in Editor at This Line', contextMenuGroupId: 'navigation', contextMenuOrder: 0,
      run: () => void openCurrent(),
    });
    let models: monaco.editor.ITextModel[] = [];
    const clear = () => { diff.setModel(null); models.forEach((m) => m.dispose()); models = []; };

    /** Where the branch's files are on disk: its worktree, or the main checkout when it has none. */
    async function checkout(): Promise<string> {
      const wts = await api.git.worktrees(project!.id);
      return (wts.find((w) => w.branch === branch) ?? wts[0]).path;
    }
    async function openCurrent(): Promise<void> {
      if (!current) return;
      const line = diff.getModifiedEditor().getPosition()?.lineNumber ?? diff.getLineChanges()?.[0]?.modifiedStartLineNumber ?? 1;
      await openAt(`${await checkout()}/${current.path}`, line, panel.id);
    }

    async function show(f: { status: string; path: string; old?: string }): Promise<void> {
      current = f;
      for (const b of list.querySelectorAll('button')) b.setAttribute('aria-current', String(b.dataset.path === f.path));
      try {
        const { original, modified } = await api.git.diffFile(project!.id, branch, f.path, f.old);
        clear();
        const n = Date.now();
        models = [
          monaco.editor.createModel(original, undefined, monaco.Uri.from({ scheme: 'base', path: `/${n}/${f.old ?? f.path}` })),
          monaco.editor.createModel(modified, undefined, monaco.Uri.from({ scheme: 'branch', path: `/${n}/${f.path}` })),
        ];
        diff.setModel({ original: models[0], modified: models[1] });
        openKey.disabled = f.status === 'D';
      } catch (e) { say(`Could not load ${f.path}: ${errText(e)}`); }
    }

    async function load(): Promise<void> {
      const branches = await api.git.branches(project!.id).catch(() => [] as string[]);
      if (!branches.includes(branch)) branch = branches[0] ?? '';
      pick.replaceChildren(...branches.map((b) => h('option', { value: b, textContent: b, selected: b === branch })));
      pick.disabled = !branches.length;
      merge.disabled = discard.disabled = !branch;
      list.replaceChildren();
      clear();
      current = null;
      openKey.disabled = true;
      if (!branch) { baseEl.textContent = ''; say('No employee branches in this project.'); return; }
      panel.setTitle(`Review ${branch.replace(/^myide\//, '')}`);
      try {
        const { base, files } = await api.git.diff(project!.id, branch);
        baseEl.textContent = `vs ${base}`;
        list.replaceChildren(...files.map((f) => {
          const b = h('button', { type: 'button', className: 'tr-row rv-file', title: f.old ? `${f.old} → ${f.path}` : f.path, onclick: () => void show(f) },
            mark(f.status), h('span', { className: 'rv-path', textContent: f.path }));
          b.dataset.path = f.path;
          return h('li', {}, b);
        }));
        say(files.length ? `${files.length} file${files.length === 1 ? '' : 's'} changed on ${branch} since it left ${base}.` : `Nothing on ${branch} that ${base} does not have.`);
        if (files[0]) await show(files[0]);
      } catch (e) { say(`Could not diff ${branch}: ${errText(e)}`); }
    }

    function choose(b: string): void {
      branch = b;
      panel.updateParameters({ ...params, branch });
      void load();
    }

    async function doMerge(): Promise<void> {
      const into = baseEl.textContent?.replace(/^vs /, '') || 'the main checkout';
      if (!(await ask(`Merge ${branch} into ${into}?`, `Runs git merge --no-ff ${branch} in ${project!.path}. Conflicts are left there for you.`, 'Merge'))) return;
      try {
        const r = await api.git.merge(project!.id, branch);
        if (r.conflicts?.length) {
          const links = r.conflicts.map((c) => h('button', { type: 'button', className: 'rv-link', textContent: c.startsWith(project!.path + '/') ? c.slice(project!.path.length + 1) : c, onclick: () => void openAt(c, 1, panel.id) }));
          say(`${r.message} `, ...links);
          return;
        }
        say(r.message);
        if (r.ok) await load();
      } catch (e) { say(`Merge failed: ${errText(e)}`); }
    }

    async function doDiscard(): Promise<void> {
      const b = branch;
      if (!(await ask(`Discard ${b}?`, 'Deletes the branch and any commits on it that are not merged. This cannot be undone.', 'Discard', true))) return;
      try {
        let r = await api.git.discard(project!.id, b);
        if (!r.ok && r.worktree) {
          const emp = (await api.employees.list(project!.id)).find((e) => e.branch === b);
          const who = emp ? ` ${emp.name} works there and will be fired.` : '';
          const lost = r.lost ?? [];
          const files = lost.length ? `\n\nIn the worktree now (!! is ignored, deleted with it; anything else makes git refuse):\n${lost.slice(0, 30).join('\n')}${lost.length > 30 ? `\n…and ${lost.length - 30} more` : ''}` : '';
          if (!(await ask(`Remove the worktree too?`, `${r.message}${who} Git refuses if it has uncommitted changes.${files}`, 'Remove worktree and discard', true))) return;
          r = await api.git.discard(project!.id, b, true); // throws, keeping the employee, if git will not remove it
          if (emp) await api.employees.fire(emp.id, { removeWorktree: false });
        }
        say(r.message);
        await load();
      } catch (e) { say(`Could not discard: ${errText(e)}`); }
    }

    void load();
    return {
      onShow: () => diff.layout(),
      dispose: () => { clear(); diff.dispose(); },
    };
  },
});
