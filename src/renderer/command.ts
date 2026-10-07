// Panel scope and the command line's grammar, with no DOM or Electron, so scripts/check-home.mjs runs it in plain node.

export const HOME_ID = 'home';

/** The project a panel shows, or null for all of them. `scope`: 'tab' or missing (the tab's project; on Home, all),
 *  'all', or a project id. `tab`: the shown tab's id, null with no tab open. */
export function resolveScope(scope: unknown, tab: string | null): string | null {
  if (scope === undefined || scope === null || scope === '' || scope === 'tab') return !tab || tab === HOME_ID ? null : tab;
  if (scope === 'all') return null;
  return String(scope);
}

/** A parsed command line. Project and employee are names as typed; the panel resolves them. */
export type Command =
  | { cmd: 'issue'; project?: string; title: string }
  | { cmd: 'todo'; text: string }
  | { cmd: 'assign'; project?: string; employee: string; text: string }
  | { cmd: 'hire'; project?: string; role: string; text: string }
  | { cmd: 'go'; project?: string; employee: string }
  | { cmd: 'pause' | 'resume'; project?: string }
  | { cmd: 'help' };

export const USAGE: Record<string, string> = {
  issue: 'issue <project> "title"',
  todo: 'todo "text" @role',
  assign: 'assign <project>/<employee> "task"',
  hire: 'hire <project> <role> "task"',
  go: 'go <project>/<employee>',
  pause: 'pause <project>',
  resume: 'resume <project>',
  help: 'help',
};

/** Words, with "double" or 'single' quotes keeping spaces; `quoted` marks the ones that were quoted. */
export function tokens(line: string): { text: string; quoted: boolean }[] {
  const out: { text: string; quoted: boolean }[] = [];
  const re = /"([^"]*)"?|'([^']*)'?|(\S+)/g;
  for (let m; (m = re.exec(line));) out.push(m[3] !== undefined ? { text: m[3], quoted: false } : { text: m[1] ?? m[2] ?? '', quoted: true });
  return out;
}

/** "proj/emp" or "emp". */
const who = (s: string): { project?: string; employee: string } => {
  const i = s.indexOf('/');
  return i < 0 ? { employee: s } : { project: s.slice(0, i), employee: s.slice(i + 1) };
};

/** Parses one line. A project may be left out when the panel has one (its scope). */
export function parse(line: string): Command | { error: string } {
  const t = tokens(line.trim());
  if (!t.length) return { error: 'Type a command, or help.' };
  const [head, ...rest] = t;
  const cmd = head.text.toLowerCase();
  const bad = { error: `Usage: ${USAGE[cmd] ?? Object.values(USAGE).join(' · ')}` };
  // The quoted text (or, unquoted, every word left) is the title, task or to-do.
  const textFrom = (i: number) => rest.slice(i).map((x) => x.text).join(' ').trim();
  const firstQuoted = rest.findIndex((x) => x.quoted);
  switch (cmd) {
    case 'help': return { cmd: 'help' };
    case 'issue': {
      const project = firstQuoted === 0 || rest.length < 2 ? undefined : rest[0].text;
      const title = textFrom(project === undefined ? 0 : 1);
      return title ? { cmd: 'issue', project, title } : bad;
    }
    case 'todo': {
      const text = textFrom(0);
      return text ? { cmd: 'todo', text } : bad;
    }
    case 'assign': {
      if (rest.length < 2 || rest[0].quoted) return bad;
      const text = textFrom(1);
      return text ? { cmd: 'assign', ...who(rest[0].text), text } : bad;
    }
    case 'hire': {
      // hire <project> <role> "task", or hire <role> "task" in a project's scope; the task is quoted.
      const words = firstQuoted;
      if (words < 1 || words > 2) return bad;
      const text = textFrom(words);
      if (!text) return bad;
      return words === 2 ? { cmd: 'hire', project: rest[0].text, role: rest[1].text, text } : { cmd: 'hire', role: rest[0].text, text };
    }
    case 'go': return rest.length === 1 ? { cmd: 'go', ...who(rest[0].text) } : bad;
    case 'pause': case 'resume': return rest.length <= 1 ? { cmd, project: rest[0]?.text } : bad;
    default: return { error: `Unknown command "${head.text}". Try: ${Object.keys(USAGE).join(', ')}.` };
  }
}

/** Finds by name (any case), then by id. */
export const byName = <T extends { id: string; name: string }>(list: T[], s: string | undefined): T | undefined =>
  s === undefined ? undefined : list.find((x) => x.name.toLowerCase() === s.toLowerCase()) ?? list.find((x) => x.id === s);

export interface CompleteCtx { projects: string[]; employees: Record<string, string[]>; roles: string[] }

/** Whole-line completions for the word being typed: a command, a project, project/employee, or a role. */
export function complete(line: string, ctx: CompleteCtx): string[] {
  const m = /^(.*?)(\S*)$/.exec(line)!;
  const [before, word] = [m[1], m[2]];
  const prior = tokens(before);
  const lw = word.toLowerCase();
  const pick = (opts: string[]) => opts.filter((o) => o.toLowerCase().startsWith(lw) && o !== word).map((o) => before + o);
  if (!prior.length) return pick(Object.keys(USAGE).map((c) => `${c} `));
  if (word.startsWith('"') || prior.some((x) => x.quoted)) return [];
  const cmd = prior[0].text.toLowerCase();
  const slashed = () => ctx.projects.flatMap((p) => [`${p}/`, ...(ctx.employees[p] ?? []).map((e) => `${p}/${e} `)]);
  if (prior.length === 1) {
    if (cmd === 'assign' || cmd === 'go') return pick(word.includes('/') ? slashed() : ctx.projects.map((p) => `${p}/`));
    if (cmd === 'issue' || cmd === 'hire' || cmd === 'pause' || cmd === 'resume') return pick(ctx.projects.map((p) => `${p} `));
  }
  if (prior.length === 2 && cmd === 'hire') return pick(ctx.roles.map((r) => `${r} `));
  return [];
}
