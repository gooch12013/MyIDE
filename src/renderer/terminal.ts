import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { registerPanel } from './registry';

const { pty } = window.myide;
const terms = new Map<string, Terminal>(); // panel id (= PTY id) -> xterm
pty.onData((id, data) => terms.get(id)?.write(data));
pty.onExit((id, code) => terms.get(id)?.write(`\r\n\x1b[2m[process exited with code ${code}]\x1b[0m\r\n`));

const theme = {
  background: '#08090b',
  foreground: '#e7e9ec',
  cursor: '#ffb21a',
  cursorAccent: '#1c1300',
  selectionBackground: '#ffb21a59',
  selectionForeground: '#ffffff',
};

registerPanel('terminal', {
  title: 'Terminal',
  create(el, params, api) {
    const id = api.id;
    const term = new Terminal({
      fontFamily: '"JetBrains Mono", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.15,
      scrollback: 10_000,
      cursorBlink: true,
      theme,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);

    let webgl: WebglAddon | undefined;
    let ownerWindow: Window | null = null;
    const loadWebgl = () => {
      try {
        webgl = new WebglAddon();
        webgl.onContextLoss(() => { webgl?.dispose(); webgl = undefined; });
        term.loadAddon(webgl);
      } catch {
        webgl = undefined; // falls back to xterm's DOM renderer
      }
      ownerWindow = el.ownerDocument.defaultView;
    };
    loadWebgl();
    // The WebGL context dies silently (no onContextLoss) when the panel's window changes, e.g. a
    // pop-out docking back. Swapping in a fresh addon keeps the scrollback. A hidden tab is adopted
    // into its new document only when next shown, so this runs on resize as well as on move.
    const rehome = () => {
      if (!el.isConnected || el.ownerDocument.defaultView === ownerWindow) return;
      webgl?.dispose();
      loadWebgl();
      term.refresh(0, term.rows - 1);
    };
    const refit = () => {
      rehome();
      try { fit.fit(); } catch { /* not laid out yet */ }
    };

    terms.set(id, term);
    term.onData((d) => pty.write(id, d));
    term.onResize(({ cols, rows }) => pty.resize(id, cols, rows));
    refit();
    void pty.spawn(id, { cwd: typeof params.cwd === 'string' ? params.cwd : undefined, cols: term.cols, rows: term.rows });
    term.focus();

    const subs = [
      api.onDidDimensionsChange(refit),
      api.onDidLocationChange(() => {
        rehome();
        // Focus does not follow the panel into (or out of) a pop-out window.
        setTimeout(() => api.isActive && term.focus(), 50);
      }),
    ];
    return {
      onShow: () => { refit(); term.focus(); },
      dispose() {
        subs.forEach((s) => s.dispose());
        terms.delete(id);
        pty.kill(id);
        term.dispose();
      },
    };
  },
});
