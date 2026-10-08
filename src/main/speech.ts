import { BrowserWindow, dialog, ipcMain } from 'electron';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, closeSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { COMPONENTS_DIR, componentPath, detect, MANIFEST, rows, type Entry, type Row } from './components';
import { readConfig, writeConfig } from './projects';
import { broadcast, STATE_DIR } from './store';

// Read-back (feature 14), off by default, one utterance at a time, through an engine: macOS `say`
// (built in) or a manifest component of kind "tts". Dictation: macOS dictation (built in) or an
// installed whisper-cli. Every child runs through execFile/spawn with an argument list, never a
// shell; the spoken text goes in on stdin.

export type Voice = { id: string; label: string; lang: string };
export interface SpeechSettings { on: boolean; engine: string; voice: string; rate: number }
export interface DictateSettings { engine: 'macos' | 'whisper'; model: string }
export interface SpeechStatus extends SpeechSettings { dictation: boolean; dictate: DictateSettings }
export type SpeechPatch = Partial<SpeechSettings> & { dictate?: Partial<DictateSettings> };
/** What a tts engine's helper is doing: not started, fetching or loading a model, ready, or failed (with `error`). */
export type EngineStatus = 'idle' | 'starting' | 'downloading' | 'loading' | 'ready' | 'error';
export interface Engine { id: string; name: string; state: 'builtin' | Row['state']; status: EngineStatus; error?: string; canInstall: boolean; voices: Voice[] }
export interface SpeechOptions { engines: Engine[]; whisper: Row['state']; models: { path: string; label: string }[] }

export const SAY = 'say';
const tts = (id: string): Entry | undefined => MANIFEST.find((e) => e.kind === 'tts' && e.id === id);
const engineName = (id: string) => (id === SAY ? 'macOS voices' : tts(id)?.name ?? id);

/** The read-back helper (build/speech/helper.py, copied to dist/speech), run with the engine's Python. */
export const HELPER = join(__dirname, 'speech', 'helper.py');

/** Read-back settings. Old configs ({on, voice, rate}) read as the macOS engine; an engine that was removed falls back to it too. */
export function settings(): SpeechSettings {
  const s = (readConfig() as { speech?: Partial<SpeechSettings> }).speech ?? {};
  const engine = typeof s.engine === 'string' && (s.engine === SAY || (tts(s.engine) && componentPath(s.engine))) ? s.engine : SAY;
  return {
    on: typeof s.on === 'boolean' ? s.on : false,
    engine,
    voice: engine === (s.engine ?? SAY) && typeof s.voice === 'string' ? s.voice : '', // '' and 0: the system voice and speed
    rate: typeof s.rate === 'number' ? s.rate : 0,
  };
}

/** The model whisper-cli runs: the chosen one while it exists, else the installed Whisper model component. */
const modelPath = (chosen?: string) => (chosen && existsSync(chosen) ? chosen : componentPath('whisper-model') ?? '');
const whisperReady = (model: string) => !!componentPath('whisper') && !!model;

/** Dictation settings. Before any choice, Local Whisper is used when it is ready (the old behaviour). */
export function dictate(): DictateSettings {
  const d = (readConfig() as { dictation?: Partial<DictateSettings> }).dictation ?? {};
  const model = modelPath(typeof d.model === 'string' ? d.model : '');
  const engine = (d.engine ?? 'whisper') === 'whisper' && whisperReady(model) ? 'whisper' : 'macos';
  return { engine, model };
}
export const status = (): SpeechStatus => {
  const d = dictate();
  return { ...settings(), dictation: d.engine === 'whisper', dictate: d };
};

/** Parses `say -v '?'`: "Eddy (English (UK)) en_GB    # Hello! My name is Eddy." */
export function parseVoices(out: string): { name: string; lang: string }[] {
  return out.split('\n').flatMap((l) => {
    const m = /^(.+?)\s+([a-z]{2,3}_[A-Za-z0-9]+)\s+#/.exec(l);
    return m ? [{ name: m[1].trim(), lang: m[2] }] : [];
  });
}
let voiceList: Promise<{ name: string; lang: string }[]> | undefined;
export const voices = () => (voiceList ??= new Promise((resolve) =>
  execFile('/usr/bin/say', ['-v', '?'], { timeout: 10_000 }, (err, out) => resolve(err ? [] : parseVoices(out)))));

