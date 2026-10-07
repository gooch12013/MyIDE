import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Lines that mark text as AI-written, anchored so people and prose stay: the Claude trailer by its
// address, the Claude Code footer by its robot or its link, and the session line. Each pattern works
// both as a JS RegExp (flag i) and as a grep -E pattern, so the commit-msg hook reads this same list.
export const ATTRIBUTION = [
  '^ *Co-Authored-By:.*<noreply@anthropic\\.com>',
  '^ *(🤖 *)?Generated with \\[Claude Code\\]\\(',
  '^ *🤖 *Generated with Claude Code',
  '^ *Claude-Session:',
  // Codex (strings in codex-cli 0.157.1): its trailer by address, and its footer.
  '^ *Co-Authored-By:.*<noreply@openai\\.com>',
  '^ *(🤖 *)?Generated with \\[Codex\\]\\(',
  '^ *(🤖 *)?Generated with Codex\\.? *$',
];
const res = ATTRIBUTION.map((p) => new RegExp(p, 'i'));

/** Drops attribution lines and the blank lines they leave at the end. */
export function stripAttribution(text: string): string {
  const kept = text.split('\n').filter((l) => !res.some((r) => r.test(l)));
  return kept.join('\n').replace(/\s+$/, '') + (text.endsWith('\n') ? '\n' : '');
}

// Every client-side hook git runs; each chains to the repository's own hook of the same name.
const HOOKS = ['applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg',
  'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout', 'post-merge', 'pre-push', 'post-rewrite', 'reference-transaction',
  'push-to-checkout', 'pre-auto-gc', 'post-index-change', 'sendemail-validate'];

/** Installs the chaining hook under every hook name, plus its pattern list, into `hooksDir`. `hookSrc` is the shipped script. */
export function installHooks(hookSrc: string, hooksDir: string): void {
  mkdirSync(hooksDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(hooksDir, 'attribution-patterns'), ATTRIBUTION.join('\n') + '\n', { mode: 0o600 });
  for (const name of HOOKS) {
    copyFileSync(hookSrc, join(hooksDir, name));
    chmodSync(join(hooksDir, name), 0o700);
  }
}
