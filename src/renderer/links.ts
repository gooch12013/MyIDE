// file:line references in terminal output and employee messages: `src/foo.ts:12`, `/abs/x.rs:3:7`, `../a.py:9`.
// Pure, so scripts/check-links.mjs runs it under node. Whether a match is a real, openable file is asked of main.

export interface FileRef { start: number; end: number; path: string; line: number }

// A path without spaces whose last part has an extension, then :line and an optional :column.
// Not inside a longer word or path (so a URL's host:port never starts a match mid-way).
const RE = /(?<![\w./~@+-])((?:\.{1,2}\/|\/)?[\w@.+-]+(?:\/[\w@.+-]+)*\.[A-Za-z0-9]+):(\d+)(?::\d+)?/g;

export function fileRefs(text: string): FileRef[] {
  return [...text.matchAll(RE)].map((m) => ({ start: m.index!, end: m.index! + m[0].length, path: m[1], line: Number(m[2]) }));
}

/** `p` made absolute against `cwd`, with `.` and `..` folded. */
export function resolvePath(cwd: string, p: string): string {
  const out: string[] = [];
  for (const part of (p.startsWith('/') ? p : `${cwd}/${p}`).split('/')) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return `/${out.join('/')}`;
}
