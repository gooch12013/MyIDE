# MyIDE

A desktop app for running a team of AI coding agents across several projects at once. Each project gets a lead agent with its own reports, organised like an org chart. The home screen shows what needs you, what each agent is working on, how far along it is and what's left.

Status: in development. Nothing to install yet.

MyIDE is an independent project. It is not affiliated with, endorsed by or sponsored by Anthropic, OpenAI, Google or any other AI provider. Product names belong to their owners.

## Development

Needs macOS, Node 22 and the Xcode command line tools (node-pty is rebuilt for Electron on install).

```
npm install      # also rebuilds node-pty for Electron
npm run dev      # build and launch
npm run build    # bundle into dist/
npm run typecheck
```

Cmd+T opens a terminal tab. The key in each group's header pops the group out to its own window, and docks it back. App state lives in `~/.myide/`.

### Packaging notes

Not scripted yet. Talking to `claude` with `/voice` in a terminal pane needs the microphone, which macOS grants only to a packaged, signed app: `NSMicrophoneUsageDescription` in Info.plist, the `com.apple.security.device.audio-input` entitlement, and `systemPreferences.askForMediaAccess('microphone')` at launch. Package with `@electron/packager --no-asar` so node-pty's `pty.node` and `spawn-helper` load from disk, and sign those two files before signing the app with `--deep`.

## Licence

[PolyForm Noncommercial 1.0.0](LICENSE.md). You may use, copy and modify this project for any noncommercial purpose. You may not sell it or use it commercially. Anyone who passes on any part of it must include the licence and this line:

Required Notice: Copyright (c) 2026 David Gooch (https://github.com/gooch12013)

Author: David Gooch ([@gooch12013](https://github.com/gooch12013)).
