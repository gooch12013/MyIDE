// Images: the ones David attaches to a message (stored, then sent as image blocks), and the ones an
// employee writes in its worktree (read here and handed to the renderer as data URLs; never file://).
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, resolve, sep } from 'node:path';
import { STATE_DIR, writePrivate } from './store';

// The renderer (src/renderer/attach.ts) checks the same limits first, for a clear message.
export const MAX_IMAGES = 5;
export const MAX_BYTES = 5 * 1024 * 1024;
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/** The image type from its first bytes (the clipboard's own type is not trusted). */
export function sniff(b: Uint8Array): string | undefined {
  const at = (i: number, s: string) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0));
  if (b[0] === 0x89 && at(1, 'PNG')) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (at(0, 'GIF8')) return 'image/gif';
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp';
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
