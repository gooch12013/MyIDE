// Checks src/main/speech.ts and src/main/components.ts: `say -v '?'` parsing, read-back start and
// stop (written to an AIFF with `say -o`, so nothing plays aloud), read-back engines (voice lists per
// engine, cloned voices, refusing an engine that is not installed, "use existing Python", the helper
// protocol through a fake Python (models per voice, speed, one long-lived process, stop, crash and
// restart, honest fallback to `say`)), settings migration, dictation engine and model choice, the components manifest, detection
// of existing installs, "use existing", dictation through a fake whisper-cli, and one real install
// and removal of the GitHub CLI (about 14 MB) plus a checksum failure, all in a temp MYIDE_HOME.
// Usage: node scripts/check-speech.mjs   (add --offline to skip the downloads)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { accessSync, chmodSync, constants, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir, userInfo } from 'node:os';
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
assert.equal(eng('kokoro').status, 'idle');
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

// a model folder chosen by an older build is not an engine: Python engines need their interpreter
const hf = join(fakeHome, '.cache', 'huggingface', 'hub', 'models--hexgrad--Kokoro-82M');
mkdirSync(hf, { recursive: true });
writeCfg({ components: { kokoro: { path: hf, existing: true } } });
assert.equal(comp.componentPath('kokoro'), null);
writeCfg({});

// "Use existing Python": refused unless it is a program that imports the engine
await assert.rejects(comp.usePython('kokoro', 'python3'), /not a Python program/);
await assert.rejects(comp.usePython('kokoro', hf), /not a Python program/);
await assert.rejects(comp.usePython('kokoro', '/usr/bin/false'), /cannot run Kokoro voice/);
await assert.rejects(comp.usePython('gh', '/usr/bin/true'), /does not run in Python/);

// A fake Python that speaks the helper protocol (build/speech/helper.py): -c is the import check; with
// the helper path it answers requests, writing each request (plus its pid and whether its model was
// already loaded) to `out`. Text FAIL fails the line, CRASH exits, SLOW waits for a stop.
cpSync('build/speech', join(tmp, 'speech'), { recursive: true }); // where speech.HELPER looks in this bundle
const py = join(bin, 'fakepython');
writeFileSync(py, `#!${process.execPath}
const fs = require('fs'), [flag, script] = process.argv.slice(2);
if (flag === '-c') process.exit(0);
if (flag !== '-u' || !fs.existsSync(script)) process.exit(9);
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const loaded = new Set(); let stops = 0;
send({ ready: true });
require('readline').createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  if (m.stop) { stops++; return; }
  if (m.text.includes('CRASH')) process.exit(3);
  if (m.text.includes('FAIL')) return send({ id: m.id, ok: false, error: 'boom' });
  if (!loaded.has(m.model)) { loaded.add(m.model); send({ id: m.id, state: 'loading' }); }
  const done = () => { fs.writeFileSync(m.out, JSON.stringify({ ...m, pid: process.pid, stops })); send({ id: m.id, ok: true, secs: 0.1 }); };
  if (m.text.includes('SLOW')) setTimeout(done, 1500); else done();
});
`);
chmodSync(py, 0o755);
await comp.usePython('kokoro', py);
assert.equal(comp.componentPath('kokoro'), py);
opt = await speech.options();
assert.equal(eng('kokoro').state, 'existing');
let st = await speech.update({ engine: 'kokoro' });
assert.equal(st.engine, 'kokoro');
assert.equal(st.voice, 'af_heart', 'switching engine picks its first voice');
await assert.rejects(speech.update({ voice: 'Albert' }), /Kokoro voice has no voice Albert/);
st = await speech.update({ voice: 'bf_emma' });
assert.equal(st.voice, 'bf_emma');
const engineEvents = [];
speech.onEngine((id) => engineEvents.push(id));
const hw = join(tmp, 'helper.json');
const said = (f) => JSON.parse(readFileSync(f, 'utf8'));
assert.equal(await speech.speak('Helper test.', { engine: 'kokoro', voice: 'bf_emma', rate: 270, out: hw }), '');
let req = said(hw);
assert.deepEqual([req.model, req.voice, req.lang, req.speed, req.text, req.rate], ['mlx-community/Kokoro-82M-bf16', 'bf_emma', 'b', 1.5, 'Helper test.', undefined], 'Kokoro: model, British voice, speed in the model');
const pid = req.pid;
opt = await speech.options();
assert.equal(eng('kokoro').status, 'ready');
assert.ok(engineEvents.length >= 3, 'starting, loading and ready were announced');
assert.equal(speech.speaking(), false);
await speech.speak('Again.', { engine: 'kokoro', voice: 'af_heart', out: hw });
req = said(hw);
assert.equal(req.pid, pid, 'one long-lived helper');
assert.deepEqual([req.lang, req.speed], ['a', 1], 'system speed is 1');
// stop: resolves at once, tells the helper, and the helper stays up
const t1 = Date.now();
const slow = speech.speak('SLOW line.', { engine: 'kokoro', out: join(tmp, 'slow.json') });
setTimeout(() => speech.stop(), 50);
assert.equal(await slow, '');
assert.ok(Date.now() - t1 < 1000, 'stop does not wait for the line');
assert.equal(speech.speaking(), false);
await speech.speak('After stop.', { engine: 'kokoro', out: hw });
req = said(hw);
assert.equal(req.pid, pid);
assert.equal(req.stops, 1, 'the helper got the stop');
// a failed line falls back to say with a note
const fb = join(tmp, 'fallback.aiff');
assert.match(await speech.speak('FAIL this.', { engine: 'kokoro', out: fb }), /Kokoro voice failed \(boom\), so this used the macOS system voice/);
assert.ok(statSync(fb).size > 1000, 'fell back to say');
opt = await speech.options();
assert.equal(eng('kokoro').status, 'error');
assert.equal(eng('kokoro').error, 'boom');
// a crash falls back too, and the next line starts a new helper
assert.match(await speech.speak('CRASH now.', { engine: 'kokoro', out: join(tmp, 'crash.aiff') }), /voice helper stopped \(exit 3\).*macOS system voice/);
await speech.speak('Restarted.', { engine: 'kokoro', out: hw });
assert.notEqual(said(hw).pid, pid, 'restarted after the crash');
opt = await speech.options();
assert.equal(eng('kokoro').status, 'ready');

