// Role wizard panel: pick a template (or blank), a short interview with the AI (its structured questions are controls,
// the settings one card), then a review form with a live preview of the role file, save, and "Hire one now?".
import type { Draft, Settings } from '../main/role-file';
import { check, draftOf, efforts as effortsOf, renderRole, settingsOf } from '../main/role-file';
import type { Ctx } from '../main/wizard';
import { ask, errText, field, h, key, seg } from './dom';
import { MODE_TEXT, openHire } from './hire';
import { activeProject, allProjects } from './projects';
import { openPanel, registerPanel } from './registry';
import { micButton } from './speech';

const api = window.myide;
type Where = 'user' | 'project';
type Card = { el: HTMLElement; get(): Settings & { where: Where }; apply(s: Record<string, unknown>): void };

/** Opens the wizard for `projectId` (the active project by default); `edit` names an existing role to change. */
export function openWizard(o: { projectId?: string; edit?: string } = {}): void {
  openPanel('role-wizard', { projectId: o.projectId ?? activeProject()?.id ?? '', edit: o.edit ?? '' });
}

const select = (label: string, options: [string, string, boolean?][], value: string, onpick: (v: string) => void): HTMLLabelElement => {
  const s = h('select', { className: 'input select', onchange: () => onpick(s.value) }, ...options.map(([v, l, off]) => Object.assign(new Option(l, v), { disabled: !!off })));
  s.value = value;
  return field(label, s);
};
const num = (label: string, value: number | undefined, placeholder: string, onset: (n: number | undefined) => void): HTMLLabelElement => {
  const i = h('input', { type: 'number', className: 'input num', min: '1', max: '1000', placeholder, value: value === undefined ? '' : String(value) });
  i.onchange = () => onset(i.value ? Number(i.value) : undefined);
  return field(label, i);
};
const check1 = (label: string, on: boolean, onset: (b: boolean) => void): HTMLLabelElement =>
  h('label', { className: 'toggle' }, h('input', { type: 'checkbox', className: 'switch', checked: on, onchange: (ev: Event) => onset((ev.target as HTMLInputElement).checked) }), label);

/** The settings card: every structured choice as a control, prefilled with the AI's suggestions. A value David
 *  changed is his: later suggestions leave it alone. The same card moves into the review form. */
