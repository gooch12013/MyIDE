import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Lines that mark text as AI-written. Each pattern works both as a JS RegExp (flag i) and as a
// grep -E pattern, so the commit-msg hook reads this same list from the patterns file.
export const ATTRIBUTION = [
  '^ *Co-Authored-By: *Claude',
  'Generated with \\[?Claude Code',
  '^ *Claude-Session:',
];
const res = ATTRIBUTION.map((p) => new RegExp(p, 'i'));

/** Drops attribution lines and the blank lines they leave at the end. */
export function stripAttribution(text: string): string {
  const kept = text.split('\n').filter((l) => !res.some((r) => r.test(l)));
  return kept.join('\n').replace(/\s+$/, '') + (text.endsWith('\n') ? '\n' : '');
}

/** Installs the commit-msg hook and its pattern list into `hooksDir`. `hookSrc` is the shipped hook file. */
export function installHooks(hookSrc: string, hooksDir: string): void {
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(join(hooksDir, 'attribution-patterns'), ATTRIBUTION.join('\n') + '\n');
  copyFileSync(hookSrc, join(hooksDir, 'commit-msg'));
  chmodSync(join(hooksDir, 'commit-msg'), 0o755);
}
