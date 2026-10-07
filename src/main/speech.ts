import { ipcMain } from 'electron';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { componentPath } from './components';
import { readConfig, writeConfig } from './projects';
import { broadcast } from './store';

// Read-back through macOS `say` (feature 14), off by default, one utterance at a time; dictation
// through an installed whisper-cli. Every child runs through execFile/spawn with an argument list,
// never a shell; the spoken text goes in on stdin.

export interface SpeechSettings { on: boolean; voice: string; rate: number }
export interface SpeechStatus extends SpeechSettings { dictation: boolean }
const DEFAULTS: SpeechSettings = { on: false, voice: '', rate: 0 }; // '' and 0: the system voice and speed

export function settings(): SpeechSettings {
  const s = (readConfig() as { speech?: Partial<SpeechSettings> }).speech ?? {};
  return {
    on: typeof s.on === 'boolean' ? s.on : DEFAULTS.on,
    voice: typeof s.voice === 'string' ? s.voice : DEFAULTS.voice,
    rate: typeof s.rate === 'number' ? s.rate : DEFAULTS.rate,
  };
}
export const status = (): SpeechStatus => ({ ...settings(), dictation: !!(componentPath('whisper') && componentPath('whisper-model')) });

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

/** Summaries only: fenced code is dropped and the length capped, so a stray report never reads out a file. */
export function speakable(text: string): string {
  const t = text.replace(/```[\s\S]*?(```|$)/g, ' (code) ').replace(/`([^`\n]{40,})`/g, ' (code) ').replace(/\s+/g, ' ').trim();
  return t.length > 1500 ? `${t.slice(0, 1500)}…` : t;
}

let current: ChildProcess | null = null;
let emit = (_speaking: boolean): void => {};
export const onSpeaking = (cb: (speaking: boolean) => void): void => { emit = cb; };
export const speaking = () => !!current;

/** Stops any utterance, then says `text`. Resolves when it ends or is stopped. `out` writes an AIFF instead of playing (tests). */
export function speak(text: string, o: { voice?: string; rate?: number; out?: string } = {}): Promise<void> {
  stop();
  const words = speakable(text);
  if (!words) return Promise.resolve();
  const args: string[] = [];
  if (o.voice) args.push('-v', o.voice);
  if (o.rate) args.push('-r', String(Math.round(Math.min(400, Math.max(90, o.rate)))));
  if (o.out) args.push('-o', o.out);
  const child = spawn('/usr/bin/say', args, { stdio: ['pipe', 'ignore', 'ignore'] });
  current = child;
  emit(true);
  child.stdin!.on('error', () => {}); // killed before reading
  child.stdin!.end(words);
  return new Promise((resolve) => child.on('close', () => {
    if (current === child) { current = null; emit(false); }
    resolve();
  }));
}
export function stop(): void {
  if (!current) return;
  const c = current;
  current = null;
  c.kill();
  emit(false);
}

/** Transcribes a 16 kHz mono WAV with the installed whisper-cli and model. */
export async function transcribe(wav: Uint8Array): Promise<string> {
  const bin = componentPath('whisper'), model = componentPath('whisper-model');
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
  ipcMain.handle('speech:get', () => status());
  ipcMain.handle('speech:voices', () => voices());
  ipcMain.handle('speech:set', (_e, patch: Partial<SpeechSettings>) => {
    const s = settings();
    if (typeof patch?.on === 'boolean') s.on = patch.on;
    if (typeof patch?.voice === 'string') s.voice = patch.voice.slice(0, 100);
    if (typeof patch?.rate === 'number' && Number.isFinite(patch.rate)) s.rate = patch.rate && Math.min(400, Math.max(90, patch.rate));
    writeConfig({ ...readConfig(), speech: s } as ReturnType<typeof readConfig>);
    if (!s.on) stop();
    broadcast('speech:change', status());
    return status();
  });
  // force: the Test voice key works while read-back is off.
  ipcMain.handle('speech:speak', async (_e, text: string, force = false) => {
    const s = settings();
    if (!s.on && !force) return;
    await speak(String(text ?? ''), { voice: s.voice, rate: s.rate, out: process.env.MYIDE_SAY_OUT }); // MYIDE_SAY_OUT: tests write audio to a file instead of playing it
  });
  ipcMain.handle('speech:stop', () => stop());
  ipcMain.handle('speech:transcribe', (_e, wav: Uint8Array) => transcribe(wav));
}
