import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { openPanel, startDock } from './registry';
import './terminal';

startDock(document.getElementById('dock')!);
openPanel('terminal');

window.myide.onCommand((name) => {
  if (name === 'new-terminal') openPanel('terminal');
});
