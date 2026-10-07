import type { ForgeSnapshot } from '../main/forge';
import { errText, h, key } from './dom';
import { led, openEmployee, type Employee } from './employees';
import { activeProject, allProjects } from './projects';
import { registerPanel } from './registry';

const api = window.myide;
type Issue = ForgeSnapshot['issues'][number];
type Linked = Employee & { issue?: { repo: string; number: number } };

const FORGE = { github: 'GitHub', forgejo: 'Forgejo' } as const;
const proj = (id: string) => allProjects().find((p) => p.id === id);
const clock = (t?: number) => (t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'never');
function age(iso: string): string {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!(s > 0)) return '';
  return s < 3600 ? `${Math.max(1, Math.round(s / 60))} min` : s < 86400 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} d`;
}
const holder = (emps: Linked[], s: ForgeSnapshot, n: number) => emps.find((e) => e.projectId === s.projectId && e.issue?.repo === s.repo && e.issue?.number === n);
const sheetText = (form: HTMLElement) => {
  const t = h('p', { className: 'pref-warn' });
  t.setAttribute('aria-live', 'polite');
  form.append(t);
  return (s: string) => { t.textContent = s; };
};

/** A modal sheet; resolves when closed. */
function sheet(label: string, form: HTMLFormElement): HTMLDialogElement {
  const d = h('dialog', { className: 'sheet iss-sheet' }, form);
  d.setAttribute('aria-label', label);
  d.onclose = () => d.remove();
  document.body.append(d);
  d.showModal();
  return d;
}

/** "Give to": an existing employee of the project, or a role to hire. Values are "e:<id>" or "r:<role>". */
async function assignee(projectId: string, withNone: boolean): Promise<HTMLSelectElement> {
  const [emps, roles] = await Promise.all([api.employees.list(projectId), api.employees.roles(projectId)]);
  const sel = h('select', { className: 'input select' });
  if (withNone) sel.add(new Option('Nobody yet', ''));
  const eg = h('optgroup', { label: 'Employees' }, ...emps.map((e) => new Option(`${e.name} (${e.role}, ${e.state})`, `e:${e.id}`)));
  const rg = h('optgroup', { label: 'Hire from role' }, ...roles.map((r) => new Option(`New ${r.name}`, `r:${r.name}`)));
  if (emps.length) sel.append(eg);
  if (roles.length) sel.append(rg);
  return sel;
}
const target = (v: string) => (v.startsWith('e:') ? { employeeId: v.slice(2) } : v.startsWith('r:') ? { role: v.slice(2) } : undefined);

async function openAssign(s: ForgeSnapshot, i: Issue): Promise<void> {
  const who = await assignee(s.projectId, false);
  const note = h('textarea', { className: 'input', rows: 2, placeholder: 'Anything to add (optional)' });
  const go = h('button', { className: 'btn btn--primary', value: 'go', textContent: 'Assign' });
  const form = h('form', { method: 'dialog' },
    h('h2', { className: 'legend', textContent: `Assign #${i.number}` }),
    h('p', { className: 'iss-sheet-title', textContent: i.title }),
    h('label', { className: 'field' }, h('span', { className: 'legend', textContent: 'Give to' }), who),
    h('label', { className: 'field' }, h('span', { className: 'legend', textContent: 'Note' }), note),
    h('p', { className: 'pref-hint', textContent: 'MyIDE comments that work has started, assigns the issue to you and adds the "in progress" label.' }),
  );
  const say = sheetText(form);
  form.append(h('div', { className: 'sheet-keys' }, h('button', { className: 'btn', value: 'cancel', formNoValidate: true, textContent: 'Cancel' }), go));
  go.disabled = !who.options.length;
  if (!who.options.length) say('No employees and no roles in this project yet.');
  const d = sheet(`Assign issue ${i.number}`, form);
  form.onsubmit = async (ev) => {
    if (ev.submitter !== go) return;
    ev.preventDefault();
    go.disabled = true;
    say('Assigning…');
    try {
      const r = await api.forge.assign({ projectId: s.projectId, number: i.number, ...target(who.value), note: note.value.trim() || undefined });
      if (r.warning) { say(r.warning); go.textContent = 'Assigned'; return; }
      d.close();
      openEmployee(r.employeeId);
    } catch (e) { say(errText(e)); go.disabled = false; }
  };
}

