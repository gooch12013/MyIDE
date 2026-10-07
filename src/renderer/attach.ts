// Images in message boxes: paste or drop to attach (thumbnails, click to enlarge, × to remove), and
// thumbnails of image files an employee mentions, read by main from inside its worktree only.
import { h, key } from './dom';

// Main (src/main/attach.ts) enforces the same limits.
export const MAX_IMAGES = 5;
export const MAX_BYTES = 5 * 1024 * 1024;

let viewer: HTMLDialogElement | undefined;
/** Shows `src` large in a modal; Esc, the × or a click anywhere closes it. */
export function enlarge(src: string, alt: string): void {
  if (!viewer) {
    viewer = h('dialog', { className: 'sheet img-view' });
    viewer.setAttribute('aria-label', 'Image');
    viewer.onclick = () => viewer!.close();
    document.body.append(viewer);
  }
  viewer.replaceChildren(h('img', { src, alt }), key('×', () => viewer!.close(), { className: 'key key--sm img-view-x', ariaLabel: 'Close' }));
  viewer.showModal();
}

/** A thumbnail that enlarges on click, with an optional × to remove it. */
export function thumb(src: string, alt: string, remove?: () => void): HTMLElement {
  return h('span', { className: 'iss-thumb' },
    h('button', { type: 'button', className: 'thumb-open', title: `Enlarge ${alt}`, onclick: () => enlarge(src, alt) }, h('img', { src, alt })),
    ...(remove ? [key('×', remove, { title: `Remove ${alt}`, ariaLabel: `Remove ${alt}` })] : []));
}

export type Picked = { name: string; type: string; data: Uint8Array; url: string };

/** Lets `target` (a textarea) take pasted and dropped images. `say` shows limit messages; `onChange` runs after each add or remove. */
export function attachBox(target: HTMLElement, say: (t: string) => void, onChange?: () => void) {
  const images: Picked[] = [];
  const el = h('div', { className: 'iss-thumbs' });
  const draw = () => {
    el.replaceChildren(...images.map((img, n) => thumb(img.url, img.name, () => { images.splice(n, 1); draw(); })));
    onChange?.();
  };
  const add = async (files: File[]) => {
    const notes: string[] = [];
    for (const f of files) {
      const name = f.name || `pasted-${images.length + 1}.png`;
      if (images.length >= MAX_IMAGES) { notes.push(`At most ${MAX_IMAGES} images per message.`); break; }
      if (f.size > MAX_BYTES) { notes.push(`${name} is ${(f.size / 1048576).toFixed(1)} MB; the limit is ${MAX_BYTES / 1048576} MB.`); continue; }
      const data = new Uint8Array(await f.arrayBuffer());
      images.push({ name, type: f.type, data, url: `data:${f.type};base64,${btoa(Array.from(data, (c) => String.fromCharCode(c)).join(''))}` }); // the CSP allows data: images, not blob:
    }
    say(notes.join(' '));
    draw();
  };
  const imageFiles = (l?: FileList | null) => [...(l ?? [])].filter((f) => f.type.startsWith('image/'));
  const take = (ev: Event, l?: FileList | null) => { const f = imageFiles(l); if (f.length) { ev.preventDefault(); void add(f); } };
  target.addEventListener('paste', (ev) => take(ev, ev.clipboardData?.files));
  target.addEventListener('dragover', (ev) => { if (ev.dataTransfer?.types.includes('Files')) ev.preventDefault(); });
  target.addEventListener('drop', (ev) => take(ev, ev.dataTransfer?.files));
  return {
    el,
    images,
    /** What goes over IPC. */
    payload: () => images.map(({ type, data }) => ({ type, data })),
    clear() { images.length = 0; draw(); },
  };
}

/** Image file paths mentioned in `text` (absolute or relative; not URLs). */
export function imagePaths(text: string): string[] {
  const re = /(?<![\w:/.@+-])(?:\.{1,2}\/|\/)?(?:[\w.@+-]+\/)*[\w.@+-]+\.(?:png|jpe?g|gif|webp)(?![\w/]|\.\w)/gi;
  return [...new Set(text.match(re) ?? [])].slice(0, 8);
}

/** Thumbnails for the image files `text` mentions that main finds inside employee `id`'s worktree. */
export function workImages(id: string, text: string): HTMLElement {
  const el = h('div', { className: 'iss-thumbs' });
  for (const p of imagePaths(text)) {
    void window.myide.employees.image(id, p).then((src) => { if (src) el.append(thumb(src, p)); }, () => {});
  }
  return el;
}
