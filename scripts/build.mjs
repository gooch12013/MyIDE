// Bundles main, preload and renderer into dist/. Usage: node scripts/build.mjs
import { build } from 'esbuild';
import { cpSync, rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
const common = { bundle: true, sourcemap: 'linked', logLevel: 'warning', target: 'es2022' };

await Promise.all([
  build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main.js', platform: 'node', format: 'cjs', external: ['electron', 'node-pty'] }),
  build({ ...common, entryPoints: ['src/main/acp/host.ts'], outfile: 'dist/acp-host.js', platform: 'node', format: 'cjs', external: ['electron'] }), // runs ACP adapters in a utility process
  build({ ...common, entryPoints: ['src/preload/preload.ts'], outfile: 'dist/preload.js', platform: 'node', format: 'cjs', external: ['electron'] }),
  // The UMD build of dockview-core carries its stylesheet; the ESM build has none.
  build({ ...common, entryPoints: ['src/renderer/app.ts'], outfile: 'dist/renderer/app.js', platform: 'browser', format: 'iife', alias: { 'dockview-core': './node_modules/dockview-core/dist/dockview-core.js' }, loader: { '.ttf': 'file' }, minify: true }), // minified: Monaco is ~9 MB of source
  // Monaco's language-service workers, loaded by src/renderer/editor.ts from /monaco/.
  build({ ...common, sourcemap: false, minify: true, platform: 'browser', format: 'iife', outdir: 'dist/renderer/monaco', entryNames: '[name]', entryPoints: Object.fromEntries(
    [['editor', 'editor/editor.worker.js'], ['ts', 'language/typescript/ts.worker.js'], ['css', 'language/css/css.worker.js'], ['json', 'language/json/json.worker.js'], ['html', 'language/html/html.worker.js']]
      .map(([name, file]) => [`${name}.worker`, `node_modules/monaco-editor/esm/vs/${file}`])) }),
]);
cpSync('build/hooks', 'dist/hooks', { recursive: true }); // the chaining git hook, installed into ~/.myide/hooks under every hook name at launch
cpSync('build/bin', 'dist/bin', { recursive: true }); // the `issue` quick-add script, copied to ~/.myide/bin at launch
cpSync('build/providers.json', 'dist/providers.json'); // the AI capability table
cpSync('build/prompt-guides', 'dist/prompt-guides', { recursive: true }); // asset studio prompt guides, copied to ~/.myide/prompt-guides on first use
cpSync('build/agents', 'dist/agents', { recursive: true }); // the designer role, installed into ~/.claude/agents only on a click
cpSync('build/prompt-guides', 'dist/prompt-guides', { recursive: true }); // asset studio prompt guides, copied to ~/.myide/prompt-guides on first use
cpSync('build/agents', 'dist/agents', { recursive: true }); // the designer role, installed into ~/.claude/agents only on a click
for (const f of ['index.html', 'popout.html']) cpSync(`src/renderer/${f}`, `dist/renderer/${f}`);
console.log('built dist/');
