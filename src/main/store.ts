import { app, dialog } from 'electron';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// MYIDE_HOME points the app at another state folder (tests use a temp dir).
export const STATE_DIR = process.env.MYIDE_HOME || join(homedir(), '.myide');

const moved: string[] = [];

/** Reads `~/.myide/<name>`. Missing file gives `fallback`; corrupt JSON is moved aside (and reported once) so it is never overwritten. */
export function readJSON<T>(name: string, fallback: T): T {
  const file = join(STATE_DIR, name);
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    if (!(e instanceof SyntaxError)) throw e;
    const aside = `${file}.corrupt-${Date.now()}`;
    renameSync(file, aside);
    if (moved.push(aside) === 1) {
      void app.whenReady().then(() => {
        dialog.showErrorBox('MyIDE settings were damaged', `These files could not be read and were moved aside; MyIDE started with defaults:\n\n${moved.join('\n')}`);
        moved.length = 0;
      });
    }
    return fallback;
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
