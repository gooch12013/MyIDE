// Checks image attachments: type sniffing, the count/size/type limits and 0600 storage in
// src/main/attach.ts, worktree-only reads of employee images (no escape by .. or symlink), and the
// image-path finder in src/renderer/attach.ts.
// Usage: node scripts/check-attach.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

const tmp = mkdtempSync(join(tmpdir(), 'myide-attach-check-'));
process.env.MYIDE_HOME = join(tmp, 'home');
const stub = join(tmp, 'stub.cjs');
writeFileSync(stub, 'module.exports = new Proxy({}, { get: () => new Proxy(function () {}, { get: () => () => {} }) });');
const load = async (entry, name) => {
  const out = join(tmp, name);
  await build({ entryPoints: [entry], outfile: out, bundle: true, platform: 'node', format: 'cjs', logLevel: 'error', alias: { electron: stub, 'node-pty': stub } });
  return createRequire(import.meta.url)(out);
};
const m = await load('src/main/attach.ts', 'main.cjs');
const r = await load('src/renderer/attach.ts', 'renderer.cjs');

try {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0]);
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0]);
  const gif = new TextEncoder().encode('GIF89a...');
  const webp = new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ');
  assert.equal(m.sniff(png), 'image/png');
  assert.equal(m.sniff(jpg), 'image/jpeg');
  assert.equal(m.sniff(gif), 'image/gif');
  assert.equal(m.sniff(webp), 'image/webp');
  assert.equal(m.sniff(new TextEncoder().encode('<svg>')), undefined);

  // Storage: numbered per employee, 0600, numbering carries on across messages.
  assert.deepEqual(m.saveAttachments('p1', 'dev-1', undefined), []);
  const a = m.saveAttachments('p1', 'dev-1', [{ type: 'image/png', data: png }, { type: 'image/jpeg', data: jpg }]);
  assert.deepEqual(a.map((f) => f.split('/').slice(-4).join('/')), ['p1/attachments/dev-1/1.png', 'p1/attachments/dev-1/2.jpg']);
  assert.equal(statSync(a[0]).mode & 0o777, 0o600);
  assert.deepEqual([...readFileSync(a[0])], [...png]);
  assert.match(m.saveAttachments('p1', 'dev-1', [{ data: gif }])[0], /\/3\.gif$/);
  assert.deepEqual(m.readImage(a[1]), { mediaType: 'image/jpeg', data: Buffer.from(jpg).toString('base64') });

  // Limits: nothing is written when any image fails.
  assert.throws(() => m.saveAttachments('p1', 'dev-2', Array(6).fill({ data: png })), /At most 5 images/);
  const big = new Uint8Array(m.MAX_BYTES + 1); big.set(png);
  assert.throws(() => m.saveAttachments('p1', 'dev-2', [{ data: png }, { data: big }]), /Image 2 is 5\.0 MB; the limit is 5 MB/);
  assert.throws(() => m.saveAttachments('p1', 'dev-2', [{ data: new TextEncoder().encode('<svg/>') }]), /not a PNG/);
  assert.throws(() => m.saveAttachments('p1', 'dev-2', [{ data: 'aGVsbG8=' }]), /Bad image data/);
  assert.throws(() => statSync(join(process.env.MYIDE_HOME, 'projects/p1/attachments/dev-2')), /ENOENT/);

  // Worktree images: inside only, after resolving links; image types only.
  const wt = join(tmp, 'wt');
  mkdirSync(join(wt, 'shots'), { recursive: true });
  writeFileSync(join(wt, 'shots', 'a.png'), png);
  writeFileSync(join(wt, 'notes.png'), 'not really a png');
  writeFileSync(join(wt, 'secret.txt'), 'x');
  writeFileSync(join(tmp, 'outside.png'), png);
  symlinkSync(join(tmp, 'outside.png'), join(wt, 'link.png'));
  const url = `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
  assert.equal(m.worktreeImage(wt, 'shots/a.png'), url);
  assert.equal(m.worktreeImage(wt, join(wt, 'shots', 'a.png')), url);
  assert.equal(m.worktreeImage(wt, './shots/../shots/a.png'), url);
  assert.equal(m.worktreeImage(wt, '../outside.png'), null);
  assert.equal(m.worktreeImage(wt, join(tmp, 'outside.png')), null);
  assert.equal(m.worktreeImage(wt, 'link.png'), null);
  assert.equal(m.worktreeImage(wt, 'notes.png'), null);
  assert.equal(m.worktreeImage(wt, 'secret.txt'), null);
  assert.equal(m.worktreeImage(wt, 'missing.png'), null);

  // Paths in employee text: absolute, relative, in JSON and markdown; not URLs.
  assert.deepEqual(r.imagePaths('Saved the screenshot to /Users/x/wt/shots/home.png and ./out/b.JPG.'), ['/Users/x/wt/shots/home.png', './out/b.JPG']);
  assert.deepEqual(r.imagePaths('Write {"file_path":"/tmp/wt/assets/icon@2x.webp","content":""}'), ['/tmp/wt/assets/icon@2x.webp']);
  assert.deepEqual(r.imagePaths('![logo](assets/logo.gif) and `docs/a.jpeg`'), ['assets/logo.gif', 'docs/a.jpeg']);
  assert.deepEqual(r.imagePaths('See https://example.com/a.png or file.pngx or image.png.bak'), []);
  assert.deepEqual(r.imagePaths('a.png a.png'), ['a.png']);
  console.log('check-attach: ok');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