/** An engine's voices: `say`'s list, or the manifest's plus any cloning references in <component>/voices/*.wav. */
export async function engineVoices(id: string): Promise<Voice[]> {
  if (id === SAY) return (await voices()).map((v) => ({ id: v.name, label: v.name, lang: v.lang }));
  let clones: string[] = [];
  try { if (tts(id)?.cloneModel) clones = readdirSync(join(COMPONENTS_DIR, id, 'voices')).filter((n) => /\.wav$/i.test(n)); } catch { /* none */ }
  return [...(tts(id)?.voices ?? []), ...clones.map((n) => { const name = n.replace(/\.wav$/i, ''); return { id: `clone:${name}`, label: `Cloned: ${name}`, lang: '' }; })];
}

/** Whisper models on this Mac: the installed component and any ggml model detection finds. */
export async function whisperModels(): Promise<{ path: string; label: string }[]> {
  const e = MANIFEST.find((x) => x.id === 'whisper-model')!;
  const paths = [...new Set([componentPath('whisper-model'), ...(await detect(e))].filter((p): p is string => !!p))];
  return paths.map((path) => ({ path, label: basename(path).replace(/^ggml-|\.bin$/g, '') }));
}

/** Everything Preferences > Voice & read-back offers. */
export async function options(): Promise<SpeechOptions> {
  const [list, models, sayVoices] = await Promise.all([rows(), whisperModels(), engineVoices(SAY)]);
  const engines: Engine[] = [{ id: SAY, name: engineName(SAY), state: 'builtin', status: 'ready', canInstall: false, voices: sayVoices }];
  for (const r of list.filter((x) => x.kind === 'tts')) {
    const h = helpers.get(r.id);
    engines.push({ id: r.id, name: r.name, state: r.state, status: h?.status ?? 'idle', error: h?.error, canInstall: !r.status && !!(r.url || r.pip), voices: await engineVoices(r.id) });
  }
  return { engines, whisper: list.find((x) => x.id === 'whisper')?.state ?? 'missing', models };
}

/** Applies a settings change. An engine that is not installed is refused, so read-back never points at one it cannot use. */
export async function update(patch: SpeechPatch): Promise<SpeechStatus> {
  const s = settings(), d = dictate();
  if (typeof patch?.on === 'boolean') s.on = patch.on;
  if (typeof patch?.engine === 'string' && patch.engine !== s.engine) {
    const e = tts(patch.engine);
    if (patch.engine !== SAY && !e) throw new Error(`Unknown read-back engine ${patch.engine}.`);
    if (e && !componentPath(e.id)) throw new Error(`Install ${e.name} first. Read-back keeps using ${engineName(s.engine)}.`);
    s.engine = patch.engine;
    s.voice = e?.voices?.[0]?.id ?? '';
  }
  if (typeof patch?.voice === 'string') {
    // `say` takes any installed voice name (and fails harmlessly on a wrong one); other engines only their own voices.
    if (s.engine !== SAY && !(await engineVoices(s.engine)).some((v) => v.id === patch.voice)) throw new Error(`${engineName(s.engine)} has no voice ${patch.voice}.`);
    s.voice = patch.voice.slice(0, 100);
  }
  if (typeof patch?.rate === 'number' && Number.isFinite(patch.rate)) s.rate = patch.rate && Math.min(400, Math.max(90, patch.rate));
  const p = patch?.dictate;
  if (typeof p?.model === 'string') {
    if (!(await whisperModels()).some((m) => m.path === p.model)) throw new Error('That Whisper model is not installed.');
    d.model = p.model;
  }
  if (p?.engine === 'macos') d.engine = 'macos';
  else if (p?.engine === 'whisper') {
    if (!whisperReady(modelPath(d.model))) throw new Error(`Install ${componentPath('whisper') ? 'a Whisper model' : 'Local Whisper'} first. Dictation keeps using macOS dictation.`);
    d.engine = 'whisper';
  }
  // Dictation is stored only once chosen, so until then Local Whisper takes over when it becomes ready.
  const c = readConfig();
  writeConfig({ ...c, speech: s, ...(p ? { dictation: d } : {}) } as ReturnType<typeof readConfig>);
  if (!s.on) stop();
  return status();
}

