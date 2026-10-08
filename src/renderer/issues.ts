import type { ForgeLink, ForgeSnapshot } from '../main/forge';
import type { Detected, Found } from '../main/remotes';
import { attachBox } from './attach';
import { ask, errText, h, key, sheet } from './dom';
import { chip, cueOf, led, openEmployee, stateName, steps, type Employee } from './employees';
import type { Project } from '../main/projects';
import type { OrgState, TrackRow } from '../preload/preload';
import { allProjects, scopeOf } from './projects';
import { openPanel, registerPanel } from './registry';
import { openIssue } from './issue';
import { micButton } from './speech';
import { arrange, DEFAULT_VIEW, fullOrder, grouped, GROUPS, move, SORTS, STATUSES, viewOf, type Group, type Row, type Sort, type View } from './issue-view';

const api = window.myide;
type Issue = ForgeSnapshot['issues'][number];
type Linked = Employee;

const FORGE = { github: 'GitHub', forgejo: 'Forgejo' } as const;
const NO_FILTERS: Partial<View> = { q: '', state: 'all', labels: [], who: '', emp: '', pr: '' };
const proj = (id: string) => allProjects().find((p) => p.id === id);
const clock = (t?: number) => (t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'never');
function age(iso: string): string {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!(s > 0)) return '';
  return s < 3600 ? `${Math.max(1, Math.round(s / 60))} min` : s < 86400 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} d`;
}
// Several employees on one issue (a lead and its reports): the shallowest holds it, and shows the roll-up.
const holder = (emps: Linked[], s: ForgeSnapshot, n: number) => emps.filter((e) => e.projectId === s.projectId && [e.issue, ...(e.more ?? [])].some((i) => i?.repo === s.repo && i?.number === n))
  .sort((a, b) => a.depth - b.depth)[0];
/** The employee's state, or 'paused' while its project is paused and its turn waits. */
const statusOf = (e: Employee, paused: Set<string>) => (paused.has(e.projectId) && e.state === 'queued' ? 'paused' : e.state);

/** LED, cue count and text, model chip: one right-aligned button that opens the employee. */
function statusButton(e: Employee, everyone: Employee[], status: string): HTMLButtonElement {
  const { count, text } = cueOf(e, everyone);
  const b = h('button', { type: 'button', className: 'iss-status', title: `Open ${e.name}${text ? `: ${text}` : ''}`, onclick: () => openEmployee(e.id) },
    status === 'paused' ? led('interrupted', 'Paused') : led(status),
    ...(count ? [h('span', { className: 'o-cue-count', textContent: count })] : []),
    ...(e.progress?.total ? [steps(e)] : []),
    ...(text ? [h('span', { className: 'iss-status-text', textContent: text })] : []),
    chip(e));
  b.dataset.state = status;
  b.setAttribute('aria-label', `${e.name}: ${stateName(status)}${count ? `, ${count}` : ''}${text ? `, ${text}` : ''}. Open ${e.name}`);
  return b;
}
const sheetText = (form: HTMLElement) => {
  const t = h('p', { className: 'pref-warn' });
  t.setAttribute('aria-live', 'polite');
  form.append(t);
  return (s: string) => { t.textContent = s; };
};


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

export async function openAssign(s: ForgeSnapshot, i: Issue): Promise<void> {
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
  const d = sheet(`Assign issue ${i.number}`, form, 'iss-sheet');
  form.onsubmit = async (ev) => {
    if (ev.submitter !== go) return;
    ev.preventDefault();
    go.disabled = true;
    say('Assigning…');
    try {
      const r = await api.forge.assign({ projectId: s.projectId, number: i.number, ...target(who.value), note: note.value.trim() || undefined });
      if (r.warning) { say(r.warning); go.textContent = 'Assigned'; return; }
      d.close();
      openIssue(s.projectId, i.number); // the issue's dashboard: its conversation, action items and timeline
    } catch (e) { say(errText(e)); go.disabled = false; }
  };
}

/** The New issue sheet. `projectId` preselects a project. */
/** `prefill` fills the title (a promoted to-do). */
export async function openNewIssue(projectId?: string, prefill = ''): Promise<void> {
  const linked = await api.forge.issues();
  if (!linked.length) { alert('No project links a forge yet. Link one in Preferences > Forges.'); return; }
  const project = h('select', { className: 'input select' }, ...linked.map((s) => new Option(`${proj(s.projectId)?.name ?? s.projectId} · ${FORGE[s.provider]} ${s.repo}`, s.projectId)));
  project.value = linked.some((s) => s.projectId === projectId) ? projectId! : linked[0].projectId;
  const title = h('input', { className: 'input', required: true, autocomplete: 'off', placeholder: 'Leaderboard flickers when a match ends', value: prefill });
  const body = h('textarea', { className: 'input', rows: 5, placeholder: 'Steps, logs, or paste a screenshot (optional)' });
  const labels = h('input', { className: 'input', autocomplete: 'off', placeholder: 'bug, sync' });
  const attach = attachBox(body, (t) => say(t), () => void sync()); // say is set once the form exists
  const images = attach.images;
  const as = h('p', { className: 'pref-hint' });
  const whoBox = h('div', { className: 'field' });
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
  project.onchange = () => void sync();
  await sync();

  const form = h('form', { method: 'dialog', className: 'iss-form' },
    h('h2', { className: 'legend', textContent: 'New issue' }),
    h('label', { className: 'field' }, h('span', { className: 'legend', textContent: 'Project' }), project),
    h('label', { className: 'field' }, h('span', { className: 'legend', textContent: 'Title' }), title,
      h('span', { className: 'pref-hint', textContent: 'The title can be the whole spec. Employees verify it against the code.' })),
    h('label', { className: 'field' }, h('span', { className: 'legend', textContent: 'Body (optional)' }), body), micButton(body, (t) => say(t)), attach.el,
    h('div', { className: 'iss-form-row' },
      h('label', { className: 'field' }, h('span', { className: 'legend', textContent: 'Labels' }), labels), whoBox),
    as,
  );
  const say = sheetText(form);
  form.append(h('div', { className: 'sheet-keys' }, h('button', { className: 'btn', value: 'cancel', formNoValidate: true, textContent: 'Cancel' }), file));
  const d = sheet('New issue', form, 'iss-sheet');
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

/** A drafted issue (forge draft_issue), in the Issues panel and in NEEDS YOU: nothing was posted; File strips and posts it. */
export function draftCard(s: ForgeSnapshot, d: ForgeSnapshot['drafts'][number]): HTMLElement {
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

/** The Assigned list: every issue given to an employee, with who has it now, its action items and the latest event.
 *  Closed ones fold away below. */
function assignedList(tracked: TrackRow[], snaps: ForgeSnapshot[], emps: Linked[], all: boolean, paused: Set<string>): HTMLElement[] {
  const rows = tracked.map((t) => {
    const s = snaps.find((x) => x.projectId === t.projectId);
    const i = s?.issues.find((x) => x.number === t.number);
    const e = s && holder(emps, s, t.number);
    const last = t.events.at(-1);
    const p = proj(t.projectId);
    const closed = i ? i.state === 'closed' : !!t.closedAt;
    const li = h('li', { className: 'iss-row iss-tracked' },
      h('div', { className: 'iss-line' },
        h('span', { className: 'iss-ref', textContent: `#${t.number}` }),
        h('button', { type: 'button', className: 'iss-title', textContent: i?.title ?? t.title, title: `Open #${t.number}'s dashboard`, onclick: () => openIssue(t.projectId, t.number) }),
        h('span', { className: 'iss-age', textContent: [all && p ? p.name : '', closed ? 'closed' : '', last ? `${last.text} · ${age(new Date(last.at).toISOString())}` : ''].filter(Boolean).join(' · ') })),
      h('div', { className: 'iss-line iss-line--meta' }, e ? statusButton(e, emps, statusOf(e, paused)) : h('span', { className: 'iss-nobody', textContent: 'No one on it now' })));
    if (all && p) li.style.setProperty('--proj', p.colour);
    if (e) li.dataset.emp = statusOf(e, paused);
    return { li, closed, at: last?.at ?? t.assignedAt };
  }).sort((a, b) => b.at - a.at);
  const open = rows.filter((r) => !r.closed);
  const closed = rows.filter((r) => r.closed);
  if (!rows.length) return [];
  return [h('h2', { className: 'needs-title iss-assigned-title', textContent: `Assigned · ${open.length}` }),
    h('ul', { className: 'iss-list' }, ...open.map((r) => r.li)),
    ...(closed.length ? [h('details', { className: 'iss-group' }, h('summary', { className: 'iss-group-head' }, h('span', { className: 'legend', textContent: 'Closed' }), h('span', { className: 'iss-count', textContent: String(closed.length) })),
      h('ul', { className: 'iss-list' }, ...closed.map((r) => r.li)))] : [])];
}

