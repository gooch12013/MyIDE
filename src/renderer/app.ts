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
import './buttons';
import './assets';
import { startWorkspace } from './layouts';
import { activeProject } from './projects';

void startWorkspace(startDock(document.getElementById('dock')!));

window.myide.onCommand((name) => {
  if (name === 'new-terminal') openPanel('terminal', { cwd: activeProject()?.path });
});
