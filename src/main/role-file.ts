// The role wizard's pure part: the AI's JSON reply, a role draft, its checks, and the role file it becomes.
// No Node or Electron imports: the renderer uses it for the live preview, main for saving, scripts/check-roles.mjs for tests.

export type RoleMode = 'pinned' | 'manager' | 'auto';
export interface Settings {
  provider: string; account: string; model: string; effort?: string; mode: RoleMode;
  lead: boolean; maxReports?: number; shared: boolean; readOnly: boolean; maxTurns?: number;
}
export interface Draft extends Settings {
  name: string; description: string; body: string; rules: string[]; firstTask?: string;
  /** Only ever from a role file on disk (never the AI, never IPC): keys the wizard does not edit (tools, color, myide-add-dir...)
   *  as their raw text after the colon, re-emitted verbatim; and the file's own name and model, kept as written while unchanged. */
  extra?: Record<string, string>;
  orig?: { name?: string; model?: string };
}
export interface WizardCtx {
  providers: Record<string, { label: string; models: string[][]; efforts: string[][] }>;
  accounts: { id: string; name: string; provider: string; allowAuto: boolean }[];
  installed: Record<string, boolean>;
}
export type Question = { q: string; choices?: string[]; multi?: boolean };
export interface Reply { ask: Question[]; settings?: Partial<Settings>; draft?: Draft }
/** A role file the wizard cannot rewrite without losing something: nested or list values, block scalars, empty values. */
export const ADVANCED = 'This role uses advanced frontmatter; edit the file by hand.';

const MODES: RoleMode[] = ['pinned', 'manager', 'auto'];
const KNOWN = ['name', 'description', 'model', 'effort', 'myide-mode', 'myide-account', 'myide-lead', 'myide-max-reports', 'myide-shared', 'myide-max-turns', 'myide-readonly'];
export const slugName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const int = (v: unknown, lo: number, hi: number): number | undefined => {
  const n = Number(v);
  return v !== null && v !== '' && Number.isInteger(n) && n >= lo && n <= hi ? n : undefined;
};
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const yes = (v: unknown): boolean => v === true || v === 'true';
const models = (ctx: WizardCtx, p: string) => (ctx.providers[p]?.models ?? []).map(([m]) => m);
export const efforts = (ctx: WizardCtx, p: string, model: string): string[] => (/haiku/i.test(model) ? [] : (ctx.providers[p]?.efforts ?? []).map(([e]) => e));
const modelOk = (ctx: WizardCtx, p: string, m: string) => models(ctx, p).includes(m) || (p === 'claude' && /^claude-[\w.-]+$/.test(m));
const oneLine = (v: string) => v.replace(/[\r\n]+/g, ' ');