function retry(s: ForgeSnapshot): HTMLButtonElement {
  const b = key(s.offline ? 'Retry now' : 'Refresh', () => {
    b.disabled = true;
    void api.forge.refresh(s.projectId, true).finally(() => { b.disabled = false; });
  });
  return b;
}

function issueRow(s: ForgeSnapshot, i: Issue, emps: Linked[], all: boolean, paused: Set<string>): HTMLElement {
  const p = proj(s.projectId);
  const pr = s.prs[String(i.number)];
  const emp = holder(emps, s, i.number);
  const row = h('li', { className: 'iss-row' });
  row.dataset.state = pr?.merged ? 'merged' : i.state;
  const status = emp && statusOf(emp, paused);
  if (status) row.dataset.emp = status;
  if (all && p) row.style.setProperty('--proj', p.colour);
  const labelChips = i.labels.map((l) => h('span', { className: `iss-label${/in progress/i.test(l) ? ' is-progress' : ''}`, textContent: l }));
  const prText = pr ? (pr.merged ? `PR #${pr.number} merged` : `PR #${pr.number} ${pr.state}`) : '';
  row.append(
    h('div', { className: 'iss-line' },
      h('span', { className: 'iss-ref', textContent: `#${i.number}` }),
      h('button', { type: 'button', className: 'iss-title', textContent: i.title, title: `Open #${i.number}`, onclick: () => openIssue(s.projectId, i.number) }),
      h('span', { className: 'iss-age', textContent: [all && p ? p.name : '', i.state === 'closed' ? 'closed' : '', i.comments ? `${i.comments} comment${i.comments === 1 ? '' : 's'}` : '', age(i.updatedAt)].filter(Boolean).join(' · ') })),
    h('div', { className: 'iss-line iss-line--meta' },
      emp ? h('button', { type: 'button', className: 'iss-emp', textContent: emp.name, title: `Open ${emp.name}`, onclick: () => openEmployee(emp.id) })
        : h('span', { className: 'iss-nobody', textContent: 'No employee' }),
      ...(prText ? [pr!.url ? h('button', { type: 'button', className: 'iss-pr', textContent: prText, onclick: () => void api.terminal.openUrl(pr!.url) }) : h('span', { className: 'iss-pr', textContent: prText })] : []),
      h('span', { className: 'iss-labels' }, ...labelChips),
      ...(emp ? [statusButton(emp, emps, status!)] : []),
      h('span', { className: 'iss-actions' }, ...(i.state === 'open' && !emp ? [key('Assign…', () => void openAssign(s, i))] : []))),
  );
  return row;
}