function settingsCard(ctx: Ctx, init: Partial<Draft>, where: Where, onchange: () => void): Card {
  const orig = init.orig; // the edited file's own model stays a choice
  let v: Settings & { where: Where } = { ...settingsOf(init, ctx), where: ctx.project ? where : 'user' };
  const mine = new Set<string>();
  const el = h('section', { className: 'wz-card' });
  el.setAttribute('aria-label', 'Role settings');
  const set = (k: string, val: unknown, redraw = false) => {
    mine.add(k);
    v = { ...settingsOf({ ...v, [k]: val, orig }, ctx), where: k === 'where' ? val as Where : v.where };
    if (k === 'provider') mine.add('account');
    if (redraw) draw();
    onchange();
  };
  const draw = () => {
    const p = ctx.providers[v.provider];
    const efforts = (p?.efforts ?? []).filter(([e]) => effortsOf(ctx, v.provider, v.model).includes(e));
    const models = p?.models.some(([m]) => m === v.model) ? p.models : [...(p?.models ?? []), [v.model, v.model]];
    const fileName = `${ctx.project && v.where === 'project' ? '<repo>/' : '~/'}.claude/agents/<name>.md`;
    el.replaceChildren(
      h('h3', { className: 'legend wz-card-title', textContent: 'Settings' }),
      h('div', { className: 'wz-grid' },
        select('AI', Object.entries(ctx.providers).filter(([id]) => ctx.accounts.some((a) => a.provider === id))
          .map(([id, x]) => [id, ctx.installed[id] ? x.label : `${x.label} (not installed)`, !ctx.installed[id]]), v.provider, (x) => set('provider', x, true)),
        select('Account', ctx.accounts.filter((a) => a.provider === v.provider).map((a) => [a.id, a.allowAuto ? a.name : `${a.name} · not for leads' hires`]), v.account, (x) => set('account', x)),
        select('Model', models.map(([m, l]) => [m, l]), v.model, (x) => set('model', x, true)),
        ...(efforts.length ? [select('Effort', [['', 'Default'], ...efforts.map(([e, l]) => [e, l] as [string, string])], v.effort ?? '', (x) => set('effort', x || undefined))] : []),
        num('Max turns', v.maxTurns, 'No limit', (n) => set('maxTurns', n))),
      seg('Mode', Object.entries(MODE_TEXT), v.mode, (x) => set('mode', x)).el,
      seg('Staff', [['staff', 'Project staff'], ['shared', 'Contractor (released after it reports)']], v.shared ? 'shared' : 'staff', (x) => set('shared', x === 'shared')).el,
      h('div', { className: 'wz-row' },
        check1('Lead: can hire reports', v.lead, (b) => set('lead', b, true)),
        ...(v.lead ? [num('Max reports', v.maxReports, '3', (n) => set('maxReports', n ?? 3))] : []),
        check1('Read-only: no file edits', v.readOnly, (b) => set('readOnly', b))),
      seg('Save to', [['user', 'All projects'], ['project', ctx.project ? `This project (${ctx.project.name})` : 'This project']], v.where, (x) => set('where', x, true), ctx.project ? [] : ['project']).el,
      h('p', { className: 'pref-hint', textContent: v.where === 'project' ? `${fileName}: inside the repo, so it is committed and shared with it.` : `${fileName}: for every project on this Mac.` }));
  };
  draw();
  return {
    el,
    get: () => v,
    apply(s) {
      const fresh = Object.fromEntries(Object.entries(s ?? {}).filter(([k]) => !mine.has(k)));
      v = { ...settingsOf({ ...v, ...fresh, orig }, ctx), where: v.where };
      draw();
    },
  };
}

