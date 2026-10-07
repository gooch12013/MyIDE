import type { Prefs } from '../main/prefs';
import { errText, h, key } from './dom';
import { removeProject, resetLayout } from './layouts';
import { activeProject, allProjects, loadProjects } from './projects';
import { registerPanel } from './registry';
import { api as staff, led } from './employees';
import { openCommandTerminal, reloadTerminalSettings } from './terminal';

const api = window.myide;
type Info = Awaited<ReturnType<typeof api.prefs.get>>;

const field = (props: Partial<HTMLInputElement>) => h('input', { className: 'input', ...props });
function pref(name: string, hint: string, ...ctl: Node[]): HTMLElement {
  return h('div', { className: 'pref' },
    h('div', { className: 'pref-label' }, h('span', { className: 'pref-name', textContent: name }), ...(hint ? [h('span', { className: 'pref-hint', textContent: hint })] : [])),
    h('div', { className: 'pref-ctl' }, ...ctl));
}
function toggle(label: string, checked: boolean, onchange: (on: boolean) => void): HTMLLabelElement {
  const box = field({ type: 'checkbox', className: 'switch', checked });
  box.onchange = () => onchange(box.checked);
  return h('label', { className: 'toggle' }, box, label);
}

// Project colours: warn near the accent amber (the live colour) or near another project's colour.
const AMBER = '#ffb21a';
const rgb = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const dist = (a: string, b: string) => { const x = rgb(a), y = rgb(b); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); };
function colourWarning(colour: string, id: string): string {
  if (dist(colour, AMBER) < 60) return 'Too close to amber, which marks the live project and selection.';
  const twin = allProjects().find((p) => p.id !== id && dist(p.colour, colour) < 40);
  if (!twin) return '';
  return twin.colour.toLowerCase() === colour.toLowerCase() ? `Same colour as ${twin.name}.` : `Hard to tell apart from ${twin.name}.`;
}

const SECTIONS = [['appearance', 'Appearance'], ['projects', 'Projects'], ['layouts', 'Layouts'], ['startup', 'Startup'], ['claude', 'Claude'], ['advanced', 'Advanced']] as const;
type Section = (typeof SECTIONS)[number][0];