type TokenRow = { provider: ForgeLink['provider']; host: string; has: boolean; projects: string[] };

/** One forge host's token: paste and save to the Keychain, test, remove, import from gh. */
function tokenRow(r: TokenRow, say: (t: string) => void, redraw: () => void, gh = false): HTMLElement {
  const input = h('input', { type: 'password', autocomplete: 'off', placeholder: r.has ? '•••••••• saved in the Keychain' : 'Paste a token', className: 'input mono grow' });
  input.setAttribute('aria-label', `Token for ${FORGE[r.provider]} ${r.host}`);
  const act = (label: string, fn: () => Promise<string | void>) => key(label, async () => {
    try { say((await fn()) || ''); } catch (e) { say(errText(e)); }
  });
  const keys = [
    act('Save', async () => {
      if (!input.value.trim()) return 'Paste a token first.';
      await api.forge.setToken(r.provider, r.host, input.value);
      redraw();
      return r.projects.length ? `Saved. ${await api.forge.test(r.provider, r.host).catch((e) => errText(e))}` : 'Saved in the Keychain.';
    }),
    ...(r.has ? [act('Test connection', () => api.forge.test(r.provider, r.host)),
      act('Remove', async () => { if (!(await ask('Remove token', `Remove the ${FORGE[r.provider]} token for ${r.host} from the Keychain?`, 'Remove', true))) return; await api.forge.removeToken(r.provider, r.host); redraw(); return 'Removed.'; })] : []),
    ...(r.provider === 'github' && gh ? [act('Import from gh', async () => { await api.forge.importGh(); redraw(); return `Imported. ${await api.forge.test('github', 'github.com').catch((e) => errText(e))}`; })] : []),
  ];
  const hint = r.provider === 'github' ? 'Issues read anonymously; writing back needs a token with repo access.'
    : r.projects.length ? `Used by ${r.projects.join(', ')}.` : 'This forge wants a sign-in, so MyIDE needs a token to read its issues.';
  return h('div', { className: 'pref' },
    h('div', { className: 'pref-label' }, h('span', { className: 'pref-name', textContent: `${FORGE[r.provider]} · ${r.host}` }), h('span', { className: 'pref-hint', textContent: hint })),
    h('div', { className: 'pref-ctl' }, r.has ? led('working', 'Saved') : led('idle', 'No token'), input, ...keys));
}

