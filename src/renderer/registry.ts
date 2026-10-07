import {
  createDockview, themeDark,
  type AddPanelPositionOptions, type DockviewApi, type DockviewGroupPanel, type DockviewPanelApi, type IContentRenderer, type IHeaderActionsRenderer, type IWatermarkRenderer,
} from 'dockview-core';
import { h, key } from './dom';
import { activeTab, allProjects } from './projects';

export interface PanelInstance {
  dispose?(): void;
  /** Called when the panel's tab becomes visible. */
  onShow?(): void;
}

export interface PanelDef {
  title: string;
  /** One line for the add-panel list; panels without one (an employee's detail) are not offered there. */
  description?: string;
  /** Shows a scope picker (params.scope: 'tab', 'all' or a project id; see resolveScope) and rebuilds on a change. */
  scoped?: boolean;
  /** Builds the panel into `container`. `params` are the ones given to openPanel (saved with the layout). */
  create(container: HTMLElement, params: Record<string, unknown>, api: DockviewPanelApi): PanelInstance;
}

const defs = new Map<string, PanelDef>();
let dock: DockviewApi;

export function registerPanel(id: string, def: PanelDef): void {
  defs.set(id, def);
}

/** Adds a new instance of a registered panel, as a tab in the active group unless `place` says where. `place.id` picks the panel id. */
export function openPanel(id: string, params: Record<string, unknown> = {}, place: { position?: AddPanelPositionOptions; initialWidth?: number; initialHeight?: number; id?: string } = {}) {
  const def = defs.get(id);
  if (!def) throw new Error(`No panel registered as "${id}"`);
  return dock.addPanel({ id: `${id}-${crypto.randomUUID().slice(0, 8)}`, component: id, title: def.title, params, ...place });
}

/** Registered panel types, for the Panels menu. */
export const panelTypes = (): { id: string; title: string }[] => [...defs].map(([id, d]) => ({ id, title: d.title }));
/** The panel types offered by the + key, with their one-line descriptions. */
export const addableTypes = (): { id: string; title: string; description: string }[] =>
  [...defs].flatMap(([id, d]) => (d.description ? [{ id, title: d.title, description: d.description }] : []));

/** "This project", "All projects" and each project, as a small select; `onpick` gets the new scope. */
function scopePicker(scope: string, onpick: (scope: string) => void): HTMLElement {
  const home = activeTab()?.id === 'home';
  const sel = h('select', { className: 'select scope-select', onchange: () => onpick(sel.value) },
    new Option(home ? 'This tab: all projects' : 'This project', 'tab'), new Option('All projects', 'all'),
    ...allProjects().map((p) => new Option(p.name, p.id)));
  if (![...sel.options].some((o) => o.value === scope)) sel.add(new Option('Removed project', scope));
  sel.value = scope;
  sel.setAttribute('aria-label', 'Scope: which projects this panel shows');
  return h('label', { className: 'scope-bar' }, h('span', { className: 'legend', textContent: 'Scope' }), sel);
}

// A project switch tears the whole layout down and rebuilds it later. While that runs, panels
// should let go of their backing process (a terminal's shell) instead of ending it.
let parking = false;
export const isParking = (): boolean => parking;
export function park(fn: () => void): void {
  parking = true;
  try { fn(); } finally { parking = false; }
}

function createComponent({ name }: { name: string }): IContentRenderer {
  const def = defs.get(name);
  // A scoped panel is a scope bar over its own body.
  const element = document.createElement('div');
  element.className = def?.scoped ? 'panel-frame' : 'panel-body';
  let body = element;
  let instance: PanelInstance = {};
  let scope = '';
  let panelApi: DockviewPanelApi | undefined;
  const build = (params: Record<string, unknown>) => {
    instance.dispose?.();
    scope = typeof params.scope === 'string' && params.scope ? params.scope : 'tab';
    body = h('div', { className: 'panel-body' });
    const p = allProjects().find((x) => x.id === scope);
    panelApi!.setTitle(scope === 'all' ? `${def!.title}: All` : p ? `${def!.title}: ${p.name}` : def!.title);
    element.replaceChildren(scopePicker(scope, (next) => {
      panelApi!.updateParameters({ scope: next === 'tab' ? undefined : next }); // update() below rebuilds
      window.dispatchEvent(new Event('myide:layout-dirty'));
    }), body);
    instance = def!.create(body, params, panelApi!);
  };
  return {
    element,
    init({ params, api }) {
      if (!def) { element.textContent = `Unknown panel "${name}"`; return; }
      panelApi = api;
      if (def.scoped) build(params ?? {});
      else instance = def.create(element, params ?? {}, api);
    },
    update({ params }) {
      if (def?.scoped && panelApi && (typeof params.scope === 'string' && params.scope ? params.scope : 'tab') !== scope) build(params);
    },
    onShow: () => instance.onShow?.(),
    dispose: () => instance.dispose?.(),
  };
}

// Each group gets a pop-out key; inside a pop-out window it docks the group back into the main window.
function createHeaderActions(group: DockviewGroupPanel): IHeaderActionsRenderer {
  const element = document.createElement('div');
  element.className = 'group-actions';
  const button = key('Pop out');
  element.append(button);
  const sync = () => {
    const out = group.api.location.type === 'popout';
    button.textContent = out ? 'Dock' : 'Pop out';
    button.title = out ? 'Dock this group back into the main window' : 'Move this group to its own window';
  };
  button.onclick = () => {
    if (group.api.location.type === 'popout') group.api.moveTo({ position: 'right' });
    else dock.addPopoutGroup(group);
  };
  sync();
  const sub = group.api.onDidLocationChange(sync);
  return { element, init() {}, dispose: () => sub.dispose() };
}

function createWatermark(): IWatermarkRenderer {
  const element = document.createElement('div');
  element.className = 'watermark';
  element.innerHTML = '<p class="legend">No panels open</p><p>Press <kbd>⌘T</kbd> for a terminal.</p>';
  return { element, init() {} };
}

export function startDock(el: HTMLElement): DockviewApi {
  dock = createDockview(el, {
    theme: { ...themeDark, gap: 6 },
    popoutUrl: '/popout.html',
    createComponent,
    createRightHeaderActionComponent: createHeaderActions,
    createWatermarkComponent: createWatermark,
  });
  return dock;
}
