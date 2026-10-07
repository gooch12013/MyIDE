import { BrowserWindow, shell } from 'electron';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { stripAttribution } from './attribution';
import { assignIssue, tell } from './employees';
import { componentPath } from './components';
import { getToken, removeToken, setToken } from './keychain';
import { onIssuePost } from './mcp';
import { listProjects, readConfig, writeConfig, type Project } from './projects';
import { detect, type Detected } from './remotes';
import { spawnEnv } from './pty';
import { handle, readJSON, STATE_DIR, writeJSON } from './store';

// Forge issues: GitHub and Forgejo over REST with fetch. One cache file per project
// (~/.myide/projects/<id>/issues.json) holds the last list, the URL that worked, linked PRs,
// drafted issues and the outbox of write-backs that wait for the forge to come back.

export type Provider = 'github' | 'forgejo';
export interface ForgeLink { provider: Provider; repo: string; urls: string[] }
export interface IssueRef { provider: Provider; repo: string; number: number; title: string; url: string }
export interface Issue { number: number; title: string; body: string; url: string; state: string; labels: string[]; assignees: string[]; author: string; updatedAt: string; createdAt: string; comments: number }
export interface PrLink { number: number; url: string; state: string; merged: boolean }
export interface Draft { id: string; employeeId: string; employeeName: string; title: string; body: string; labels: string[]; at: number }
type OpKind = 'comment' | 'labels' | 'add_labels' | 'assign_self' | 'open_pr' | 'create_issue';
// uncertain: a send timed out or got a 5xx, so it may have landed; the replay looks for it on the forge first.
interface Op { id: string; kind: OpKind; issue?: number; args: any; at: number; employeeId?: string; uncertain?: boolean }
// blocked: why the outbox stopped although the forge answers (token, rate limit, other refusal); it retries each poll.
interface Cache {
  fetchedAt?: number; via?: string; me?: string; offline?: boolean; error?: string; lastError?: string; blocked?: string;
  issues: Issue[]; prs: Record<string, PrLink>; outbox: Op[]; drafts: Draft[];
}
/** What forgeAction and startWriteBack need from an employee. */
type Holder = { id: string; projectId: string; name: string; branch: string; issue?: IssueRef };
type Sent = { msg: string; number?: number; url?: string };

const TIMEOUT_MS = 5000;
const POLL_MS = 5 * 60_000;
const START_COMMENT = 'Picking this up now.';

/** No URL answered. maybeSent: a write went out but no answer came back (timeout or 5xx). */
export class Offline extends Error { constructor(m: string, readonly maybeSent = false) { super(m); } }
/** The forge answered with an HTTP error. */
class Rejected extends Error { constructor(m: string, readonly status = 0) { super(m); } }
/** MyIDE's own GitHub write pacing is at its limit. */
class Paced extends Error {}

// ---- config ----

type P = Project & { forge?: ForgeLink };
const projects = () => listProjects() as P[];
const urlsOf = (f: ForgeLink) => (f.urls.length ? f.urls : f.provider === 'github' ? ['https://api.github.com'] : []);
/** The keychain account for a forge: the host of its first URL, with api.github.com (the default) as github.com.
 *  A GitHub Enterprise URL gets its own token, so the github.com token never goes anywhere else. */
export const tokenHost = (f: ForgeLink): string => {
  const host = new URL(urlsOf(f)[0]).host;
  return host === 'api.github.com' ? 'github.com' : host;
};
const service = (p: Provider) => `myide-${p}`;
const forgeName = (f: ForgeLink) => (f.provider === 'github' ? 'GitHub' : 'Forgejo');

function linked(projectId: string): { p: P; f: ForgeLink } {
  const p = projects().find((x) => x.id === projectId);
  if (!p?.forge) throw new Error(`${p?.name ?? 'That project'} has no forge linked (Preferences > Forges).`);
  return { p, f: p.forge };
}

