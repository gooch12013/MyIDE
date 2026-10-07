import { ipcMain, shell } from 'electron';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { finished } from 'node:stream/promises';
import { promisify } from 'node:util';
import { readConfig, writeConfig } from './projects';
import { findOnPath, spawnEnv } from './pty';
import { broadcast, STATE_DIR } from './store';

// Optional components (feature 23): nothing here is needed to run MyIDE. The manifest ships in the
// app; config.json `components` records what was installed into ~/.myide/components/<id>/ or which
// existing install on disk to use. Downloads happen only on a click, from the publisher's own URL.

export interface Entry {
  id: string; name: string; kind: string; adds: string; licence: string; licenceUrl: string; version: string;
  /** build-needed: no download for macOS; coming-soon: install not built yet. Both still offer an existing install. */
  status?: 'build-needed' | 'coming-soon'; note?: string; advanced?: string;
  url?: string; sha256?: string; size?: number; sizeNote?: string;
  archive?: 'zip';
  /** The file to use, relative to the component folder (inside the archive for a zip). */
  file?: string;
  detect: { bin?: string; dirs?: string[]; match?: string };
  /** kind "tts": a read-back engine, offered in Preferences > Voice & read-back with these voices. */
  voices?: { id: string; label: string; lang: string }[];
}
export interface Choice { path: string; version?: string; existing?: boolean }
export interface Row extends Entry { state: 'installed' | 'existing' | 'missing'; path?: string; installedVersion?: string; disk?: number; found: string[] }

export const MANIFEST: Entry[] = require('../../build/components.json');
export const COMPONENTS_DIR = join(STATE_DIR, 'components');

const entry = (id: string): Entry => {
  const e = MANIFEST.find((x) => x.id === id);
  if (!e) throw new Error(`Unknown component ${id}`);
  return e;
};
const choices = (): Record<string, Choice> => (readConfig() as { components?: Record<string, Choice> }).components ?? {};
function setChoice(id: string, c: Choice | null): void {
  const all = { ...choices() };
  if (c) all[id] = c; else delete all[id];
  writeConfig({ ...readConfig(), components: all } as ReturnType<typeof readConfig>);
}

/** The path to use for a component (its binary or model file), or null when it is not available. */
export function componentPath(id: string): string | null {
  const p = choices()[id]?.path;
  return p && existsSync(p) ? p : null;
}

const tilde = (p: string) => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

/** Existing installs on this Mac: `bin` on the login PATH, or files/folders in `dirs` matching `match`. Never our own folder. */
export async function detect(e: Entry): Promise<string[]> {
  const found = new Set<string>();
  if (e.detect.bin) {
    for (const p of findOnPath(e.detect.bin, (await spawnEnv()).PATH)) if (!p.startsWith(COMPONENTS_DIR)) found.add(p);
  }
  if (e.detect.dirs && e.detect.match) {
    const re = new RegExp(e.detect.match);
    for (const d of e.detect.dirs.map(tilde)) {
      try { for (const n of readdirSync(d)) if (re.test(n)) found.add(join(d, n)); } catch { /* not there */ }
    }
  }
  return [...found];
}

const du = (dir: string) => new Promise<number | undefined>((resolve) =>
  execFile('/usr/bin/du', ['-sk', dir], { timeout: 10_000 }, (err, out) => resolve(err ? undefined : Number(out.split('\t')[0]) * 1024)));

export async function rows(): Promise<Row[]> {
  const c = choices();
  return Promise.all(MANIFEST.map(async (e) => {
    const ch = c[e.id];
    const path = componentPath(e.id) ?? undefined;
    const state = !path ? 'missing' : ch.existing ? 'existing' : 'installed';
    const found = (await detect(e)).filter((p) => p !== path);
    return { ...e, state, path, installedVersion: state === 'installed' ? ch.version : undefined, disk: state === 'installed' ? await du(join(COMPONENTS_DIR, e.id)) : undefined, found };
  }));
}

const busy = new Set<string>();

