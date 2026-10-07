// Menu-bar icon: open MyIDE, what needs David, pause all schedules, quit.
import { app, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron';
import type { Employee } from './employees';
import { onEmployeeChange } from './employees';
import { invoke, pauseSchedules, schedulesPaused } from './buttons';

let tray: Tray | null = null;
const needs = new Map<string, boolean>(); // employee id -> in NEEDS YOU
let actions: { open(): void; showNeeds(): void };

/** A template image drawn in code: a rounded key outline with a lit dot, black on clear (macOS tints it). */
function icon(): Electron.NativeImage {
  const img = nativeImage.createEmpty();
  for (const scale of [1, 2]) {
    const n = 16 * scale;
    const px = Buffer.alloc(n * n * 4); // BGRA
    const r = 3 * scale, w = 1.5 * scale, c = (n - 1) / 2;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      // distance outside a rounded square inset by 1.5 px
      const dx = Math.max(Math.abs(x - c) - (c - 1.5 * scale - r), 0), dy = Math.max(Math.abs(y - c) - (c - 1.5 * scale - r), 0);
      const edge = Math.abs(Math.hypot(dx, dy) - r) < w / 2;
      const dot = Math.hypot(x - c, y - c) < 2.5 * scale;
      if (edge || dot) px[(y * n + x) * 4 + 3] = 255;
    }
    img.addRepresentation({ scaleFactor: scale, width: n, height: n, buffer: nativeImage.createFromBitmap(px, { width: n, height: n }).toPNG() });
  }
  img.setTemplateImage(true);
  return img;
}

export function trayMenu(): MenuItemConstructorOptions[] {
  const count = [...needs.values()].filter(Boolean).length;
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
  const count = [...needs.values()].filter(Boolean).length;
  tray.setTitle(count ? String(count) : '');
  tray.setToolTip(count ? `MyIDE: ${count} need you` : 'MyIDE');
  tray.setContextMenu(Menu.buildFromTemplate(trayMenu()));
}

export async function startTray(o: { open(): void; showNeeds(): void }): Promise<void> {
  actions = o;
  for (const e of await invoke<Employee[]>('employees:list')) needs.set(e.id, e.state === 'needs-you');
  onEmployeeChange((e) => {
    const was = needs.get(e.id);
    needs.set(e.id, e.state === 'needs-you');
    if (was !== (e.state === 'needs-you')) refreshTray();
  });
  tray = new Tray(icon());
  refreshTray();
  if (process.env.MYIDE_TEST_CLOCK) (globalThis as Record<string, unknown>).myideTray = () => trayMenu().map((i) => ({ label: i.label, checked: i.checked, enabled: i.enabled }));
}
