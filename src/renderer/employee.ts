import { employeeAi } from './accounts';
import { attachBox, imagePaths, thumb, workImages } from './attach';
import { errText, h, key } from './dom';
import { linkify } from './editor';
import { micButton, speakButton } from './speech';
import { api, chip, cue, led, needCard, openEmployee, openEmployees, type Employee } from './employees';
import { draftCard } from './issues';
import { ceilingNote, fmtPick, modelPicker, modePicker } from './hire';
import { allProjects } from './projects';
import { registerPanel } from './registry';
import { openCommandTerminal } from './terminal';

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
      const { cwd, command, ptyId } = await api.employees.talk(id); // main ends Talk when that PTY exits
      openCommandTerminal(cwd, command, ptyId);
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
    const statusBlock = h('div', { className: 'emp-said' }, status3,
      speakButton(() => (emp ? `${emp.name}. On: ${onDd.textContent}. ${progDd.textContent}. Next: ${leftDd.textContent}.` : ''), 'Read status aloud'));
    const last = h('p', { className: 'emp-last' });
    const lastBlock = h('div', { className: 'emp-said emp-said--last' }, last, speakButton(() => emp?.lastText ?? '', 'Read last message aloud'));
    // A grip under the last message: drag (or arrow keys) to make it taller; the height is kept for every employee.
    const LAST_H = 'myide.empLastHeight';
    const grip = h('div', { className: 'emp-grip', tabIndex: 0, title: 'Drag to resize the last message' });
    grip.setAttribute('role', 'separator');
    grip.setAttribute('aria-label', 'Resize the last message');
    const sizeLast = (px: number, keep = false) => {
      last.style.maxHeight = 'none';
      last.style.height = `${Math.max(40, Math.round(px))}px`;
      if (keep) try { localStorage.setItem(LAST_H, last.style.height); } catch { /* storage off: this panel only */ }
    };
    try { const saved = parseFloat(localStorage.getItem(LAST_H) ?? ''); if (saved) sizeLast(saved); } catch { /* storage off: default height */ }
    grip.onpointerdown = (ev) => {
      const y0 = ev.clientY, h0 = last.getBoundingClientRect().height;
      grip.setPointerCapture(ev.pointerId);
      grip.onpointermove = (m) => sizeLast(h0 + m.clientY - y0);
      grip.onpointerup = () => { grip.onpointermove = null; sizeLast(last.getBoundingClientRect().height, true); };
    };
    grip.onkeydown = (k) => {
      if (k.key !== 'ArrowUp' && k.key !== 'ArrowDown') return;
      k.preventDefault();
      sizeLast(last.getBoundingClientRect().height + (k.key === 'ArrowDown' ? 24 : -24), true);
    };
    let lastShots: HTMLElement = h('div'); // images its last message mentions, from its worktree
    let shotsKey = '';
    const cues = h('ol', { className: 'cuelist' });

    // Message for the next turn.
    const msg = h('textarea', { className: 'input', rows: 3, placeholder: 'A message or the next task. Sent as the next turn.' });
    msg.setAttribute('aria-label', 'Message');
    const attach = attachBox(msg, say);
    const sent = h('div', { className: 'emp-sent' }); // the last message sent, with its images
    const send = key('Send', act(async () => {
      if (!msg.value.trim()) { if (attach.images.length) say('Add a line of text to go with the images.'); return; }
      const text = msg.value.trim();
      await api.employees.send(id, text, attach.payload());
      sent.replaceChildren(h('p', { className: 'pref-hint', textContent: `Sent: ${text}` }),
        h('div', { className: 'iss-thumbs' }, ...attach.images.map((i) => thumb(i.url, i.name))));
      attach.clear();
      msg.value = '';
    }, 'Sent. It runs as the next turn.'));

    // Model and effort, pinned: they apply next turn, or now (interrupt and resume).
    const pending = h('div', { className: 'apply-pending', hidden: true },
      h('span', { textContent: 'Applies on the next turn.' }),
      key('Apply now', act(async () => { await api.employees.setModel(id, { ...pick.get(), now: true }); pending.hidden = true; }, 'Applied now.')));
    const pick = modelPicker('', '', act(async () => { await api.employees.setModel(id, pick.get()); pending.hidden = false; }));
    // Mode: pinned uses the picker above; manager and auto choose per task (the chip shows the current pick).
    const mode = modePicker('pinned', act(async () => {
      await api.employees.setModel(id, { mode: mode.get() });
      pending.hidden = true;
      pick.el.hidden = mode.get() !== 'pinned';
    }));
    const ceil = h('p', { className: 'pref-hint' });
    const aiLine = h('p', { className: 'pref-hint' }); // which AI account it runs on
    const held = h('p', { className: 'pref-warn', hidden: true });

    // Worktree.
    const tree = h('dl', { className: 'kv' });

    // Transcript, loaded when opened.
    const lines = h('ol', { className: 'transcript' });
    const transcript = h('details', { className: 'emp-transcript' }, h('summary', { className: 'legend', textContent: 'Transcript' }), lines);
    transcript.addEventListener('toggle', async () => {
      if (!transcript.open) return;
      try {
        const t = await api.employees.transcript(id);
        lines.replaceChildren(...t.map((m) => h('li', {}, h('span', { className: 'legend', textContent: m.role }), ' ', ...linkify(m.text, emp?.worktree ?? ''),
          m.images?.length ? h('div', { className: 'iss-thumbs' }, ...m.images.map((src, n) => thumb(src, `Image ${n + 1}`))) : '',
          m.role === 'user' ? '' : workImages(id, m.text))));
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
    // Everything waiting on David from this employee and, for a lead, from everyone under it: NEEDS YOU cards and
    // drafted issues, answered here. Cards are kept by id across redraws. A lead also lists its reports.
    const needs = h('section', { className: 'needs emp-needs' });
    needs.setAttribute('aria-label', 'Needs you');
    needs.hidden = true;
    const reports = h('ul', { className: 'emp-reports' });
    const reportsBox = h('section', { className: 'box' }, h('h2', { className: 'legend box-title', textContent: 'Reports' }), reports);
    reportsBox.hidden = true;
    const needCards = new Map<string, HTMLElement>();
    let drawSeq = 0;
    const drawNeeds = async () => {
      const n = ++drawSeq;
      const [pendingList, everyone, forges] = await Promise.all([api.approvals.list(), api.employees.list(), api.forge.issues().catch(() => [])]);
      if (n !== drawSeq) return;
      const team = new Set([id]);
      for (let grew = true; grew;) {
        grew = false;
        for (const x of everyone) if (x.parentId && team.has(x.parentId) && !team.has(x.id)) { team.add(x.id); grew = true; }
      }
      const nameOf = (eid: string) => everyone.find((x) => x.id === eid)?.name ?? 'This employee';
      const live = new Set<string>();
      const keep = (k: string, make: () => HTMLElement) => { const c = needCards.get(k) ?? make(); needCards.set(k, c); live.add(k); return c; };
      const cards = [
        ...pendingList.filter((a) => team.has(a.employeeId)).map((a) => keep(`a:${a.id}`, () => needCard(a, nameOf(a.employeeId), undefined))),
        ...forges.flatMap((f) => f.drafts.filter((d) => team.has(d.employeeId)).map((d) => keep(`d:${d.id}`, () => draftCard(f, d)))),
      ];
      for (const k of needCards.keys()) if (!live.has(k)) needCards.delete(k);
      needs.replaceChildren(...cards);
      needs.hidden = !cards.length;
      const mine = everyone.filter((x) => x.parentId === id);
      reports.replaceChildren(...mine.map((x) => h('li', { className: 'emp-report' }, led(x.state),
        key(x.name, () => void openEmployee(x.id), { title: `Open ${x.name}: message, approve, fire` }), chip(x),
        h('span', { className: 'emp-report-cue', textContent: cue(x).text }))));
      reportsBox.hidden = !mine.length;
    };
    void drawNeeds();
    el.append(head, needs, statusBlock, lastBlock, grip, lastShots, h('div', { className: 'emp-grid' },
      h('div', { className: 'emp-col' }, box('Cue list', cues), box('Message', msg, attach.el, h('div', { className: 'pref-ctl' }, micButton(msg, say), send), sent), reportsBox),
      h('div', { className: 'emp-col' }, box('Model & effort', aiLine, mode.el, pick.el, pending, held, ceil), box('Worktree', tree), transcript)),
    status, fireSheet);

    function render(e: Employee): void {
      const first = !emp;
      emp = e;
      panel.setTitle(e.name);
      const proj = allProjects().find((p) => p.id === e.projectId);
      if (proj) el.style.setProperty('--proj', proj.colour);
      name.replaceChildren(e.name, led(e.state), chip(e));
      const rank = e.contractor ? 'Contractor' : e.lead ? 'Lead' : e.parentId ? `Report, level ${e.depth}` : '';
      sub.textContent = [e.issue ? `Working #${e.issue.number}: ${e.issue.title}` : '', e.role, rank, proj?.name].filter(Boolean).join(' · ');
      talk.disabled = e.state === 'talking';
      interrupt.disabled = !['working', 'needs-you'].includes(e.state);
      void employeeAi(e, { pick, talk, line: aiLine, first });
      if (first) { pick.set(e.model, e.effort); mode.set(e.mode); pick.el.hidden = e.mode !== 'pinned'; }
      held.hidden = !e.held;
      held.textContent = e.held ? `Waiting for your approval to run on ${fmtPick(e.held)}, above the ceiling. It is in Needs you.` : '';
      void api.org.get().then((o) => { ceil.textContent = ceilingNote(o.projects.find((p) => p.id === e.projectId)?.ceiling); });

      const p = e.progress;
      const c = cue(e);
      onDd.textContent = c.text || e.task || '—';
      progDd.textContent = e.state === 'failed' ? `Failed: ${e.error ?? 'no detail'}`
        : p?.total ? `${c.count} · ${p.done} done` : led(e.state).textContent!;
      leftDd.textContent = p?.next.length ? p.next.join(' · ') : 'Nothing queued';
      last.replaceChildren(...linkify(e.lastText ?? '', e.worktree));
      const k = imagePaths(e.lastText ?? '').join('\n'); // refetched only when the paths change
      if (k !== shotsKey) { shotsKey = k; const next = workImages(id, e.lastText ?? ''); lastShots.replaceWith(next); lastShots = next; }

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
      api.approvals.onChange(() => void drawNeeds()),
      api.forge.onChange(() => void drawNeeds()),
      api.employees.onChange((e) => { if (e.id === id || e.parentId === id) void drawNeeds(); }),
      api.employees.onRemoved(() => void drawNeeds()),
    ];
    return { dispose() { offs.forEach((off) => off()); openEmployees.delete(id); } };
  },
});
