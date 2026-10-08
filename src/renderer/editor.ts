import * as monaco from 'monaco-editor';
import { ask, choose, errText, h, key, sheet } from './dom';
import { led } from './employees';
import { fileRefs, resolvePath } from './links';
import { activeProject } from './projects';
import { openPanel, registerPanel } from './registry';

const api = window.myide;

// Monaco's language services run in workers, bundled to /monaco/<name>.worker.js by scripts/build.mjs.
const WORKER: Record<string, string> = { typescript: 'ts', javascript: 'ts', css: 'css', scss: 'css', less: 'css', json: 'json', html: 'html', handlebars: 'html', razor: 'html' };
(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker: (_id, label) => new Worker(`/monaco/${WORKER[label] ?? 'editor'}.worker.js`),
};

monaco.editor.defineTheme('myide', {
  base: 'vs-dark', inherit: true, rules: [],
  colors: {
    'editor.background': '#08090b', 'editor.lineHighlightBackground': '#0e1014', 'editorCursor.foreground': '#ffb21a',
    'editor.selectionBackground': '#6b4b0c', 'editorLineNumber.activeForeground': '#e7e9ec', 'editorLineNumber.foreground': '#565e68',
    'diffEditor.insertedTextBackground': '#3ddc8426', 'diffEditor.removedTextBackground': '#ff4d6129',
    'diffEditor.insertedLineBackground': '#3ddc8414', 'diffEditor.removedLineBackground': '#ff4d6117',
  },
});
export const EDITOR_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  theme: 'myide', automaticLayout: true, minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false,
  fontFamily: '"JetBrains Mono", ui-monospace, Menlo, monospace',
};

