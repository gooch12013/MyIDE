import * as monaco from 'monaco-editor';
import { marked } from 'marked';
import { h } from './dom';
import { resolvePath } from './links';

declare global {
  interface Element { setHTML(html: string, options?: { sanitizer?: Sanitizer }): void } // Chromium 146+, not yet in TypeScript's DOM lib
}

// Raw HTML in a Markdown file goes through the browser's own sanitizer: setHTML always drops scripts, event handlers,
// javascript: links and frames, whatever is allowed here. Its safe default, plus what GitHub keeps in a README.
// Never ids (headings get prefixed ones below), names, styles, or classes other than a code block's language.
const GITHUB = new Sanitizer();
GITHUB.allowElement({ name: 'img', attributes: ['src', 'alt', 'width', 'height'] });
GITHUB.allowElement({ name: 'input', attributes: ['type', 'checked', 'disabled'] }); // task list boxes
GITHUB.allowElement({ name: 'details', attributes: ['open'] });
GITHUB.allowElement('summary');
GITHUB.allowElement({ name: 'code', attributes: ['class'] });
GITHUB.allowAttribute('align');
for (const t of ['picture', 'center', 'font']) GITHUB.replaceElementWithChildren(t); // keeps what is inside (a picture's <img>)

const SCHEME = /^[a-z][\w+.-]*:|^\/\//i; // a URL, not a path in the checkout
const decode = (s: string): string => { try { return decodeURIComponent(s); } catch { return s; } };

/** `text`, the Markdown in `file` (in the checkout at `root`), rendered as GitHub renders a file: GFM, front matter as a
 *  YAML block, heading anchors, highlighted code. Relative links and images resolve as on GitHub (a leading / is the
 *  checkout's root). A link to a file calls `open` with its #L line; a web link opens in the browser. */
export async function markdown(text: string, file: string, root: string, open: (path: string, line?: number) => void): Promise<HTMLElement> {
  const dir = file.slice(0, file.lastIndexOf('/'));
  const local = (url: string): string => {
    const p = decode(url.split(/[?#]/)[0]);
    return p.startsWith('/') ? resolvePath(root, p.slice(1)) : resolvePath(dir, p);
  };
  const el = h('article', { className: 'md' });
  el.setHTML(marked.parse(text.replace(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/, '```yaml\n$1\n```\n'), { async: false }), { sanitizer: GITHUB });

  // Images in the checkout come through main's /view route, which serves project and worktree files only.
  for (const img of el.querySelectorAll('img')) {
    const src = img.getAttribute('src');
    if (src && !SCHEME.test(src)) img.src = `/view?path=${encodeURIComponent(local(src))}`;
  }
  // GitHub's anchors: the heading's text lowercased, punctuation dropped, spaces as dashes, repeats numbered.
  const seen = new Map<string, number>();
  for (const hd of el.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const slug = (hd.textContent ?? '').trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    hd.id = `user-content-${n ? `${slug}-${n}` : slug}`; // prefixed, as GitHub does, so no heading shadows a global
  }
  const langs = monaco.languages.getLanguages();
  await Promise.all([...el.querySelectorAll('pre > code[class^="language-"]')].map(async (code) => {
    const name = code.className.slice('language-'.length).toLowerCase();
    const id = langs.find((l) => l.id === name || l.aliases?.some((a) => a.toLowerCase() === name) || l.extensions?.includes(`.${name}`))?.id;
    if (id) code.innerHTML = await monaco.editor.colorize((code.textContent ?? '').replace(/\n$/, ''), id, {}); // Monaco escapes the text
  }));

  el.addEventListener('click', (e) => {
    const href = (e.target as Element).closest('a')?.getAttribute('href');
    if (href == null) return;
    e.preventDefault(); // a relative href would otherwise load in place of the app
    const [path, frag = ''] = href.split('#');
    if (!path) el.querySelector(`#${CSS.escape(`user-content-${decode(frag).toLowerCase()}`)}`)?.scrollIntoView();
    else if (SCHEME.test(href)) void window.myide.terminal.openUrl(href); // main opens http(s) only
    else open(local(path), Number(/^L(\d+)/.exec(frag)?.[1]) || undefined);
  });
  return el;
}
