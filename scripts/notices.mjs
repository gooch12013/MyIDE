// Writes THIRD_PARTY_NOTICES.txt for the production dependency tree of the project in the current
// directory, and exits 1 if any licence is outside the allowlist.
// Usage: node scripts/notices.mjs [out-file]   (default out/THIRD_PARTY_NOTICES.txt)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ALLOWED = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'OFL-1.1']);
const FONTS = 'src/renderer/fonts'; // bundled fonts ship their licence as *.txt next to them
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
  // An "A OR B" expression is fine if any choice is allowed; AND or anything else must match exactly.
  if (!String(licence).replace(/[()]/g, '').split(' OR ').some((l) => ALLOWED.has(l.trim()))) bad.push(`${pkg.name}@${pkg.version}: ${licence}`);
  const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)/i.test(f));
  parts.push(`${'='.repeat(78)}\n${pkg.name} ${pkg.version}\nLicence: ${licence}\n\n${file ? readFileSync(join(dir, file), 'utf8').trim() : '(no licence file in package)'}\n`);
}
if (existsSync(FONTS)) {
  for (const f of readdirSync(FONTS).filter((f) => f.endsWith('.txt'))) parts.push(`${'='.repeat(78)}\nFont licence: ${f}\n\n${readFileSync(join(FONTS, f), 'utf8').trim()}\n`);
}

if (bad.length) {
  console.error(`Licences outside the allowlist (${[...ALLOWED].join(', ')}):\n  ${bad.join('\n  ')}`);
  process.exit(1);
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, parts.join('\n'));
console.log(`wrote ${out} (${dirs.length} packages)`);
