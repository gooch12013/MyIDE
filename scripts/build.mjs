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
  build({ ...common, entryPoints: ['src/renderer/app.ts'], outfile: 'dist/renderer/app.js', platform: 'browser', format: 'iife', alias: { 'dockview-core': './node_modules/dockview-core/dist/dockview-core.js' } }),
]);
cpSync('build/hooks', 'dist/hooks', { recursive: true }); // the chaining git hook, installed into ~/.myide/hooks under every hook name at launch
cpSync('build/bin', 'dist/bin', { recursive: true }); // the `issue` quick-add script, copied to ~/.myide/bin at launch
cpSync('build/providers.json', 'dist/providers.json'); // the AI capability table
for (const f of ['index.html', 'popout.html']) cpSync(`src/renderer/${f}`, `dist/renderer/${f}`);
console.log('built dist/');
