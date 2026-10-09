// Checks src/renderer/markdown.ts in a hidden Electron window (setHTML is Chromium's): what the sanitizer keeps and drops,
// front matter, heading anchors, image and link resolution, code highlighting (Monaco stubbed). Usage: node scripts/check-markdown.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const electron = (await import('electron')).default;
if (!process.versions.electron) process.exit(spawnSync(electron, [fileURLToPath(import.meta.url)], { stdio: 'inherit' }).status ?? 1);

const { build } = await import('esbuild');
const { outputFiles: [bundle] } = await build({
  stdin: { contents: "import { markdown } from './src/renderer/markdown.ts'; window.markdown = markdown;", resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'error',
  plugins: [{ name: 'stub-monaco', setup(b) {
    b.onResolve({ filter: /^monaco-editor$/ }, () => ({ path: 'monaco', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: `
      export const languages = { getLanguages: () => [{ id: 'typescript', aliases: ['TypeScript', 'ts'], extensions: ['.ts'] }] };
      export const editor = { colorize: async (t, id) => '<span class="mtk1">' + id + ':' + t.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</span>' };` }));
  } }],
});

const MD = `---
name: readme
---
# Getting Started!
## Getting Started!
<p align="center"><img src="docs/logo.png?raw=true" width="100" name="cookie" onerror="alert(1)"></p>
<picture><source media="(prefers-color-scheme: dark)" srcset="dark.png"><img src="/light.png" alt="logo"></picture>
<div id="myide" class="topbar" style="position:fixed">boxed</div>
<script>alert(1)</script><style>body{display:none}</style><iframe src="x"></iframe><form action="x"><button>b</button></form>
<base href="https://evil.example/"><meta http-equiv="refresh" content="0;url=https://evil.example/">
<details open><summary>More</summary>inside</details>
<center>centred</center>

- [x] done
- [ ] todo

| a | b |
|---|---|
| 1 | 2 |

\`\`\`ts
const a = 1 < 2;
\`\`\`

[up](../x.md#L5) [root](/top.md) [web](https://example.com/a#b) [anchor](#getting-started-1) [bad](javascript:alert(1)) <a href="javascript:alert(2)">bad2</a>
`;

const { app, BrowserWindow } = electron;
// Not awaited at the top: Electron holds 'ready' until an ESM main's top-level awaits settle.
void app.whenReady().then(async () => {
const w = new BrowserWindow({ show: false });
await w.loadURL('data:text/html,<!doctype html><body></body>');
await w.webContents.executeJavaScript(bundle.text);
const r = await w.webContents.executeJavaScript(`(async () => {
  const opened = [], urls = [];
  window.myide = { terminal: { openUrl: async (u) => { urls.push(u); } } };
  const el = await window.markdown(${JSON.stringify(MD)}, '/r/p/docs/README.md', '/r/p', (p, line) => opened.push([p, line ?? null]));
  document.body.append(el);
  const prevented = [];
  for (const a of el.querySelectorAll('a')) { const e = new MouseEvent('click', { bubbles: true, cancelable: true }); a.dispatchEvent(e); prevented.push(e.defaultPrevented); }
  const q = (s) => el.querySelector(s);
  return {
    html: el.innerHTML, opened, urls, prevented,
    ids: [...el.querySelectorAll('[id]')].map((e) => e.id),
    imgs: [...el.querySelectorAll('img')].map((i) => [i.getAttribute('src'), i.getAttribute('width'), i.getAttribute('alt')]),
    yaml: q('pre > code.language-yaml')?.textContent, hr: !!q('hr'),
    tasks: [...el.querySelectorAll('li > input[type=checkbox][disabled]')].map((i) => i.checked),
    details: q('details[open] > summary')?.textContent, centred: el.textContent.includes('centred'),
    p: q('p[align=center]') !== null, table: !!q('table td'), code: q('pre > code.language-ts')?.innerHTML,
    hrefs: [...el.querySelectorAll('a')].map((a) => a.getAttribute('href')),
    leaked: [...el.querySelectorAll('script, style, iframe, form, base, meta, source, [style], [onerror], [name], [class]:not(code, .mtk1)')].map((e) => e.outerHTML),
  };
})()`);

try {
assert.deepEqual(r.leaked, [], 'nothing unsafe or app-styled survives');
assert.ok(!/alert|evil/.test(r.html), r.html);
assert.equal(r.yaml, 'name: readme\n', 'front matter shows as YAML');
assert.equal(r.hr, false, "front matter's --- lines are not rules");
assert.deepEqual(r.ids, ['user-content-getting-started', 'user-content-getting-started-1'], 'only prefixed heading ids');
assert.deepEqual(r.imgs, [['/view?path=%2Fr%2Fp%2Fdocs%2Fdocs%2Flogo.png', '100', null], ['/view?path=%2Fr%2Fp%2Flight.png', null, 'logo']]);
assert.ok(r.p, 'align is kept');
assert.deepEqual(r.tasks, [true, false], 'task list boxes');
assert.equal(r.details, 'More');
assert.ok(r.centred, "a dropped wrapper's text stays");
assert.ok(r.table, 'GFM tables');
assert.equal(r.code, '<span class="mtk1">typescript:const a = 1 &lt; 2;</span>', 'ts fences are highlighted, text escaped');
assert.deepEqual(r.hrefs, ['../x.md#L5', '/top.md', 'https://example.com/a#b', '#getting-started-1', null, null], 'javascript: hrefs dropped');
assert.deepEqual(r.opened, [['/r/p/x.md', 5], ['/r/p/top.md', null]], 'file links resolve from the file, / from the root');
assert.deepEqual(r.urls, ['https://example.com/a#b'], 'web links go to the browser');
assert.deepEqual(r.prevented, [true, true, true, true, false, false], 'no link navigates the app');
console.log('check-markdown: ok');
app.exit(0);
} catch (e) { console.error(e); app.exit(1); }
});
