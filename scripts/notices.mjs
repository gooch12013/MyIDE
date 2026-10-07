// Writes THIRD_PARTY_NOTICES.txt for the production dependency tree of the project in the current
// directory, and exits 1 if any licence is outside the allowlist.
// Usage: node scripts/notices.mjs [out-file]   (default out/THIRD_PARTY_NOTICES.txt)
//        node scripts/notices.mjs --self-test
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ALLOWED = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'OFL-1.1']);

/** Splits an SPDX expression on ` op ` outside parentheses; strips one pair of outer parentheses per part. */
function split(expr, op) {
  const parts = [''];
  let depth = 0;
  for (const word of expr.trim().split(/\s+/)) {
    if (depth === 0 && word === op) { parts.push(''); continue; }
    depth += (word.match(/\(/g) ?? []).length - (word.match(/\)/g) ?? []).length;
    parts[parts.length - 1] += ` ${word}`;
  }
  return parts.map((p) => p.trim().replace(/^\((.*)\)$/, '$1').trim());
}
// Every AND term must be allowed; a term may be an OR group, where one allowed choice is enough.
// ponytail: one level of nesting; deeper expressions fail closed.
const allowed = (licence) => split(String(licence), 'AND').every((term) => split(term, 'OR').some((l) => ALLOWED.has(l)));

if (process.argv[2] === '--self-test') {
  assert.equal(allowed('(MIT OR Apache-2.0) AND GPL-3.0'), false);
  assert.equal(allowed('MIT OR GPL-3.0'), true);
  assert.equal(allowed('MIT AND ISC'), true);
  assert.equal(allowed('(MIT OR GPL-3.0) AND (ISC OR GPL-2.0)'), true);
  assert.equal(allowed('UNKNOWN'), false);
  assert.equal(allowed('GPL-3.0'), false);
  console.log('notices self-test ok');
  process.exit(0);
}

const out = process.argv[2] ?? 'out/THIRD_PARTY_NOTICES.txt';

// npm ls exits non-zero on extraneous/missing packages but still prints the tree.
let ls;
try { ls = execFileSync('npm', ['ls', '--omit=dev', '--all', '--parseable'], { encoding: 'utf8' }); }
catch (e) { ls = e.stdout; }
const dirs = [...new Set(ls.trim().split('\n').slice(1))].sort(); // first line is the project itself

const bad = [];
const parts = ['MyIDE uses the following third-party software.\n'];
for (const dir of dirs) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const licence = pkg.license?.type ?? pkg.license ?? pkg.licenses?.map((l) => l.type).join(' OR ') ?? 'UNKNOWN';
  if (!allowed(licence)) bad.push(`${pkg.name}@${pkg.version}: ${licence}`);
  const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)/i.test(f));
  parts.push(`${'='.repeat(78)}\n${pkg.name} ${pkg.version}\nLicence: ${licence}\n\n${file ? readFileSync(join(dir, file), 'utf8').trim() : '(no licence file in package)'}\n`);
  // Packages that bundle others (Monaco) ship those notices in their own file.
  const extra = readdirSync(dir).find((f) => /^third_?party_?notices/i.test(f));
  if (extra) parts.push(`${pkg.name} bundles:\n\n${readFileSync(join(dir, extra), 'utf8').trim()}\n`);
}

if (bad.length) {
  console.error(`Licences outside the allowlist (${[...ALLOWED].join(', ')}):\n  ${bad.join('\n  ')}`);
  process.exit(1);
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, parts.join('\n'));
console.log(`wrote ${out} (${dirs.length} packages)`);
