import { ipcMain } from 'electron';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { COMPONENTS_DIR, componentPath, detect, MANIFEST, rows, type Entry, type Row } from './components';
import { readConfig, writeConfig } from './projects';
import { broadcast } from './store';

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

async function viaHelper(id: string, python: string, words: string, o: { voice?: string; rate?: number; out?: string }): Promise<string> {
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
      h.child.stdin!.write(`${JSON.stringify({ id: n, ...helperRequest(id, o.voice, o.rate), text: words, ...(o.out ? { out: o.out } : {}) })}\n`);
    }
    r = await replied;
  } catch (err) { r = { ok: false, error: (err as Error).message }; }
  if (current !== t) return ''; // stopped, or replaced by the next line
  end(t);
  return r.ok === false ? viaSay(words, '', o.rate, o.out, `${engineName(id)} failed (${r.error}), so this used the macOS system voice.`) : '';
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
  // force: the Test voice key works while read-back is off.
  ipcMain.handle('speech:speak', async (_e, text: string, force = false) => {
    const s = settings();
    if (!s.on && !force) return '';
    return speak(String(text ?? ''), { engine: s.engine, voice: s.voice, rate: s.rate, out: process.env.MYIDE_SAY_OUT }); // MYIDE_SAY_OUT: tests write audio to a file instead of playing it
  });
  ipcMain.handle('speech:stop', () => stop());
  ipcMain.handle('speech:transcribe', (_e, wav: Uint8Array) => transcribe(wav));
}
