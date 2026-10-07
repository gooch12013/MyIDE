// Checks file:line link matching in src/renderer/links.ts. Usage: node scripts/check-links.mjs
import assert from 'node:assert/strict';
import { fileRefs, resolvePath } from '../src/renderer/links.ts';

const refs = (t) => fileRefs(t).map((r) => [t.slice(r.start, r.end), r.path, r.line]);
assert.deepEqual(refs('error in src/foo.ts:12 here'), [['src/foo.ts:12', 'src/foo.ts', 12]]);
assert.deepEqual(refs('at run (/Users/d/x/main.js:10:5)'), [['/Users/d/x/main.js:10:5', '/Users/d/x/main.js', 10]]);
assert.deepEqual(refs('see ../a.py:9, ./b.rs:3 and c.go:4'), [['../a.py:9', '../a.py', 9], ['./b.rs:3', './b.rs', 3], ['c.go:4', 'c.go', 4]]);
assert.deepEqual(refs('`.github/workflows/ci.yml:7`'), [['.github/workflows/ci.yml:7', '.github/workflows/ci.yml', 7]]);
assert.deepEqual(refs('https://example.com:443/x and localhost:8080 and v1.2:3'), [['v1.2:3', 'v1.2', 3]]); // no URL host:port; main's exists check drops v1.2
assert.deepEqual(refs('src/foo.ts without a line, Makefile:3'), []);
assert.equal(resolvePath('/r/p', 'src/a.ts'), '/r/p/src/a.ts');
assert.equal(resolvePath('/r/p/sub', '../a.ts'), '/r/p/a.ts');
assert.equal(resolvePath('/r/p', './x/./y.ts'), '/r/p/x/y.ts');
assert.equal(resolvePath('/r/p', '/abs/z.ts'), '/abs/z.ts');
console.log('check-links: ok');
