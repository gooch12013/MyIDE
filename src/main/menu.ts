import { app, BrowserWindow, ipcMain, Menu, shell, type MenuItemConstructorOptions } from 'electron';
import { deleteNamedLayout, namedLayouts } from './layouts';
import { listProjects } from './projects';

/** What the renderer reports for the menu: the active project and which panel types are open. */
export interface MenuState { active: string | null; panels: { id: string; title: string; open: boolean }[] }

let state: MenuState = { active: null, panels: [] };
let send: (command: string) => void = () => {};

/** Builds the app menu. Call again whenever projects, named layouts or open panels change. */
export function buildMenu(): void {
  const cmd = (command: string) => () => send(command);
  const named = namedLayouts();
  const projects = listProjects();
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
      ],
    },
    // A menu titled "Edit" gets macOS's Start Dictation and Emoji items added by the system.
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        {
          label: 'Panels',
          submenu: state.panels.map((p) => ({ label: p.title, type: 'checkbox' as const, checked: p.open, click: cmd(`panel:${p.id}`) })),
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
        { type: 'separator' },
        { role: 'reload' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' as const }]),
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Project',
      submenu: [
        ...projects.map((p, i) => ({
          label: p.name, type: 'radio' as const, checked: p.id === state.active,
          accelerator: i < 9 ? `CmdOrCtrl+${i + 1}` : undefined, click: cmd(`project:${i + 1}`),
        })),
        ...(projects.length ? [{ type: 'separator' as const }] : []),
        { label: 'Add Project…', click: cmd('add-project') },
        { label: 'Remove Current Project…', enabled: !!state.active, click: cmd('remove-project') },
        { type: 'separator' },
        { label: 'Hire Employee…', enabled: !!state.active, click: cmd('hire-employee') },
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
  ipcMain.on('menu:state', (_e, s: MenuState) => { state = s; buildMenu(); });
  buildMenu();
}