// Files around embedded projects that Monaco does not map by name. Monaco ships no CMake grammar, so a small one.
monaco.languages.register({ id: 'ini', filenames: ['sdkconfig', 'sdkconfig.defaults'] });
monaco.languages.register({ id: 'cpp', extensions: ['.ino'] });
monaco.languages.register({ id: 'cmake', filenames: ['CMakeLists.txt'], extensions: ['.cmake'] });
monaco.languages.setMonarchTokensProvider('cmake', {
  ignoreCase: true,
  tokenizer: {
    root: [[/#.*$/, 'comment'], [/"([^"\\]|\\.)*"/, 'string'], [/\$\{[^}]*\}/, 'variable'], [/^\s*\w+(?=\s*\()/, 'keyword'], [/\b[A-Z_][A-Z0-9_]+\b/, 'constant'], [/\d+/, 'number']],
  },
});

// One model per open file, shared by every editor panel. A closed panel keeps its unsaved files;
// the next editor panel opened picks them up.
// disk/hash: the file's text as last read or written and the hash of its bytes (a save only lands over that hash);
// theirs: a newer disk text held back because the model has unsaved edits.
type Disk = { text: string; hash: string };
type Doc = { model: monaco.editor.ITextModel; saved: number; root: string; branch: string; disk: string; hash: string; theirs?: Disk };
const docs = new Map<string, Doc>();
const dirty = (d: Doc): boolean => d.model.getAlternativeVersionId() !== d.saved;
const base = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const rel = (d: Doc, path: string): string => (path.startsWith(d.root + '/') ? path.slice(d.root.length + 1) : path);
/** Images and PDFs open to view, not edit: main.ts serves them from app://myide/view (project and worktree files only). */
const VIEWABLE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg|heic|heif|pdf)$/i;
const viewable = (p: string): boolean => VIEWABLE.test(p);

async function load(path: string): Promise<Doc> {
  const have = docs.get(path);
  if (have) return have;
  const { text, hash, root, branch } = await api.code.read(path);
  const uri = monaco.Uri.file(path);
  const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(text, undefined, uri);
  const doc: Doc = { model, saved: model.getAlternativeVersionId(), root, branch, disk: text, hash };
  docs.set(path, doc);
  watchRoot(root);
  return doc;
}

// One watch per checkout with open files. A change on disk reloads a clean file; a dirty one gets the
// "Changed on disk" bar (every editor panel redraws through `instances`).
const watches = new Map<string, Promise<number>>(); // root -> watch id
const watchRoots = new Map<number, string>(); // watch id -> root
function watchRoot(root: string): void {
  if (!watches.has(root)) watches.set(root, api.git.watch(root).then((id) => { watchRoots.set(id, root); return id; }, () => -1));
}
api.git.onChanged(async (id) => {
  const root = watchRoots.get(id);
  if (!root) return;
  for (const [path, d] of docs) {
    if (d.root !== root) continue;
    await recheck(path, d);
  }
  for (const i of instances) i.redraw();
});
/** Compares a doc with its file: a clean doc takes the disk's text, a dirty one holds it back as `theirs`. */
async function recheck(path: string, d: Doc): Promise<void> {
  let now: Disk;
  try { const r = await api.code.read(path); now = { text: r.text, hash: r.hash }; } catch { return; } // deleted or moved: keep what is open
  if (now.hash === d.hash) { d.theirs = undefined; return; }
  if (dirty(d)) d.theirs = now;
  else takeDisk(d, now);
}
/** Replaces the model's text with the disk's, as one undoable edit, and marks it saved. */
function takeDisk(d: Doc, disk: Disk): void {
  d.model.pushEditOperations([], [{ range: d.model.getFullModelRange(), text: disk.text }], () => null);
  d.disk = disk.text;
  d.hash = disk.hash;
  d.theirs = undefined;
  d.saved = d.model.getAlternativeVersionId();
}
/** Saves a doc only over the disk text it was based on; returns '' or why not. A file changed on disk gets the "Changed on disk" bar. */
async function saveDoc(path: string, d: Doc): Promise<string> {
  const text = d.model.getValue();
  const version = d.model.getAlternativeVersionId();
  try {
    d.hash = await api.code.write(path, text, d.hash);
    d.saved = version;
    d.disk = text; // saving after "Keep mine" overwrites their change
    d.theirs = undefined;
    return '';
  } catch (e) {
    await recheck(path, d);
    return errText(e);
  } finally { for (const i of instances) i.redraw(); }
}

// Quitting with unsaved files: main asks the main window (window.myideDirty, then window.myideQuitCheck) before it quits.
const unsaved = () => [...docs].filter(([, d]) => dirty(d));
Object.assign(window, {
  myideDirty: () => unsaved().length,
  async myideQuitCheck(): Promise<boolean> {
    const list = unsaved();
    if (!list.length) return true;
    const pick = await choose(`Save ${list.length === 1 ? base(list[0][0]) : `${list.length} files`} before quitting?`,
      `Unsaved changes:\n${list.map(([p]) => p).join('\n')}`,
      [['discard', 'Don\'t save', 'btn rm'], ['save', 'Save', 'btn btn--primary']]);
    if (pick === 'discard') return true;
    if (pick !== 'save') return false;
    for (const [p, d] of list) if (await saveDoc(p, d)) return false; // the bar or status shows why; quitting stops
    return true;
  },
});

type Instance = { open(path: string, line?: number): Promise<void>; has(path: string): boolean; redraw(): void };
const instances: Instance[] = []; // most recently used first
/** Lets go of a file's model once no editor panel shows it. */
function release(path: string): void {
  const d = docs.get(path);
  if (d && !instances.some((i) => i.has(path))) {
    docs.delete(path);
    d.model.dispose();
    const w = watches.get(d.root);
    if (w && ![...docs.values()].some((x) => x.root === d.root)) { watches.delete(d.root); void w.then((id) => { watchRoots.delete(id); if (id >= 0) api.git.unwatch(id); }); }
  }
}
const ides = api.code.ides().catch(() => [] as string[]);

/** Opens `path` (absolute) in the editor at `line`. With no editor panel open, one opens to the right of panel `beside` (else in the active group). */
export async function openAt(path: string, line?: number, beside?: string): Promise<void> {
  if (!instances.length) openPanel('editor', {}, beside ? { position: { referencePanel: beside, direction: 'right' } } : {});
  await instances[0].open(path, line);
}

/** `text` with its file:line references as links that open the editor there; relative ones resolve against `root`. */
export function linkify(text: string, root: string): (Node | string)[] {
  const out: (Node | string)[] = [];
  let at = 0;
  for (const r of fileRefs(text)) {
    const abs = resolvePath(root, r.path);
    const a = h('a', { href: '#', className: 'file-link', textContent: text.slice(r.start, r.end), title: `Open at line ${r.line}` });
    a.onclick = async (e) => {
      e.preventDefault();
      if (await api.code.exists(abs)) await openAt(abs, r.line);
      else { a.classList.add('is-missing'); a.title = 'Not a file in this project or its worktrees'; }
    };
    out.push(text.slice(at, r.start), a);
    at = r.end;
  }
  out.push(text.slice(at));
  return out;
}

registerPanel('editor', {
  title: 'Editor',
  description: "Edit a file from the project or an employee's worktree.",
  create(el, params, panel) {
    el.classList.add('ed');
    let current: string | null = null;
    const open = new Set<string>();

    const tabs = h('div', { className: 'ed-files', role: 'tablist' });
    tabs.setAttribute('aria-label', 'Open files');
    const pathEl = h('span', { className: 'path' });
    const wt = h('span', { className: 'ed-wt' });
    const diskBar = h('div', { className: 'ed-disk', hidden: true }, h('span', { textContent: 'Changed on disk.' }),
      key('Reload', () => { const d = current ? docs.get(current) : undefined; if (d?.theirs) takeDisk(d, d.theirs); for (const i of instances) i.redraw(); }, { className: 'key key--sm key--lit' }),
      key('Keep mine', () => { const d = current ? docs.get(current) : undefined; if (d?.theirs) { d.disk = d.theirs.text; d.hash = d.theirs.hash; d.theirs = undefined; } for (const i of instances) i.redraw(); }));
    diskBar.setAttribute('role', 'alert');
    const status = h('p', { className: 'ed-status' });
    status.setAttribute('aria-live', 'polite');
    const say = (t: string) => { status.textContent = t; };
    const send = key('Send selection', () => void sendSelection(), { title: 'Send the selected code to an employee (⌘⇧E)', disabled: true });
    const ideKeys = h('span', { className: 'ed-keys' }, send);
    void ides.then((list) => ideKeys.append(...list.map((ide) => key(`Open in ${ide}`, () => {
      if (current) void api.code.openIn(ide, current, editor.getPosition()?.lineNumber ?? 1);
    }, { title: `Open this file in ${ide} at the cursor line` }))));
    const body = h('div', { className: 'ed-body' });
    const viewer = h('div', { className: 'ed-view', hidden: true }); // an image or a PDF in place of the editor
    el.append(tabs, h('div', { className: 'ed-head' }, h('p', { className: 'ed-path' }, pathEl), wt, ideKeys), diskBar, body, viewer, status);

    const editor = monaco.editor.create(body, { ...EDITOR_OPTIONS, model: null });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void save());
    editor.addAction({
      id: 'myide.send-selection', label: 'Send Selection to Employee…', contextMenuGroupId: 'navigation', contextMenuOrder: 0,
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyE],
      run: () => void sendSelection(),
    });
    editor.onDidFocusEditorText(() => { instances.splice(instances.indexOf(self), 1); instances.unshift(self); });

    function remember(): void { panel.updateParameters({ files: [...open], active: current }); }

    function drawTabs(): void {
      tabs.replaceChildren(...[...open].map((p) => {
        const d = docs.get(p);
        const mark = d && dirty(d) ? ' ●' : '';
        const tab = h('div', { className: `ed-file${p === current ? ' is-active' : ''}` },
          h('button', { type: 'button', className: 'ed-file-open', textContent: base(p) + mark, title: p, role: 'tab', onclick: () => void show(p) }),
          h('button', { type: 'button', className: 'ed-file-x', textContent: '×', onclick: () => void close(p) }));
        (tab.firstChild as HTMLElement).setAttribute('aria-selected', String(p === current));
        if (mark) (tab.firstChild as HTMLElement).setAttribute('aria-label', `${base(p)}, unsaved changes`);
        (tab.lastChild as HTMLElement).setAttribute('aria-label', `Close ${base(p)}`);
        return tab;
      }));
      const d = current ? docs.get(current) : undefined;
      pathEl.textContent = d && current ? rel(d, current) : current ?? '';
      wt.textContent = d?.branch ? `on ${d.branch}` : '';
      panel.setTitle(current ? `${d && dirty(d) ? '● ' : ''}${base(current)}` : 'Editor');
      send.disabled = !current || viewable(current);
      diskBar.hidden = !d?.theirs;
    }

    /** An image (fit to the panel; click for actual size) or a PDF (Chromium's viewer), read fresh from disk each time. */
    function view(path: string): void {
      const src = `/view?path=${encodeURIComponent(path)}&t=${Date.now()}`;
      let shown: HTMLElement;
      if (/\.pdf$/i.test(path)) shown = h('iframe', { className: 'ed-pdf', src, title: base(path) });
      else {
        const img = h('img', { className: 'ed-img', src, alt: base(path), title: 'Click for actual size' });
        img.onload = () => say(`${base(path)}: ${img.naturalWidth} × ${img.naturalHeight} px. View only.`);
        img.onerror = () => say(`Could not show ${base(path)}.`);
        img.onclick = () => img.classList.toggle('is-actual');
        shown = img;
      }
      viewer.replaceChildren(shown);
      viewer.hidden = false;
      body.hidden = true;
      editor.setModel(null);
      current = path;
      open.add(path);
      if (/\.pdf$/i.test(path)) say(`${base(path)}: view only.`);
      drawTabs();
      remember();
    }

    async function show(path: string, line?: number): Promise<void> {
      if (viewable(path)) return view(path);
      let d: Doc;
      try { d = await load(path); } catch (e) { say(`Could not open ${base(path)}: ${errText(e)}`); return; }
      open.add(path);
      viewer.replaceChildren();
      viewer.hidden = true;
      body.hidden = false;
      if (current !== path) { editor.setModel(d.model); current = path; }
      if (line) {
        editor.revealLineInCenter(line);
        editor.setPosition({ lineNumber: line, column: 1 });
      }
      editor.focus();
      drawTabs();
      remember();
    }

    async function save(): Promise<void> {
      const d = current ? docs.get(current) : undefined;
      if (!d || !current) return;
      const why = await saveDoc(current, d);
      say(why ? `Could not save: ${why}` : `Saved ${rel(d, current)}`);
    }

    async function close(path: string): Promise<void> {
      const d = docs.get(path);
      if (d && dirty(d) && !(await ask(`Close ${base(path)} without saving?`, 'Your changes to this file will be lost.', 'Close without saving', true))) return;
      open.delete(path);
      if (d) { d.saved = d.model.getAlternativeVersionId(); release(path); } // its changes were dropped on purpose
      if (current === path) {
        current = null;
        const next = [...open].pop();
        if (next) await show(next);
        else { editor.setModel(null); viewer.replaceChildren(); viewer.hidden = true; body.hidden = false; }
      }
      drawTabs();
      remember();
    }

    async function sendSelection(): Promise<void> {
      const d = current ? docs.get(current) : undefined;
      const sel = editor.getSelection();
      const project = activeProject();
      if (!d || !current || !sel || !project) return;
      const text = d.model.getValueInRange(sel);
      if (!text.trim()) { say('Select some code first.'); return; }
      const end = sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber ? sel.endLineNumber - 1 : sel.endLineNumber; // whole lines selected
      const lines = sel.startLineNumber === end ? `${end}` : `${sel.startLineNumber}-${end}`;
      const ref = `${rel(d, current)}:${lines}`;
      const emps = await api.employees.list(project.id);
      if (!emps.length) { say('No employees in this project to send to.'); return; }
      const pick = h('fieldset', { className: 'send-who' }, h('legend', { className: 'field-label legend', textContent: 'To employee' }),
        ...emps.map((e, i) => {
          const r = h('input', { type: 'radio', name: 'who', value: e.id, checked: e.worktree === d.root || (i === 0 && !emps.some((x) => x.worktree === d.root)) });
          return h('label', { className: 'who' }, r, h('span', { className: 'who-name', textContent: e.name }), led(e.state), h('span', { className: 'who-role', textContent: e.role }));
        }));
      const note = h('input', { className: 'input', autocomplete: 'off', placeholder: 'A question or instruction (optional)' });
      note.setAttribute('aria-label', 'Note');
      const form = h('form', { method: 'dialog' },
        h('p', { className: 'legend', textContent: `Send ${ref}` }), pick, note,
        h('p', { className: 'pref-hint', textContent: 'Arrives as its next turn; nothing running is interrupted.' }),
        h('div', { className: 'sheet-keys' },
          h('button', { className: 'btn', value: 'cancel', formNoValidate: true, textContent: 'Cancel' }),
          h('button', { className: 'btn btn--primary', value: 'send', textContent: 'Send' })));
      const d2 = sheet('Send selection to an employee', form, 'send-sheet');
      await new Promise((r) => d2.addEventListener('close', r, { once: true }));
      const id = (form.elements.namedItem('who') as RadioNodeList | null)?.value;
      if (d2.returnValue !== 'send' || !id) return;
      const fence = '```';
      const message = `${note.value.trim() ? note.value.trim() + '\n\n' : ''}From ${ref}:\n${fence}${d.model.getLanguageId()}\n${text}\n${fence}`;
      try {
        await api.employees.send(id, message);
        say(`Sent ${ref} to ${emps.find((e) => e.id === id)?.name}.`);
      } catch (e) { say(`Could not send: ${errText(e)}`); }
    }

    const changed = editor.onDidChangeModelContent(() => drawTabs());

    const self: Instance = { open: show, has: (p) => open.has(p), redraw: drawTabs };
    instances.unshift(self);

    // Reopen the files this panel had, then any unsaved files a closed panel left behind.
    const saved = Array.isArray(params.files) ? (params.files as string[]) : [];
    const orphans = [...docs.keys()].filter((p) => dirty(docs.get(p)!));
    void (async () => {
      for (const p of [...saved, ...orphans]) {
        if (open.has(p)) continue;
        try { if (viewable(p) ? await api.code.exists(p) : await load(p)) open.add(p); } catch { /* moved or deleted */ }
      }
      const active = typeof params.active === 'string' && open.has(params.active) ? params.active : [...open].pop();
      if (active) await show(active); else drawTabs();
    })();

    return {
      onShow: () => editor.layout(),
      dispose() {
        instances.splice(instances.indexOf(self), 1);
        changed.dispose();
        // Unsaved files stay in memory for the next editor panel; saved ones are let go.
        for (const p of open) { const d = docs.get(p); if (d && !dirty(d)) release(p); }
        editor.dispose();
      },
    };
  },
});
