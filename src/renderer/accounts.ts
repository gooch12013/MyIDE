// AI accounts: Preferences > AI accounts, the account picker on hire, and capability greying.
import type { Account, Usage } from '../main/accounts';
import { errText, h, key } from './dom';
import { led, meterBar } from './employees';
import { openCommandTerminal } from './terminal';

const api = window.myide;
type Providers = Awaited<ReturnType<typeof api.accounts.providers>>;
type Cap = [boolean | 'unknown', string];

let table: Promise<Providers> | undefined;
export const providers = (): Promise<Providers> => (table ??= api.accounts.providers());

const CAPS = [['voice', 'Voice input'], ['planMode', 'Plan mode'], ['liveModel', 'Live model change'], ['effort', 'Effort levels'],
  ['todos', 'To-do progress'], ['resume', 'Session resume'], ['images', 'Image input'], ['computerUse', 'Computer use']] as const;
export type CapName = (typeof CAPS)[number][0];

/** Greys `el` with the reason as its tooltip when the employee's AI lacks `cap` (providers.json). */
export async function greyUnless(el: HTMLButtonElement | HTMLSelectElement, provider: string | undefined, cap: CapName): Promise<void> {
  const [ok, why] = ((await providers())[provider ?? 'claude']?.[cap] as Cap | undefined) ?? ['unknown', 'Unknown AI.'];
  if (ok === true) return;
  el.disabled = true;
  el.title = `Not available for this AI: ${why}`;
}

const pct = (f?: number) => (typeof f === 'number' ? Math.round(f * 100) : undefined);
function meter(id: string, u?: Usage): HTMLElement {
  const five = pct(u?.fiveHour);
  const bar = meterBar(five ?? 0, 'Five-hour usage');
  const week = pct(u?.sevenDay);
  const text = five === undefined ? 'No reading yet' : `${five}% · 5 h${week === undefined ? '' : ` · ${week}% · 7 d`}`;
  const el = h('span', { className: 'acct-use', title: u?.resetsAt ? `Five-hour window resets ${new Date(u.resetsAt).toLocaleString()}` : 'Updates after the next turn on this account' },
    bar, h('span', { className: 'acct-use-val', textContent: text }));
  el.dataset.usage = id;
  return el;
}
api.accounts.onUsage((id, u) => document.querySelectorAll<HTMLElement>(`[data-usage="${CSS.escape(id)}"]`).forEach((el) => el.replaceWith(meter(id, u))));

const label = (a: Account, p: Providers) => `${a.name} · ${p[a.provider]?.label ?? a.provider}`;