/** Summaries only: fenced code is dropped and the length capped, so a stray report never reads out a file. */
export function speakable(text: string): string {
  const t = text.replace(/```[\s\S]*?(```|$)/g, ' (code) ').replace(/`([^`\n]{40,})`/g, ' (code) ').replace(/\s+/g, ' ').trim();
  return t.length > 1500 ? `${t.slice(0, 1500)}…` : t;
}

// One utterance at a time, through `say` or an engine's helper; stop() ends whichever is running.
let current: { stop(): void } | null = null;
let emit = (_speaking: boolean): void => {};
export const onSpeaking = (cb: (speaking: boolean) => void): void => { emit = cb; };
export const speaking = () => !!current;
const begin = (stopFn: () => void) => { const t = { stop: stopFn }; current = t; emit(true); return t; };
const end = (t: object) => { if (current === t) { current = null; emit(false); } };

/** Stops any utterance, then says `text` in the engine's voice. Resolves when it ends or is stopped, with a
 *  note when it fell back to the macOS system voice. `out` writes a file instead of playing (tests). */
export function speak(text: string, o: { engine?: string; voice?: string; rate?: number; out?: string } = {}): Promise<string> {
  stop();
  const words = speakable(text);
  if (!words) return Promise.resolve('');
  if (!o.engine || o.engine === SAY) return viaSay(words, o.voice, o.rate, o.out);
  const python = componentPath(o.engine);
  return python ? viaHelper(o.engine, python, words, o)
    : viaSay(words, '', o.rate, o.out, `${engineName(o.engine)} is not installed, so this used the macOS system voice.`);
}
export function stop(): void {
  if (!current) return;
  const c = current;
  current = null;
  c.stop();
  emit(false);
}

function viaSay(words: string, voice = '', rate = 0, out = '', note = ''): Promise<string> {
  const args: string[] = [];
  if (voice) args.push('-v', voice);
  if (rate) args.push('-r', String(Math.round(Math.min(400, Math.max(90, rate)))));
  if (out) args.push('-o', out);
  const child = spawn('/usr/bin/say', args, { stdio: ['pipe', 'ignore', 'ignore'] });
  const t = begin(() => child.kill());
  child.stdin!.on('error', () => {}); // killed before reading
  child.stdin!.end(words);
  return new Promise((resolve) => child.on('close', () => { end(t); resolve(note); }));
}

// ---- engine helpers: one long-lived Python process per engine, models kept loaded between lines ----

type Reply = { id?: number; ok?: boolean; error?: string; state?: EngineStatus; ready?: boolean; secs?: number; stopped?: boolean };
interface Helper { child: ChildProcess; python: string; status: EngineStatus; error?: string; ready: Promise<void>; waiting: Map<number, (r: Reply) => void> }
const helpers = new Map<string, Helper>();
let nextId = 0;
let emitEngine = (_id: string): void => {};
export const onEngine = (cb: (id: string) => void): void => { emitEngine = cb; };

/** The engine's running helper, started (again) when there is none, it died, or its Python changed. */
function helper(id: string, python: string): Helper {
  const old = helpers.get(id);
  if (old && old.python === python && old.child.exitCode === null && old.child.signalCode === null) return old;
  old?.child.kill();
  const child = spawn(python, ['-u', HELPER], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HF_HUB_DISABLE_PROGRESS_BARS: '1', TOKENIZERS_PARALLELISM: 'false' } });
  const h: Helper = { child, python, status: 'starting', waiting: new Map(), ready: Promise.resolve() };
  const set = (st: EngineStatus, err?: string) => { h.status = st; h.error = err; emitEngine(id); };
  let tail = '', startErr = '';
  child.stderr!.on('data', (d: Buffer) => { tail = (tail + d.toString()).slice(-4000); });
  child.stdin!.on('error', () => {}); // it exited; the exit handler reports why
  h.ready = new Promise((resolve, reject) => {
    const fail = (msg: string) => {
      set('error', startErr || msg);
      reject(new Error(h.error));
      for (const cb of h.waiting.values()) cb({ ok: false, error: h.error });
      h.waiting.clear();
    };
    createInterface({ input: child.stdout! }).on('line', (line) => {
      let m: Reply;
      try { m = JSON.parse(line); } catch { return; }
      if (m.ready === true) { set('ready'); resolve(); } else if (m.ready === false) startErr = `Python cannot run the voice helper: ${m.error}`;
      else if (m.state) set(m.state);
      else if (m.id !== undefined) {
        if (!m.stopped) set(m.ok === false ? 'error' : 'ready', m.error);
        h.waiting.get(m.id)?.(m);
        h.waiting.delete(m.id);
      }
    });
    child.on('error', (err) => fail(`Could not start ${python}: ${err.message}`));
    child.on('exit', (code, sig) => fail(`The voice helper stopped (${sig ?? `exit ${code}`}): ${tail.trim().split('\n').pop() ?? ''}`.replace(/: $/, '.')));
  });
  h.ready.catch(() => {});
  helpers.set(id, h);
  set('starting');
  return h;
}

/** wpm to a speed factor around `say`'s default of about 180 wpm. */
const factor = (rate = 0) => (rate ? Math.min(2, Math.max(0.5, rate / 180)) : 1);

/** The helper request for an engine and voice: which model it needs and how speed applies. Kokoro takes a
 *  speed and a language (the voice's first letter); Qwen3-TTS presets need the CustomVoice model, clones
 *  the Base model plus the sample (and its transcript, if there is one), and speed applies on playback. */
export function helperRequest(id: string, voice = '', rate = 0): Record<string, unknown> {
  const e = tts(id)!;
  const v = voice || e.voices?.[0]?.id || '';
  if (id === 'kokoro') return { model: e.model, voice: v, lang: v[0], speed: factor(rate) };
  if (!v.startsWith('clone:')) return { model: e.model, voice: v, rate: factor(rate) };
  const base = join(COMPONENTS_DIR, id, 'voices', v.slice(6));
  let refText = '';
  try { refText = readFileSync(`${base}.txt`, 'utf8').trim(); } catch { /* no transcript: the voice is cloned from the sound alone */ }
  return { model: e.cloneModel, ref: `${base}.wav`, ...(refText ? { ref_text: refText } : {}), rate: factor(rate) };
}

/** Sends one request to the engine's helper as the current utterance; null when it was stopped or replaced. */
async function ask(id: string, python: string, req: Record<string, unknown>): Promise<Reply | null> {
  let finish!: (r: Reply) => void;
  const replied = new Promise<Reply>((r) => { finish = r; });
  const h = helper(id, python), n = ++nextId;
  const t = begin(() => {
    h.waiting.delete(n);
    if (h.child.exitCode === null) h.child.stdin!.write('{"stop":true}\n');
    finish({ stopped: true });
  });
  let r: Reply;
  try {
    await Promise.race([h.ready, replied]);
    if (current === t) {
      h.waiting.set(n, finish);
      h.child.stdin!.write(`${JSON.stringify({ id: n, ...req })}\n`);
    }
    r = await replied;
  } catch (err) { r = { ok: false, error: (err as Error).message }; }
  if (current !== t) return null; // stopped, or replaced by the next line
  end(t);
  return r;
}

async function viaHelper(id: string, python: string, words: string, o: { voice?: string; rate?: number; out?: string }): Promise<string> {
  const r = await ask(id, python, { ...helperRequest(id, o.voice, o.rate), text: words, ...(o.out ? { out: o.out } : {}) });
  return r?.ok === false ? viaSay(words, '', o.rate, o.out, `${engineName(id)} failed (${r.error}), so this used the macOS system voice.`) : '';
}

// ---- cloned voices: <qwen3-tts>/voices/<Name>.wav plus an optional <Name>.txt transcript. Clips are
// copied in (never moved or changed), found with Spotlight, or designed from a description. ----

const CLONER = 'qwen3-tts';
export const voicesDir = (): string => join(COMPONENTS_DIR, CLONER, 'voices');
export interface Clone { name: string; duration?: number; transcript: string }
export interface Clip { path: string; name: string; duration?: number; transcript: string; score: number }
const AUDIO = /\.(wav|m4a|mp3|aiff?)$/i;

/** A voice name that is safe as a file name: letters, digits, spaces, _ and -, at most 40 characters. */
export function cloneName(raw: string): string {
  const n = String(raw ?? '').normalize('NFC').trim().replace(AUDIO, '').replace(/[^\p{L}\p{N} _-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 40).trim();
  if (!n) throw new Error('Give the voice a name (letters, digits, spaces, - or _).');
  return n;
}

/** A WAV's length in seconds from its header, or undefined when it is not a readable WAV. */
export function wavSeconds(file: string): number | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const b = Buffer.alloc(4096), n = readSync(fd, b, 0, 4096, 0);
    if (n < 12 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WAVE') return undefined;
    let rate = 0;
    for (let at = 12; at + 8 <= n;) {
      const id = b.toString('latin1', at, at + 4), size = b.readUInt32LE(at + 4);
      if (id === 'fmt ' && at + 20 <= n) rate = b.readUInt32LE(at + 16); // byte rate
      if (id === 'data') return rate ? Math.min(size, statSync(file).size - at - 8) / rate : undefined;
      at += 8 + size + (size & 1);
    }
  } catch { /* unreadable */ } finally { if (fd !== undefined) closeSync(fd); }
  return undefined;
}

const readText = (f: string) => { try { return readFileSync(f, 'utf8').trim().slice(0, 2000); } catch { return ''; } };
/** The transcript next to a clip: same folder, same base name, .txt. */
export const siblingText = (clip: string): string => readText(join(dirname(clip), `${basename(clip, extname(clip))}.txt`));
const suggest = (clip: string) => { try { return cloneName(basename(clip)); } catch { return ''; } };

/** The cloned voices MyIDE has, by name. */
export function clones(): Clone[] {
  let names: string[] = [];
  try { names = readdirSync(voicesDir()).filter((n) => /\.wav$/i.test(n) && !n.startsWith('.')).map((n) => n.slice(0, -4)); } catch { /* none yet */ }
  return names.sort((a, b) => a.localeCompare(b)).map((name) => ({ name, duration: wavSeconds(join(voicesDir(), `${name}.wav`)), transcript: readText(join(voicesDir(), `${name}.txt`)) }));
}
/** The path (without extension) of a voice that exists; anything else, including a path, is refused. */
function known(name: string): string {
  if (!clones().some((c) => c.name === name)) throw new Error(`There is no cloned voice called ${name}.`);
  return join(voicesDir(), name);
}

// Only clips MyIDE itself offered (picked, found or designed) can be added or previewed.
const offered = new Set<string>();
const info = (path: string): Clip => ({ path, name: suggest(path), duration: /\.wav$/i.test(path) ? wavSeconds(path) : undefined, transcript: siblingText(path), score: 0 });
/** A clip the user picked: offered, with a suggested name and the transcript next to it. */
export function clipInfo(path: string): Clip { offered.add(path); return info(path); }

/** Spotlight results to candidate clips: in the home folder but not Library, .Trash, node_modules or MyIDE's own
 *  folder; 3 to 30 s where the length is known; ones with a transcript next to them, then voice-like names, first. */
export function rankClips(paths: string[], home = homedir()): Clip[] {
  const skip = [join(home, 'Library'), join(home, '.Trash'), join(home, '.myide'), STATE_DIR].map((d) => `${d}/`);
  const out: Clip[] = [];
  for (const path of paths.slice(0, 5000)) { // ponytail: header reads for the first 5000 hits only; enough for one home folder
    if (!path.startsWith(`${home}/`) || skip.some((d) => path.startsWith(d)) || path.includes('/node_modules/') || !AUDIO.test(path)) continue;
    const c = info(path);
    if (c.duration !== undefined && (c.duration < 3 || c.duration > 30)) continue;
    c.score = (c.transcript ? 2 : 0) + (/ref|reference|voice|clone/i.test(basename(path)) ? 1 : 0);
    out.push(c);
  }
  const top = out.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, 100);
  for (const c of top) offered.add(c.path);
  return top;
}

/** WAV clips on this Mac, through Spotlight. */
export async function findClips(): Promise<Clip[]> {
  const home = homedir();
  const out = await new Promise<string>((resolve, reject) =>
    execFile('/usr/bin/mdfind', ['-onlyin', home, 'kMDItemContentType == "com.microsoft.waveform-audio"'], { timeout: 30_000, maxBuffer: 32 * 1024 * 1024 },
      (err, so) => (err ? reject(new Error(`Spotlight search failed: ${err.message}`)) : resolve(so))));
  return rankClips(out.split('\n').filter(Boolean), home);
}

/** afconvert to a 24 kHz mono 16-bit WAV, the format the cloning model reads. */
export const afconvertArgs = (src: string, dest: string): string[] => ['-f', 'WAVE', '-d', 'LEI16@24000', '-c', '1', src, dest];

/** Copies a clip into the voices folder as <name>.wav (other formats converted), with its transcript. The original is untouched. */
export async function addClone(src: string, rawName: string, transcript = ''): Promise<Clone> {
  if (!offered.has(src)) throw new Error('Pick the clip with Add voice, Find voices or Design a voice first.');
  if (!AUDIO.test(src) || !statSync(src).isFile()) throw new Error(`${basename(src)} is not a WAV, M4A, MP3 or AIFF file.`);
  if (statSync(src).size > 200 * 1024 * 1024) throw new Error(`${basename(src)} is too long for a voice sample; use 3 to 30 seconds.`);
  const name = cloneName(rawName), dir = voicesDir(), dest = join(dir, `${name}.wav`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (existsSync(dest)) throw new Error(`There is already a voice called ${name}.`);
  if (/\.wav$/i.test(src)) copyFileSync(src, dest, constants.COPYFILE_EXCL);
  else {
    const tmp = join(dir, `.${name}.partial.wav`);
    try {
      await promisify(execFile)('/usr/bin/afconvert', afconvertArgs(src, tmp), { timeout: 120_000 });
      renameSync(tmp, dest);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw new Error(`Could not convert ${basename(src)}: ${((err as { stderr?: string }).stderr || (err as Error).message).trim()}`);
    }
  }
  chmodSync(dest, 0o600);
  setTranscript(name, transcript);
  return clones().find((c) => c.name === name)!;
}

/** What is said in a voice's clip; empty removes it (the voice is then cloned from the sound alone). */
export function setTranscript(name: string, text: string): void {
  const base = known(name), t = String(text ?? '').trim().slice(0, 2000);
  if (!t) { rmSync(`${base}.txt`, { force: true }); return; }
  writeFileSync(`${base}.txt`, `${t}\n`, { mode: 0o600 });
  chmodSync(`${base}.txt`, 0o600);
}

/** Read-back follows a renamed voice, and goes back to the first preset when its voice is removed. */
function retarget(from: string, to: string): void {
  const c = readConfig() as { speech?: SpeechSettings };
  if (c.speech?.voice === `clone:${from}`) writeConfig({ ...c, speech: { ...c.speech, voice: to ? `clone:${to}` : '' } } as ReturnType<typeof readConfig>);
}

export function renameClone(from: string, to: string): string {
  const a = known(from), name = cloneName(to), b = join(voicesDir(), name);
  if (name === from) return name;
  if (name.toLowerCase() !== from.toLowerCase() && existsSync(`${b}.wav`)) throw new Error(`There is already a voice called ${name}.`);
  renameSync(`${a}.wav`, `${b}.wav`);
  if (existsSync(`${a}.txt`)) renameSync(`${a}.txt`, `${b}.txt`);
  retarget(from, name);
  return name;
}

/** Deletes MyIDE's copy of the voice (and its transcript); the clip it came from is not touched. */
export function removeClone(name: string): void {
  const base = known(name);
  rmSync(`${base}.wav`, { force: true });
  rmSync(`${base}.txt`, { force: true });
  retarget(name, '');
}

/** Plays a clip MyIDE offered, as the current utterance (stop() ends it). */
export async function preview(path: string): Promise<string> {
  if (!offered.has(path)) throw new Error('MyIDE did not offer that clip.');
  stop();
  const child = spawn('/usr/bin/afplay', [path], { stdio: 'ignore' });
  const t = begin(() => child.kill());
  return new Promise((resolve) => { child.on('error', () => {}); child.on('close', () => { end(t); resolve(''); }); });
}

let designDir = '', designN = 0;
/** Generates `text` in a voice described in words (Qwen3-TTS VoiceDesign model, fetched on first use) into a
 *  temp WAV, offered for preview and for saving as a cloned voice. */
export async function design(description: string, text: string): Promise<string> {
  const e = tts(CLONER)!, python = componentPath(CLONER);
  if (!python) throw new Error(`Install ${e.name} first.`);
  const d = String(description ?? '').replace(/\s+/g, ' ').trim().slice(0, 500), words = speakable(String(text ?? '')).slice(0, 300);
  if (!d || !words) throw new Error('Describe the voice and give a sentence for it to say.');
  stop();
  designDir ||= mkdtempSync(join(tmpdir(), 'myide-design-'));
  const out = join(designDir, `design-${++designN}.wav`);
  const r = await ask(CLONER, python, { model: e.designModel, instruct: d, text: words, out });
  if (!r) throw new Error('Stopped.');
  if (r.ok === false || !existsSync(out)) throw new Error(`${e.name} could not design the voice: ${r.error ?? 'no audio'}`);
  offered.add(out);
  return out;
}

/** Transcribes a 16 kHz mono WAV with the installed whisper-cli and model. */
export async function transcribe(wav: Uint8Array): Promise<string> {
  const bin = componentPath('whisper'), model = dictate().model;
  if (!bin || !model) throw new Error('Install Local Whisper and a Whisper model to use this.');
  if (wav.byteLength > 64 * 1024 * 1024) throw new Error('That recording is too long.');
  const dir = mkdtempSync(join(tmpdir(), 'myide-dictation-'));
  try {
    const file = join(dir, 'in.wav');
    writeFileSync(file, wav);
    const out = await new Promise<string>((resolve, reject) =>
      execFile(bin, ['-m', model, '-f', file, '-nt', '-np'], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (err, so, se) =>
        err ? reject(new Error(`whisper-cli failed: ${(se || err.message).trim().split('\n').pop()}`)) : resolve(so)));
    return out.replace(/\[(BLANK_AUDIO|MUSIC|NOISE)[^\]]*\]/gi, '').replace(/\s+/g, ' ').trim();
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export function registerSpeechIpc(): void {
  onSpeaking((on) => broadcast('speech:speaking', on));
  onEngine((id) => broadcast('speech:engine', id));
  ipcMain.handle('speech:get', () => status());
  ipcMain.handle('speech:options', () => options());
  ipcMain.handle('speech:set', async (_e, patch: SpeechPatch) => {
    const st = await update(patch);
    broadcast('speech:change', st);
    return st;
  });
  // force: the Test voice key works while read-back is off. voice: one of the engine's voices instead of the chosen one (a clone's Test key).
  ipcMain.handle('speech:speak', async (_e, text: string, force = false, voice = '') => {
    const s = settings();
    if (!s.on && !force) return '';
    if (voice && !(await engineVoices(s.engine)).some((v) => v.id === voice)) throw new Error(`${engineName(s.engine)} has no voice ${voice}.`);
    const out = process.env.MYIDE_SAY_OUT; // tests write audio to a file instead of playing it
    // An engine that throws (rather than replying with an error) still reads the line, in the system voice, and says why.
    return speak(String(text ?? ''), { engine: s.engine, voice: voice || s.voice, rate: s.rate, out }).catch((err: Error) => {
      console.error('Read-back failed:', err);
      return speak(String(text ?? ''), { rate: s.rate, out }).then(() => `${engineName(s.engine)} failed (${err.message}), so this used the macOS system voice.`);
    });
  });
  // Cloned voices. Each change tells every window, so voice lists refresh.
  const changed = <T>(v: T): T => { broadcast('speech:change', status()); return v; };
  ipcMain.handle('speech:clones', () => clones());
  ipcMain.handle('speech:pick-clip', async (ev) => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(ev.sender)!, {
      title: 'Add a voice', message: 'Choose a short, clear clip of the voice: 3 to 30 seconds of speech. MyIDE copies it; the original stays where it is.',
      properties: ['openFile'], filters: [{ name: 'Audio', extensions: ['wav', 'm4a', 'mp3', 'aiff', 'aif'] }],
    });
    return r.canceled || !r.filePaths[0] ? null : clipInfo(r.filePaths[0]);
  });
  ipcMain.handle('speech:find-clips', () => findClips());
  ipcMain.handle('speech:preview', (_e, path: string) => preview(String(path)));
  ipcMain.handle('speech:design', (_e, description: string, text: string) => design(description, text));
  ipcMain.handle('speech:add-clone', async (_e, path: string, name: string, transcript: string) => changed(await addClone(String(path), name, transcript)));
  ipcMain.handle('speech:rename-clone', (_e, from: string, to: string) => changed(renameClone(String(from), to)));
  ipcMain.handle('speech:remove-clone', (_e, name: string) => changed(removeClone(String(name))));
  ipcMain.handle('speech:clone-text', (_e, name: string, text: string) => setTranscript(String(name), text));
  ipcMain.handle('speech:stop', () => stop());
  ipcMain.handle('speech:transcribe', (_e, wav: Uint8Array) => transcribe(wav));
}
