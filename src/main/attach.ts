// Images: the ones David attaches to a message (stored, then sent as image blocks), and the ones an
// employee writes in its worktree (read here and handed to the renderer as data URLs; never file://).
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, resolve, sep } from 'node:path';
import { STATE_DIR, writePrivate } from './store';

// The renderer (src/renderer/attach.ts) checks the same limits first, for a clear message.
export const MAX_IMAGES = 5;
export const MAX_BYTES = 5 * 1024 * 1024;
export const MAX_SIDE = 8000; // pixels; the API rejects larger images
export const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/** The image type from its first bytes (the clipboard's own type is not trusted). */
export function sniff(b: Uint8Array): string | undefined {
  const at = (i: number, s: string) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0));
  if (b[0] === 0x89 && at(1, 'PNG')) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (at(0, 'GIF8')) return 'image/gif';
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp';
  return undefined;
}

/** Width and height from an image's header (PNG, GIF, WebP, JPEG), or undefined if it cannot be read. */
export function size(b: Uint8Array): [number, number] | undefined {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  try {
    const type = sniff(b);
    if (type === 'image/png') return [v.getUint32(16), v.getUint32(20)];
    if (type === 'image/gif') return [v.getUint16(6, true), v.getUint16(8, true)];
    if (type === 'image/webp') {
      const kind = String.fromCharCode(b[12], b[13], b[14], b[15]);
      if (kind === 'VP8 ') return [v.getUint16(26, true) & 0x3fff, v.getUint16(28, true) & 0x3fff];
      if (kind === 'VP8L') { const n = v.getUint32(21, true); return [(n & 0x3fff) + 1, ((n >> 14) & 0x3fff) + 1]; }
      const u24 = (i: number) => { if (i + 3 > b.length) throw new RangeError(); return b[i] | (b[i + 1] << 8) | (b[i + 2] << 16); };
      if (kind === 'VP8X') return [u24(24) + 1, u24(27) + 1];
    }
    if (type === 'image/jpeg') {
      for (let i = 2; i + 9 < b.length;) { // walk the segments to the frame header (SOF0..SOF15, not DHT/JPG/DAC)
        if (b[i] !== 0xff) return undefined;
        const m = b[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [v.getUint16(i + 7), v.getUint16(i + 5)];
        i += 2 + v.getUint16(i + 2);
      }
    }
  } catch { /* truncated */ }
  return undefined;
}

/** Checks then stores a message's images as ~/.myide/projects/<id>/attachments/<employee>/<n>.<ext> (0600). Returns the paths. */
export function saveAttachments(projectId: string, employee: string, images: unknown): string[] {
  if (images === undefined || images === null) return [];
  if (!Array.isArray(images)) throw new Error('Bad images');
  if (images.length > MAX_IMAGES) throw new Error(`At most ${MAX_IMAGES} images per message.`);
  const checked = images.map((img, i) => {
    const data = (img as { data?: unknown })?.data;
    if (!(data instanceof Uint8Array)) throw new Error('Bad image data');
    if (data.byteLength > MAX_BYTES) throw new Error(`Image ${i + 1} is ${(data.byteLength / 1048576).toFixed(1)} MB; the limit is ${MAX_BYTES / 1048576} MB.`);
    const type = sniff(data);
    if (!type) throw new Error(`Image ${i + 1} is not a PNG, JPEG, GIF or WebP.`);
    const wh = size(data);
    if (!wh) throw new Error(`Image ${i + 1}: its size could not be read.`);
    if (Math.max(...wh) > MAX_SIDE) throw new Error(`Image ${i + 1} is ${wh[0]} x ${wh[1]} pixels; the limit is ${MAX_SIDE} on each side.`);
    return { data, ext: EXT[type] };
  });
  const dir = join(STATE_DIR, 'projects', projectId, 'attachments', employee);
  let n = 0;
  try { for (const f of readdirSync(dir)) n = Math.max(n, parseInt(f, 10) || 0); } catch { /* first one */ }
  return checked.map(({ data, ext }) => {
    const file = join(dir, `${++n}.${ext}`);
    writePrivate(file, data);
    return file;
  });
}

/** A stored image as base64 with its type, for a Claude or ACP image block. */
export function readImage(file: string): { mediaType: string; data: string } {
  const b = readFileSync(file);
  return { mediaType: sniff(b) ?? 'image/png', data: b.toString('base64') };
}

/** `p` (absolute, or relative to `root`) as a data URL, only if it is an image file inside `root` after resolving links. */
export function worktreeImage(root: string, p: string): string | null {
  try {
    if (!/\.(png|jpe?g|gif|webp)$/i.test(extname(p))) return null;
    const real = realpathSync(isAbsolute(p) ? p : resolve(root, p));
    if (!real.startsWith(realpathSync(root) + sep)) return null;
    const st = statSync(real);
    if (!st.isFile() || st.size > MAX_BYTES * 4) return null;
    const b = readFileSync(real);
    const type = sniff(b);
    return type ? `data:${type};base64,${b.toString('base64')}` : null;
  } catch { return null; }
}