/** The New issue sheet. `projectId` preselects a project. */
export async function openNewIssue(projectId?: string): Promise<void> {
  const linked = await api.forge.issues();
  if (!linked.length) { alert('No project links a forge yet. Link one in Preferences > Forges.'); return; }
  const project = h('select', { className: 'input select' }, ...linked.map((s) => new Option(`${proj(s.projectId)?.name ?? s.projectId} · ${FORGE[s.provider]} ${s.repo}`, s.projectId)));
  project.value = linked.some((s) => s.projectId === projectId) ? projectId! : linked[0].projectId;
  const title = h('input', { className: 'input', required: true, autocomplete: 'off', placeholder: 'Leaderboard flickers when a match ends' });
  const body = h('textarea', { className: 'input', rows: 5, placeholder: 'Steps, logs, or paste a screenshot (optional)' });
  const labels = h('input', { className: 'input', autocomplete: 'off', placeholder: 'bug, sync' });
  const thumbs = h('div', { className: 'iss-thumbs' });
  const as = h('p', { className: 'pref-hint' });
  const whoBox = h('div', { className: 'field' });
  const images: { name: string; type: string; data: Uint8Array; url: string }[] = [];
  const file = h('button', { className: 'btn btn--primary', value: 'file', textContent: 'File issue' });
  let who: HTMLSelectElement;

  const sync = async () => {
    const s = linked.find((x) => x.projectId === project.value)!;
    const github = s.provider === 'github';
    as.textContent = `Posts as you${s.me ? ` (${s.me})` : ''} on ${FORGE[s.provider]}, ${s.repo}. No AI attribution.`
      + (github && images.length ? ' GitHub has no image upload API: the browser opens its new-issue page with this filled in, to drop the images there.' : '');
    file.textContent = github && images.length ? 'Open on GitHub' : 'File issue';
    who = await assignee(s.projectId, true);
    who.disabled = github && images.length > 0;
    whoBox.replaceChildren(h('span', { className: 'legend', textContent: 'Assign now' }), who);
  };
  const drawThumbs = () => thumbs.replaceChildren(...images.map((img, n) => h('span', { className: 'iss-thumb' },
    h('img', { src: img.url, alt: img.name }),
    key('×', () => { URL.revokeObjectURL(img.url); images.splice(n, 1); drawThumbs(); void sync(); }, { title: `Remove ${img.name}`, ariaLabel: `Remove ${img.name}` }))));
  body.onpaste = async (ev) => {
    const files = [...(ev.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    ev.preventDefault();
    for (const f of files) images.push({ name: f.name || `pasted-${images.length + 1}.png`, type: f.type, data: new Uint8Array(await f.arrayBuffer()), url: URL.createObjectURL(f) });
    drawThumbs();
    void sync();
  };
  project.onchange = () => void sync();
  await sync();

  const form = h('form', { method: 'dialog', className: 'iss-form' },
    h('h2', { className: 'legend', textContent: 'New issue' }),
    h('label', { className: 'field' }, h('span', { className: 'legend', textContent: 'Project' }), project),
    h('label', { className: 'field' }, h('span', { className: 'legend', textContent: 'Title' }), title,
      h('span', { className: 'pref-hint', textContent: 'The title can be the whole spec. Employees verify it against the code.' })),
    h('label', { className: 'field' }, h('span', { className: 'legend', textContent: 'Body (optional)' }), body), thumbs,
    h('div', { className: 'iss-form-row' },
      h('label', { className: 'field' }, h('span', { className: 'legend', textContent: 'Labels' }), labels), whoBox),
    as,
  );
  const say = sheetText(form);
  form.append(h('div', { className: 'sheet-keys' }, h('button', { className: 'btn', value: 'cancel', formNoValidate: true, textContent: 'Cancel' }), file));
  const d = sheet('New issue', form);
  d.addEventListener('close', () => images.forEach((i) => URL.revokeObjectURL(i.url)));
  title.focus();
  form.onsubmit = async (ev) => {
    if (ev.submitter !== file) return;
    ev.preventDefault();
    file.disabled = true;
    say('Filing…');
    try {
      const r = await api.forge.create({
        projectId: project.value, title: title.value, body: body.value, labels: labels.value,
        images: images.map(({ name, type, data }) => ({ name, type, data })), assign: who.disabled ? undefined : target(who.value),
      });
      if (r.warning) { say(r.warning); file.textContent = 'Done'; return; }
      d.close();
    } catch (e) { say(errText(e)); file.disabled = false; }
  };
}

function draftCard(s: ForgeSnapshot, d: ForgeSnapshot['drafts'][number]): HTMLElement {
  const p = proj(s.projectId);
  const card = h('article', { className: 'need' });
  if (p) card.style.setProperty('--proj', p.colour);
  const status = h('p', { className: 'pref-warn' });
  const busy = (fn: () => Promise<unknown>) => async () => {
    card.querySelectorAll('button').forEach((b) => (b.disabled = true));
    try { await fn(); } catch (e) { status.textContent = errText(e); card.querySelectorAll('button').forEach((b) => (b.disabled = false)); }
  };
  card.append(
    h('div', { className: 'need-head' }, led('needs-you', 'Drafted issue'), h('span', { className: 'need-who', textContent: `${p?.name ?? '?'} / ${d.employeeName}` })),
    h('p', { className: 'need-q', textContent: d.title }),
    ...(d.body ? [h('pre', { className: 'need-plan', textContent: d.body })] : []),
    ...(d.labels.length ? [h('p', { className: 'need-why', textContent: `Labels: ${d.labels.join(', ')}` })] : []),
    h('div', { className: 'need-keys' },
      key('File', busy(async () => { const r = await api.forge.fileDraft(s.projectId, d.id); if (r.warning) alert(r.warning); }), { className: 'key key--sm key--lit' }),
      key('Discard', busy(() => api.forge.discardDraft(s.projectId, d.id)))),
    status,
  );
  return card;
}

function retry(s: ForgeSnapshot): HTMLButtonElement {
  const b = key(s.offline ? 'Retry now' : 'Refresh', () => {
    b.disabled = true;
    void api.forge.refresh(s.projectId, true).finally(() => { b.disabled = false; });
  });
  return b;
}

function issueRow(s: ForgeSnapshot, i: Issue, emps: Linked[], all: boolean): HTMLElement {
  const p = proj(s.projectId);
  const pr = s.prs[String(i.number)];
  const emp = holder(emps, s, i.number);
  const row = h('li', { className: 'iss-row' });
  row.dataset.state = pr?.merged ? 'merged' : i.state;
  if (all && p) row.style.setProperty('--proj', p.colour);
  const labelChips = i.labels.map((l) => h('span', { className: `iss-label${/in progress/i.test(l) ? ' is-progress' : ''}`, textContent: l }));
  const prText = pr ? (pr.merged ? `PR #${pr.number} merged` : `PR #${pr.number} ${pr.state}`) : '';
  row.append(
    h('div', { className: 'iss-line' },
      h('span', { className: 'iss-ref', textContent: `#${i.number}` }),
      h('button', { type: 'button', className: 'iss-title', textContent: i.title, title: `Open #${i.number} on ${FORGE[s.provider]}`, onclick: () => void api.terminal.openUrl(i.url) }),
      h('span', { className: 'iss-age', textContent: [all && p ? p.name : '', i.state === 'closed' ? 'closed' : '', age(i.updatedAt)].filter(Boolean).join(' · ') })),
    h('div', { className: 'iss-line iss-line--meta' },
      emp ? h('button', { type: 'button', className: 'iss-emp', textContent: emp.name, title: `Open ${emp.name}`, onclick: () => openEmployee(emp.id) })
        : h('span', { className: 'iss-nobody', textContent: 'No employee' }),
      ...(prText ? [pr!.url ? h('button', { type: 'button', className: 'iss-pr', textContent: prText, onclick: () => void api.terminal.openUrl(pr!.url) }) : h('span', { className: 'iss-pr', textContent: prText })] : []),
      h('span', { className: 'iss-labels' }, ...labelChips),
      h('span', { className: 'iss-actions' }, ...(i.state === 'open' && !emp ? [key('Assign…', () => void openAssign(s, i))] : []))),
  );
  return row;
}

registerPanel('issues', {
  title: 'Issues',
  create(el, params) {
    el.classList.add('issues');
    let scope = typeof params.scope === 'string' ? params.scope : activeProject()?.id ?? 'all';
    const filters = { open: true, mine: false, nobody: false, label: '' };
    const head = h('div', { className: 'iss-head' });
    const scopeKeys = h('div', { className: 'iss-scope', role: 'group' });
    scopeKeys.setAttribute('aria-label', 'Project');
    const toggle = (name: 'open' | 'mine' | 'nobody', label: string) => {
      const b = key(label, () => { filters[name] = !filters[name]; b.setAttribute('aria-pressed', String(filters[name])); void draw(); });
      b.setAttribute('aria-pressed', String(filters[name]));
      return b;
    };
    const labelSel = h('select', { className: 'input select iss-label-sel' });
    labelSel.setAttribute('aria-label', 'Label');
    labelSel.onchange = () => { filters.label = labelSel.value; void draw(); };
    const controls = h('div', { className: 'iss-controls' }, scopeKeys,
      h('div', { className: 'iss-filters', role: 'group' }, h('span', { className: 'legend', textContent: 'Show' }),
        toggle('open', 'Open'), toggle('mine', 'Mine'), toggle('nobody', 'No employee'), labelSel));
    const drafts = h('section', { className: 'needs' });
    drafts.setAttribute('aria-label', 'Drafted issues');
    const list = h('ul', { className: 'iss-list' });
    const empty = h('p', { className: 'iss-empty' });
    el.append(head, controls, drafts, list, empty);

    let seq = 0;
    async function draw(): Promise<void> {
      const n = ++seq;
      const [snaps, emps] = await Promise.all([api.forge.issues(), api.employees.list() as Promise<Linked[]>]);
      if (n !== seq) return;
      if (scope !== 'all' && !snaps.some((s) => s.projectId === scope)) scope = 'all';
      const shown = snaps.filter((s) => scope === 'all' || s.projectId === scope);

      scopeKeys.replaceChildren(...[{ id: 'all', name: 'All' }, ...snaps.map((s) => ({ id: s.projectId, name: proj(s.projectId)?.name ?? s.projectId }))].map((x) => {
        const b = key(x.name, () => { scope = x.id; void api.forge.refresh(x.id === 'all' ? undefined : x.id); void draw(); });
        b.setAttribute('aria-pressed', String(scope === x.id));
        const c = proj(x.id)?.colour;
        if (c) b.style.setProperty('--proj', c);
        return b;
      }));

      head.replaceChildren(h('dl', { className: 'forges' }, ...shown.map((s) => {
        const p = proj(s.projectId);
        const note = s.offline
          ? `Stale, last synced ${clock(s.fetchedAt)} · ${s.error ?? 'unreachable'} · retrying on the next poll`
          : s.error ? s.error : `Via ${s.host}${s.me ? ` as ${s.me}` : ' (no token: read only)'} · synced ${clock(s.fetchedAt)}`;
        const dd = h('dd', {}, s.offline ? led('interrupted', 'Unreachable') : s.error ? led('failed', 'Error') : led('working', 'Connected'),
          h('span', { className: 'forge-note', textContent: note }),
          ...(s.outbox ? [h('span', { className: 'forge-note', textContent: `${s.outbox} write-back${s.outbox === 1 ? '' : 's'} waiting to send` })] : []),
          ...(s.lastError ? [h('span', { className: 'forge-note forge-err', textContent: `Not sent: ${s.lastError}` })] : []),
          retry(s));
        const row = h('div', { className: 'forge' }, h('dt', { textContent: `${p?.name ?? '?'} · ${FORGE[s.provider]}` }), dd);
        if (p) row.style.setProperty('--proj', p.colour);
        row.dataset.forgeState = s.offline ? 'stale' : 'ok';
        return row;
      })), key('+ New issue', () => void openNewIssue(scope === 'all' ? undefined : scope), { className: 'key iss-new' }));

      const allDrafts = shown.flatMap((s) => s.drafts.map((d) => draftCard(s, d)));
      drafts.hidden = !allDrafts.length;
      drafts.replaceChildren(h('h2', { className: 'needs-title', textContent: `Needs you · drafted issues · ${allDrafts.length}` }), ...allDrafts);

      const labels = [...new Set(shown.flatMap((s) => s.issues.flatMap((i) => i.labels)))].sort();
      labelSel.replaceChildren(new Option('Any label', ''), ...labels.map((l) => new Option(l, l)));
      labelSel.value = labels.includes(filters.label) ? filters.label : '';
      const rows = shown.flatMap((s) => s.issues
        .filter((i) => (!filters.open || i.state === 'open')
          && (!filters.mine || (!!s.me && i.assignees.includes(s.me)))
          && (!filters.nobody || !holder(emps, s, i.number))
          && (!labelSel.value || i.labels.includes(labelSel.value)))
        .map((i) => ({ s, i })))
        .sort((a, b) => b.i.updatedAt.localeCompare(a.i.updatedAt));
      list.replaceChildren(...rows.map(({ s, i }) => issueRow(s, i, emps, scope === 'all')));
      empty.hidden = !!rows.length;
      empty.textContent = !snaps.length ? 'No project links a forge yet. Link one in Preferences > Forges.'
        : filters.mine && shown.some((s) => !s.me) ? 'No issues match. "Mine" needs a token, so MyIDE knows who you are.'
        : 'No issues match these filters.';
    }

    const refresh = () => void api.forge.refresh(scope === 'all' ? undefined : scope);
    el.addEventListener('focusin', refresh);
    const offs = [api.forge.onChange(() => void draw()), api.employees.onChange(() => void draw())];
    void draw();
    refresh();
    return { onShow: refresh, dispose: () => { offs.forEach((off) => off()); el.removeEventListener('focusin', refresh); } };
  },
});

// ---- Preferences > Forges ----

/** Per-project forge links and one token per forge host. Rebuilds itself after each change. */
export function forgesSection(say: (t: string) => void): Node[] {
  const box = h('div', { className: 'forge-prefs' });
  const field = (props: Partial<HTMLInputElement>) => h('input', { className: 'input', ...props });

  async function draw(): Promise<void> {
    const [snaps, { rows, gh }] = await Promise.all([api.forge.issues(), api.forge.tokens()]);
    const links = allProjects().map((p) => {
      const s = snaps.find((x) => x.projectId === p.id);
      const provider = h('select', { className: 'input select' }, new Option('No forge', ''), new Option('GitHub', 'github'), new Option('Forgejo', 'forgejo'));
      provider.value = s?.provider ?? '';
      provider.setAttribute('aria-label', `Forge for ${p.name}`);
      const repo = field({ value: s?.repo ?? '', placeholder: 'owner/name', className: 'input mono', spellcheck: false });
      repo.setAttribute('aria-label', `Repo for ${p.name}`);
      const urls = h('textarea', { className: 'input mono', rows: 2, spellcheck: false, value: (s?.urls ?? []).join('\n'), placeholder: 'https://git.example.dev\nhttps://tunnel.example.dev' });
      urls.setAttribute('aria-label', `URLs for ${p.name}, one per line, tried in order`);
      const urlBox = h('label', { className: 'field' }, h('span', { className: 'pref-hint', textContent: 'URLs, one per line, tried in this order (5 s each).' }), urls);
      const syncKind = () => { repo.disabled = !provider.value; urlBox.hidden = provider.value !== 'forgejo'; };
      provider.onchange = syncKind;
      syncKind();
      const save = key('Save', async () => {
        try {
          await api.forge.setLink(p.id, provider.value ? { provider: provider.value as 'github' | 'forgejo', repo: repo.value, urls: urls.value.split('\n') } : null);
          say(provider.value ? `${p.name} linked to ${repo.value.trim()}.` : `${p.name} has no forge now.`);
          void api.forge.refresh(p.id, true);
          void draw();
        } catch (e) { say(errText(e)); }
      });
      const row = h('div', { className: 'proj-row forge-link' }, h('span', { className: 'pref-name', textContent: p.name }),
        h('div', { className: 'pref-ctl' }, provider, repo, save), urlBox);
      row.style.setProperty('--proj', p.colour);
      return row;
    });

    const tokens = rows.map((r) => {
      const input = field({ type: 'password', autocomplete: 'off', placeholder: r.has ? '•••••••• saved in the Keychain' : 'Paste a token', className: 'input mono grow' });
      input.setAttribute('aria-label', `Token for ${FORGE[r.provider]} ${r.host}`);
      const act = (label: string, fn: () => Promise<string | void>) => key(label, async () => {
        try { say((await fn()) || ''); } catch (e) { say(errText(e)); }
      });
      const keys = [
        act('Save', async () => {
          if (!input.value.trim()) return 'Paste a token first.';
          await api.forge.setToken(r.provider, r.host, input.value);
          void draw();
          return `Saved. ${await api.forge.test(r.provider, r.host).catch((e) => errText(e))}`;
        }),
        ...(r.has ? [act('Test connection', () => api.forge.test(r.provider, r.host)),
          act('Remove', async () => { if (!confirm(`Remove the ${FORGE[r.provider]} token for ${r.host} from the Keychain?`)) return; await api.forge.removeToken(r.provider, r.host); void draw(); return 'Removed.'; })] : []),
        ...(r.provider === 'github' && gh ? [act('Import from gh', async () => { await api.forge.importGh(); void draw(); return `Imported. ${await api.forge.test('github', 'github.com').catch((e) => errText(e))}`; })] : []),
      ];
      const hint = r.provider === 'github' ? 'Issues read anonymously; writing back needs a token with repo access.' : `Used by ${r.projects.join(', ')}.`;
      return h('div', { className: 'pref' },
        h('div', { className: 'pref-label' }, h('span', { className: 'pref-name', textContent: `${FORGE[r.provider]} · ${r.host}` }), h('span', { className: 'pref-hint', textContent: hint })),
        h('div', { className: 'pref-ctl' }, r.has ? led('working', 'Saved') : led('idle', 'No token'), input, ...keys));
    });

    box.replaceChildren(
      h('p', { className: 'psec-lede', textContent: 'Link each project to its repo. Everything posts as you; tokens stay in the macOS Keychain.' }),
      h('h3', { className: 'legend psec-sub', textContent: 'Projects' }),
      ...(links.length ? links : [h('p', { className: 'pref-hint', textContent: 'No projects yet.' })]),
      h('h3', { className: 'legend psec-sub', textContent: 'Tokens' }),
      ...tokens,
    );
  }
  void draw();
  return [box];
}