/** Preferences > AI accounts. `again` re-renders the section. */
export async function accountsSection(say: (t: string) => void, again: () => void): Promise<Node[]> {
  const [list, p, staff, codex] = await Promise.all([api.accounts.list(), providers(), api.employees.list(), api.accounts.codexInfo()]);
  const act = (fn: () => Promise<unknown>) => async () => { try { await fn(); } catch (e) { say(errText(e)); } };

  const rows = list.map((a) => {
    const users = staff.filter((e) => (e.accountId ?? 'claude-default') === a.id).length;
    const name = h('input', { className: 'input', value: a.name, maxLength: 40 });
    name.setAttribute('aria-label', `Name of ${a.name}`);
    name.onchange = act(() => api.accounts.update(a.id, { name: name.value }));
    const cap = h('input', { className: 'input num', type: 'number', min: '0', max: '20', value: String(a.cap) });
    cap.setAttribute('aria-label', `Most employees working at once on ${a.name}`);
    cap.onchange = act(() => api.accounts.update(a.id, { cap: Number(cap.value) }));
    const auto = h('input', { type: 'checkbox', className: 'switch', checked: a.allowAuto });
    auto.onchange = act(() => api.accounts.update(a.id, { allowAuto: auto.checked }));
    const signin = led('idle', 'Checking…');
    void api.accounts.status(a.id).then((s) => signin.replaceWith(Object.assign(led(s.loggedIn ? 'working' : 'failed', s.loggedIn ? 'Signed in' : 'Not signed in'), { title: s.detail })));
    const where = a.env.CLAUDE_CONFIG_DIR ?? a.env.CODEX_HOME ?? (a.provider === 'codex' ? '~/.codex' : '~/.claude');
    const td = (l: string, ...kids: Node[]) => { const c = h('td', {}, ...kids); c.dataset.l = l; return c; };
    return h('tr', {},
      h('th', { scope: 'row' }, name, h('span', { className: 'acct-sub', textContent: `${p[a.provider]?.label ?? a.provider} · ${where}`, title: where })),
      td('Sign-in', signin),
      td('Usage', meter(a.id, a.usage)),
      td('Used by', document.createTextNode(users ? `${users} employee${users > 1 ? 's' : ''}` : '—')),
      td('Cap', cap),
      td('Auto may use', h('label', { className: 'toggle' }, auto, 'Allowed')),
      td('Actions', h('span', { className: 'acct-keys' },
        key('Log in', act(async () => { openCommandTerminal(undefined, (await api.accounts.login(a.id)).command); say(`${a.name}: finish the login in the terminal, then press Test.`); }),
          { title: 'Opens the AI\'s own login in a terminal, with this account\'s folder. MyIDE never sees the credentials.' }),
        key('Test', act(async () => { say(`Testing ${a.name}…`); const r = await api.accounts.test(a.id); say(`${a.name}: ${r.ok ? 'works' : 'failed'}. ${r.detail}`); }),
          { title: 'Runs one tiny turn on this account' }),
        ...(a.id === 'claude-default' ? [] : [h('button', {
          type: 'button', className: 'btn btn--quiet rm', textContent: 'Remove', disabled: users > 0,
          title: users ? 'Fire or move its employees first' : `Forget this account. Its folder (${where}) stays on disk.`,
          onclick: act(async () => { if (!confirm(`Remove ${a.name}? Its login stays in ${where} until you delete that folder.`)) return; await api.accounts.remove(a.id); again(); }),
        })]))));
  });
  const tbl = h('table', { className: 'ptbl acct-tbl' },
    h('thead', {}, h('tr', {}, ...['Account', 'Sign-in', 'Usage', 'Used by', 'Cap', 'Auto may use', ''].map((t) => h('th', { scope: 'col', textContent: t })))),
    h('tbody', {}, ...rows));

  // Add: provider, name, and for Codex whether it uses ~/.codex or a login of its own.
  const prov = h('select', { className: 'input select' }, new Option('Claude Code', 'claude'), new Option('OpenAI Codex', 'codex'),
    Object.assign(new Option('Gemini CLI (not yet)', 'gemini'), { disabled: true }));
  prov.setAttribute('aria-label', 'Provider');
  const nm = h('input', { className: 'input', placeholder: 'Name, e.g. Work', maxLength: 40 });
  nm.setAttribute('aria-label', 'Account name');
  const own = h('input', { type: 'checkbox', className: 'switch', checked: list.some((a) => a.provider === 'codex' && !a.env.CODEX_HOME) });
  const ownLbl = h('label', { className: 'toggle' }, own, 'Own login (not ~/.codex)');
  const sync = () => { ownLbl.hidden = prov.value !== 'codex'; };
  prov.onchange = sync;
  sync();
  const add = key('+ Add account', act(async () => {
    const a = await api.accounts.add({ provider: prov.value as Account['provider'], name: nm.value, ownLogin: own.checked });
    again();
    say(`Added ${a.name}. Press Log in to sign it in${a.provider === 'claude' ? ' (use a private browser window if the browser is signed in to your other account)' : ''}.`);
  }));

  // Capability table, straight from providers.json.
  const ids = Object.keys(p);
  const caps = h('table', { className: 'ptbl acct-caps' },
    h('thead', {}, h('tr', {}, h('th', { scope: 'col', textContent: 'Feature' }), ...ids.map((id) => h('th', { scope: 'col', textContent: p[id].label })))),
    h('tbody', {}, ...CAPS.map(([c, title]) => h('tr', {}, h('th', { scope: 'row', textContent: title }), ...ids.map((id) => {
      const [ok, why] = (p[id][c] as Cap | undefined) ?? ['unknown', ''];
      const l = led(ok === true ? 'working' : ok === false ? 'idle' : 'queued', ok === true ? 'Yes' : ok === false ? 'No' : 'Unknown');
      l.title = why;
      return h('td', {}, l);
    })))));

  const codexState = !codex.version ? led('idle', 'Not installed') : codex.tested ? led('working', 'Tested') : led('interrupted', 'Untested');
  return [
    h('p', { className: 'psec-lede', textContent: 'Each account is one login of an AI\'s own CLI, with its own cap and usage gauge. An employee stays on the account it was hired on; when that account is at its limit its work waits. MyIDE never moves work to another account and never sees your credentials.' }),
    tbl,
    h('div', { className: 'pref-ctl acct-add' }, prov, nm, ownLbl, add),
    h('h3', { className: 'legend psec-sub', textContent: 'What each AI can do' }),
    caps,
    h('div', { className: 'pref' },
      h('div', { className: 'pref-label' }, h('span', { className: 'pref-name', textContent: 'Codex CLI' }),
        h('span', { className: 'pref-hint', textContent: codex.version ? (codex.tested ? 'The version MyIDE is tested with.' : `MyIDE is tested with ${codex.testedVersion}.`) : 'Install OpenAI Codex to hire Codex employees.' })),
      h('div', { className: 'pref-ctl' }, h('span', { className: 'path', textContent: codex.path ?? 'none' }), codexState)),
  ];
}

