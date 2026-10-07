// Project tab order and open/closed state, with no Electron or DOM, so scripts/check-tabs.mjs runs it in
// plain node. The order is the projects array in config.json; `closed` is when the tab was closed.
export type Tab = { id: string; closed?: number };

export const openTabs = <T extends Tab>(ps: T[]): T[] => ps.filter((p) => !p.closed);

/** Moves `id` to just before `before` (null: the end) in the full list, closed ones included. */
export function moveBefore<T extends Tab>(ps: T[], id: string, before: string | null): T[] {
  const p = ps.find((x) => x.id === id);
  if (!p || id === before) return ps;
  const rest = ps.filter((x) => x.id !== id);
  const i = before === null ? -1 : rest.findIndex((x) => x.id === before);
  return i < 0 ? [...rest, p] : [...rest.slice(0, i), p, ...rest.slice(i)];
}

/** Moves an open tab `delta` places among the open tabs (Alt+Left/Right), clamped at the ends. */
export function moveBy<T extends Tab>(ps: T[], id: string, delta: number): T[] {
  const open = openTabs(ps);
  const i = open.findIndex((x) => x.id === id);
  const j = Math.max(0, Math.min(open.length - 1, i + delta));
  if (i < 0 || i === j) return ps;
  return moveBefore(ps, id, j > i ? (open[j + 1]?.id ?? null) : open[j].id);
}

/** Closes (stamped with `now`) or reopens one tab. */
export const setClosed = <T extends Tab>(ps: T[], id: string, closed: boolean, now = Date.now()): T[] =>
  ps.map((p) => (p.id !== id ? p : closed ? { ...p, closed: now } : (({ closed: _, ...rest }) => rest as T)(p)));

/** The most recently closed project, for Reopen Closed Project. */
export const lastClosed = <T extends Tab>(ps: T[]): T | undefined =>
  ps.filter((p) => p.closed).sort((a, b) => b.closed! - a.closed!)[0];

/** The open tab to show after closing `id`: the one to its right, else the one to its left, else none. */
export function neighbour<T extends Tab>(ps: T[], id: string): T | null {
  const open = openTabs(ps);
  const i = open.findIndex((x) => x.id === id);
  return open[i + 1] ?? open[i - 1] ?? null;
}

/** A new order from the renderer is used only if it is the same projects, each once. */
export const sameIds = (ps: Tab[], ids: unknown): ids is string[] =>
  Array.isArray(ids) && ids.length === ps.length && new Set(ids).size === ids.length && ps.every((p) => ids.includes(p.id));
