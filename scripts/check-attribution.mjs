// Checks stripAttribution() and the commit-msg hook that uses the same pattern list.
// Usage: node scripts/check-attribution.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installHooks, stripAttribution } from '../src/main/attribution.ts';

const msg = 'Fix the thing\n\nBody line.\n\nCo-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/x\n';
const pr = 'Summary\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n';
assert.equal(stripAttribution(msg), 'Fix the thing\n\nBody line.\n');
assert.equal(stripAttribution(pr), 'Summary\n');
assert.equal(stripAttribution('Co-authored-by: Ann <a@b.c>\n'), 'Co-authored-by: Ann <a@b.c>\n'); // people stay

const dir = mkdtempSync(join(tmpdir(), 'myide-hook-'));
try {
  installHooks('build/hooks/commit-msg', dir);
  const file = join(dir, 'MSG');
  writeFileSync(file, msg);
  execFileSync(join(dir, 'commit-msg'), [file], { cwd: dir });
  assert.equal(readFileSync(file, 'utf8'), stripAttribution(msg));
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log('attribution ok');