/** Puts the AI's own model and effort lists into a modelPicker's selects. A Claude model name means
 *  nothing to Codex, so a value the AI lacks falls back to its first model. Keeps Claude's lists as
 *  they are (they may hold a role's full model id). Returns whether anything changed. */
export async function modelsFor(pickEl: HTMLElement, provider: string): Promise<boolean> {
  const [model, effort] = pickEl.querySelectorAll('select');
  const prov = (await providers())[provider];
  if (!model || !prov) return false;
  const fits = (sel: HTMLSelectElement, opts: string[][]) => [...sel.options].every((o) => opts.some(([v]) => v === o.value));
  if (provider === 'claude' ? pickEl.dataset.ai !== 'codex' && pickEl.dataset.ai !== 'gemini' : fits(model, prov.models) && (!effort || fits(effort, prov.efforts))) return false;
  const fill = (sel: HTMLSelectElement, opts: string[][]) => {
    const keep = opts.some(([v]) => v === sel.value) ? sel.value : opts[0]?.[0] ?? '';
    sel.replaceChildren(...opts.map(([v, l]) => new Option(l, v)));
    sel.value = keep;
  };
  fill(model, prov.models);
  if (effort) fill(effort, prov.efforts);
  pickEl.dataset.ai = provider;
  return true;
}

/** The account picker on the hire sheet; sync() after anything that resets the model picker. */
export async function accountPicker(pickEl: HTMLElement): Promise<{ el: HTMLElement; get(): { accountId: string; provider: Account['provider'] }; sync(): Promise<void> }> {
  const [list, p] = await Promise.all([api.accounts.list(), providers()]);
  const usable = list.filter((a) => p[a.provider]?.models.length);
  const s = h('select', { className: 'input select', id: 'hire-account' }, ...usable.map((a) => new Option(label(a, p), a.id)));
  const provider = () => usable.find((a) => a.id === s.value)?.provider ?? 'claude';
  const sync = async () => { if (await modelsFor(pickEl, provider())) pickEl.querySelector('select')?.dispatchEvent(new Event('change')); };
  s.onchange = () => void sync();
  return {
    el: h('label', { className: 'field', htmlFor: 'hire-account' }, h('span', { className: 'legend', textContent: 'AI account' }), s),
    get: () => ({ accountId: s.value, provider: provider() }),
    sync,
  };
}

/** The employee panel's AI line, model lists and greyed controls (talk needs resume; model and effort their capabilities). */
export async function employeeAi(e: { provider?: string; accountId?: string; model: string; effort?: string }, o: { pick: { el: HTMLElement; set(m: string, ef?: string): void }; talk: HTMLButtonElement; line: HTMLElement; first: boolean }): Promise<void> {
  const provider = e.provider ?? 'claude';
  if (o.first) {
    const [list, p] = await Promise.all([api.accounts.list(), providers()]);
    const a = list.find((x) => x.id === (e.accountId ?? 'claude-default'));
    o.line.textContent = `AI account: ${a ? label(a, p) : `${e.accountId} (removed)`}. Fixed at hire; to change it, fire and rehire.`;
    if (await modelsFor(o.pick.el, provider)) o.pick.set(e.model, e.effort);
    const [model, effort] = o.pick.el.querySelectorAll('select');
    if (model) await greyUnless(model, provider, 'liveModel');
    if (effort) await greyUnless(effort, provider, 'effort');
  }
  await greyUnless(o.talk, provider, 'resume');
}
