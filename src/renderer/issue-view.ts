// The Issues panel's filter, sort, group and custom order: pure functions over plain rows, so
// scripts/check-issue-view.mjs can test them without a DOM. Saved per project as issues-view.json.

export type Sort = 'updated' | 'created' | 'number' | 'title' | 'comments' | 'custom';
export type Group = 'none' | 'label' | 'state' | 'employee';
export interface View {
  q: string; state: 'open' | 'closed' | 'all'; labels: string[];
  who: string; // '' anyone, 'me', 'none' (unassigned), or a login
  emp: '' | 'yes' | 'no'; pr: '' | 'yes' | 'no';
  sort: Sort; desc: boolean; group: Group;
  order: string[]; // custom order, by row key (the issue number; "project#number" in the all-projects view)
  collapsed: string[]; // collapsed group names
}
export interface Row {
  key: string; number: number; title: string; body: string; labels: string[]; state: string; assignees: string[];
  updatedAt: string; createdAt: string; comments: number; me?: string; employee?: string; pr: boolean;
}

export const DEFAULT_VIEW: View = { q: '', state: 'open', labels: [], who: '', emp: '', pr: '', sort: 'updated', desc: true, group: 'none', order: [], collapsed: [] };
export const SORTS: Sort[] = ['updated', 'created', 'number', 'title', 'comments', 'custom'];
export const GROUPS: Group[] = ['none', 'label', 'state', 'employee'];

const pick = <T>(v: unknown, ok: readonly T[], d: T): T => (ok.includes(v as T) ? (v as T) : d);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

/** A saved view, checked field by field; anything missing or wrong falls back to the default. */
export function viewOf(raw: unknown): View {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_VIEW;
  return {
    q: typeof r.q === 'string' ? r.q : d.q,
    state: pick(r.state, ['open', 'closed', 'all'] as const, d.state),
    labels: strs(r.labels), who: typeof r.who === 'string' ? r.who : d.who,
    emp: pick(r.emp, ['', 'yes', 'no'] as const, d.emp), pr: pick(r.pr, ['', 'yes', 'no'] as const, d.pr),
    sort: pick(r.sort, SORTS, d.sort), desc: typeof r.desc === 'boolean' ? r.desc : d.desc,
    group: pick(r.group, GROUPS, d.group), order: strs(r.order), collapsed: strs(r.collapsed),
  };
}

export function matches(v: View, r: Row): boolean {
  const q = v.q.trim().toLowerCase().replace(/^#(?=\d+$)/, '');
  return (v.state === 'all' || r.state === v.state)
    && v.labels.every((l) => r.labels.includes(l))
    && (!v.who || (v.who === 'me' ? !!r.me && r.assignees.includes(r.me) : v.who === 'none' ? !r.assignees.length : r.assignees.includes(v.who)))
    && (!v.emp || (v.emp === 'yes') === !!r.employee)
    && (!v.pr || (v.pr === 'yes') === r.pr)
    && (!q || String(r.number) === q || [r.title, r.body, ...r.labels].some((t) => t.toLowerCase().includes(q)));
}

/** The saved custom order with rows it has never seen on top, newest first. */
export function fullOrder(order: string[], rows: Row[]): string[] {
  const seen = new Set(order);
  const fresh = rows.filter((r) => !seen.has(r.key)).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.number - a.number);
  return [...fresh.map((r) => r.key), ...order];
}

/** `key` moved to just before (or after) `target`. */
export function move(order: string[], key: string, target: string, after = false): string[] {
  if (key === target) return order;
  const out = order.filter((k) => k !== key);
  const i = out.indexOf(target);
  if (i < 0) return order;
  out.splice(after ? i + 1 : i, 0, key);
  return out;
}

const by: Record<Exclude<Sort, 'custom'>, (a: Row, b: Row) => number> = {
  updated: (a, b) => a.updatedAt.localeCompare(b.updatedAt),
  created: (a, b) => a.createdAt.localeCompare(b.createdAt),
  number: (a, b) => a.number - b.number,
  title: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true }),
  comments: (a, b) => a.comments - b.comments,
};

/** Filtered and sorted rows. Custom order ignores `desc`. */
export function arrange(v: View, rows: Row[]): Row[] {
  const shown = rows.filter((r) => matches(v, r));
  if (v.sort === 'custom') {
    const at = new Map(fullOrder(v.order, rows).map((k, i) => [k, i]));
    return shown.sort((a, b) => at.get(a.key)! - at.get(b.key)!);
  }
  const f = by[v.sort];
  return shown.sort((a, b) => (v.desc ? -1 : 1) * (f(a, b) || a.number - b.number));
}

// ponytail: an issue with several labels groups under its first one; show it in every label group if that is wanted.
const groupName = (g: Group, r: Row): string =>
  g === 'label' ? r.labels[0] ?? 'No label' : g === 'state' ? r.state : g === 'employee' ? r.employee ?? 'No employee' : '';

/** Arranged rows split into groups, in order of first appearance (rows keep their arranged order inside each). */
export function grouped(v: View, rows: Row[]): { name: string; rows: Row[] }[] {
  const out = new Map<string, Row[]>();
  for (const r of arrange(v, rows)) {
    const n = groupName(v.group, r);
    out.set(n, [...(out.get(n) ?? []), r]);
  }
  return [...out].map(([name, rows]) => ({ name, rows }));
}