registerPanel('preferences', {
  title: 'Preferences',
  create(el) {
    el.classList.add('prefs');
    const nav = h('nav', { className: 'prefs-nav' });
    nav.setAttribute('aria-label', 'Preference sections');
    const main = h('div', { className: 'prefs-main' });
    el.append(nav, main);
    let current: Section = 'appearance';
    const navKeys = SECTIONS.map(([id, title]) => key(title, () => void show(id), { className: 'key pnav-key' }));
    nav.append(...navKeys);

    async function show(id: Section = current): Promise<void> {
      current = id;
      SECTIONS.forEach(([s], i) => navKeys[i].setAttribute('aria-current', String(s === id)));
      const info = await api.prefs.get();
      const title = SECTIONS.find(([s]) => s === id)![1];
      const status = h('p', { className: 'pref-status' });
      status.setAttribute('aria-live', 'polite');
      const say = (t: string) => { status.textContent = t; };
      const body = await build[id](info, say);
      main.replaceChildren(h('section', { className: 'psec' }, h('h2', { className: 'psec-title', textContent: title }), ...body, status));
    }

    const set = async (patch: Partial<Prefs>) => {
      await api.prefs.set(patch);
      if ('terminalFontFamily' in patch || 'terminalFontSize' in patch) reloadTerminalSettings();
    };

    const build: Record<Section, (info: Info, say: (t: string) => void) => Promise<Node[]> | Node[]> = {
      appearance({ prefs }) {
        const size = field({ type: 'range', min: '12', max: '18', step: '1', value: String(prefs.uiFontSize), className: 'range' });
        size.setAttribute('aria-label', 'UI font size');
        const out = h('output', { className: 'pref-value', value: `${prefs.uiFontSize} px` });
        size.oninput = () => { out.value = `${size.value} px`; void set({ uiFontSize: Number(size.value) }); };
        const reset = h('button', { type: 'button', className: 'btn', textContent: 'Reset to 14', onclick: () => { size.value = '14'; size.dispatchEvent(new Event('input')); } });

        const family = field({ value: prefs.terminalFontFamily, placeholder: 'From Ghostty', className: 'input mono grow', spellcheck: false });
        family.setAttribute('aria-label', 'Terminal font family');
        family.onchange = () => void set({ terminalFontFamily: family.value.trim() });
        const tsize = field({ type: 'number', min: '8', max: '32', value: prefs.terminalFontSize ? String(prefs.terminalFontSize) : '', placeholder: 'Ghostty', className: 'input num' });
        tsize.setAttribute('aria-label', 'Terminal font size');
        tsize.onchange = () => void set({ terminalFontSize: Math.min(32, Math.max(0, Number(tsize.value) || 0)) });
        return [
          pref('UI font size', 'Body text size. Every label and key scales with it, pop-out windows included.', size, out, reset),
          pref('Terminal font', 'A CSS font list, e.g. "Iosevka", monospace. Empty uses your Ghostty config.', family),
          pref('Terminal font size', 'Empty uses your Ghostty config.', tsize, h('span', { className: 'pref-unit', textContent: 'px' })),
          pref('Reduce motion', 'Turns off transitions and animations in every window.', toggle('Reduce motion', prefs.reduceMotion, (on) => void set({ reduceMotion: on }))),
        ];
      },

      projects({ palette }, say) {
        const rows = allProjects().map((p) => {
          const row = h('div', { className: 'proj-row' });
          row.style.setProperty('--proj', p.colour);
          const name = field({ value: p.name, maxLength: 60, className: 'input proj-name-in' });
          name.setAttribute('aria-label', `Name of ${p.name}`);
          name.onchange = async () => {
            if (!name.value.trim()) { name.value = p.name; return; }
            await api.prefs.updateProject(p.id, { name: name.value });
            await loadProjects();
          };
          const warn = h('p', { className: 'pref-warn' });
          const pick = async (colour: string) => {
            row.style.setProperty('--proj', colour);
            custom.value = colour;
            warn.textContent = colourWarning(colour, p.id);
            await api.prefs.updateProject(p.id, { colour });
            await loadProjects();
            swatches.forEach((s) => s.setAttribute('aria-pressed', String(s.dataset.c === colour)));
          };
          const swatches = palette.map((c) => {
            const s = h('button', { type: 'button', className: 'swatch', title: c, onclick: () => void pick(c) });
            s.dataset.c = c;
            s.style.background = c;
            s.setAttribute('aria-label', `Colour ${c}`);
            s.setAttribute('aria-pressed', String(c === p.colour));
            return s;
          });
          const custom = field({ type: 'color', value: p.colour, className: 'swatch swatch--custom', title: 'Any colour' });
          custom.setAttribute('aria-label', `Custom colour for ${p.name}`);
          custom.oninput = () => void pick(custom.value);
          warn.textContent = colourWarning(p.colour, p.id);
          row.append(
            name,
            h('div', { className: 'proj-path' }, h('span', { className: 'path', textContent: `‎${p.path}`, title: p.path }), key('Reveal in Finder', () => void api.prefs.revealProject(p.id))),
            h('div', { className: 'swatches' }, ...swatches, custom),
            h('button', { type: 'button', className: 'btn btn--quiet rm', textContent: 'Remove', onclick: async () => { await removeProject(p); void show(); } }),
            warn,
          );
          return row;
        });
        const add = key('+ Add project', async () => {
          try { if (await api.projects.add()) { await loadProjects(); void show(); } } catch (e) { say(errText(e)); }
        });
        return [
          h('p', { className: 'psec-lede', textContent: 'Each project is a folder with its own terminals and layout. Its colour marks its key in the top bar.' }),
          ...(rows.length ? rows : [h('p', { className: 'pref-hint', textContent: 'No projects yet.' })]),
          h('div', { className: 'pref-ctl' }, add),
        ];
      },

      async layouts(_info, say) {
        const named = Object.keys((await api.layouts.get()).named).sort((a, b) => a.localeCompare(b));
        const namedRows = named.map((n) => {
          const input = field({ value: n, maxLength: 60, className: 'input grow' });
          input.setAttribute('aria-label', `Name of layout ${n}`);
          input.onchange = async () => {
            try { await api.prefs.renameLayout(n, input.value); void show(); } catch (e) { input.value = n; say(errText(e)); }
          };
          return h('div', { className: 'pref-ctl layout-row' }, input, h('button', {
            type: 'button', className: 'btn btn--quiet rm', textContent: 'Delete', onclick: async () => { await api.prefs.deleteLayout(n); void show(); },
          }));
        });
        const resets = allProjects().map((p) => {
          const row = pref(p.name, p.id === activeProject()?.id ? 'Current project: its open panels close.' : '', key('Reset to default', async () => {
            if (!confirm(`Reset the layout of ${p.name} to a single terminal?`)) return;
            await resetLayout(p.id);
            say(`${p.name} will open with a single terminal.`);
          }));
          row.style.setProperty('--proj', p.colour);
          row.classList.add('pref--proj');
          return row;
        });
        return [
          h('h3', { className: 'legend psec-sub', textContent: 'Saved layouts' }),
          ...(namedRows.length ? namedRows : [h('p', { className: 'pref-hint', textContent: 'None yet. View > Layouts > Save Current Layout As… adds one.' })]),
          h('h3', { className: 'legend psec-sub', textContent: 'Project layouts' }),
          ...(resets.length ? resets : [h('p', { className: 'pref-hint', textContent: 'No projects yet.' })]),
        ];
      },

      startup({ prefs, openAtLogin }) {
        return [
          pref('Open at login', 'Start MyIDE when you log in to this Mac.', toggle('Open at login', openAtLogin, (on) => void api.prefs.setOpenAtLogin(on))),
          pref('Restore last session', 'Reopen the last project with its layout. Off: start on the first project with one terminal.',
            toggle('Restore last project and layout', prefs.restoreLast, (on) => void set({ restoreLast: on }))),
        ];
      },

      async claude(_info, say) {
        const i = await staff.claude.info();
        const state = !i.version ? led('failed', 'Not found') : i.tested ? led('working', 'Tested') : led('interrupted', 'Untested');
        return [
          pref('Claude Code', i.version ? (i.tested ? 'The version MyIDE is tested with.' : `MyIDE is tested with ${i.testedVersion}.`) : 'Install Claude Code to use employees.',
            h('span', { className: 'path', textContent: i.version ?? 'none' }), state),
          pref('Log in', 'Opens Claude Code in a terminal, where it runs its own login.', key('Log in', () => {
            openCommandTerminal(undefined, 'env -u CLAUDE_CONFIG_DIR claude'); // the default account, as employees use
          })),
          pref('Test', 'Runs one tiny Claude turn to check employees can work.', key('Test', async () => {
            say('Testing…');
            try { const r = await staff.claude.test(); say(`${r.ok ? 'Works' : 'Failed'}: ${r.detail}`); } catch (e) { say(errText(e)); }
          })),
        ];
      },

      advanced({ dataDir }, say) {
        return [
          pref('Data folder', 'Projects, preferences and layouts. Set MYIDE_HOME to use another folder.',
            h('span', { className: 'path', textContent: dataDir }), key('Reveal', () => void api.prefs.revealData())),
          pref('Export settings', 'Writes projects, preferences and layouts to one JSON file. No secrets are in it.',
            key('Export…', async () => { const f = await api.prefs.exportSettings(); if (f) say(`Exported to ${f}`); })),
          pref('Import settings', 'Replaces projects, preferences and layouts with an exported file, then restarts MyIDE.',
            key('Import…', async () => { say((await api.prefs.importSettings()) ?? ''); })),
        ];
      },
    };

    void show();
    return {};
  },
});
