// Checks src/main/speech.ts and src/main/components.ts: `say -v '?'` parsing, read-back start and
// stop (written to an AIFF with `say -o`, so nothing plays aloud), read-back engines (voice lists per
// engine, cloned voices, refusing an engine that is not installed, the helper dispatch and its honest
// fallback to `say`), settings migration, dictation engine and model choice, the components manifest, detection
// of existing installs, "use existing", dictation through a fake whisper-cli, and one real install
// and removal of the GitHub CLI (about 14 MB) plus a checksum failure, all in a temp MYIDE_HOME.
// Usage: node scripts/check-speech.mjs   (add --offline to skip the downloads)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

const tmp = mkdtempSync(join(tmpdir(), 'myide-speech-'));
const home = join(tmp, 'myide'), fakeHome = join(tmp, 'home'), bin = join(tmp, 'bin');
process.env.MYIDE_HOME = home;
process.env.HOME = fakeHome; // detection looks under ~/.cache
mkdirSync(home, { recursive: true });
mkdirSync(bin);

globalThis.__stub = {
  electron: {
    app: { whenReady: () => new Promise(() => {}), getPath: () => tmp }, dialog: {}, shell: {}, BrowserWindow: {},
    ipcMain: { handle() {}, on() {} }, webContents: { getAllWebContents: () => [] },
  },
  pty: { spawnEnv: async () => ({ PATH: `${bin}:/usr/bin:/bin` }),
    // the real findOnPath (src/main/pty.ts), which cannot be bundled here because it loads node-pty
    findOnPath: (name, path = '') => path.split(':').filter(Boolean).map((d) => join(d, name)).filter((p) => { try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; } }) },
};
const stubs = { electron: 'electron', './pty': 'pty' };
const out = join(tmp, 'speech.cjs');
await build({
  stdin: { contents: "export * as speech from './src/main/speech.ts'; export * as comp from './src/main/components.ts';", resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'warning',
  plugins: [{
    name: 'stubs',
    setup(b) {
      b.onResolve({ filter: /^(electron|\.\/pty)$/ }, (a) => ({ path: stubs[a.path], namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: `module.exports = globalThis.__stub[${JSON.stringify(a.path)}];`, loader: 'js' }));
    },
  }],
});
const { speech, comp } = createRequire(import.meta.url)(out);
const writeCfg = (c) => writeFileSync(join(home, 'config.json'), JSON.stringify(c));
const readCfg = () => JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));

// ---- voices ----
const voices = speech.parseVoices('Albert              en_US    # Hello! My name is Albert.\nEddy (English (UK)) en_GB    # Hello!\nnoise\n');
assert.deepEqual(voices, [{ name: 'Albert', lang: 'en_US' }, { name: 'Eddy (English (UK))', lang: 'en_GB' }]);
const real = await speech.voices();
assert.ok(real.length > 0, 'say -v ? lists voices');

// ---- read-back: summaries only, one at a time, stop ----
assert.equal(speech.speakable('Done. ```\nrm -rf /\n``` Merged.'), 'Done. (code) Merged.');
assert.ok(speech.speakable('x'.repeat(5000)).length <= 1501);
const aiff = join(tmp, 'a.aiff');
const p1 = speech.speak('Engineer one finished the sync teardown.', { out: aiff });
assert.equal(speech.speaking(), true);
await p1;
assert.equal(speech.speaking(), false);
assert.ok(statSync(aiff).size > 1000, 'say wrote audio');
const aiff2 = join(tmp, 'b.aiff');
const states = [];
speech.onSpeaking((on) => states.push(on));
const long = speech.speak('This is a long summary. '.repeat(400), { out: aiff2, rate: 200 });
const t0 = Date.now();
setTimeout(() => speech.stop(), 100);
await long;
assert.ok(Date.now() - t0 < 3000, 'stop ends the utterance');
assert.equal(speech.speaking(), false);
assert.deepEqual(states, [true, false]);
// a second speak replaces the first
const a = speech.speak('First. '.repeat(300), { out: join(tmp, 'c.aiff') });
const b = speech.speak('Second.', { out: join(tmp, 'd.aiff') });
await a; await b;
assert.equal(speech.speaking(), false);
assert.equal(speech.settings().on, false, 'read-back is off by default');
assert.equal(speech.settings().engine, 'say');

