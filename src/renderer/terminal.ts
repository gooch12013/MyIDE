import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { isParking, registerPanel } from './registry';

const { pty, terminal } = window.myide;
const { settings } = terminal;
const terms = new Map<string, Terminal>(); // panel id (= PTY id) -> xterm
const infoHandlers = new Map<string, (info: { cwd: string; process: string }) => void>();
pty.onData((id, data) => terms.get(id)?.write(data));
pty.onExit((id, code) => terms.get(id)?.write(`\r\n\x1b[2m[process exited with code ${code}]\x1b[0m\r\n`));
pty.onInfo((id, info) => infoHandlers.get(id)?.(info));

async function paste(term: Terminal): Promise<void> {
  const text = await terminal.paste();
  if (text) term.paste(text);
}

registerPanel('terminal', {
  title: 'Terminal',
  create(el, params, api) {
    const id = api.id;
    const term = new Terminal({
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      lineHeight: 1.15,
      scrollback: 10_000,
      cursorBlink: true,
      theme: settings.theme,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_e, uri) => void terminal.openUrl(uri)));
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

    // Title is the cwd's folder plus the foreground program when it isn't the shell; the cwd is
    // saved in params so a restored layout reopens the terminal there.
    let cwd = typeof params.cwd === 'string' ? params.cwd : '';
    const onInfo = (info: { cwd: string; process: string }) => {
      if (info.cwd !== cwd) { cwd = info.cwd; api.updateParameters({ ...params, cwd }); }
      const folder = cwd.split('/').filter(Boolean).pop() || '/';
      api.setTitle(info.process ? `${folder} · ${info.process}` : folder);
    };
    infoHandlers.set(id, onInfo);

    // Cmd+C / Cmd+V / Cmd+K, for when no app menu catches them first (and in pop-outs).
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown' || !ev.metaKey || ev.ctrlKey || ev.altKey || ev.shiftKey) return true;
      const k = ev.key.toLowerCase();
      if (k === 'c') { if (term.hasSelection()) terminal.copy(term.getSelection()); }
      else if (k === 'v') void paste(term);
      else if (k === 'k') term.clear();
      else return true;
      ev.preventDefault();
      return false;
    });
    if (settings.copyOnSelect) term.onSelectionChange(() => { if (term.hasSelection()) terminal.copy(term.getSelection()); });
    el.addEventListener('contextmenu', async (ev) => {
      ev.preventDefault();
      const action = await terminal.menu(term.hasSelection(), cwd);
      if (action === 'copy') terminal.copy(term.getSelection());
      else if (action === 'paste') await paste(term);
      else if (action === 'clear') term.clear();
      term.focus();
    });

    terms.set(id, term);
    term.onData((d) => pty.write(id, d));
    let replaying = false;
    term.onResize(({ cols, rows }) => { if (!replaying) pty.resize(id, cols, rows); });
    refit();
    void pty.spawn(id, { cwd: cwd || undefined, cols: term.cols, rows: term.rows }).then(async (info) => {
      onInfo(info);
      if (!info.replay?.length) return;
      // Reattached to a running shell: redraw its recent output at the sizes it was drawn for, then refit.
      replaying = true;
      for (const seg of info.replay) {
        term.resize(seg.cols, seg.rows);
        await new Promise<void>((r) => term.write(seg.data, r));
      }
      replaying = false;
      refit();
      pty.resize(id, term.cols, term.rows);
    });
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
        infoHandlers.delete(id);
        if (!isParking()) pty.kill(id); // a project switch parks the shell; it reattaches by id
        term.dispose();
      },
    };
  },
});
