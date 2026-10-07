// Checks stripAttribution() and the chaining hooks that use the same pattern list.
// Usage: node scripts/check-attribution.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installHooks, stripAttribution } from '../src/main/attribution.ts';

const msg = 'Fix the thing\n\nBody line.\n\nCo-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/x\n';
const pr = 'Summary\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n';
const human = 'Fix\n\nCo-Authored-By: Claude Dupont <cd@example.fr>\n';
const prose = 'Fix\n\nTests generated with Claude Code fixtures are flaky\n';
assert.equal(stripAttribution(msg), 'Fix the thing\n\nBody line.\n');
assert.equal(stripAttribution(pr), 'Summary\n');
assert.equal(stripAttribution('Summary\n\nGenerated with [Claude Code](https://claude.com/claude-code)\n'), 'Summary\n');
assert.equal(stripAttribution('Co-authored-by: Ann <a@b.c>\n'), 'Co-authored-by: Ann <a@b.c>\n'); // people stay
assert.equal(stripAttribution(human), human);
assert.equal(stripAttribution(prose), prose);
const codex = 'Fix\n\nCo-authored-by: Codex <noreply@openai.com>\n';
const codexPr = 'Summary\n\nGenerated with [Codex](https://openai.com/codex/).\nGenerated with Codex.\n';
const codexProse = 'Fix\n\nGenerated with Codex fixtures, see notes\n';
assert.equal(stripAttribution(codex), 'Fix\n');
assert.equal(stripAttribution(codexPr), 'Summary\n');
assert.equal(stripAttribution(codexProse), codexProse);

const dir = mkdtempSync(join(tmpdir(), 'myide-hook-'));
try {
  installHooks('build/hooks/chain', dir);
  const file = join(dir, 'MSG');
  const hook = (text) => { writeFileSync(file, text); execFileSync(join(dir, 'commit-msg'), [file], { cwd: dir }); return readFileSync(file, 'utf8'); };
  for (const t of [msg, pr, human, prose, codex, codexPr, codexProse]) assert.equal(hook(t), stripAttribution(t));
  rmSync(join(dir, 'attribution-patterns'));
  assert.equal(hook(msg), msg); // no patterns: the message is left alone
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log('attribution ok');
