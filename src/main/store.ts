import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const STATE_DIR = join(homedir(), '.myide');

/** Reads `~/.myide/<name>`. Missing file gives `fallback`; corrupt JSON throws so nobody overwrites it blindly. */
export function readJSON<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(join(STATE_DIR, name), 'utf8')) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw e;
  }
}

/** Writes `~/.myide/<name>` atomically: temp file in the same dir, then rename. */
export function writeJSON(name: string, data: unknown): void {
  const file = join(STATE_DIR, name);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, file);
}
