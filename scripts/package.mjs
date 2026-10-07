// Builds, packages and ad-hoc signs MyIDE for Apple silicon. Output: out/MyIDE-darwin-arm64/MyIDE.app
// Usage: node scripts/package.mjs   (no notarization; Gatekeeper treats it as a locally built app)
import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';

const run = (cmd, ...args) => execFileSync(cmd, args, { stdio: 'inherit' });
const NOTICES = 'out/THIRD_PARTY_NOTICES.txt';
const ELECTRON = 'node_modules/electron/dist';

run('node', 'scripts/build.mjs');
run('node', 'scripts/notices.mjs', NOTICES); // fails the package on a disallowed licence
run('sh', '-c', 'chmod +x node_modules/node-pty/prebuilds/*/spawn-helper'); // node-pty 1.1.0 ships it non-executable

const [dir] = await packager({
  dir: '.',
  name: 'MyIDE',
  platform: 'darwin',
  arch: 'arm64',
  out: 'out',
  overwrite: true,
  asar: false, // node-pty's pty.node and spawn-helper must load from disk
  appBundleId: 'io.github.gooch12013.myide',
  appCategoryType: 'public.app-category.developer-tools',
  extendInfo: 'build/Info.plist',
  extraResource: [NOTICES, `${ELECTRON}/LICENSE`, `${ELECTRON}/LICENSES.chromium.html`],
  // Ship only the bundle and runtime modules; drop node-pty's Windows and Intel binaries (~60 MB).
  ignore: (p) =>
    !(p === '' || p === '/package.json' || p.startsWith('/dist') || p.startsWith('/node_modules')) ||
    /^\/node_modules\/node-pty\/(deps|third_party|prebuilds\/(?!darwin-arm64))/.test(p),
});
const app = `${dir}/MyIDE.app`;

// --deep does not reach loose binaries under Resources, so sign node-pty's first, then the bundle.
run('sh', '-c', `find "${app}/Contents/Resources/app/node_modules/node-pty" \\( -name '*.node' -o -name spawn-helper \\) -type f -exec codesign --force --sign - --options runtime {} \\;`);
run('codesign', '--force', '--deep', '--sign', '-', '--options', 'runtime', '--entitlements', 'build/entitlements.plist', app);
run('codesign', '--verify', '--deep', '--strict', app);
console.log(`signed ok: ${app}`);
