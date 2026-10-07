import { app, dialog } from 'electron';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

/** Writes a file only its owner can read, creating owner-only folders. ~/.myide holds session ids and MCP tokens. */
export function writePrivate(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600); // mode only applies when the file is created
}

/** Writes `~/.myide/<name>` atomically: temp file in the same dir, then rename. */
export function writeJSON(name: string, data: unknown): void {
  const file = join(STATE_DIR, name);
  const tmp = `${file}.${process.pid}.tmp`;
  writePrivate(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, file);
}

/** At launch: folders under ~/.myide 0700, files 0600 (0700 if executable, e.g. hooks). Worktrees and
 *  Electron's own folder are locked at their root only; their contents keep the modes they have. */
export function lockDown(dir = STATE_DIR): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    try {
      const st = lstatSync(p);
      if (st.isDirectory()) {
        if (existsSync(join(p, '.git')) || (dir === STATE_DIR && name === 'electron')) chmodSync(p, 0o700);
        else lockDown(p);
      } else if (st.isFile()) chmodSync(p, st.mode & 0o100 ? 0o700 : 0o600);
    } catch { /* vanished or not ours */ }
  }
}
