// Menu-bar icon: open MyIDE, what needs David, pause all schedules, quit.
import { app, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron';
import { listEmployees, onEmployeeChange, onEmployeeRemoved } from './employees';
import { pauseSchedules, schedulesPaused } from './buttons';
import { join } from 'node:path';

let tray: Tray | null = null;
let actions: { open(): void; showNeeds(): void };
// Counted from the live list on every change, so a fired employee can never leave the count stuck.
const needsCount = (): number => listEmployees().filter((e) => e.state === 'needs-you').length;

/** A rounded key outline with a lit dot, black on clear (macOS tints it); the @2x file is picked up beside it. */
const icon = () => { const img = nativeImage.createFromPath(join(__dirname, 'trayTemplate.png')); img.setTemplateImage(true); return img; };

export function trayMenu(): MenuItemConstructorOptions[] {
  const count = needsCount();
  return [
    { label: 'Open MyIDE', click: () => actions.open() },
    { label: count ? `Needs You: ${count}` : 'Nothing Needs You', enabled: count > 0, click: () => actions.showNeeds() },
    { type: 'separator' },
    { label: 'Pause All Schedules', type: 'checkbox', checked: schedulesPaused(), click: (i) => pauseSchedules(i.checked) },
    { type: 'separator' },
    { label: 'Quit MyIDE', click: () => app.quit() },
  ];
}

export function refreshTray(): void {
  if (!tray) return;
  const count = needsCount();
  tray.setTitle(count ? String(count) : '');
  tray.setToolTip(count ? `MyIDE: ${count} need you` : 'MyIDE');
  tray.setContextMenu(Menu.buildFromTemplate(trayMenu()));
}

export async function startTray(o: { open(): void; showNeeds(): void }): Promise<void> {
  actions = o;
  onEmployeeChange(refreshTray);
  onEmployeeRemoved(refreshTray);
  tray = new Tray(icon());
  refreshTray();
  if (process.env.MYIDE_TEST_CLOCK) (globalThis as Record<string, unknown>).myideTray = () => trayMenu().map((i) => ({ label: i.label, checked: i.checked, enabled: i.enabled }));
}