const linkHost = (l: ForgeLink) => (l.urls[0] ? new URL(l.urls[0]).host : 'github.com');
/** A detected forge, sent from the Issues panel's Edit to the Preferences form (filled in, not saved). */
let editing: { projectId: string; link: ForgeLink } | undefined;
/** The remote picked per project, so a redraw (a poll, a change elsewhere) keeps it. */
const picks = new Map<string, number>();

/** "Found GitHub owner/repo at host from remote origin. Use it?" Use saves the same link the form saves; Edit hands the
 *  values to the form; a token step shows when the forge wants a sign-in and has no token. Nothing saves without a click. */
function foundLine(p: Project, d: Detected, o: { edit: (l: ForgeLink) => void; done: () => void; say: (t: string) => void }): HTMLElement {
  const box = h('div', { className: 'forge-found' });
  box.style.setProperty('--proj', p.colour);
  if (!d.found.length) { box.append(h('p', { className: 'pref-hint', textContent: `${d.reason ?? 'No remotes found.'} Fill in the forge by hand.` })); return box; }
  const draw = async () => {
    const pick = Math.min(picks.get(p.id) ?? 0, d.found.length - 1);
    const f: Found = d.found[pick];
    const what = f.provider
      ? `Found ${f.signIn ? 'Forgejo (probably; sign-in required)' : f.note} ${f.repo} at ${f.host} from remote ${f.remote}. Use it?`
      : `Remote ${f.remote} points at ${f.host} (${f.repo}): ${f.note}.`;
    const keys: Node[] = [];
    if (f.link) {
      const link = f.link;
      keys.push(key('Use', async () => {
        try {
          await api.forge.setLink(p.id, link);
          o.say(`${p.name} linked to ${link.repo}.`);
          void api.forge.refresh(p.id, true);
          o.done();
        } catch (e) { o.say(errText(e)); }
      }, { className: 'key key--sm key--lit' }), key('Edit', () => o.edit(link)));
    } else keys.push(key('Edit', () => o.edit({ provider: 'forgejo', repo: /^[\w.-]+\/[\w.-]+$/.test(f.repo) ? f.repo : '', urls: [`https://${f.host}`] })));
    if (d.found.length > 1) {
      const sel = h('select', { className: 'input select' }, ...d.found.map((x, i) => new Option(`${x.remote}: ${x.host}/${x.repo}`, String(i))));
      sel.value = String(pick);
      sel.setAttribute('aria-label', 'Pick another remote');
      sel.title = 'Pick another remote';
      sel.onchange = () => { picks.set(p.id, Number(sel.value)); void draw(); };
      keys.push(sel);
    }
    let token: Node[] = [];
    if (f.link && f.signIn) {
      const host = linkHost(f.link);
      if (!(await api.forge.hasToken(f.link.provider, host))) token = [tokenRow({ provider: f.link.provider, host, has: false, projects: [] }, o.say, () => void draw())];
    }
    box.replaceChildren(h('div', { className: 'forge-found-line' }, h('span', { className: 'forge-note', textContent: what }), ...keys), ...token);
  };
  void draw();
  return box;
}

