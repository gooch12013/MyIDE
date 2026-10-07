import { app, systemPreferences } from 'electron';

// Voice input in a terminal (claude's /voice) needs the mic, which macOS grants only to the packaged
// app. Ask once; after that the status is granted or denied and the user decides in System Settings.
// MYIDE_NO_MIC_PROMPT skips the prompt for automated launches.
app.whenReady().then(() => {
  if (!app.isPackaged || process.platform !== 'darwin' || process.env.MYIDE_NO_MIC_PROMPT) return;
  if (systemPreferences.getMediaAccessStatus('microphone') === 'not-determined') {
    systemPreferences.askForMediaAccess('microphone').catch(() => {});
  }
});