/** A markdown file's frontmatter as flat `key: value` strings (quotes stripped); {} if it has none. */
export function parseFrontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return Object.fromEntries((m?.[1] ?? '').split('\n').map((l) => /^([\w-]+):\s*(.*)$/.exec(l)).filter((x) => !!x).map((x) => [x![1], x![2].trim().replace(/^(['"])(.*)\1$/, '$2')]));
}

/** The last ```json block in the AI's text, or else its last {...}; undefined if none parses. */
export function extractJson(text: string): any {
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const end = text.lastIndexOf('}') + 1;
  // ponytail: tries each '{' to the last '}' in turn: quadratic in the worst case, fine for a chat reply.
  const bare = [...text.matchAll(/\{/g)].map((m) => text.slice(m.index, end));
  for (const t of [...blocks.reverse(), ...bare]) {
    try { const j = JSON.parse(t); if (j && typeof j === 'object') return j; } catch { /* next */ }
  }
  return undefined;
}

/** The AI's text without its JSON block: what David reads. */
export const prose = (text: string): string => text.replace(/```(?:json)?\s*\n[\s\S]*?```/g, '').trim();

/** Settings with every value one MyIDE can use: the account decides the provider, a model the provider lacks falls back. */
export function settingsOf(raw: any, ctx: WizardCtx, base?: Settings): Settings {
  const r = { ...base, ...Object.fromEntries(Object.entries(raw ?? {}).filter(([, v]) => v !== undefined)) } as any;
  let acct = ctx.accounts.find((a) => a.id === r.account);
  const wanted = str(r.provider) in ctx.providers ? str(r.provider) : acct?.provider ?? 'claude';
  if (!acct || acct.provider !== wanted) acct = ctx.accounts.find((a) => a.provider === wanted) ?? acct ?? ctx.accounts[0];
  const provider = acct?.provider ?? wanted;
  const m = str(r.model);
  const model = modelOk(ctx, provider, m) || (m && m === r.orig?.model) ? m : provider === 'claude' ? 'sonnet' : models(ctx, provider)[0] ?? '';
  const lead = yes(r.lead);
  return {
    provider, account: acct?.id ?? '', model, effort: efforts(ctx, provider, model).includes(str(r.effort)) ? str(r.effort) : undefined,
    mode: MODES.includes(r.mode) ? r.mode : 'pinned', lead, maxReports: lead ? int(r.maxReports, 1, 20) ?? 3 : undefined,
    shared: yes(r.shared), readOnly: yes(r.readOnly), maxTurns: int(r.maxTurns, 1, 1000),
  };
}

/** A draft from the AI's JSON (or the review form), coerced to valid types. `extra` and `orig` pass through: callers decide where they come from. */
export function draftOf(raw: any, ctx: WizardCtx, base?: Settings): Draft {
  const rules = (Array.isArray(raw?.rules) ? raw.rules : str(raw?.rules).split('\n')).map((x: unknown) => oneLine(str(x).replace(/^[-*]\s*/, ''))).filter(Boolean);
  const orig = raw?.orig && typeof raw.orig === 'object' ? { name: str(raw.orig.name) || undefined, model: str(raw.orig.model) || undefined } : undefined;
  const name = str(raw?.name);
  return {
    ...settingsOf({ ...raw, orig }, ctx, base), name: name && name === orig?.name && /^\w[\w.-]*$/.test(name) ? name : slugName(name),
    description: str(raw?.description).replace(/\s+/g, ' '), body: str(raw?.body), rules,
    firstTask: str(raw?.firstTask) || undefined, extra: raw?.extra && typeof raw.extra === 'object' ? raw.extra : undefined, orig,
  };
}

/** The AI's reply: its questions (at most two), its suggested settings, and a draft once it has one. */
export function replyOf(text: string, ctx: WizardCtx): Reply | undefined {
  const j = extractJson(text);
  if (!j) return undefined;
  const ask = (Array.isArray(j.ask) ? j.ask : []).slice(0, 2).map((q: any) => ({
    q: str(q?.q), choices: Array.isArray(q?.choices) ? q.choices.map(str).filter(Boolean).slice(0, 8) : undefined, multi: q?.multi === true,
  })).filter((q: Question) => q.q);
  // The AI never sets frontmatter of its own: no extra keys, no kept originals.
  const draft = j.draft && typeof j.draft === 'object' && str(j.draft.body) ? draftOf({ ...j.draft, extra: undefined, orig: undefined }, ctx) : undefined;
  return { ask, settings: j.settings && typeof j.settings === 'object' ? j.settings : undefined, draft };
}

/** What stops a save (errors) and what David should know (warnings). `taken`: role names that exist where it is saved, minus the one being edited. */
export function check(d: Draft, ctx: WizardCtx, taken: string[] = []): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const p = ctx.providers[d.provider];
  const a = ctx.accounts.find((x) => x.id === d.account);
  if (!d.name) errors.push('Give the role a name.');
  else if (taken.includes(d.name)) errors.push(`A role named ${d.name} already exists there. Pick another name, or edit that role instead.`);
  if (!d.description) errors.push('Add a one-line description: when to hire this role.');
  if (!d.body) errors.push('The job description is empty.');
  if (!p) errors.push(`Unknown AI: ${d.provider}.`);
  else {
    if (!ctx.installed[d.provider]) errors.push(`${p.label} is not installed on this Mac.`);
    if (!modelOk(ctx, d.provider, d.model) && d.model !== d.orig?.model) errors.push(`${d.model || 'No model'} is not a ${p.label} model.`);
    if (d.effort && !efforts(ctx, d.provider, d.model).includes(d.effort)) errors.push(`${p.label} ${d.model} has no effort ${d.effort}.`);
  }
  if (!a) errors.push('Pick an AI account.');
  else if (a.provider !== d.provider) errors.push(`${a.name} is not a ${p?.label ?? d.provider} account.`);
  else if (!a.allowAuto) warnings.push(`${a.name} does not allow automatic use, so a lead hiring this role puts it on the lead's own account.`);
  if (d.readOnly && d.provider !== 'claude') warnings.push('Read-only is enforced for Claude only; on other AIs it rests on the rules in the role.');
  return { errors, warnings };
}

const q = (s: string) => `"${oneLine(s).replace(/\\/g, '/').replace(/"/g, "'")}"`;

/** The role file: frontmatter MyIDE and Claude Code read, then the job, then the rules. */
export function renderRole(d: Draft): string {
  const fm: [string, string | number | undefined][] = [
    ['name', d.name], ['description', q(d.description)], ['model', d.model], ['effort', d.effort],
    ['myide-mode', d.mode === 'pinned' ? undefined : d.mode], ['myide-account', d.account === 'claude-default' ? undefined : d.account],
    ['myide-lead', d.lead ? 'true' : undefined], ['myide-max-reports', d.lead ? d.maxReports : undefined],
    ['myide-shared', d.shared ? 'true' : undefined], ['myide-max-turns', d.maxTurns], ['myide-readonly', d.readOnly ? 'true' : undefined],
  ];
  const head = [...fm.filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}: ${oneLine(String(v))}`),
    // extra values are the raw text after the colon, so they go back exactly as written
    ...Object.entries(d.extra ?? {}).filter(([k, v]) => /^[\w-]+$/.test(k) && !KNOWN.includes(k) && typeof v === 'string').map(([k, v]) => `${k}:${oneLine(v)}`)].join('\n');
  const rules = d.rules.length ? `\n\n## Rules\n\n${d.rules.map((r) => `- ${r}`).join('\n')}` : '';
  return `---\n${head}\n---\n\n${d.body.trim()}${rules}\n`;
}

/** A role file back into a draft (for editing): its own rules section split out, unknown keys kept verbatim in extra.
 *  Throws ADVANCED for frontmatter the flat key: value form cannot carry back unchanged. */
export function parseRoleText(text: string, ctx: WizardCtx): Draft {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const raw = (m?.[1] ?? '').split(/\r?\n/).filter((l) => l.trim()).map((l) => /^([\w-]+):(.*)$/.exec(l));
  if (raw.some((x) => !x || !x[2].trim() || /^\s*[>|]/.test(x[2])) || new Set(raw.map((x) => x?.[1])).size < raw.length) throw new Error(ADVANCED);
  const f = parseFrontmatter(text);
  let body = text.slice(m?.[0].length ?? 0).trim();
  let rules: string[] = [];
  const r = /\n*## Rules\n+((?:[-*] .*(?:\n|$))+)\s*$/.exec(body);
  if (r) { rules = r[1].split('\n').map((l) => l.replace(/^[-*]\s*/, '').trim()).filter(Boolean); body = body.slice(0, r.index).trim(); }
  const account = f['myide-account'] || 'claude-default';
  return draftOf({
    name: f.name, description: f.description, body, rules, model: f.model, effort: f.effort, orig: { name: f.name, model: f.model },
    mode: f['myide-mode'], account, provider: ctx.accounts.find((a) => a.id === account)?.provider, lead: f['myide-lead'], maxReports: f['myide-max-reports'],
    shared: f['myide-shared'], maxTurns: f['myide-max-turns'], readOnly: f['myide-readonly'],
    extra: Object.fromEntries(raw.filter((x) => !KNOWN.includes(x![1])).map((x) => [x![1], x![2]])),
  }, ctx);
}