registerPanel('issues', {
  title: 'Issues',
  description: 'GitHub and Forgejo issues, drafts and who is working on each.',
  scoped: true,
  create(el, params) {
    el.classList.add('issues');
    // The panel's scope (see scopeOf): the tab's project by default, every project on Home or with { scope: 'all' }.
    const { all, project } = scopeOf(params);
    const scope = all ? 'all' : project?.id ?? '';
    let v: View = { ...DEFAULT_VIEW };
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const save = () => { clearTimeout(saveTimer); if (scope) saveTimer = setTimeout(() => void api.forge.setView(scope, v).catch(() => {}), 250); };
    const set = (patch: Partial<View>) => { v = { ...v, ...patch }; save(); render(); };

    const head = h('div', { className: 'iss-head' });
    const live = h('p', { className: 'sr-only' });
    live.setAttribute('aria-live', 'polite');

    // ---- filter bar ----
    const sel = (label: string, opts: [string, string][], get: () => string, put: (x: string) => void) => {
      const s = h('select', { className: 'input select iss-sel' }, ...opts.map(([val, t]) => new Option(t, val)));
      s.setAttribute('aria-label', label);
      s.onchange = () => put(s.value);
      return Object.assign(s, { sync: () => { s.value = get(); } });
    };
    const search = h('input', { type: 'search', className: 'input iss-search', placeholder: 'Search title, #, label, body', autocomplete: 'off', spellcheck: false });
    search.setAttribute('aria-label', 'Search issues');
    search.oninput = () => set({ q: search.value });
    const stateKeys = (['open', 'closed', 'all'] as const).map((s) => {
      const b = key(s[0].toUpperCase() + s.slice(1), () => set({ state: s }));
      b.dataset.state = s;
      return b;
    });
    const stateBox = h('div', { className: 'iss-seg', role: 'group' }, ...stateKeys);
    stateBox.setAttribute('aria-label', 'State');
    const who = h('select', { className: 'input select iss-sel' });
    who.setAttribute('aria-label', 'Assignee');
    who.onchange = () => set({ who: who.value });
    const emp = sel('Employee', [['', 'Any employee'], ['yes', 'Given to an employee'], ['no', 'No employee'], ...STATUSES.map((x): [string, string] => [x, `Employee: ${stateName(x)}`])], () => v.emp, (x) => set({ emp: x as View['emp'] }));
    const pr = sel('Pull request', [['', 'Any PR'], ['yes', 'Has PR'], ['no', 'No PR']], () => v.pr, (x) => set({ pr: x as View['pr'] }));
    const labelBox = h('div', { className: 'iss-labelpick', role: 'group' });
    labelBox.setAttribute('aria-label', 'Labels (all selected must match)');
    const SORT_NAMES: Record<Sort, string> = { updated: 'Updated', created: 'Created', number: 'Number', title: 'Title', comments: 'Comments', custom: 'Custom order' };
    const sort = sel('Sort by', SORTS.map((s) => [s, SORT_NAMES[s]]), () => v.sort, (x) => set({ sort: x as Sort }));
    const dir = key('', () => set({ desc: !v.desc }), { className: 'key key--sm iss-dir' });
    const group = sel('Group by', GROUPS.map((g) => [g, g === 'none' ? 'No groups' : g === 'status' ? 'By employee status' : `By ${g}`]), () => v.group, (x) => set({ group: x as Group }));
    const clear = key('Clear', () => set({ q: '', state: 'open', labels: [], who: '', emp: '', pr: '' }), { title: 'Clear the filters (keeps sort and order)' });
    const bar = h('div', { className: 'iss-bar' },
      h('div', { className: 'iss-bar-row' }, search, stateBox, who, emp, pr, clear),
      labelBox,
      h('div', { className: 'iss-bar-row' }, h('span', { className: 'legend', textContent: 'Arrange' }), sort, dir, group,
        h('span', { className: 'pref-hint iss-hint', textContent: 'Drag a row, or Alt+Up / Alt+Down, to set a custom order.' })));

    const drafts = h('section', { className: 'needs' });
    drafts.setAttribute('aria-label', 'Drafted issues');
    const assigned = h('section', { className: 'iss-assigned' });
    assigned.setAttribute('aria-label', 'Assigned issues');
    let tracked: TrackRow[] = [];
    let closedOpen = false; // the Closed fold, kept open across redraws
    const list = h('div', { className: 'iss-groups' });
    const empty = h('p', { className: 'iss-empty' });
    const found = h('section', { className: 'iss-found' });
    found.setAttribute('aria-label', 'Forges found in git remotes');
    el.append(head, found, assigned, bar, drafts, list, empty, live);

    // Projects with no forge: what their git remotes point at, one confirm line each. The panel's own project also shows
    // why nothing was found; in the all-projects view the rest stay quiet unless a remote turned up.
    let foundSeq = 0;
    const kept = new Map<string, { k: string; row: HTMLElement }>();
    const status = h('p', { className: 'pref-warn' });
    status.setAttribute('aria-live', 'polite');
    const say = (t: string) => { status.textContent = t; };
    async function drawFound(snaps: ForgeSnapshot[]): Promise<void> {
      const n = ++foundSeq;
      const bare = allProjects().filter((p) => (all || p.id === scope) && !snaps.some((s) => s.projectId === p.id));
      const ds = await Promise.all(bare.map((p) => api.forge.detect(p.id).catch((e) => ({ found: [], reason: errText(e) }) as Detected)));
      if (n !== foundSeq) return;
      const edit = (p: Project) => (link: ForgeLink) => {
        editing = { projectId: p.id, link };
        if (window.dispatchEvent(new CustomEvent('myide:prefs-section', { detail: 'forges', cancelable: true }))) openPanel('preferences', { section: 'forges' });
      };
      const lines = bare.flatMap((p, i) => {
        if (!ds[i].found.length && p.id !== scope) return [];
        // The same answer keeps its line, so a poll's redraw never wipes a token being typed.
        const k = JSON.stringify([p.name, p.colour, ds[i]]);
        if (kept.get(p.id)?.k === k) return [kept.get(p.id)!.row];
        const row = h('div', { className: 'forge' }, h('dt', { textContent: `${p.name} · no forge` }),
          h('dd', {}, foundLine(p, ds[i], { edit: edit(p), done: () => void draw(), say })));
        row.style.setProperty('--proj', p.colour);
        kept.set(p.id, { k, row });
        return [row];
      });
      found.hidden = !lines.length;
      found.replaceChildren(h('dl', { className: 'forges' }, ...lines), status);
    }

    let snaps: ForgeSnapshot[] = [];
    let emps: Linked[] = [];
    let paused = new Set<string>(); // paused project ids
    let rows: (Row & { s: ForgeSnapshot; i: Issue })[] = [];
    let focusKey = '';
    let dragKey = '';

    /** Rows in a custom order. Moving from another sort starts the custom order from what is on screen now. */
    const reorder = (k: string, target: string, after: boolean, said: string) => {
      const base = v.sort === 'custom' ? fullOrder(v.order, rows) : arrange({ ...v, ...NO_FILTERS }, rows).map((r) => r.key);
      focusKey = k;
      live.textContent = said;
      set({ sort: 'custom', order: move(base, k, target, after) });
    };

    function rowEl(r: (typeof rows)[number]): HTMLElement {
      const li = issueRow(r.s, r.i, emps, all, paused);
      li.dataset.key = r.key;
      li.tabIndex = 0;
      li.draggable = true;
      li.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown');
      li.setAttribute('aria-label', `#${r.number} ${r.title}`);
      li.onkeydown = (e) => {
        if (e.target !== li || !e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
        e.preventDefault();
        const up = e.key === 'ArrowUp';
        const n = (up ? li.previousElementSibling : li.nextElementSibling) as HTMLElement | null;
        if (n?.dataset.key) reorder(r.key, n.dataset.key, !up, `Moved #${r.number} ${up ? 'above' : 'below'} ${n.querySelector('.iss-ref')?.textContent}`);
      };
      li.ondragstart = (e) => { dragKey = r.key; e.dataTransfer!.effectAllowed = 'move'; e.dataTransfer!.setData('text/plain', `#${r.number}`); li.classList.add('is-dragging'); };
      li.ondragend = () => { dragKey = ''; li.classList.remove('is-dragging'); list.querySelectorAll('.is-drop-before, .is-drop-after').forEach((x) => x.classList.remove('is-drop-before', 'is-drop-after')); };
      const below = (e: DragEvent) => e.clientY > li.getBoundingClientRect().top + li.offsetHeight / 2;
      li.ondragover = (e) => {
        if (!dragKey || dragKey === r.key) return;
        e.preventDefault();
        li.classList.toggle('is-drop-after', below(e));
        li.classList.toggle('is-drop-before', !below(e));
      };
      li.ondragleave = () => li.classList.remove('is-drop-before', 'is-drop-after');
      li.ondrop = (e) => {
        e.preventDefault();
        if (dragKey && dragKey !== r.key) reorder(dragKey, r.key, below(e), `Moved ${dragKey.replace(/^.*#/, '#')} ${below(e) ? 'below' : 'above'} #${r.number}`);
      };
      return li;
    }

    /** Filter bar and list from the last fetch; no IPC, so typing in the search box stays quick. */
    function render(): void {
      const was = el.ownerDocument.activeElement as HTMLElement | null;
      if (search.value !== v.q) search.value = v.q;
      stateKeys.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.state === v.state)));
      const logins = [...new Set([...snaps.flatMap((s) => s.issues.flatMap((i) => i.assignees)), ...(['', 'me', 'none'].includes(v.who) ? [] : [v.who])])].sort();
      who.replaceChildren(new Option('Anyone', ''), new Option('Assigned to me', 'me'), new Option('Unassigned', 'none'), ...logins.map((l) => new Option(l, l)));
      who.value = v.who;
      emp.sync(); pr.sync(); sort.sync(); group.sync();
      dir.textContent = v.desc ? 'Desc' : 'Asc';
      dir.title = v.desc ? 'Descending: click for ascending' : 'Ascending: click for descending';
      dir.setAttribute('aria-label', `Sort direction: ${v.desc ? 'descending' : 'ascending'}`);
      dir.disabled = v.sort === 'custom';

      const labels = [...new Set([...snaps.flatMap((s) => s.issues.flatMap((i) => i.labels)), ...v.labels])].sort();
      labelBox.hidden = !labels.length;
      labelBox.replaceChildren(h('span', { className: 'legend', textContent: 'Labels' }), ...labels.map((l) => {
        const on = v.labels.includes(l);
        const b = key(l, () => set({ labels: on ? v.labels.filter((x) => x !== l) : [...v.labels, l] }), { className: 'key key--sm iss-chip' });
        b.dataset.label = l;
        b.setAttribute('aria-pressed', String(on));
        return b;
      }));

      const groups = grouped(v, rows);
      const ul = (rs: typeof rows) => h('ul', { className: 'iss-list' }, ...rs.map(rowEl));
      list.replaceChildren(...(v.group === 'none' ? (groups[0] ? [ul(groups[0].rows as typeof rows)] : []) : groups.map((g) => {
        const d = h('details', { className: 'iss-group', open: !v.collapsed.includes(g.name) },
          h('summary', { className: 'iss-group-head' }, v.group === 'status' ? (g.name === 'none' ? h('span', { className: 'legend', textContent: 'No employee' }) : led(g.name === 'paused' ? 'interrupted' : g.name, stateName(g.name)))
            : h('span', { className: 'legend', textContent: g.name }), h('span', { className: 'iss-count', textContent: String(g.rows.length) })),
          ul(g.rows as typeof rows));
        d.dataset.group = g.name;
        d.ontoggle = () => { v = { ...v, collapsed: d.open ? v.collapsed.filter((x) => x !== g.name) : [...new Set([...v.collapsed, g.name])] }; save(); };
        return d;
      })));
      const count = groups.reduce((n, g) => n + g.rows.length, 0);
      empty.hidden = !!count;
      const p = proj(scope);
      empty.textContent = !snaps.length ? (all ? 'No project links a forge yet. Link one in Preferences > Forges.' : `${p?.name ?? 'This project'} links no forge yet. Link one above or in Preferences > Forges.`)
        : v.who === 'me' && snaps.some((s) => !s.me) ? 'No issues match. "Assigned to me" needs a token, so MyIDE knows who you are.'
        : 'No issues match these filters.';
      // A redraw replaces the rows and chips; keep focus where it was.
      const k = focusKey || (was && list.contains(was) ? was.closest<HTMLElement>('.iss-row')?.dataset.key : '');
      const again = k ? list.querySelector<HTMLElement>(`[data-key="${CSS.escape(k)}"]`)
        : was?.dataset.label ? labelBox.querySelector<HTMLElement>(`[data-label="${CSS.escape(was.dataset.label)}"]`) : null;
      again?.focus();
      focusKey = '';
    }

    let seq = 0;
    async function draw(): Promise<void> {
      const n = ++seq;
      const [s, ts] = await Promise.all([api.forge.issues(all ? undefined : scope || '-'), api.tracks.list(all ? undefined : scope || '-').catch(() => [])]);
      if (n !== seq) return;
      snaps = s;
      tracked = ts;
      void drawFound(snaps);

      head.replaceChildren(h('dl', { className: 'forges' }, ...snaps.map((s) => {
        const p = proj(s.projectId);
        const note = s.offline
          ? `Stale, last synced ${clock(s.fetchedAt)} · ${s.error ?? 'unreachable'} · retrying on the next poll`
          : s.error ? s.error : `Via ${s.host}${s.me ? ` as ${s.me}` : ' (no token: read only)'} · synced ${clock(s.fetchedAt)}`;
        const dd = h('dd', {}, s.offline ? led('interrupted', 'Unreachable') : s.error ? led('failed', 'Error') : led('working', 'Connected'),
          h('span', { className: 'forge-note', textContent: note }),
          ...(s.outbox ? [h('span', { className: 'forge-note', textContent: `${s.outbox} write-back${s.outbox === 1 ? '' : 's'} waiting to send` })] : []),
          ...(s.blocked ? [h('span', { className: 'forge-note forge-err', textContent: `Sending paused: ${s.blocked}` }),
            key('Drop it', () => void api.forge.dropOp(s.projectId, s.blockedOp!).catch(() => {}), { title: 'Drop the write at the front of the queue and send the rest' })] : []),
          ...(s.lastError ? [h('span', { className: 'forge-note forge-err', textContent: `Not sent: ${s.lastError}` })] : []),
          retry(s));
        const row = h('div', { className: 'forge' }, h('dt', { textContent: `${p?.name ?? '?'} · ${FORGE[s.provider]} ${s.repo}` }), dd);
        if (p) row.style.setProperty('--proj', p.colour);
        row.dataset.forgeState = s.offline ? 'stale' : 'ok';
        return row;
      })), key('+ New issue', () => void openNewIssue(all ? undefined : scope), { className: 'key iss-new' }));

      const allDrafts = snaps.flatMap((s) => s.drafts.map((d) => draftCard(s, d)));
      drafts.hidden = !allDrafts.length;
      drafts.replaceChildren(h('h2', { className: 'needs-title', textContent: `Needs you · drafted issues · ${allDrafts.length}` }), ...allDrafts);

      rebuild();
    }
    /** Rows from the last fetch and the live employees; an employee change lands here without asking the forge. */
    function rebuild(): void {
      rows = snaps.flatMap((s) => s.issues.map((i) => {
        const e = holder(emps, s, i.number);
        return { s, i, key: all ? `${s.projectId}#${i.number}` : String(i.number), number: i.number, title: i.title, body: i.body, labels: i.labels,
          state: i.state, assignees: i.assignees, updatedAt: i.updatedAt, createdAt: i.createdAt ?? '', comments: i.comments ?? 0,
          me: s.me, employee: e?.name, status: e && statusOf(e, paused), pr: !!s.prs[String(i.number)] };
      }));
      assigned.replaceChildren(...assignedList(tracked, snaps, emps, all, paused));
      const fold = assigned.querySelector('details');
      if (fold) { fold.open = closedOpen; fold.ontoggle = () => { closedOpen = fold.open; }; }
      assigned.hidden = !assigned.childElementCount;
      render();
    }

    const refresh = () => void api.forge.refresh(all ? undefined : scope || '-');
    el.addEventListener('focusin', refresh);
    const pausedOf = (o: OrgState) => new Set(o.projects.filter((p) => p.paused).map((p) => p.id));
    const offs = [api.forge.onChange(() => void draw()), api.tracks.onChange(() => void draw()),
      api.employees.onChange((e) => { emps = [...emps.filter((x) => x.id !== e.id), e]; rebuild(); }),
      api.employees.onRemoved((id) => { emps = emps.filter((x) => x.id !== id); rebuild(); }),
      api.org.onChange((o) => { paused = pausedOf(o); rebuild(); })];
    void Promise.all([scope ? api.forge.view(scope).catch(() => null) : null, api.employees.list(), api.org.get().catch(() => null)]).then(([saved, e, o]) => {
      v = viewOf(saved); emps = e; if (o) paused = pausedOf(o); void draw();
    });
    refresh();
    return { onShow: refresh, dispose: () => { clearTimeout(saveTimer); if (scope) void api.forge.setView(scope, v).catch(() => {}); offs.forEach((off) => off()); el.removeEventListener('focusin', refresh); } };
  },
});