// Qwen3-TTS: presets need the CustomVoice model, clones the Base model plus the sample and its transcript
const q = (v, rate) => speech.helperRequest('qwen3-tts', v, rate);
assert.deepEqual(q('Ryan', 360), { model: 'mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16', voice: 'Ryan', rate: 2 });
const vdir = join(comp.COMPONENTS_DIR, 'qwen3-tts', 'voices');
assert.deepEqual(q('clone:David', 90), { model: 'mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16', ref: join(vdir, 'David.wav'), rate: 0.5 });
writeFileSync(join(vdir, 'David.txt'), ' Hello, this is my voice.\n');
assert.deepEqual(q('clone:David'), { model: 'mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16', ref: join(vdir, 'David.wav'), ref_text: 'Hello, this is my voice.', rate: 1 });
mkdirSync(join(comp.COMPONENTS_DIR, 'kokoro', 'voices'), { recursive: true });
writeFileSync(join(comp.COMPONENTS_DIR, 'kokoro', 'voices', 'Me.wav'), 'x');
assert.ok(!(await speech.engineVoices('kokoro')).some((v) => v.id.startsWith('clone:')), 'Kokoro cannot clone');
// Removing our own Python engine deletes its venv but keeps the voice samples
mkdirSync(join(comp.COMPONENTS_DIR, 'qwen3-tts', 'venv', 'bin'), { recursive: true });
cpSync(py, join(comp.COMPONENTS_DIR, 'qwen3-tts', 'venv', 'bin', 'python'));
writeCfg({ ...readCfg(), components: { ...readCfg().components, 'qwen3-tts': { path: join(comp.COMPONENTS_DIR, 'qwen3-tts', 'venv', 'bin', 'python'), version: 'x' } } });
assert.equal((await comp.rows()).find((x) => x.id === 'qwen3-tts').state, 'installed');
comp.remove('qwen3-tts');
assert.ok(!existsSync(join(comp.COMPONENTS_DIR, 'qwen3-tts', 'venv')) && existsSync(join(vdir, 'David.wav')));
// removing the engine puts read-back back on say
comp.remove('kokoro');
assert.equal(speech.settings().engine, 'say');
assert.equal(speech.settings().voice, '');

// ---- manifest ----
const ids = comp.MANIFEST.map((e) => e.id);
assert.deepEqual(ids, ['whisper', 'whisper-model', 'gh', 'uv', 'kokoro', 'qwen3-tts']);
for (const e of comp.MANIFEST) {
  for (const k of ['name', 'kind', 'adds', 'licence', 'licenceUrl', 'version']) assert.ok(typeof e[k] === 'string' && e[k], `${e.id}.${k}`);
  assert.ok(e.detect.bin || (e.detect.dirs && e.detect.match) || e.pip, `${e.id} has detection (a Python engine is picked instead)`);
  if (e.pip) assert.ok(e.pip.every((p) => /==/.test(p)) && e.check && e.model, `${e.id} pins its packages and names its model`);
  if (e.url) {
    assert.ok(e.url.startsWith('https://') && !e.url.includes('/main/'), `${e.id} url is https and pinned`);
    assert.match(e.sha256, /^[0-9a-f]{64}$/);
    assert.ok(e.size > 0 && e.file);
  } else assert.ok(e.pip || ['build-needed', 'coming-soon'].includes(e.status), `${e.id} without url says why`);
}
assert.ok(!comp.MANIFEST.some((e) => /kokoro-js/i.test(JSON.stringify(e))));
assert.match(comp.MANIFEST.find((e) => e.id === 'kokoro').licence, /GPL.*espeak-ng.*phonemizer/, 'Kokoro names its GPL dependencies');

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
  // uv, the installer for the Python engines (a .tar.gz)
  const uvBin = await comp.install('uv');
  assert.match(execFileSync(uvBin, ['--version'], { encoding: 'utf8' }), /^uv 0\.12\.23/);
  comp.remove('uv');
}

