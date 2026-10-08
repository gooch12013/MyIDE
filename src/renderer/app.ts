import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { openPanel, startDock } from './registry';
import './terminal';
import './files';
import './editor';
import './diff';
import './prefs';
import './employees';
import './employee';
import './issues';
import './issue';
import './buttons';
import './assets';
import './todos';
import './wizard';
import './home';
import { startWorkspace } from './layouts';
import { activeProject } from './projects';

void startWorkspace(startDock(document.getElementById('dock')!));

// Alt+Enter is OK: typing in a form, it presses the form's primary key (Enter stays a new line in a text box).
// Boxes outside a form get the same from dom.ts okKey.
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter' || !ev.altKey || ev.defaultPrevented || ev.isComposing) return;
  const t = ev.target;
  if (!(t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit', 'file'].includes(t.type)))) return;
  const form = t.closest('form');
  const ok = form?.querySelector<HTMLButtonElement>('button.btn--primary:not(:disabled)');
  if (!form || !ok) return;
  ev.preventDefault();
  if (ok.type === 'submit') form.requestSubmit(ok); else ok.click();
});

window.myide.onCommand((name) => {
  if (name === 'new-terminal') openPanel('terminal', { cwd: activeProject()?.path });
});