api.onCommand((c) => { if (c === 'issues-all') openPanel('issues', { scope: 'all' }); });

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
      const fill = (l: ForgeLink) => { provider.value = l.provider; repo.value = l.repo; urls.value = l.urls.join('\n'); syncKind(); repo.focus(); };
      if (editing?.projectId === p.id) { fill(editing.link); editing = undefined; }
      syncKind();
      // No forge yet: what the git remotes say, above the form. Re-detect asks again (and may replace a link, on Use).
      const foundBox = h('div', { className: 'forge-found-box' });
      const detect = async (force: boolean) => {
        const d = await api.forge.detect(p.id, force).catch((e) => ({ found: [], reason: errText(e) }) as Detected);
        foundBox.replaceChildren(foundLine(p, d, { edit: fill, done: () => void draw(), say }));
      };
      if (!s) void detect(false);
      const redetect = key('Re-detect', () => void detect(true), { title: `Look at ${p.name}'s git remotes again` });
      const save = key('Save', async () => {
        try {
          await api.forge.setLink(p.id, provider.value ? { provider: provider.value as 'github' | 'forgejo', repo: repo.value, urls: urls.value.split('\n') } : null);
          say(provider.value ? `${p.name} linked to ${repo.value.trim()}.` : `${p.name} has no forge now.`);
          void api.forge.refresh(p.id, true);
          void draw();
        } catch (e) { say(errText(e)); }
      });
      const row = h('div', { className: 'proj-row forge-link' }, h('span', { className: 'pref-name', textContent: p.name }),
        h('div', { className: 'pref-ctl' }, provider, repo, save, redetect), urlBox, foundBox);
      row.style.setProperty('--proj', p.colour);
      return row;
    });

    const tokens = rows.map((r) => tokenRow(r, say, () => void draw(), gh));

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