// ---- settings migration: the old {on, voice, rate} reads as the macOS engine ----
writeCfg({ speech: { on: true, voice: 'Albert', rate: 200 } });
assert.deepEqual(speech.settings(), { on: true, engine: 'say', voice: 'Albert', rate: 200 });
await speech.update({ rate: 210 });
assert.deepEqual(readCfg().speech, { on: true, engine: 'say', voice: 'Albert', rate: 210 }, 'a change writes the new shape');
assert.equal(readCfg().dictation, undefined, 'dictation is stored only once chosen');
writeCfg({ speech: { on: false, engine: 'nonsense', voice: 'x', rate: 0 } });
assert.deepEqual(speech.settings(), { on: false, engine: 'say', voice: '', rate: 0 }, 'an unknown engine falls back to say');
writeCfg({});

// ---- read-back engines: each with its own voices; one that is not installed is refused ----
let opt = await speech.options();
assert.deepEqual(opt.engines.map((e) => e.id), ['say', 'kokoro', 'qwen3-tts'], 'say plus every manifest entry of kind tts');
const eng = (id) => opt.engines.find((e) => e.id === id);
assert.equal(eng('say').state, 'builtin');
assert.ok(eng('say').voices.length > 0 && eng('say').voices.every((v) => v.id && v.lang));
assert.equal(eng('kokoro').state, 'missing');
assert.equal(eng('kokoro').helper, false);
assert.equal(eng('kokoro').voices.length, 54);
for (const id of ['af_heart', 'af_bella', 'am_michael', 'am_adam', 'bf_emma', 'bm_george']) assert.ok(eng('kokoro').voices.some((v) => v.id === id), id);
assert.deepEqual(eng('qwen3-tts').voices.map((v) => v.id), ['Vivian', 'Serena', 'Uncle_Fu', 'Dylan', 'Eric', 'Ryan', 'Aiden', 'Ono_Anna', 'Sohee']);
assert.ok(!eng('kokoro').voices.some((v) => eng('qwen3-tts').voices.some((q) => q.id === v.id)), 'lists are per engine');
await assert.rejects(speech.update({ engine: 'kokoro' }), /Install Kokoro voice first\. Read-back keeps using macOS voices/);
await assert.rejects(speech.update({ engine: 'espeak' }), /Unknown read-back engine/);
assert.equal(speech.settings().engine, 'say', 'refused engine leaves read-back on say');

// cloned voices: <component>/voices/*.wav
mkdirSync(join(comp.COMPONENTS_DIR, 'qwen3-tts', 'voices'), { recursive: true });
writeFileSync(join(comp.COMPONENTS_DIR, 'qwen3-tts', 'voices', 'David.wav'), 'x');
writeFileSync(join(comp.COMPONENTS_DIR, 'qwen3-tts', 'voices', 'notes.txt'), 'x');
assert.deepEqual((await speech.engineVoices('qwen3-tts')).slice(-1), [{ id: 'clone:David', label: 'Cloned: David', lang: '' }]);
assert.equal((await speech.engineVoices('qwen3-tts')).length, 10);

// an existing Kokoro install: selectable, voices validated per engine, no helper yet -> say with a note
const hf = join(fakeHome, '.cache', 'huggingface', 'hub', 'models--hexgrad--Kokoro-82M');
mkdirSync(hf, { recursive: true });
await comp.useExisting('kokoro', hf);
opt = await speech.options();
assert.equal(eng('kokoro').state, 'existing');
let st = await speech.update({ engine: 'kokoro' });
assert.equal(st.engine, 'kokoro');
assert.equal(st.voice, 'af_heart', 'switching engine picks its first voice');
await assert.rejects(speech.update({ voice: 'Albert' }), /Kokoro voice has no voice Albert/);
st = await speech.update({ voice: 'bf_emma' });
assert.equal(st.voice, 'bf_emma');
const fb = join(tmp, 'fallback.aiff');
assert.match(await speech.speak('Fallback test.', { engine: 'kokoro', voice: 'bf_emma', out: fb }), /voice helper is not built yet.*macOS system voice/);
assert.ok(statSync(fb).size > 1000, 'fell back to say');
// with a helper: dispatched to it with say's arguments
const helper = speech.helperPath('kokoro');
mkdirSync(join(comp.COMPONENTS_DIR, 'kokoro'), { recursive: true });
writeFileSync(helper, '#!/bin/sh\nout=""; while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done\n{ echo "$0"; cat; } > "$out"\n');
chmodSync(helper, 0o755);
opt = await speech.options();
assert.equal(eng('kokoro').helper, true);
const hw = join(tmp, 'helper.out');
assert.equal(await speech.speak('Helper test.', { engine: 'kokoro', voice: 'bf_emma', rate: 200, out: hw }), '');
assert.equal(readFileSync(hw, 'utf8'), `${helper}\nHelper test.`);
// removing the engine puts read-back back on say
comp.remove('kokoro');
assert.equal(speech.settings().engine, 'say');
assert.equal(speech.settings().voice, '');