/** Checks and normalises a forge link from the Preferences form; null unlinks. */
export function cleanLink(x: any): ForgeLink | null {
  if (!x) return null;
  if (x.provider !== 'github' && x.provider !== 'forgejo') throw new Error('Pick GitHub or Forgejo.');
  const repo = String(x.repo ?? '').trim().replace(/\.git$/, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Repo is owner/name.');
  const urls = (Array.isArray(x.urls) ? x.urls : []).map((u: unknown) => String(u).trim().replace(/\/+$/, '')).filter(Boolean);
  for (const u of urls) {
    let url: URL | undefined;
    try { url = new URL(u); } catch { /* not a URL */ }
    if (!url || !/^https?:$/.test(url.protocol)) throw new Error(`${u} is not an http(s) URL.`);
    if (url.protocol === 'http:' && !privateHost(url.hostname)) throw new Error(`${u}: use https. Plain http is only for this Mac or a private network address (10.x, 172.16-31.x, 192.168.x).`);
  }
  if (x.provider === 'forgejo' && !urls.length) throw new Error('Forgejo needs at least one URL.');
  return { provider: x.provider, repo, urls };
}

/** Loopback or an RFC 1918 address: the only hosts a token may go to over plain http. */
export function privateHost(host: string): boolean {
  if (host === 'localhost' || host === '[::1]') return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function setLink(projectId: string, link: unknown): void {
  const c = readConfig();
  const list = (c.projects ?? []) as P[];
  const p = list.find((x) => x.id === projectId);
  if (!p) throw new Error('No such project');
  const f = cleanLink(link);
  if (f) p.forge = f; else delete p.forge;
  writeConfig({ ...c, projects: list });
  update(projectId, (k) => { k.via = undefined; k.me = undefined; k.fetchedAt = undefined; });
  changed(projectId);
}

// ---- cache ----

const cacheFile = (id: string) => join('projects', id, 'issues.json');
function cache(id: string): Cache {
  return { issues: [], prs: {}, outbox: [], drafts: [], ...readJSON<Partial<Cache>>(cacheFile(id), {}) };
}
/** Synchronous read-modify-write, so awaits elsewhere never write back a stale copy. */
function update(id: string, fn: (c: Cache) => void): Cache {
  const c = cache(id);
  fn(c);
  writeJSON(cacheFile(id), c);
  return c;
}
function changed(id: string): void {
  for (const w of BrowserWindow.getAllWindows?.() ?? []) if (!w.webContents.isDestroyed()) w.webContents.send('forge:change', id);
}

// ---- REST ----

// Fetch failures that mean nothing reached the server, so another URL may be tried even for a write.
const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH']);

/** One request, trying each URL in order (the one that last worked first), 5 s each. A read moves to the next URL
 *  on any network error or 5xx. A write moves on only when the connection failed before anything was sent; a
 *  timeout or 5xx may have landed, so it throws Offline(maybeSent) instead of posting twice. GitHub writes are paced. */
async function call(f: ForgeLink, method: string, path: string, body?: unknown, projectId?: string): Promise<any> {
  if (method === 'GET' || f.provider !== 'github') return request(f, method, path, body, projectId);
  const turn = ghQueue.then(async () => {
    const wait = ghPace(ghWrites, Date.now());
    if (wait < 0) throw new Paced('MyIDE paces GitHub writes (under 80 a minute, 500 an hour) and is at that limit; the rest wait for the next poll.');
    if (wait) await new Promise((r) => setTimeout(r, wait));
    ghWrites.push(Date.now());
    if (ghWrites.length > 600) ghWrites.splice(0, ghWrites.length - 600);
    return request(f, method, path, body, projectId);
  });
  ghQueue = turn.catch(() => {});
  return turn;
}

async function request(f: ForgeLink, method: string, path: string, body?: unknown, projectId?: string): Promise<any> {
  const urls = urlsOf(f);
  const via = projectId ? cache(projectId).via : undefined;
  const order = via && urls.includes(via) ? [via, ...urls.filter((u) => u !== via)] : urls;
  const token = await getToken(service(f.provider), tokenHost(f));
  const headers: Record<string, string> = { accept: f.provider === 'github' ? 'application/vnd.github+json' : 'application/json', 'user-agent': 'MyIDE' };
  if (token) headers.authorization = f.provider === 'github' ? `Bearer ${token}` : `token ${token}`;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const write = method !== 'GET';
  const fails: string[] = [];
  for (const u of order) {
    const base = f.provider === 'github' ? u : `${u}/api/v1`;
    const host = new URL(u).host;
    let res: Response, text: string;
    try {
      res = await fetch(base + path, { method, headers, body: payload, signal: AbortSignal.timeout(TIMEOUT_MS) });
      text = await res.text();
    } catch (e) {
      const timeout = (e as Error).name === 'TimeoutError';
      fails.push(`${host}: ${timeout ? 'no answer in 5 s' : ((e as { cause?: { code?: string } }).cause?.code ?? (e as Error).message)}`);
      if (write && !NOT_SENT.has((e as { cause?: { code?: string } }).cause?.code ?? '')) throw new Offline(fails.join('; '), true);
      continue;
    }
    if (res.status >= 500) {
      fails.push(`${host}: HTTP ${res.status}`);
      if (write) throw new Offline(fails.join('; '), true);
      continue;
    }
    if (projectId && via !== u) update(projectId, (c) => { c.via = u; });
    if (!res.ok) {
      let m = text.slice(0, 300);
      try { m = JSON.parse(text).message ?? m; } catch { /* not JSON */ }
      // GitHub's rate limit is a 403 with no requests left (or a "rate limit" message); treat it like 429.
      const limited = res.status === 429 || (res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(m)));
      throw new Rejected(`${forgeName(f)} said ${res.status} to ${method} ${path.split('?')[0]}: ${m}`, limited ? 429 : res.status);
    }
    return text ? JSON.parse(text) : null;
  }
  throw new Offline(fails.join('; ') || 'No URL configured');
}

// GitHub write pacing, across every project: one at a time, at least 1 s apart, under 80 a minute and 500 an hour.
const ghWrites: number[] = [];
let ghQueue: Promise<unknown> = Promise.resolve();
/** Milliseconds to wait before the next GitHub write, or -1 when a window is full. */
export function ghPace(times: number[], now: number): number {
  const within = (ms: number) => times.filter((t) => now - t < ms).length;
  if (within(60_000) >= 79 || within(3_600_000) >= 499) return -1;
  const last = times.at(-1);
  return last === undefined ? 0 : Math.max(0, last + 1000 - now);
}

const norm = (x: any): Issue => ({
  number: x.number, title: x.title ?? '', body: x.body ?? '', url: x.html_url ?? '', state: x.state ?? 'open',
  labels: (x.labels ?? []).map((l: any) => l.name), author: x.user?.login ?? '', updatedAt: x.updated_at ?? '', createdAt: x.created_at ?? '', comments: x.comments ?? 0,
  assignees: (x.assignees ?? (x.assignee ? [x.assignee] : [])).map((a: any) => a.login),
});

async function whoami(id: string, f: ForgeLink): Promise<string> {
  const c = cache(id);
  if (c.me) return c.me;
  const me = (await call(f, 'GET', '/user', undefined, id))?.login;
  if (!me) throw new Rejected('The forge did not say who the token belongs to.');
  update(id, (k) => { k.me = me; });
  return me;
}

const last = new Map<string, number>();

/** Refreshes one project's issues and linked PRs, then replays its outbox. Never throws; the result is in the cache. */
export async function fetchIssues(id: string, force = false): Promise<void> {
  let f: ForgeLink;
  try { f = linked(id).f; } catch { return; }
  if (!force && Date.now() - (last.get(id) ?? 0) < 30_000) return; // panel focus can fire often; GitHub allows 60 anonymous calls an hour
  last.set(id, Date.now());
  try {
    const raw = await call(f, 'GET', f.provider === 'github'
      ? `/repos/${f.repo}/issues?state=all&per_page=100&sort=updated`
      : `/repos/${f.repo}/issues?state=all&type=issues&limit=50`, undefined, id);
    const issues = (raw as any[]).filter((x) => !x.pull_request).map(norm);
    const hasToken = !!(await getToken(service(f.provider), tokenHost(f)));
    if (hasToken) await whoami(id, f).catch(() => {});
    const prs: Record<string, PrLink> = {};
    for (const [n, pr] of Object.entries(cache(id).prs)) {
      if (pr.state !== 'open') continue;
      const x = await call(f, 'GET', `/repos/${f.repo}/pulls/${pr.number}`, undefined, id);
      prs[n] = { ...pr, state: x.state, merged: !!(x.merged || x.merged_at) };
    }
    update(id, (c) => { Object.assign(c, { issues, fetchedAt: Date.now(), offline: false, error: undefined }); Object.assign(c.prs, prs); });
  } catch (e) {
    update(id, (c) => { c.offline = e instanceof Offline; c.error = (e as Error).message; });
  }
  changed(id);
  if (!cache(id).offline) await drain(id);
}

/** Every linked project, one after another; nothing else waits on this. */
export async function pollAll(force = false): Promise<void> {
  for (const p of projects()) if (p.forge) await fetchIssues(p.id, force);
}

// ---- writes and the outbox ----

async function labelIds(id: string, f: ForgeLink, names: string[]): Promise<number[]> {
  const have: { id: number; name: string }[] = await call(f, 'GET', `/repos/${f.repo}/labels?limit=100`, undefined, id);
  const out: number[] = [];
  for (const n of names) {
    const hit = have.find((l) => l.name.toLowerCase() === n.toLowerCase());
    out.push(hit ? hit.id : (await call(f, 'POST', `/repos/${f.repo}/labels`, { name: n, color: '#ffb21a' }, id)).id);
  }
  return out;
}

/** For a write that may already have landed: the matching comment, issue or PR on the forge, by the token's owner. */
async function existing(id: string, f: ForgeLink, op: Op): Promise<any> {
  const me = await whoami(id, f);
  const R = `/repos/${f.repo}`;
  const since = encodeURIComponent(new Date(Math.min(op.at, Date.now() - 3_600_000)).toISOString());
  if (op.kind === 'comment') {
    const list: any[] = await call(f, 'GET', `${R}/issues/${op.issue}/comments?since=${since}&per_page=100&limit=50`, undefined, id);
    return list.find((c) => c.user?.login === me && c.body === op.args.body);
  }
  if (op.kind === 'create_issue') {
    const list: any[] = await call(f, 'GET', f.provider === 'github'
      ? `${R}/issues?state=all&creator=${encodeURIComponent(me)}&since=${since}&per_page=100`
      : `${R}/issues?state=all&type=issues&created_by=${encodeURIComponent(me)}&since=${since}&limit=50`, undefined, id);
    return list.find((x) => !x.pull_request && x.title === op.args.title && x.user?.login === me && Date.now() - Date.parse(x.created_at) < 3_600_000);
  }
  if (op.kind === 'open_pr') {
    const list: any[] = await call(f, 'GET', `${R}/pulls?state=open&per_page=100&limit=50`, undefined, id);
    return list.find((x) => x.head?.ref === op.args.head);
  }
  return undefined;
}

async function send(id: string, op: Op): Promise<Sent> {
  const { f } = linked(id);
  if (!(await getToken(service(f.provider), tokenHost(f)))) throw new Rejected(`No ${forgeName(f)} token for ${tokenHost(f)}; add one in Preferences > Forges.`);
  const R = `/repos/${f.repo}`;
  const n = op.issue;
  const labels = async (names: string[]) => (f.provider === 'github' ? names : labelIds(id, f, names));
  // A create that may have landed is looked up first, so a replay never posts it twice.
  const once = async (path: string, body: () => Promise<object> | object) => (op.uncertain && await existing(id, f, op)) || call(f, 'POST', path, await body(), id);
  switch (op.kind) {
    case 'comment':
      await once(`${R}/issues/${n}/comments`, () => ({ body: op.args.body }));
      return { msg: `Commented on #${n}.` };
    case 'labels':
    case 'add_labels':
      await call(f, op.kind === 'labels' ? 'PUT' : 'POST', `${R}/issues/${n}/labels`, { labels: await labels(op.args.labels) }, id);
      return { msg: `Labels on #${n}: ${op.args.labels.join(', ') || 'none'}.` };
    case 'assign_self': {
      const me = await whoami(id, f);
      if (f.provider === 'github') await call(f, 'POST', `${R}/issues/${n}/assignees`, { assignees: [me] }, id);
      else {
        const cur = norm(await call(f, 'GET', `${R}/issues/${n}`, undefined, id)).assignees;
        await call(f, 'PATCH', `${R}/issues/${n}`, { assignees: [...new Set([...cur, me])] }, id);
      }
      return { msg: `Assigned #${n} to ${me}.` };
    }
    case 'open_pr': {
      const pr = await once(`${R}/pulls`, async () => ({
        title: op.args.title, body: op.args.body, head: op.args.head, base: op.args.base || (await call(f, 'GET', R, undefined, id)).default_branch,
      }));
      if (n) update(id, (c) => { c.prs[n] = { number: pr.number, url: pr.html_url, state: 'open', merged: false }; });
      return { msg: `Opened PR #${pr.number}: ${pr.html_url}`, number: pr.number, url: pr.html_url };
    }
    case 'create_issue': {
      const x = await once(`${R}/issues`, async () => ({ title: op.args.title, body: op.args.body, labels: await labels(op.args.labels) }));
      update(id, (c) => { c.issues = [norm(x), ...c.issues.filter((i) => i.number !== x.number)]; });
      return { msg: `Filed #${x.number}: ${x.html_url}`, number: x.number, url: x.html_url };
    }
  }
}

const results = new Map<string, Sent | Error>();
const draining = new Map<string, Promise<void>>();
const awaited = new Set<string>(); // ops whose sender is still waiting on write()

/** Sends the outbox front to back. Unreachable (Offline), a refused token (401, 403), a rate limit (429, or
 *  MyIDE's own GitHub pacing) or no token stop the drain and keep the rest; the next poll tries again. Only a
 *  404 or 422 drops the op, and its employee is told if it is no longer waiting on the answer. */
function drain(id: string): Promise<void> {
  const next = (draining.get(id) ?? Promise.resolve()).then(async () => {
    for (let op = cache(id).outbox[0]; op; op = cache(id).outbox[0]) {
      const what = `${op.kind}${op.issue ? ` #${op.issue}` : ''}`;
      try { results.set(op.id, await send(id, op)); } catch (e) {
        const err = e as Error;
        const sent = op.id;
        if (e instanceof Offline) {
          update(id, (c) => { c.offline = true; c.error = err.message; if (e.maybeSent) c.outbox.forEach((o) => { if (o.id === sent) o.uncertain = true; }); });
          changed(id);
          return;
        }
        if (!(e instanceof Rejected && (e.status === 404 || e.status === 422))) {
          // Anything but a refusal or MyIDE's own pacing may have come after the forge took the write (a 2xx that is not
          // JSON, say): the replay looks for it first.
          const maybe = !(e instanceof Rejected) && !(e instanceof Paced);
          update(id, (c) => { c.blocked = `${what}: ${err.message}`; if (maybe) c.outbox.forEach((o) => { if (o.id === sent) o.uncertain = true; }); });
          changed(id);
          return;
        }
        results.set(op.id, err);
        update(id, (c) => { c.lastError = `${what}: ${err.message}`; });
        if (op.employeeId && !awaited.has(op.id)) tell(op.employeeId, `MyIDE could not send your queued forge write (${what}) and dropped it: ${err.message}`);
      }
      const sent = op.id;
      update(id, (c) => { c.outbox = c.outbox.filter((o) => o.id !== sent); c.blocked = undefined; });
      changed(id);
    }
  });
  draining.set(id, next.catch(() => {}));
  return next;
}

/** Queues a write behind anything already waiting and sends what it can. While the forge is known to be
 *  down it only queues; the next poll that reaches it replays the outbox in order. */
async function write(id: string, kind: OpKind, issue: number | undefined, args: object, employeeId?: string): Promise<Sent> {
  const { f } = linked(id);
  const op: Op = { id: randomUUID(), kind, issue, args, at: Date.now(), employeeId };
  const c = update(id, (k) => { k.outbox.push(op); });
  changed(id);
  awaited.add(op.id);
  try { if (!c.offline) await drain(id); } finally { awaited.delete(op.id); }
  const r = results.get(op.id);
  results.delete(op.id);
  if (r instanceof Error) throw r;
  if (r) return r;
  const k = cache(id);
  return { msg: k.blocked && !k.offline ? `Queued: ${k.blocked}. It goes out in order once that is fixed.` : `Queued: ${forgeName(f)} is unreachable, so this goes out in order when it is back.` };
}

const strip = (s: unknown) => stripAttribution(String(s ?? '')).trim();
const cleanLabels = (x: unknown): string[] => (Array.isArray(x) ? x : typeof x === 'string' ? x.split(',') : [])
  .map((l) => String(l).trim()).filter(Boolean).slice(0, 20);

/** The employees' one path to a forge. Every body is stripped of attribution. There is no close action. */
export async function forgeAction(emp: Holder, action: 'comment' | 'open_pr' | 'set_labels' | 'draft_issue', args: any): Promise<string> {
  const a = args ?? {};
  if (action === 'draft_issue') {
    const title = strip(a.title);
    if (!title) throw new Error('A draft needs a title.');
    linked(emp.projectId);
    update(emp.projectId, (c) => {
      c.drafts.push({ id: randomUUID(), employeeId: emp.id, employeeName: emp.name, title, body: strip(a.body), labels: cleanLabels(a.labels), at: Date.now() });
    });
    changed(emp.projectId);
    return 'Drafted. Nothing was posted; it waits in NEEDS YOU until David files it.';
  }
  const iss = emp.issue;
  if (!iss) throw new Error('You hold no issue, so there is nothing to write back to.');
  if (action === 'comment') {
    const body = strip(a.body);
    if (!body) throw new Error('The comment is empty.');
    return (await write(emp.projectId, 'comment', iss.number, { body }, emp.id)).msg;
  }
  if (action === 'set_labels') return (await write(emp.projectId, 'labels', iss.number, { labels: cleanLabels(a.labels) }, emp.id)).msg;
  if (action === 'open_pr') {
    const title = strip(a.title) || iss.title;
    let body = strip(a.body);
    if (!new RegExp(`\\b(close[sd]?|fix(e[sd])?|resolve[sd]?):? +#${iss.number}\\b`, 'i').test(body)) body = `${body}\n\nCloses #${iss.number}`.trim();
    return (await write(emp.projectId, 'open_pr', iss.number, { title, body, head: String(a.head || emp.branch), base: a.base ? String(a.base) : undefined }, emp.id)).msg;
  }
  throw new Error(`No forge action "${action}". There is no close: an issue closes when its PR merges.`);
}

/** On assignment: a start comment, the token owner as assignee and an "in progress" label. Throws once, after trying all three. */
export async function startWriteBack(emp: Holder): Promise<void> {
  const iss = emp.issue;
  if (!iss) return;
  const errs: string[] = [];
  for (const [kind, args] of [['comment', { body: strip(START_COMMENT) }], ['assign_self', {}], ['add_labels', { labels: ['in progress'] }]] as const) {
    try { await write(emp.projectId, kind, iss.number, args, emp.id); } catch (e) { errs.push((e as Error).message); }
  }
  if (errs.length) throw new Error(errs.join('\n'));
}

// ---- filing and assigning ----

type Image = { name: string; type: string; data: Uint8Array };
type Assign = { employeeId?: string; role?: string; note?: string };

/** David's New issue form. GitHub with images opens the browser's new-issue page instead (no upload API). */
export async function createIssue(o: { projectId: string; title: string; body?: string; labels?: unknown; images?: Image[]; assign?: Assign }):
  Promise<{ number: number; url: string; opened?: boolean; queued?: boolean; warning?: string }> {
  const { f } = linked(o.projectId);
  const title = strip(o.title);
  if (!title) throw new Error('Give the issue a title.');
  let body = strip(o.body);
  const labels = cleanLabels(o.labels);
  const images = o.images ?? [];
  if (images.length && f.provider === 'github') {
    const q = new URLSearchParams({ title, body, ...(labels.length ? { labels: labels.join(',') } : {}) });
    const url = `https://github.com/${f.repo}/issues/new?${q}`;
    await shell.openExternal(url);
    return { number: 0, url, opened: true };
  }
  const r = await write(o.projectId, 'create_issue', undefined, { title, body, labels });
  if (!r.number) return { number: 0, url: '', queued: true, warning: images.length || o.assign ? 'Queued without images or assignment.' : undefined };
  let warning: string | undefined;
  if (images.length) {
    try {
      const links: string[] = [];
      for (const img of images) {
        const form = new FormData();
        form.append('attachment', new Blob([new Uint8Array(img.data)], { type: img.type }), img.name.replace(/[^\w.-]/g, '_') || 'image.png');
        const a = await call(f, 'POST', `/repos/${f.repo}/issues/${r.number}/assets`, form, o.projectId);
        links.push(`![${a.name}](${a.browser_download_url})`);
      }
      body = [body, ...links].filter(Boolean).join('\n\n');
      const x = await call(f, 'PATCH', `/repos/${f.repo}/issues/${r.number}`, { body }, o.projectId);
      update(o.projectId, (c) => { c.issues = c.issues.map((i) => (i.number === x.number ? norm(x) : i)); });
    } catch (e) { warning = `Filed, but the images did not upload: ${(e as Error).message}`; }
  }
  changed(o.projectId);
  if (o.assign && (o.assign.employeeId || o.assign.role)) {
    const w = (await assign({ projectId: o.projectId, number: r.number, title, url: r.url!, ...o.assign })).warning;
    warning = [warning, w].filter(Boolean).join('\n') || undefined;
  }
  return { number: r.number, url: r.url!, warning };
}

/** The quick-add script's path: project matched by name, case-insensitive. Number 0 means queued (forge unreachable). */
export async function quickAddIssue(projectName: string, title: string): Promise<{ number: number; url: string }> {
  const name = String(projectName ?? '').trim().toLowerCase();
  const p = projects().find((x) => x.name.toLowerCase() === name);
  if (!p) throw new Error(`No project named ${projectName}. Projects: ${projects().map((x) => x.name).join(', ') || 'none'}.`);
  const r = await createIssue({ projectId: p.id, title });
  return { number: r.number, url: r.url };
}

/** Hands an issue to an employee (or a new hire from a role), then writes back the start. */
export async function assign(o: { projectId: string; number: number; title?: string; url?: string } & Assign): Promise<{ employeeId: string; warning?: string }> {
  const { f } = linked(o.projectId);
  const known = cache(o.projectId).issues.find((i) => i.number === o.number);
  const issue: IssueRef = { provider: f.provider, repo: f.repo, number: o.number, title: known?.title ?? o.title ?? '', url: known?.url ?? o.url ?? '' };
  const emp = await assignIssue({ projectId: o.projectId, issue, employeeId: o.employeeId, role: o.role, note: o.note });
  try { await startWriteBack({ ...emp, issue: emp.issue ?? issue }); } catch (e) { return { employeeId: emp.id, warning: `Assigned, but the forge write-back failed: ${(e as Error).message}` }; }
  return { employeeId: emp.id };
}

async function fileDraft(projectId: string, id: string): Promise<{ number: number; url: string; warning?: string }> {
  const d = cache(projectId).drafts.find((x) => x.id === id);
  if (!d) throw new Error('That draft is gone.');
  const r = await createIssue({ projectId, title: d.title, body: d.body, labels: d.labels });
  update(projectId, (c) => { c.drafts = c.drafts.filter((x) => x.id !== id); });
  changed(projectId);
  return r;
}

// ---- tokens ----

/** gh's token for github.com: gh on the login PATH, else the gh MyIDE installed as an optional component. */
async function ghToken(): Promise<string | null> {
  const env = await spawnEnv().catch(() => undefined);
  const run = (bin: string) => new Promise<string | null>((resolve) => {
    execFile(bin, ['auth', 'token', '--hostname', 'github.com'], { env, timeout: 5000 }, (err, out) => resolve(err ? null : out.trim() || null));
  });
  const own = componentPath('gh');
  return (await run('gh')) ?? (own ? run(own) : null);
}

/** Every forge host that can hold a token: github.com always, plus each linked Forgejo. */
async function tokenRows(): Promise<{ provider: Provider; host: string; has: boolean; projects: string[] }[]> {
  const rows = new Map<string, { provider: Provider; host: string; has: boolean; projects: string[] }>();
  rows.set('github:github.com', { provider: 'github', host: 'github.com', has: false, projects: [] });
  for (const p of projects()) {
    if (!p.forge) continue;
    let host: string;
    try { host = tokenHost(p.forge); } catch { continue; }
    const k = `${p.forge.provider}:${host}`;
    if (!rows.has(k)) rows.set(k, { provider: p.forge.provider, host, has: false, projects: [] });
    rows.get(k)!.projects.push(p.name);
  }
  for (const r of rows.values()) r.has = !!(await getToken(service(r.provider), r.host));
  return [...rows.values()];
}

async function testConnection(provider: Provider, host: string): Promise<string> {
  const f = provider === 'github' && host === 'github.com' ? { provider, repo: '', urls: [] }
    : projects().map((p) => p.forge).find((x) => x?.provider === provider && tokenHost(x) === host);
  if (!f) throw new Error(`No project links ${host}.`);
  if (!(await getToken(service(provider), host))) throw new Error('No token saved.');
  const me = await call(f, 'GET', '/user');
  return `Connected as ${me.login}.`;
}

// ---- wiring ----

/** Snapshot for the Issues panel: every linked project, or one. */
function snapshot(projectId?: string) {
  return projects().filter((p) => p.forge && (!projectId || p.id === projectId)).map((p) => {
    const c = cache(p.id);
    let host = '';
    try { host = c.via ? new URL(c.via).host : tokenHost(p.forge!); } catch { /* bad URL */ }
    return {
      projectId: p.id, provider: p.forge!.provider, repo: p.forge!.repo, urls: p.forge!.urls, host,
      fetchedAt: c.fetchedAt, offline: !!c.offline, error: c.error, lastError: c.lastError, blocked: c.blocked, me: c.me,
      issues: c.issues, prs: c.prs, outbox: c.outbox.length, drafts: c.drafts, blockedOp: c.blocked ? c.outbox[0]?.id : undefined,
    };
  });
}
export type ForgeSnapshot = ReturnType<typeof snapshot>[number];

const detected = new Map<string, Promise<Detected>>();

export function registerForgeIpc(): void {
  // The quick-add script: ~/.myide/bin/issue PROJECT "title".
  try {
    mkdirSync(join(STATE_DIR, 'bin'), { recursive: true, mode: 0o700 });
    copyFileSync(join(__dirname, 'bin', 'issue'), join(STATE_DIR, 'bin', 'issue'));
    chmodSync(join(STATE_DIR, 'bin', 'issue'), 0o700);
  } catch (e) { console.error('Could not install the issue script', e); }

  onIssuePost(quickAddIssue);
  setTimeout(() => void pollAll(), 3000);
  setInterval(() => void pollAll(), POLL_MS);

  handle('forge:issues', (projectId?: string) => snapshot(projectId));
  // The forge a project's git remotes point at, for the confirm line; kept until Re-detect.
  handle('forge:detect', (projectId: string, force?: boolean) => {
    const p = projects().find((x) => x.id === projectId);
    if (!p) throw new Error('No such project');
    if (force || !detected.has(p.id)) detected.set(p.id, detect(p.path).catch((e) => ({ found: [], reason: (e as Error).message })));
    return detected.get(p.id)!;
  });
  handle('forge:refresh', async (projectId?: string, force?: boolean) => {
    if (projectId) await fetchIssues(projectId, !!force); else await pollAll(!!force);
  });
  handle('forge:set-link', (projectId: string, link: unknown) => setLink(projectId, link));
  handle('forge:tokens', async () => ({ rows: await tokenRows(), gh: !!(await ghToken()) }));
  handle('forge:set-token', async (provider: Provider, host: string, token: string) => {
    await setToken(service(provider), host, String(token ?? '').trim());
    for (const p of projects()) if (p.forge?.provider === provider) update(p.id, (c) => { c.me = undefined; });
  });
  handle('forge:has-token', async (provider: Provider, host: string) => !!(await getToken(service(provider), host)));
  handle('forge:remove-token', (provider: Provider, host: string) => removeToken(service(provider), host));
  handle('forge:import-gh', async () => {
    const t = await ghToken();
    if (!t) throw new Error('gh has no token for github.com.');
    await setToken('myide-github', 'github.com', t);
  });
  handle('forge:test', testConnection);
  handle('forge:create', createIssue);
  handle('forge:assign', assign);
  handle('forge:file-draft', fileDraft);
  handle('forge:drop-op', (projectId: string, opId: string) => { // the blocked op David saw, by id: never whatever is at the front now
    if (!cache(projectId).outbox.some((o) => o.id === opId)) throw new Error('That write already went out or was dropped.');
    update(projectId, (c) => { c.outbox = c.outbox.filter((o) => o.id !== opId); c.blocked = undefined; });
    changed(projectId);
    void drain(projectId);
  });
  // The Issues panel's filters, sort and custom order: per project, or one file for the all-projects view.
  const viewFile = (scope: string) => {
    if (scope === 'all') return 'issues-view.json';
    if (!projects().some((p) => p.id === scope)) throw new Error('No such project');
    return join('projects', scope, 'issues-view.json');
  };
  handle('forge:view', (scope: string) => readJSON<unknown>(viewFile(scope), null));
  handle('forge:set-view', (scope: string, view: unknown) => {
    if (!view || typeof view !== 'object' || JSON.stringify(view).length > 200_000) throw new Error('Bad view');
    writeJSON(viewFile(scope), view);
  });
  handle('forge:discard-draft', (projectId: string, id: string) => {
    update(projectId, (c) => { c.drafts = c.drafts.filter((x) => x.id !== id); });
    changed(projectId);
  });
}
