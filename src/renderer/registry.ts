import {
  createDockview, themeDark,
  type DockviewApi, type DockviewGroupPanel, type DockviewPanelApi, type IContentRenderer, type IHeaderActionsRenderer, type IWatermarkRenderer,
} from 'dockview-core';

export interface PanelInstance {
  dispose?(): void;
  /** Called when the panel's tab becomes visible. */
  onShow?(): void;
}

export interface PanelDef {
  title: string;
  /** Builds the panel into `container`. `params` are the ones given to openPanel (saved with the layout). */
  create(container: HTMLElement, params: Record<string, unknown>, api: DockviewPanelApi): PanelInstance;
}

const defs = new Map<string, PanelDef>();
let dock: DockviewApi;

export function registerPanel(id: string, def: PanelDef): void {
  defs.set(id, def);
}

/** Adds a new instance of a registered panel as a tab in the active group. */
export function openPanel(id: string, params: Record<string, unknown> = {}) {
  const def = defs.get(id);
  if (!def) throw new Error(`No panel registered as "${id}"`);
  return dock.addPanel({ id: `${id}-${crypto.randomUUID().slice(0, 8)}`, component: id, title: def.title, params });
}

function createComponent({ name }: { name: string }): IContentRenderer {
  const element = document.createElement('div');
  element.className = 'panel-body';
  let instance: PanelInstance = {};
  return {
    element,
    init({ params, api }) {
      const def = defs.get(name);
      if (!def) { element.textContent = `Unknown panel "${name}"`; return; }
      instance = def.create(element, params ?? {}, api);
    },
    onShow: () => instance.onShow?.(),
    dispose: () => instance.dispose?.(),
  };
}

function key(label: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'key key--sm';
  b.textContent = label;
  return b;
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
