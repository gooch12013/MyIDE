import { app, BrowserWindow, ipcMain, Menu, shell, type MenuItemConstructorOptions } from 'electron';
import { deleteNamedLayout, namedLayouts } from './layouts';
import { listEmployees, onEmployeeChange, onEmployeeRemoved } from './employees';
import { listProjects, projectById, readConfig } from './projects';
import { lastClosed, openTabs } from './tabs';

/** What the renderer reports for the menu: the active project and which panel types are open. */
export interface MenuState { active: string | null; panels: { id: string; title: string; open: boolean }[] }

let state: MenuState = { active: null, panels: [] };
let send: (command: string) => void = () => {};
// Employees that need David, per project; the menu is rebuilt only when this changes.
const needsKey = (): string => JSON.stringify(listEmployees().filter((e) => e.state === 'needs-you').map((e) => e.projectId).sort());
let lastNeeds = '';

/** Builds the app menu. Call again whenever projects, named layouts or open panels change. */
export function buildMenu(): void {
  const cmd = (command: string) => () => send(command);
  const named = namedLayouts();
  const projects = listProjects();
  const open = openTabs(projects);
  const homeClosed = readConfig().homeClosed;
  lastNeeds = needsKey();
  const needs = (id: string) => listEmployees().filter((e) => e.projectId === id && e.state === 'needs-you').length;
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Preferences…', accelerator: 'CmdOrCtrl+,', click: cmd('open-preferences') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Terminal', accelerator: 'CmdOrCtrl+T', click: cmd('new-terminal') },
        { label: 'Add Project…', click: cmd('add-project') },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: cmd('close-tab') },
        { label: 'Close Project Tab', accelerator: 'CmdOrCtrl+Shift+W', enabled: !!state.active, click: cmd('close-project') },
      ],
    },
    // A menu titled "Edit" gets macOS's Start Dictation and Emoji items added by the system.
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Home', accelerator: 'CmdOrCtrl+0', click: cmd('project:home') },
        {
          label: 'Panels',
          submenu: [
            { label: 'Add Panel…', click: cmd('add-panel') },
            { type: 'separator' as const },
            ...state.panels.map((p) => ({ label: p.title, type: 'checkbox' as const, checked: p.open, click: cmd(`panel:${p.id}`) })),
          ],
        },
        {
          label: 'Layouts',
          submenu: [
            { label: 'Terminal Only', click: cmd('preset:terminal') },
            { label: 'Terminal + Files', click: cmd('preset:files') },
            { label: 'Code Review', click: cmd('preset:review') },
            { type: 'separator' },
            ...named.map((n) => ({ label: n, click: cmd(`layout:${n}`) })),
            ...(named.length ? [{ type: 'separator' as const }] : []),
            { label: 'Save Current Layout As…', click: cmd('save-layout') },
            {
              label: 'Delete Layout',
              enabled: named.length > 0,
              submenu: named.map((n) => ({ label: n, click: (_i, w) => void deleteNamedLayout(n, buildMenu, w as BrowserWindow | undefined) })),
            },
          ],
        },
        { label: 'Employees', accelerator: 'CmdOrCtrl+Shift+Y', click: cmd('panel:employees') },
        { label: 'Employees: All Projects', accelerator: 'CmdOrCtrl+Alt+Shift+Y', click: cmd('employees-all') },
        { label: 'Issues: All Projects', click: cmd('issues-all') },
        { type: 'separator' },
        { role: 'reload' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' as const }]),
        { type: 'separator' },
        { role: 'resetZoom', accelerator: 'CmdOrCtrl+Alt+0' }, // Cmd+0 is Home { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Projects',
      // Every project in tab order: a check on open tabs, "(current)" on the shown one, ⌘1..9 following the open tabs.
      submenu: [
        { label: `Home${state.active === 'home' ? ' (current)' : ''}`, type: 'checkbox' as const, checked: !homeClosed, accelerator: 'CmdOrCtrl+0', registerAccelerator: false, click: cmd('project:home') },
        ...projects.map((p) => {
          const n = needs(p.id);
          const i = open.indexOf(p);
          return {
            label: `${p.name}${p.id === state.active ? ' (current)' : ''}${n ? `  ·  ${n} need${n === 1 ? 's' : ''} you` : ''}`,
            type: 'checkbox' as const, checked: !p.closed,
            accelerator: i >= 0 && i < 9 ? `CmdOrCtrl+${i + 1}` : undefined, click: cmd(`project:${p.id}`),
          };
        }),
        ...(projects.length ? [{ type: 'separator' as const }] : []),
        { label: 'Add Project…', click: cmd('add-project') },
        { label: 'Close Project Tab', accelerator: 'CmdOrCtrl+Shift+W', registerAccelerator: false, enabled: !!state.active, click: cmd('close-project') },
        { label: 'Reopen Closed Project', accelerator: 'CmdOrCtrl+Shift+T', enabled: !!lastClosed([{ id: 'home', closed: homeClosed }, ...projects]), click: cmd('reopen-project') },
        { label: 'Remove Current Project…', enabled: !!state.active && state.active !== 'home', click: cmd('remove-project') },
        { type: 'separator' },
        { label: 'Hire Employee…', enabled: !!state.active && state.active !== 'home', click: cmd('hire-employee') },
        { label: 'New Employee Role…', click: cmd('new-role') },
      ],
    },
    // macOS lists every open window (pop-outs included) at the bottom of this menu.
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [{ label: 'MyIDE on GitHub', click: () => void shell.openExternal('https://github.com/gooch12013/MyIDE') }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

export function registerMenu(sendCommand: (command: string) => void): void {
  send = sendCommand;
  const cmd = (command: string) => () => send(command);
  ipcMain.on('menu:state', (_e, s: MenuState) => { state = s; buildMenu(); });
  const needsChanged = () => { if (needsKey() !== lastNeeds) buildMenu(); };
  onEmployeeChange(needsChanged);
  onEmployeeRemoved(needsChanged);
  // A project key's context menu.
  // Home can only be closed: no folder to reveal, no settings, never removed.
  ipcMain.on('projects:menu', (e, id: string) => {
    const p = projectById(id);
    if (!p && id !== 'home') return;
    const others = openTabs(listProjects()).length + (readConfig().homeClosed ? 0 : 1) > 1;
    const close: MenuItemConstructorOptions[] = [
      { label: 'Close Tab', click: cmd(`close-project:${id}`) },
      { label: 'Close Others', enabled: others, click: cmd(`close-others:${id}`) },
    ];
    if (!p) return void Menu.buildFromTemplate(close).popup({ window: BrowserWindow.fromWebContents(e.sender) ?? undefined });
    Menu.buildFromTemplate([
      ...close,
      { type: 'separator' },
      { label: 'Reveal in Finder', click: () => shell.showItemInFolder(p.path) },
      { label: 'Project Settings…', click: cmd(`project-settings:${id}`) },
      { type: 'separator' },
      { label: 'Remove Project…', click: cmd(`remove-project:${id}`) },
    ]).popup({ window: BrowserWindow.fromWebContents(e.sender) ?? undefined });
  });
  buildMenu();
}
