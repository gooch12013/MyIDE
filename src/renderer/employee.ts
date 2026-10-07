import { h, key } from './dom';
import { api, chip, cue, led, openEmployees, type Employee } from './employees';
import { modelPicker } from './hire';
import { allProjects } from './projects';
import { openPanel, registerPanel } from './registry';

// Talk terminals by panel (= PTY) id. Talk ends when the program the terminal started returns
// to the shell, or the terminal exits or is closed (closing kills its PTY).
const talking = new Map<string, { emp: string; seen: boolean }>();
const talkDone = (tid: string) => {
  const t = talking.get(tid);
  if (!t) return;
  talking.delete(tid);
  void api.employees.talkDone(t.emp);
};
api.pty.onExit((id) => talkDone(id));
api.pty.onInfo((id, info) => {
  const t = talking.get(id);
  if (!t) return;
  if (info.process) t.seen = true;
  else if (t.seen) talkDone(id);
});

const errText = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const apps = api.terminal.apps().catch(() => ['Terminal']);

registerPanel('employee', {
  title: 'Employee',
  create(el, params, panel) {
    el.classList.add('emp');
    const id = typeof params.id === 'string' ? params.id : '';
    if (!id) {
      el.append(h('p', { className: 'files-note', textContent: 'Open an employee from the Employees panel.' }));
      return {};
    }
    openEmployees.set(id, panel);
    let emp: Employee | undefined;

    const status = h('p', { className: 'pref-status' });
    status.setAttribute('aria-live', 'polite');
    const say = (t: string) => { status.textContent = t; };
    const act = (fn: () => Promise<unknown>, done = '') => async () => { try { await fn(); say(done); } catch (e) { say(errText(e)); } };

    // Head: name, LED, chip, and the keys.
    const name = h('h1', { className: 'emp-name' });
    const sub = h('p', { className: 'pref-hint' });
    const talk = key('Talk', act(async () => {
      const { cwd, command } = await api.employees.talk(id);
      talking.set(openPanel('terminal', { cwd, command }).id, { emp: id, seen: false });
    }), { className: 'key key--go', title: 'Pause background turns and open this session in a terminal' });
    const interrupt = key('Interrupt', act(() => api.employees.interrupt(id), 'Interrupted.'));
    const openers = h('span', { className: 'emp-open' });
    void apps.then((list) => openers.append(...list.filter((a) => a !== 'Ghostty').map((a) =>
      key(`Open in ${a}`, () => emp && void api.terminal.openIn(a, emp.worktree), { title: 'Open the worktree' }))));
    const fire = h('button', { type: 'button', className: 'btn btn--quiet rm', textContent: 'Fire…', onclick: () => fireSheet.showModal() });
    const head = h('section', { className: 'emp-head' },
      h('div', {}, name, sub),
      h('div', { className: 'emp-actions' }, talk, interrupt, openers, fire));

    // Three-line status and the cue list.
    const line = (label: string) => { const dd = h('dd'); return [h('div', {}, h('dt', { textContent: label }), dd), dd] as const; };
    const [onRow, onDd] = line('On');
    const [progRow, progDd] = line('Progress');
    const [leftRow, leftDd] = line('Left');
    const status3 = h('dl', { className: 'status3' }, onRow, progRow, leftRow);
    const last = h('p', { className: 'emp-last' });
    const cues = h('ol', { className: 'cuelist' });

    // Message for the next turn.
    const msg = h('textarea', { className: 'input', rows: 3, placeholder: 'A message or the next task. Sent as the next turn.' });
    msg.setAttribute('aria-label', 'Message');
    const send = key('Send', act(async () => {
      if (!msg.value.trim()) return;
      await api.employees.send(id, msg.value.trim());
      msg.value = '';
    }, 'Sent. It runs as the next turn.'));

    // Model and effort, pinned: they apply next turn, or now (interrupt and resume).
    const pending = h('div', { className: 'apply-pending', hidden: true },
      h('span', { textContent: 'Applies on the next turn.' }),
      key('Apply now', act(async () => { await api.employees.setModel(id, { ...pick.get(), now: true }); pending.hidden = true; }, 'Applied now.')));
    const pick = modelPicker('', '', act(async () => { await api.employees.setModel(id, pick.get()); pending.hidden = false; }));

    // Worktree.
    const tree = h('dl', { className: 'kv' });

    // Transcript, loaded when opened.
    const lines = h('ol', { className: 'transcript' });
    const transcript = h('details', { className: 'emp-transcript' }, h('summary', { className: 'legend', textContent: 'Transcript' }), lines);
    transcript.addEventListener('toggle', async () => {
      if (!transcript.open) return;
      try {
        const t = await api.employees.transcript(id);
        lines.replaceChildren(...t.map((m) => h('li', {}, h('span', { className: 'legend', textContent: m.role }), ' ', m.text)));
        if (!t.length) lines.append(h('li', { textContent: 'Nothing yet.' }));
      } catch (e) { lines.replaceChildren(h('li', { textContent: errText(e) })); }
    });

    // Fire: keep or remove the worktree.
    const fireSheet = h('dialog', { className: 'sheet' });
    const doFire = (removeWorktree: boolean) => act(async () => { fireSheet.close(); await api.employees.fire(id, { removeWorktree }); panel.close(); });
    fireSheet.append(h('form', { method: 'dialog' },
      h('p', { className: 'legend', textContent: 'Fire this employee?' }),
      h('p', { className: 'pref-hint', textContent: 'Stops any running turn and forgets the session. The branch stays either way.' }),
      h('div', { className: 'sheet-keys' },
        h('button', { className: 'btn', value: 'cancel', textContent: 'Cancel' }),
        h('button', { type: 'button', className: 'btn', textContent: 'Fire, keep worktree', onclick: doFire(false) }),
        h('button', { type: 'button', className: 'btn rm', textContent: 'Fire, remove worktree', onclick: doFire(true) }))));

    const box = (title: string, ...kids: Node[]) => h('section', { className: 'box' }, h('h2', { className: 'legend box-title', textContent: title }), ...kids);
    el.append(head, status3, last, h('div', { className: 'emp-grid' },
      h('div', { className: 'emp-col' }, box('Cue list', cues), box('Message', msg, h('div', { className: 'pref-ctl' }, send))),
      h('div', { className: 'emp-col' }, box('Model & effort', pick.el, pending), box('Worktree', tree), transcript)),
    status, fireSheet);

    function render(e: Employee): void {
      const first = !emp;
      emp = e;
      panel.setTitle(e.name);
      const proj = allProjects().find((p) => p.id === e.projectId);
      if (proj) el.style.setProperty('--proj', proj.colour);
      name.replaceChildren(e.name, led(e.state), chip(e));
      sub.textContent = `${e.role}${proj ? ` · ${proj.name}` : ''}`;
      talk.disabled = e.state === 'talking';
      interrupt.disabled = !['working', 'needs-you'].includes(e.state);
      if (first) pick.set(e.model, e.effort);

      const p = e.progress;
      const c = cue(e);
      onDd.textContent = c.text || e.task || '—';
      progDd.textContent = e.state === 'failed' ? `Failed: ${e.error ?? 'no detail'}`
        : p?.total ? `${c.count} · ${p.done} done` : led(e.state).textContent!;
      leftDd.textContent = p?.next.length ? p.next.join(' · ') : 'Nothing queued';
      last.textContent = e.lastText ?? '';

      const rows: HTMLElement[] = [];
      const cueRow = (num: string, title: string, state: string, ledState: string, ledText: string) => {
        const li = h('li', { className: 'cue' }, h('span', { className: 'cue-num', textContent: num }), h('span', { className: 'cue-title', textContent: title }), led(ledState, ledText));
        li.dataset.cue = state;
        return li;
      };
      if (p?.done) rows.push(cueRow(p.done > 1 ? `1–${p.done}` : '1', `${p.done} done`, 'done', 'done', 'Done'));
      const complete = !p || p.done >= p.total;
      let n = (p?.done ?? 0) + 1;
      if (p && !complete && p.current) rows.push(cueRow(`Cue ${n++}`, p.current, 'current', e.state, led(e.state).textContent!));
      for (const t of p?.next ?? []) rows.push(cueRow(`Cue ${n++}`, t, 'pending', 'idle', 'Pending'));
      cues.replaceChildren(...rows);
      if (!rows.length) cues.append(h('li', { className: 'pref-hint', textContent: 'No cues yet.' }));

      tree.replaceChildren(
        h('dt', { textContent: 'Branch' }), h('dd', { className: 'path', textContent: e.branch }),
        h('dt', { textContent: 'Path' }), h('dd', { className: 'path', textContent: e.worktree }),
        ...(e.sessionId ? [h('dt', { textContent: 'Session' }), h('dd', { className: 'path', textContent: e.sessionId })] : []));
    }

    void api.employees.list().then((all) => {
      const e = all.find((x) => x.id === id);
      if (e) render(e);
      else name.textContent = 'This employee is gone.';
    });
    const offs = [
      api.employees.onChange((e) => { if (e.id === id) render(e); }),
      api.employees.onRemoved((gone) => { if (gone === id) panel.close(); }),
    ];
    return { dispose() { offs.forEach((off) => off()); openEmployees.delete(id); } };
  },
});
