// Org rules with no Electron or file access, so scripts/check-org.mjs can run them in plain node
// and the renderer can share rollup(). employees.ts feeds them its live state.

export type Mode = 'pinned' | 'manager' | 'auto';
export type Pick = { model: string; effort?: string };
export type AutoRule = { match: string[]; model: string; effort?: string };
export type Usage = { fiveHour?: number; sevenDay?: number; resetsAt?: string; at?: number };

export const DEFAULT_AUTO: { rules: AutoRule[]; fallback: string } = {
  rules: [
    { match: ['lint', 'rename', 'format'], model: 'haiku' },
    { match: ['architecture', 'design', 'plan'], model: 'opus' },
  ],
  fallback: 'sonnet',
};
/** Above this five-hour utilization (0 to 1) an account's cap drops by one. */
export const SLOW_AT = 0.8;

/** Auto mode: the first rule with a keyword at a word start in the task wins.
 *  ponytail: keyword table; misroutes vague tasks. A one-shot Haiku classifier if that shows up. */
export function autoPick(task: string, rules: AutoRule[] = DEFAULT_AUTO.rules, fallback = DEFAULT_AUTO.fallback): Pick {
  for (const r of rules) {
    if (r.match.some((k) => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(task))) return { model: r.model, effort: r.effort };
  }
  return { model: fallback };
}

/** The CLIs' own effort when none is passed (spike B: medium). */
export const DEFAULT_EFFORT = 'medium';

/** Position of `v` in `list`: exact first, else the first entry it contains (a full id like claude-opus-4-1 is opus). */
const rank = (list: string[], v?: string) => {
  const i = list.findIndex((x) => x === v);
  return i >= 0 ? i : list.findIndex((x) => !!v && v.toLowerCase().includes(x));
};

/** True when `want` is above `ceiling`: a stronger model, or the same model at a higher effort. `models` is the
 *  provider's list strongest first, `efforts` lowest first (providers.json order). A model not in the list counts
 *  as above, on either side; a missing effort is the CLI default; a provider with no efforts compares models only. */
export function aboveCeiling(want: Pick, ceiling: Pick | undefined, models: string[], efforts: string[]): boolean {
  if (!ceiling?.model) return false;
  const w = rank(models, want.model), c = rank(models, ceiling.model);
  if (w < 0 || c < 0) return true;
  if (w !== c) return w < c;
  if (!efforts.length) return false; // the provider has no effort setting (Gemini): same model, nothing above
  const we = rank(efforts, want.effort || DEFAULT_EFFORT), ce = rank(efforts, ceiling.effort || DEFAULT_EFFORT);
  return we < 0 || ce < 0 || we > ce;
}

export interface QItem { id: string; projectId: string; accountId: string; parentId?: string; queuedAt?: number }
export interface Limits {
  global: number;
  perProject: number;
  account(id: string): number;
  maxReports(leadId: string): number;
  paused(projectId: string): boolean;
  priority(projectId: string): number;
}

/** Which waiting turns start now: highest project priority first, then oldest. A turn blocked by its
 *  own project, account or lead is skipped, not waited on, so it never holds up the others. */
export function pickStarts(waiting: QItem[], running: QItem[], l: Limits): string[] {
  const run = [...running];
  const count = (f: (r: QItem) => boolean) => run.filter(f).length;
  const out: string[] = [];
  const order = [...waiting].sort((a, b) => l.priority(b.projectId) - l.priority(a.projectId) || (a.queuedAt ?? 0) - (b.queuedAt ?? 0));
  for (const w of order) {
    if (run.length >= l.global) break;
    if (l.paused(w.projectId)) continue;
    if (count((r) => r.projectId === w.projectId) >= l.perProject) continue;
    if (count((r) => r.accountId === w.accountId) >= l.account(w.accountId)) continue;
    if (w.parentId && count((r) => r.parentId === w.parentId) >= l.maxReports(w.parentId)) continue;
    run.push(w);
    out.push(w.id);
  }
  return out;
}

/** An account's cap, one lower once its five-hour window passes SLOW_AT (never below one). */
export function slowedCap(cap: number, u?: Usage): number {
  return u?.fiveHour !== undefined && u.fiveHour >= SLOW_AT ? Math.max(1, cap - 1) : cap;
}

type Node = { id: string; parentId?: string; state: string; progress?: { done: number; total: number } };
/** A lead's status summed over itself and everyone below it: "9 of 14 across 3 reports". */
export function rollup(all: Node[], id: string): { done: number; total: number; reports: number } {
  let done = 0, total = 0, reports = -1;
  const walk = (n: Node) => {
    reports++;
    const p = n.progress;
    if (p?.total) { total += p.total; done += n.state === 'done' ? p.total : Math.min(p.done, p.total); }
    for (const k of all) if (k.parentId === n.id) walk(k);
  };
  const root = all.find((n) => n.id === id);
  if (root) walk(root);
  return { done, total, reports: Math.max(0, reports) };
}

/** Goal mode: automatic "keep going" turns per goal before it goes to David (or its lead). */
export const GOAL_TRIES = 8;
export type GoalStep = { kind: 'done' } | { kind: 'blocked'; why: string } | { kind: 'wait' } | { kind: 'continue' } | { kind: 'exhausted' };
/** After a turn: GOAL DONE or GOAL BLOCKED (capitals, ending one of its last three lines, Markdown marks or a label like
 *  "Status:" allowed) decide; otherwise a lead whose reports are still busy waits for them, and anyone else is sent on
 *  until the tries run out. "Goal done? Not yet" is no marker, and neither is GOAL DONE in the middle of a sentence. */
export function goalStep(text: string, tries: number, reportsBusy: boolean, cap = GOAL_TRIES): GoalStep {
  const tail = text.trim().split('\n').slice(-3).join('\n');
  if (/(^|[^A-Za-z])GOAL DONE[^A-Za-z\n]*$/m.test(tail)) return { kind: 'done' };
  const b = /(^|[^A-Za-z])GOAL BLOCKED\b[*_`]*:?(.*)$/m.exec(tail);
  if (b) return { kind: 'blocked', why: b[2].replace(/^[\s*_`:]+|[\s*_`]+$/g, '') || 'no reason given' };
  if (reportsBusy) return { kind: 'wait' };
  return tries < cap ? { kind: 'continue' } : { kind: 'exhausted' };
}
