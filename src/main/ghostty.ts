import { ipcMain } from 'electron';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface TerminalSettings {
  fontFamily: string;
  fontSize: number;
  copyOnSelect: boolean;
  /** xterm ITheme fields. */
  theme: Record<string, string>;
}

const DEFAULT_FONTS = ['"JetBrains Mono"', 'Menlo', 'monospace'];
const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
const KEYS: Record<string, string> = {
  background: 'background',
  foreground: 'foreground',
  'cursor-color': 'cursor',
  'cursor-text': 'cursorAccent',
  'selection-background': 'selectionBackground',
  'selection-foreground': 'selectionForeground',
};

const hex = (v: string): string | undefined => (/^#?[0-9a-f]{6}$/i.test(v) ? (v.startsWith('#') ? v : `#${v}`) : undefined);

/** Parses Ghostty's key = value lines. Includes, theme files and named colours are ignored. */
export function parseGhostty(text: string): TerminalSettings {
  const fonts: string[] = [];
  const theme: TerminalSettings['theme'] = {
    background: '#08090b', foreground: '#e7e9ec', cursor: '#ffb21a', cursorAccent: '#1c1300',
    selectionBackground: '#ffb21a59', selectionForeground: '#ffffff',
  };
  let fontSize = 13;
  let copyOnSelect = true;
  for (const raw of text.split('\n')) {
    const m = /^\s*([a-z0-9-]+)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m) continue;
    const [, key, value] = m;
    const v = value.replace(/^"(.*)"$/, '$1');
    if (key === 'font-family' && v) fonts.push(`"${v.replace(/"/g, '')}"`);
    else if (key === 'font-size' && Number(v) > 0) fontSize = Number(v);
    else if (key === 'copy-on-select') copyOnSelect = v !== 'false';
    else if (KEYS[key] && hex(v)) theme[KEYS[key]] = hex(v)!;
    else if (key === 'palette') {
      const p = /^(\d+)\s*=\s*(\S+)$/.exec(v);
      const n = p ? Number(p[1]) : -1;
      const c = p && hex(p[2]);
      // ponytail: only the 16 ANSI colours; entries 16-255 keep xterm's defaults.
      if (!c || n > 15) continue;
      if (n < 8) theme[ANSI[n]] = c;
      else theme[`bright${ANSI[n - 8][0].toUpperCase()}${ANSI[n - 8].slice(1)}`] = c;
    }
  }
  return { fontFamily: [...fonts, ...DEFAULT_FONTS].join(', '), fontSize, copyOnSelect, theme };
}

function load(): TerminalSettings {
  try {
    return parseGhostty(readFileSync(join(homedir(), '.config', 'ghostty', 'config'), 'utf8'));
  } catch {
    return parseGhostty('');
  }
}

// Read once at launch; the preload fetches it synchronously so terminals can be built straight away.
const settings = load();
ipcMain.on('terminal:settings', (e) => { e.returnValue = settings; });