registerPanel('role-wizard', {
  title: 'Role wizard',
  create(el, params, panel) {
    el.classList.add('wizard');
    const id = crypto.randomUUID();
    const projectId = typeof params.projectId === 'string' && params.projectId ? params.projectId : undefined;
    const editName = typeof params.edit === 'string' && params.edit ? params.edit : undefined;
    const project = allProjects().find((p) => p.id === projectId);
    const status = h('p', { className: 'pref-warn' });
    status.setAttribute('aria-live', 'polite');
    const say = (t: string) => { status.textContent = t; };
    let ctx: Ctx;
    let base: Draft | undefined; // the template or the role being edited
    let templateFile: string | undefined;
    let editFile: string | undefined;
    let editWhere: Where | undefined;
    let where: Where = project ? 'project' : 'user';
    let card: Card | undefined;
    let draft: Draft | undefined;
    let talked = false; // an AI turn ran: drafting asks it
    let answered = false; // David said something: cancel asks first
    let busy = false;
    const body = h('div', { className: 'wz-body' });
    el.append(h('header', { className: 'wz-head' }, h('h2', { className: 'legend', textContent: editName ? `Edit role · ${editName}` : 'New employee role' }),
      h('span', { className: 'pref-hint', textContent: project ? project.name : 'All projects' })), body, status);

    const close = async () => {
      if (answered && !(await ask('Discard this role?', 'The interview and the draft are not saved anywhere.', 'Discard', true))) return;
      void api.wizard.end(id);
      panel.close();
    };

    // ---- chat ----
    const log = h('ol', { className: 'wz-log' });
    log.setAttribute('aria-label', 'Interview');
    const input = h('textarea', { className: 'input', rows: 3, placeholder: 'Type, or dictate with the mic.' });
    input.setAttribute('aria-label', 'Your answer');
    let open: { q: string; get(): string }[] = []; // the AI's questions still waiting
    const line = (who: string, ...kids: (Node | string)[]) => {
      const li = h('li', { className: `wz-line wz-${who === 'You' ? 'you' : 'ai'}` }, h('span', { className: 'legend', textContent: who }), h('div', { className: 'wz-text' }, ...kids));
      log.append(li);
      li.scrollIntoView({ block: 'nearest' });
      return li;
    };
    /** One question: its suggested answers as keys (one) or checkboxes (several), and an Other field. */
    const question = (q: { q: string; choices?: string[]; multi?: boolean }) => {
      const picked = new Set<string>();
      const other = h('input', { className: 'input wz-other', placeholder: 'Other…' });
      other.setAttribute('aria-label', `Other answer: ${q.q}`);
      const opts = (q.choices ?? []).map((c) => q.multi
        ? h('label', { className: 'toggle' }, h('input', { type: 'checkbox', className: 'switch', onchange: (ev: Event) => { if ((ev.target as HTMLInputElement).checked) picked.add(c); else picked.delete(c); } }), c)
        : key(c, function (this: HTMLButtonElement) {
          picked.clear();
          picked.add(c);
          this.parentElement!.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === this)));
        }, { ariaPressed: 'false' }));
      open.push({ q: q.q, get: () => [...picked, other.value.trim()].filter(Boolean).join(', ') });
      return h('div', { className: 'wz-q' }, h('p', { className: 'wz-q-text', textContent: q.q }),
        ...(opts.length ? [h('div', { className: 'wz-choices' }, ...opts)] : []), other);
    };
    const showCard = (s: Record<string, unknown> | undefined) => {
      if (card) return s && card.apply(s);
      if (!s) return;
      card = settingsCard(ctx, s, where, () => { answered = true; refresh(); });
      line('Wizard', 'My suggested settings. Change anything here; it goes with your next message.', card.el);
    };
    const send = async (text: string, drafting = false) => {
      if (busy) return;
      const answers = open.map((x) => [x.q, x.get()]).filter(([, a]) => a);
      const typed = text.trim();
      if (!answers.length && !typed && !drafting) return say('Answer a question or type something first.');
      say('');
      busy = true;
      answered ||= !!(answers.length || typed);
      const shown = [...answers.map(([q, a]) => `${q} ${a}`), typed].filter(Boolean).join('\n') || 'Draft it.';
      line('You', shown);
      input.value = '';
      open = [];
      log.querySelectorAll('.wz-q input, .wz-q button').forEach((x) => { (x as HTMLInputElement).disabled = true; });
      const msg = [
        !talked && base ? `Starting from this role file:\n\`\`\`markdown\n${renderRole(base)}\`\`\`` : '',
        ...answers.map(([q, a]) => `Q: ${q}\nA: ${a}`), typed,
        card ? `Settings: ${JSON.stringify(card.get())}` : '',
        drafting ? 'That is enough. Send the draft now.' : '',
      ].filter(Boolean).join('\n\n');
      const wait = line('Wizard', h('span', { className: 'pref-hint', textContent: 'Thinking…' }));
      try {
        const r = await api.wizard.turn({ id, projectId, message: msg });
        talked = true;
        wait.remove();
        const rep = r.reply;
        if (!rep) { line('Wizard', r.text || 'No answer.'); say('The AI did not answer in the expected form. Answer again, or press Draft it.'); return; }
        line('Wizard', r.text, ...rep.ask.map(question));
        showCard(rep.settings);
        if (rep.draft) review(rep.draft);
        else if (drafting) say('No draft came back. Press Draft it again.');
      } catch (e) { wait.remove(); say(errText(e)); }
      finally { busy = false; }
    };
    const draftKey = key('That\'s enough, draft it', () => {
      if (!talked && base) return review(base); // a template or role as it is: no AI turn needed
      void send(input.value, true);
    }, { title: 'Go to the review form now' });
    const chat = h('section', { className: 'wz-chat' }, log,
      h('div', { className: 'wz-compose' }, input,
        h('div', { className: 'wz-keys' }, micButton(input, say),
          key('Send', () => void send(input.value), { className: 'key key--sm key--lit' }), draftKey, key('Cancel', () => void close()))));
    input.onkeydown = (ev) => { if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); void send(input.value); } };

    const startChat = () => {
      body.replaceChildren(chat);
      if (base) {
        line('Wizard', editName ? `Here is ${base.name} as it is now. What should change?` : `Here is the ${base.name} template. Anything to change for ${project ? project.name : 'this role'}?`,
          h('p', { className: 'pref-hint', textContent: base.description }));
        showCard(base as unknown as Record<string, unknown>);
      } else line('Wizard', 'What job should this employee do? A sentence or two is enough: I will ask the rest.');
      input.focus();
    };

    // ---- review ----
    const review = (raw: Draft) => {
      draft = raw;
      showCard(raw as unknown as Record<string, unknown>);
      const name = h('input', { className: 'input', value: raw.name, maxLength: 60 });
      const desc = h('input', { className: 'input', value: raw.description, maxLength: 300 });
      const job = h('textarea', { className: 'input wz-job', rows: 14, value: raw.body });
      const rules = h('textarea', { className: 'input', rows: 5, value: raw.rules.join('\n') });
      const task = h('textarea', { className: 'input', rows: 3, value: raw.firstTask ?? '' });
      const preview = h('pre', { className: 'wz-preview' });
      const problems = h('div', { className: 'wz-problems' });
      problems.setAttribute('aria-live', 'polite');
      const save = h('button', { type: 'button', className: 'key key--go', textContent: 'Save role' });
      // the file's own extra keys and originals: main re-reads them from disk when saving
      const current = () => draftOf({ ...draft, extra: base?.extra, orig: base?.orig, name: name.value, description: desc.value, body: job.value, rules: rules.value, firstTask: task.value, ...card!.get() }, ctx);
      refresh = () => {
        const d = current();
        const w = card!.get().where;
        const mine = (n: string) => !!editFile && w === editWhere && (n === editName || editFile.endsWith(`/${n}.md`));
        const c = check(d, ctx, ctx.taken[w].filter((n) => !mine(n)));
        preview.textContent = renderRole(d);
        problems.replaceChildren(...c.errors.map((t) => h('p', { className: 'pref-warn', textContent: t })), ...c.warnings.map((t) => h('p', { className: 'pref-hint', textContent: t })));
        save.disabled = c.errors.length > 0;
        return d;
      };
      for (const x of [name, desc, job, rules, task]) x.oninput = () => { answered = true; refresh(); };
      save.onclick = () => void doSave(refresh()!);
      body.replaceChildren(h('section', { className: 'wz-review' },
        h('div', { className: 'wz-form' },
          field('Name', name, 'Lowercase with dashes; the file is <name>.md.'), field('Description', desc, 'When to hire this role.'), card!.el,
          field('Job', job, 'Purpose, responsibilities, how to work, definition of done, what to report back.'),
          field('Rules', rules, 'One per line: what it may and may not do.'),
          field('First task', task, 'Offered when you hire one after saving.'),
          problems,
          h('div', { className: 'sheet-keys' }, key('Back to chat', () => { body.replaceChildren(chat); }), key('Cancel', () => void close()), save)),
        h('section', { className: 'wz-file' }, h('h3', { className: 'legend', textContent: 'Role file' }), preview)));
      refresh();
      name.focus();
    };
    let refresh = (): Draft | undefined => undefined;

    const doSave = async (d: Draft) => {
      const w = card!.get().where;
      const file = editFile && w === editWhere ? editFile : undefined;
      const o: Parameters<typeof api.wizard.save>[1] = { where: w, projectId, file, template: file ? undefined : templateFile };
      try {
        let r = await api.wizard.save(d, o);
        if (r.rename) {
          if (!(await ask(`Rename ${editName} to ${d.name}?`, `Saves ${d.name}.md and removes ${r.rename}.`, 'Rename', true))) return;
          r = await api.wizard.save(d, { ...o, rename: true });
        }
        if (r.exists) {
          if (!(await ask(`Replace ${d.name}?`, `${r.exists} already exists. Saving replaces that file.`, 'Replace', true))) return;
          r = await api.wizard.save(d, { ...o, rename: true, overwrite: true });
        }
        void api.wizard.end(id);
        answered = false;
        const hire = key('Hire one now', () => { void openHire({ project, role: d.name, task: d.firstTask }); panel.close(); }, { className: 'key key--go' });
        hire.disabled = !project;
        if (!project) hire.title = 'Open a project to hire into';
        body.replaceChildren(h('section', { className: 'wz-done' },
          h('p', { className: 'legend', textContent: `Saved ${d.name}` }), h('p', { className: 'path', textContent: r.file ?? '' }),
          ...(w === 'project' ? [h('p', { className: 'pref-hint', textContent: 'It is in the repo: commit it to share it.' })] : []),
          h('p', { textContent: 'Hire one now?' }), h('div', { className: 'sheet-keys' }, key('Done', () => panel.close()), hire)));
        say('');
      } catch (e) { say(errText(e)); }
    };

    // ---- start: an edit loads the role; otherwise templates, then the chat ----
    void (async () => {
      try {
        ctx = await api.wizard.context(projectId);
        if (editName) {
          const r = await api.wizard.read(projectId, editName);
          if (!r.draft) {
            return body.replaceChildren(h('section', { className: 'wz-done' },
              h('p', { textContent: 'This role uses advanced frontmatter; edit the file by hand.' }), h('p', { className: 'path', textContent: r.file }),
              h('div', { className: 'sheet-keys' }, key('Close', () => panel.close()), key('Reveal in Finder', () => void api.wizard.reveal(projectId, editName), { className: 'key key--go' }))));
          }
          base = r.draft;
          editFile = r.file;
          where = editWhere = r.where;
          return startChat();
        }
        const list = await api.wizard.templates();
        const pick = (t?: { file: string; draft: Draft }) => { base = t?.draft; templateFile = t?.file; startChat(); };
        const meta = (d: Draft) => `${d.model}${d.effort ? ` · ${d.effort}` : ''} · ${MODE_TEXT[d.mode]}${d.lead ? ' · lead' : ''}${d.readOnly ? ' · read-only' : ''}`;
        body.replaceChildren(h('section', { className: 'wz-templates' },
          h('h3', { className: 'legend', textContent: 'Start from' }),
          h('div', { className: 'wz-tpl-list' },
            h('button', { type: 'button', className: 'key wz-tpl', onclick: () => pick() }, h('span', { className: 'btn-label', textContent: 'Start blank' }), h('span', { className: 'wz-tpl-sub', textContent: 'The wizard asks about the job from scratch.' })),
            ...list.map((t) => h('button', { type: 'button', className: 'key wz-tpl', title: t.file, onclick: () => pick(t) },
              h('span', { className: 'btn-label', textContent: t.draft.name }), h('span', { className: 'wz-tpl-sub', textContent: t.draft.description }),
              h('span', { className: 'wz-tpl-meta', textContent: meta(t.draft) })))),
          h('p', { className: 'pref-hint', textContent: 'Your own templates go in ~/.myide/role-templates (role files; names starting with _ are skipped).' }),
          h('div', { className: 'sheet-keys' }, key('Cancel', () => void close()))));
      } catch (e) { say(errText(e)); }
    })();

    return { dispose: () => void api.wizard.end(id) };
  },
});

window.myide.onCommand((name) => { if (name === 'new-role') openWizard(); });
