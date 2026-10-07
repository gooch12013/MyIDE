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

const MODELS = ['haiku', 'sonnet', 'opus'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const rank = (list: string[], v?: string) => list.findIndex((x) => v?.toLowerCase().includes(x));

/** Auto mode: the first rule with a keyword at a word start in the task wins.
 *  ponytail: keyword table; misroutes vague tasks. A one-shot Haiku classifier if that shows up. */
export function autoPick(task: string, rules: AutoRule[] = DEFAULT_AUTO.rules, fallback = DEFAULT_AUTO.fallback): Pick {
  for (const r of rules) {
    if (r.match.some((k) => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(task))) return { model: r.model, effort: r.effort };
  }
  return { model: fallback };
}

/** True when `want` is a stronger model than `ceiling`, or the same model at a higher effort. Unknown names never count as above. */
export function aboveCeiling(want: Pick, ceiling?: Pick): boolean {
  if (!ceiling?.model) return false;
  const w = rank(MODELS, want.model), c = rank(MODELS, ceiling.model);
  if (w < 0 || c < 0) return false;
  if (w !== c) return w > c;
  return !!ceiling.effort && rank(EFFORTS, want.effort) > rank(EFFORTS, ceiling.effort);
}

/** Layered defaults: role frontmatter, then the project's override, then what this hire asked for. */
export function layered<T extends object>(...layers: (Partial<T> | undefined)[]): Partial<T> {
  const out: Partial<T> = {};
  for (const l of layers) for (const [k, v] of Object.entries(l ?? {})) if (v !== undefined && v !== '') (out as any)[k] = v;
  return out;
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