// ---- manifest ----
const ids = comp.MANIFEST.map((e) => e.id);
assert.deepEqual(ids, ['whisper', 'whisper-model', 'gh', 'kokoro', 'qwen3-tts']);
for (const e of comp.MANIFEST) {
  for (const k of ['name', 'kind', 'adds', 'licence', 'licenceUrl', 'version']) assert.ok(typeof e[k] === 'string' && e[k], `${e.id}.${k}`);
  assert.ok(e.detect.bin || (e.detect.dirs && e.detect.match), `${e.id} has detection`);
  if (e.url) {
    assert.ok(e.url.startsWith('https://') && !e.url.includes('/main/'), `${e.id} url is https and pinned`);
    assert.match(e.sha256, /^[0-9a-f]{64}$/);
    assert.ok(e.size > 0 && e.file);
  } else assert.ok(['build-needed', 'coming-soon'].includes(e.status), `${e.id} without url says why`);
}
assert.ok(!comp.MANIFEST.some((e) => /kokoro-js/i.test(JSON.stringify(e))));

// ---- detection, use existing, dictation ----
let rows = Object.fromEntries((await comp.rows()).map((r) => [r.id, r]));
assert.equal(rows.whisper.state, 'missing');
assert.deepEqual(rows.whisper.found, []);
assert.equal(speech.status().dictation, false);
await assert.rejects(speech.update({ dictate: { engine: 'whisper' } }), /Install Local Whisper first/);
const cli = join(bin, 'whisper-cli');
writeFileSync(cli, '#!/bin/sh\n[ "$1" = -m ] && [ "$3" = -f ] && [ "$5" = -nt ] && [ "$6" = -np ] || exit 3\n[ -s "$4" ] || exit 4\necho " Hello [BLANK_AUDIO] there."\n');
chmodSync(cli, 0o755);
const models = join(fakeHome, '.cache', 'whisper-cpp');
mkdirSync(models, { recursive: true });
writeFileSync(join(models, 'ggml-tiny.en.bin'), 'x');
writeFileSync(join(models, 'notes.txt'), 'x');
rows = Object.fromEntries((await comp.rows()).map((r) => [r.id, r]));
assert.deepEqual(rows.whisper.found, [cli]);
assert.deepEqual(rows['whisper-model'].found, [join(models, 'ggml-tiny.en.bin')]);
await assert.rejects(comp.useExisting('whisper', '/bin/sh'), /not a Local Whisper install/);
await assert.rejects(speech.transcribe(new Uint8Array(10)), /Install Local Whisper/);
await comp.useExisting('whisper', cli);
await comp.useExisting('whisper-model', join(models, 'ggml-tiny.en.bin'));
assert.equal(speech.status().dictation, true);
assert.equal(await speech.transcribe(new Uint8Array(100)), 'Hello there.');
// dictation engine and model: models are the installed ones only
assert.equal(speech.dictate().engine, 'whisper', 'Local Whisper is used once ready (old behaviour)');
writeFileSync(join(models, 'ggml-small.bin'), 'x');
assert.deepEqual((await speech.whisperModels()).map((m) => m.label).sort(), ['small', 'tiny.en']);
await assert.rejects(speech.update({ dictate: { model: '/etc/hosts' } }), /not installed/);
st = await speech.update({ dictate: { model: join(models, 'ggml-small.bin') } });
assert.equal(st.dictate.model, join(models, 'ggml-small.bin'));
st = await speech.update({ dictate: { engine: 'macos' } });
assert.equal(st.dictation, false);
assert.equal(speech.status().dictation, false, 'macOS dictation hides the mic keys');
st = await speech.update({ dictate: { engine: 'whisper' } });
assert.equal(st.dictation, true);
assert.deepEqual(readCfg().dictation, { engine: 'whisper', model: join(models, 'ggml-small.bin') });
rmSync(join(models, 'ggml-small.bin'));
assert.equal(speech.dictate().model, join(models, 'ggml-tiny.en.bin'), 'a deleted model falls back to the component');
rows = Object.fromEntries((await comp.rows()).map((r) => [r.id, r]));
assert.equal(rows.whisper.state, 'existing');
assert.deepEqual(rows.whisper.found, []);
comp.remove('whisper');
assert.ok(existsSync(cli), 'removing an existing install leaves its files');
assert.equal(speech.status().dictation, false);