/** Downloads, checks and unpacks a component into ~/.myide/components/<id>/; replaces an older install. */
export async function install(id: string, progress: (got: number, total: number) => void = () => {}): Promise<string> {
  const e = entry(id);
  if (!e.url || !e.file || e.status) throw new Error(`${e.name} cannot be installed from MyIDE yet.`);
  if (!e.url.startsWith('https://')) throw new Error('Downloads must use HTTPS.');
  if (!/^[0-9a-f]{64}$/.test(e.sha256 ?? '')) throw new Error(`${e.name} has no published checksum to check the download against.`);
  if (busy.has(id)) throw new Error(`${e.name} is already downloading.`);
  // ponytail: one arm64 download per entry. Ceiling: Intel Macs get a binary that will not run; add per-arch URLs if anyone needs them.
  const dir = join(COMPONENTS_DIR, id), tmp = `${dir}.partial`, old = `${dir}.old`;
  const cap = (e.size ?? Infinity) * 1.1; // a download well past its published size is not the file we want
  try {
    busy.add(id);
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true, mode: 0o700 });
    const res = await fetch(e.url);
    if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
    if (!res.url.startsWith('https://')) throw new Error('The download was redirected off HTTPS.');
    const total = Number(res.headers.get('content-length')) || e.size || 0;
    const tooBig = () => new Error(`The download is larger than ${e.name}'s published size; nothing was installed.`);
    if (total > cap) throw tooBig();
    const file = join(tmp, basename(new URL(e.url).pathname));
    const hash = createHash('sha256');
    const out = createWriteStream(file, { mode: 0o600 });
    let got = 0, last = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      got += chunk.length;
      if (got > cap) { out.destroy(); throw tooBig(); }
      if (!out.write(chunk)) await once(out, 'drain');
      if (Date.now() - last > 250) { last = Date.now(); progress(got, total); }
    }
    out.end();
    await finished(out);
    progress(got, total);
    if (hash.digest('hex') !== e.sha256) throw new Error('The download does not match its published checksum; nothing was installed.');
    if (e.archive === 'zip') {
      await promisify(execFile)('/usr/bin/ditto', ['-x', '-k', file, tmp]);
      rmSync(file);
    }
    const target = join(tmp, e.file);
    if (!existsSync(target)) throw new Error(`${e.file} is missing from the download.`);
    // Swap: the old install stays until the new one is in place.
    rmSync(old, { recursive: true, force: true });
    if (existsSync(dir)) renameSync(dir, old);
    try { renameSync(tmp, dir); } catch (err) { if (existsSync(old)) renameSync(old, dir); throw err; }
    rmSync(old, { recursive: true, force: true });
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  } finally { busy.delete(id); }
  const path = join(dir, e.file);
  setChoice(id, { path, version: e.version });
  return path;
}

/** Forgets the component. Our own install is deleted; an existing one elsewhere is left untouched. */
export function remove(id: string): void {
  entry(id);
  if (!choices()[id]?.existing) rmSync(join(COMPONENTS_DIR, id), { recursive: true, force: true });
  setChoice(id, null);
}

/** Uses an install found on disk. Only a path detection found is accepted, so the renderer cannot point MyIDE at any program. */
export async function useExisting(id: string, path: string): Promise<void> {
  if (!(await detect(entry(id))).includes(path)) throw new Error(`${path} is not a ${entry(id).name} install MyIDE found.`);
  setChoice(id, { path, existing: true });
}

/** After any install, update or removal; the renderer re-reads what depends on components (e.g. dictation). */
const changed = (): void => broadcast('components:change');

export function registerComponentsIpc(): void {
  ipcMain.handle('components:list', () => rows());
  ipcMain.handle('components:install', async (ev, id: string) => {
    try {
      return await install(id, (got, total) => { if (!ev.sender.isDestroyed()) ev.sender.send('components:progress', id, got, total); });
    } finally { changed(); }
  });
  ipcMain.handle('components:remove', (_e, id: string) => { remove(id); changed(); });
  ipcMain.handle('components:use', async (_e, id: string, path: string) => { await useExisting(id, path); changed(); });
  ipcMain.handle('components:reveal', () => { mkdirSync(COMPONENTS_DIR, { recursive: true, mode: 0o700 }); return shell.openPath(COMPONENTS_DIR); });
}