// ---- real engines (opt-in, Apple Silicon). MYIDE_TEST_PYTHON: a Python with mlx-audio, used for a
// Qwen3-TTS clone from the Base model already in the Hugging Face cache (offline, so nothing big is
// fetched). MYIDE_TEST_INSTALL=1: Install Kokoro for real into the temp folder (uv, Python, packages,
// then its 389 MB model) and speak with it. Audio goes to files; nothing plays.
const realHome = userInfo().homedir;
const timed = async (f) => { const t = Date.now(); const note = await f(); return [(Date.now() - t) / 1000, note]; };
const isWav = (f) => readFileSync(f).subarray(0, 4).toString() === 'RIFF' && statSync(f).size > 20_000;
if (process.env.MYIDE_TEST_PYTHON) {
  process.env.HF_HOME = join(realHome, '.cache', 'huggingface');
  process.env.HF_HUB_OFFLINE = '1';
  await comp.usePython('qwen3-tts', process.env.MYIDE_TEST_PYTHON);
  const vd = join(comp.COMPONENTS_DIR, 'qwen3-tts', 'voices');
  mkdirSync(vd, { recursive: true });
  const sample = 'Hello, this is a short sample of my speaking voice for cloning.';
  execFileSync('/usr/bin/say', ['-o', join(vd, 'Sample.wav'), '--data-format=LEI16@24000', sample]);
  writeFileSync(join(vd, 'Sample.txt'), sample);
  await speech.update({ engine: 'qwen3-tts' });
  await speech.update({ voice: 'clone:Sample' });
  const s = speech.settings();
  const seen = [];
  speech.onEngine(async () => seen.push((await speech.options()).engines.find((e) => e.id === 'qwen3-tts').status));
  const [first, n1] = await timed(() => speech.speak('Engineer one finished the sync teardown.', { ...s, out: join(tmp, 'q1.wav') }));
  const [second, n2] = await timed(() => speech.speak('Engineer two needs approval to merge.', { ...s, out: join(tmp, 'q2.wav') }));
  assert.equal(n1 + n2, '', `no fallback: ${n1} ${n2}`);
  assert.ok(isWav(join(tmp, 'q1.wav')) && isWav(join(tmp, 'q2.wav')), 'Qwen3-TTS wrote speech');
  console.log(`real Qwen3-TTS clone (Base model): first line ${first.toFixed(1)} s (start + load), second ${second.toFixed(1)} s; states ${[...new Set(seen)].join(' > ')}`);
  delete process.env.HF_HUB_OFFLINE;
}
if (process.env.MYIDE_TEST_INSTALL) {
  process.env.HF_HOME = join(realHome, '.cache', 'huggingface');
  process.env.UV_CACHE_DIR = join(realHome, '.cache', 'uv'); // reuse downloaded wheels
  let lastLine = '';
  const [secs] = await timed(() => comp.install('kokoro', (got, total, text) => { if (text && text !== lastLine) { lastLine = text; } }));
  assert.equal(comp.componentPath('kokoro'), join(comp.COMPONENTS_DIR, 'kokoro', 'venv', 'bin', 'python'));
  console.log(`real Kokoro install: ${secs.toFixed(0)} s, last uv line: ${lastLine}`);
  const [first, n1] = await timed(() => speech.speak('Engineer one finished the sync teardown.', { engine: 'kokoro', voice: 'bf_emma', rate: 200, out: join(tmp, 'k1.wav') }));
  const [second, n2] = await timed(() => speech.speak('Engineer two needs approval to merge.', { engine: 'kokoro', voice: 'am_michael', out: join(tmp, 'k2.wav') }));
  assert.equal(n1 + n2, '', `no fallback: ${n1} ${n2}`);
  assert.ok(isWav(join(tmp, 'k1.wav')) && isWav(join(tmp, 'k2.wav')), 'Kokoro wrote speech');
  console.log(`real Kokoro: first line ${first.toFixed(1)} s (start, model fetch if needed, load), second ${second.toFixed(1)} s`);
}
if (process.env.MYIDE_TEST_KEEP) cpSync(tmp, process.env.MYIDE_TEST_KEEP, { recursive: true }); // to listen to the files
rmSync(tmp, { recursive: true, force: true });
console.log('check-speech: ok');
process.exit(0); // the fake helper is still running, as a real one would be