// ---- install: a download needs a published checksum (refused before fetching), a cap at 110% of its size ----
const fake = { id: 'nosha', name: 'No checksum', kind: '', adds: '', licence: '', licenceUrl: '', version: '1', detect: {}, url: 'https://example.invalid/x.bin', file: 'x.bin' };
comp.MANIFEST.push(fake);
await assert.rejects(comp.install('nosha'), /no published checksum/);
comp.MANIFEST.pop();

// ---- install: checksum failure, then a real gh ----
if (!process.argv.includes('--offline')) {
  comp.MANIFEST.push({ id: 'small', name: 'Small', kind: '', adds: '', licence: '', licenceUrl: '', version: '1', detect: {}, size: 100,
    url: 'https://github.com/cli/cli/releases/download/v2.102.0/gh_2.102.0_checksums.txt', sha256: '0'.repeat(64), file: 'gh_2.102.0_checksums.txt' });
  await assert.rejects(comp.install('small'), /larger than Small's published size/);
  assert.ok(!existsSync(join(comp.COMPONENTS_DIR, 'small')) && !existsSync(join(comp.COMPONENTS_DIR, 'small.partial')));
  comp.MANIFEST.pop();
  comp.MANIFEST.push({ id: 'tiny', name: 'Tiny', kind: '', adds: '', licence: '', licenceUrl: '', version: '1', detect: {},
    url: 'https://github.com/cli/cli/releases/download/v2.102.0/gh_2.102.0_checksums.txt', sha256: '0'.repeat(64), file: 'gh_2.102.0_checksums.txt' });
  await assert.rejects(comp.install('tiny'), /checksum/);
  assert.ok(!existsSync(join(comp.COMPONENTS_DIR, 'tiny')) && !existsSync(join(comp.COMPONENTS_DIR, 'tiny.partial')));
  comp.MANIFEST.pop();

  let ticks = 0;
  const gh = await comp.install('gh', (got, total) => { ticks++; assert.ok(got <= total); });
  assert.ok(ticks > 0);
  assert.equal(gh, join(comp.COMPONENTS_DIR, 'gh', 'gh_2.102.0_macOS_arm64', 'bin', 'gh'));
  assert.match(execFileSync(gh, ['--version'], { encoding: 'utf8' }), /gh version 2\.102\.0/);
  rows = Object.fromEntries((await comp.rows()).map((r) => [r.id, r]));
  assert.equal(rows.gh.state, 'installed');
  assert.equal(rows.gh.installedVersion, '2.102.0');
  assert.ok(rows.gh.disk > 1e6);
  assert.equal(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).components.gh.path, gh);
  // An update swaps in the new install and leaves no .old or .partial behind.
  assert.equal(await comp.install('gh'), gh);
  assert.ok(!existsSync(join(comp.COMPONENTS_DIR, 'gh.old')) && !existsSync(join(comp.COMPONENTS_DIR, 'gh.partial')));
  comp.remove('gh');
  assert.ok(!existsSync(join(comp.COMPONENTS_DIR, 'gh')));
  assert.equal(comp.componentPath('gh'), null);
}
await assert.rejects(comp.install('kokoro'), /cannot be installed/);

rmSync(tmp, { recursive: true, force: true });
console.log('check-speech: ok');
