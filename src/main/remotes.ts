import { execFile } from 'node:child_process';
import type { ForgeLink } from './forge';

// Finds a project's forge from its git remotes. Read-only: `git remote -v`, `ssh -G` (prints config, never
// connects) and one anonymous GET of /api/v1/version for hosts that are not github.com. No token is ever sent.

export interface Remote { name: string; url: string }
export interface Parsed { host: string; repo: string; ssh: boolean; base?: string }
export interface Found {
  remote: string; url: string; host: string; repo: string;
  /** null: the forge is not supported yet (GitLab, unknown, unreachable). */
  provider: 'github' | 'forgejo' | null;
  /** Forgejo answered 401/403 or sent us to a login page: probably Forgejo, a token is needed. */
  signIn?: boolean; note: string; link?: ForgeLink;
}
export interface Detected { found: Found[]; reason?: string }

type Run = (bin: string, args: string[]) => Promise<string>;
const run: Run = (bin, args) => new Promise((resolve, reject) =>
  execFile(bin, args, { timeout: 5000 }, (err, out, errOut) => (err ? reject(new Error(String(errOut || err.message).trim())) : resolve(out))));

/** `git remote -v` output -> one entry per remote (fetch URL), in git's order. */
export function parseRemotes(out: string): Remote[] {
  const seen = new Map<string, string>();
  for (const line of out.split('\n')) {
    const m = /^(\S+)\s+(\S+)(?:\s+\((fetch|push)\))?$/.exec(line.trim());
    if (m && !seen.has(m[1])) seen.set(m[1], m[2]);
  }
  return [...seen].map(([name, url]) => ({ name, url }));
}

/** https://host[:port]/owner/repo(.git), ssh://[user@]host[:port]/owner/repo.git, [user@]host:owner/repo.git.
 *  Nested groups keep their full path (group/sub/repo). base is the web origin for http(s) remotes. */
export function parseRemoteUrl(raw: string): Parsed | null {
  const s = raw.trim();
  let host: string, path: string, ssh = false, base: string | undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    let u: URL;
    try { u = new URL(s); } catch { return null; }
    const scheme = u.protocol.replace(/:$/, '').toLowerCase();
    if (scheme === 'https' || scheme === 'http') base = `${scheme}://${u.host.toLowerCase()}`;
    else if (scheme === 'ssh' || scheme === 'git+ssh' || scheme === 'ssh+git') ssh = true;
    else return null; // file://, git:// and others have no forge API behind them
    host = u.hostname.toLowerCase();
    path = decodeURIComponent(u.pathname);
  } else {
    const m = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(s); // scp-like; a bare path or C:\ is not
    if (!m) return null;
    [host, path, ssh] = [m[1].toLowerCase(), m[2], true];
  }
  const repo = path.replace(/^\/+|\/+$/g, '').replace(/^~[^/]*\//, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  if (!host || !/^[^/]+(\/[^/]+)+$/.test(repo)) return null;
  return { host, repo, ssh, base };
}

/** The real host behind an ssh alias, from `ssh -G <alias>` (prints the resolved config; never connects). */
export async function sshHost(alias: string, exec: Run = run): Promise<string> {
  if (!/^[\w.-]+$/.test(alias)) return alias;
  try {
    const m = /^hostname\s+(\S+)/m.exec(await exec('ssh', ['-G', alias]));
    return m ? m[1].toLowerCase() : alias;
  } catch { return alias; }
}

const GITHUB = new Set(['github.com', 'www.github.com', 'ssh.github.com']);

/** Decides the provider for a host. GitHub by name; anything else is asked for /api/v1/version without credentials. */
export async function decide(host: string, base: string, f: typeof fetch = fetch): Promise<Pick<Found, 'provider' | 'signIn' | 'note'> & { base: string }> {
  if (GITHUB.has(host)) return { provider: 'github', note: 'GitHub', base: 'https://github.com' };
  const get = (url: string) => f(url, { redirect: 'manual', headers: { accept: 'application/json', 'user-agent': 'MyIDE' }, signal: AbortSignal.timeout(5000) });
  if (host.endsWith('.github.com')) { // GitHub Enterprise under github.com: only when its API answers
    try { if ((await get(`${base}/api/v3/meta`)).ok) return { provider: 'github', note: 'GitHub Enterprise', base: `${base}/api/v3` }; } catch { /* unreachable */ }
    return { provider: null, note: `${host} did not answer as GitHub Enterprise`, base };
  }
  let res: Response;
  try { res = await get(`${base}/api/v1/version`); } catch (e) {
    return { provider: null, note: `${host} did not answer (${(e as Error).name === 'TimeoutError' ? 'no answer in 5 s' : (e as { cause?: { code?: string } }).cause?.code ?? (e as Error).message})`, base };
  }
  const where = res.headers.get('location') ?? '';
  if (res.status === 200) {
    const v = await res.json().catch(() => null) as { version?: unknown } | null;
    if (typeof v?.version === 'string') return { provider: 'forgejo', note: `Forgejo ${v.version}`, base };
  } else if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400 && /login|sign_in|signin|cloudflareaccess|\/cdn-cgi\/access/i.test(where))) {
    return { provider: 'forgejo', signIn: true, note: 'Forgejo (probably; sign-in required)', base };
  }
  return { provider: null, note: /gitlab/i.test(host) ? 'GitLab: not supported yet' : 'not supported yet', base };
}

/** Every remote of `dir`, origin first, each with its forge decided. reason says why there are none. */
export async function detect(dir: string, exec: Run = run, f: typeof fetch = fetch): Promise<Detected> {
  let out: string;
  try { out = await exec('git', ['-C', dir, 'remote', '-v']); } catch (e) {
    return { found: [], reason: /not a git repository/i.test((e as Error).message) ? 'This folder is not a git repository.' : `git remote failed: ${(e as Error).message}` };
  }
  const remotes = parseRemotes(out).sort((a, b) => Number(b.name === 'origin') - Number(a.name === 'origin'));
  if (!remotes.length) return { found: [], reason: 'This repository has no remotes.' };
  const found = await Promise.all(remotes.map(async (r): Promise<Found | null> => {
    const p = parseRemoteUrl(r.url);
    if (!p) return null;
    const host = p.ssh ? await sshHost(p.host, exec) : p.host;
    const d = await decide(host, p.base && !p.ssh ? p.base : `https://${host}`, f);
    const shown = new URL(d.base).host; // the web host, with its port
    const link: ForgeLink | undefined = !d.provider ? undefined
      : d.provider === 'github' ? { provider: 'github', repo: p.repo, urls: d.base === 'https://github.com' ? [] : [d.base] }
      : { provider: 'forgejo', repo: p.repo, urls: [d.base] };
    // The forge form takes owner/name only; a nested GitLab-style path cannot be linked.
    if (link && !/^[\w.-]+\/[\w.-]+$/.test(p.repo)) return { remote: r.name, url: r.url, host: shown, repo: p.repo, provider: null, note: `${d.note}: nested repo paths are not supported yet` };
    return { remote: r.name, url: r.url, host: shown, repo: p.repo, provider: d.provider, signIn: d.signIn, note: d.note, link };
  }));
  const ok = found.filter((x): x is Found => !!x);
  return ok.length ? { found: ok } : { found: [], reason: 'No remote URL points at a forge MyIDE can read.' };
}
