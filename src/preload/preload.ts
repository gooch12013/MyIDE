import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { TerminalSettings } from '../main/ghostty';
import type { TerminalMenuAction } from '../main/openers';
import type { PtyInfo, PtySpawnOptions } from '../main/pty';
import type { MenuState } from '../main/menu';
import type { LayoutsFile } from '../main/layouts';
import type { Project } from '../main/projects';
import type { Prefs } from '../main/prefs';
import type { Employee, Mode, ProjectOrg, Role } from '../main/employees';
import type { Approval } from '../main/mcp';
import type { Account, Provider, Usage } from '../main/accounts';
import type { Providers } from '../main/transports';
import type { ForgeLink, ForgeSnapshot } from '../main/forge';
import type { Detected } from '../main/remotes';
import type { Row as ComponentRow } from '../main/components';
import type { Clip, Clone, SpeechOptions, SpeechPatch, SpeechStatus } from '../main/speech';
import type { Button, PaletteItem, Schedule } from '../main/buttons';
import type { AssetRequest, Catalog } from '../main/assets';
import type { Todo } from '../main/todos';

export type OrgState = {
  caps: { global: number; perProject: number; maxReports: number; maxDepth: number };
  projects: (ProjectOrg & { id: string; priority: number; paused: boolean; maxDepth: number })[];
};

/** Subscribes to a main-to-renderer channel; returns the unsubscribe function. */
function on<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const handler = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...(args as A));
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api = {
  pty: {
    /** Starts the user's login shell for panel `id`, or reattaches if that id already has one. */
    spawn: (id: string, opts: PtySpawnOptions): Promise<PtyInfo> => ipcRenderer.invoke('pty:spawn', id, opts),
    write: (id: string, data: string): void => ipcRenderer.send('pty:write', id, data),
    resize: (id: string, cols: number, rows: number): void => ipcRenderer.send('pty:resize', id, cols, rows),
    kill: (id: string): void => ipcRenderer.send('pty:kill', id),
    /** Resolves true if none of these terminals runs a program other than the shell, or the user agrees to end it. */
    confirmKill: (ids: string[]): Promise<boolean> => ipcRenderer.invoke('pty:confirm-kill', ids),
    onData: (cb: (id: string, data: string) => void) => on('pty:data', cb),
    onExit: (cb: (id: string, exitCode: number) => void) => on('pty:exit', cb),
    /** The shell's cwd or foreground process changed. */
    onInfo: (cb: (id: string, info: PtyInfo) => void) => on('pty:info', cb),
  },
  // Terminal: Ghostty-derived settings, clipboard, context menu and "Open in".
  terminal: {
    /** Ghostty's settings with the Preferences font overrides. */
    settings: (): TerminalSettings => ipcRenderer.sendSync('terminal:settings'),
    menu: (hasSelection: boolean, cwd: string): Promise<TerminalMenuAction> => ipcRenderer.invoke('terminal:menu', hasSelection, cwd),
    copy: (text: string): void => ipcRenderer.send('clipboard:write', text),
    paste: (): Promise<string> => ipcRenderer.invoke('clipboard:read'),
    openUrl: (url: string): Promise<void> => ipcRenderer.invoke('open:url', url),
    /** Installed "Open in" apps, and opening a folder in one of them. */
    apps: (): Promise<string[]> => ipcRenderer.invoke('open:apps'),
    openIn: (app: string, dir: string): Promise<void> => ipcRenderer.invoke('open:in', app, dir),
  },
  // Projects, per-project and named layouts, the files panel and the app menu.
  projects: {
    list: (): Promise<Project[]> => ipcRenderer.invoke('projects:list'),
    /** Opens the folder picker; resolves to the new (or already added) project, or null if cancelled. */
    add: (): Promise<Project | null> => ipcRenderer.invoke('projects:add'),
    /** Asks for confirmation; resolves true if the project was removed. */
    remove: (id: string): Promise<boolean> => ipcRenderer.invoke('projects:remove', id),
  },
  layouts: {
    get: (): Promise<LayoutsFile> => ipcRenderer.invoke('layouts:get'),
    putProject: (project: string | null, layout: unknown): void => ipcRenderer.send('layouts:put-project', project, layout),
    saveNamed: (name: string, layout: unknown): Promise<void> => ipcRenderer.invoke('layouts:save-named', name, layout),
  },
  files: {
    list: (dir: string): Promise<{ name: string; dir: boolean }[]> => ipcRenderer.invoke('files:list', dir),
    /** Opens in the default app; resolves to '' or an error message. */
    open: (path: string): Promise<string> => ipcRenderer.invoke('files:open', path),
  },
  // Preferences panel.
  prefs: {
    get: (): Promise<{ prefs: Prefs; palette: string[]; dataDir: string; openAtLogin: boolean }> => ipcRenderer.invoke('prefs:get'),
    set: (patch: Partial<Prefs>): Promise<Prefs> => ipcRenderer.invoke('prefs:set', patch),
    setOpenAtLogin: (on: boolean): Promise<void> => ipcRenderer.invoke('prefs:login', on),
    updateProject: (id: string, patch: { name?: string; colour?: string }): Promise<void> => ipcRenderer.invoke('projects:update', id, patch),
    revealProject: (id: string): Promise<void> => ipcRenderer.invoke('projects:reveal', id),
    renameLayout: (from: string, to: string): Promise<void> => ipcRenderer.invoke('layouts:rename', from, to),
    /** Asks for confirmation first. */
    deleteLayout: (name: string): Promise<void> => ipcRenderer.invoke('layouts:delete', name),
    resetLayout: (projectId: string): Promise<void> => ipcRenderer.invoke('layouts:reset', projectId),
    revealData: (): Promise<string> => ipcRenderer.invoke('data:reveal'),
    /** Resolves to the written path, or null if cancelled. */
    exportSettings: (): Promise<string | null> => ipcRenderer.invoke('settings:export'),
    /** Resolves to null (cancelled) or an error message; on success the app restarts. */
    importSettings: (): Promise<string | null> => ipcRenderer.invoke('settings:import'),
  },
  // Employees: hire, status, model, talk, fire, transcript.
  employees: {
    list: (projectId?: string): Promise<Employee[]> => ipcRenderer.invoke('employees:list', projectId),
    roles: (projectId: string): Promise<Role[]> => ipcRenderer.invoke('employees:roles', projectId),
    hire: (o: { projectId: string; role: string; task: string; model?: string; effort?: string; mode?: Mode; lead?: boolean; accountId?: string; images?: { type: string; data: Uint8Array }[] }): Promise<Employee> => ipcRenderer.invoke('employees:hire', o),
    /** Next turn; queued if busy, talking or over the caps. */
    send: (id: string, text: string, images?: { type: string; data: Uint8Array }[]): Promise<void> => ipcRenderer.invoke('employees:send', id, text, images),
    /** An image file inside the employee's worktree as a data URL, or null if it is not one. */
    image: (id: string, path: string): Promise<string | null> => ipcRenderer.invoke('employees:image', id, path),
    /** Applies on the next turn; now: interrupt and resume with the new model/effort. */
    setModel: (id: string, o: { model?: string; effort?: string; mode?: Mode; now?: boolean }): Promise<void> => ipcRenderer.invoke('employees:set-model', id, o),
    interrupt: (id: string): Promise<void> => ipcRenderer.invoke('employees:interrupt', id),
    /** Pauses the employee; open terminal ptyId in cwd running command. Talk ends when that PTY exits. */
    talk: (id: string): Promise<{ cwd: string; command: string; ptyId: string }> => ipcRenderer.invoke('employees:talk', id),
    fire: (id: string, o: { removeWorktree: boolean }): Promise<void> => ipcRenderer.invoke('employees:fire', id, o),
    /** GO on a This Mac employee's plan: its next turn runs exactly the planned commands. */
    transcript: (id: string): Promise<{ role: 'user' | 'assistant' | 'tool'; text: string; at?: string; images?: string[] }[]> => ipcRenderer.invoke('employees:transcript', id),
    onChange: (cb: (e: Employee) => void) => on('employees:change', cb),
    onRemoved: (cb: (id: string) => void) => on('employees:removed', cb),
    /** A notification was clicked: show this employee. */
    onOpen: (cb: (id: string) => void) => on('employees:open', cb),
  },
  // Org: caps, per-project priority, pause and model defaults/ceiling.
  org: {
    get: (): Promise<OrgState> => ipcRenderer.invoke('org:get'),
    /** priority/paused go to config.json; the rest to the project's state.json. paused: true stops its running turns. */
    setProject: (id: string, patch: { [K in keyof ProjectOrg]?: ProjectOrg[K] | null } & { priority?: number; paused?: boolean }): Promise<void> => ipcRenderer.invoke('org:set-project', id, patch),
    onChange: (cb: (s: OrgState) => void) => on('org:change', cb),
  },
  approvals: {
    list: (): Promise<Approval[]> => ipcRenderer.invoke('approvals:list'),
    resolve: (id: string, allow: boolean, message?: string): Promise<void> => ipcRenderer.invoke('approvals:resolve', id, allow, message),
    /** Called with the full pending list whenever it changes. */
    onChange: (cb: (pending: Approval[]) => void) => on('approvals:change', cb),
  },
  claude: {
    info: (): Promise<{ version: string | null; tested: boolean; testedVersion: string }> => ipcRenderer.invoke('claude:info'),
    /** One tiny haiku turn in a temp folder. */
    test: (): Promise<{ ok: boolean; detail: string }> => ipcRenderer.invoke('claude:test'),
  },
  // AI accounts (feature 22): which login each employee runs on, its usage gauge, and the capability table.
  accounts: {
    list: (): Promise<(Account & { usage?: Usage })[]> => ipcRenderer.invoke('accounts:list'),
    add: (o: { name?: string; provider: Provider; ownLogin?: boolean; key?: string }): Promise<Account> => ipcRenderer.invoke('accounts:add', o),
    /** A Gemini account's API key, into the Keychain. */
    setKey: (id: string, key: string): Promise<void> => ipcRenderer.invoke('accounts:set-key', id, key),
    update: (id: string, patch: { name?: string; cap?: number; allowAuto?: boolean }): Promise<void> => ipcRenderer.invoke('accounts:update', id, patch),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('accounts:remove', id),
    /** The command that runs the CLI's own login with the account's env, for a terminal. */
    login: (id: string): Promise<{ command: string }> => ipcRenderer.invoke('accounts:login', id),
    status: (id: string): Promise<{ loggedIn: boolean; detail: string }> => ipcRenderer.invoke('accounts:status', id),
    /** One tiny turn on the account. */
    test: (id: string): Promise<{ ok: boolean; detail: string }> => ipcRenderer.invoke('accounts:test', id),
    providers: (): Promise<Providers> => ipcRenderer.invoke('providers:get'),
    codexInfo: (): Promise<{ path: string | null; version: string | null; tested: boolean; testedVersion: string }> => ipcRenderer.invoke('codex:info'),
    geminiInfo: (): Promise<{ path: string | null; version: string | null }> => ipcRenderer.invoke('gemini:info'),
    onUsage: (cb: (id: string, u: Usage) => void) => on('accounts:usage', cb),
  },
  // Forge issues: GitHub and Forgejo links, tokens (kept in the Keychain, never sent here), issues, drafts.
  forge: {
    issues: (projectId?: string): Promise<ForgeSnapshot[]> => ipcRenderer.invoke('forge:issues', projectId),
    detect: (projectId: string, force?: boolean): Promise<Detected> => ipcRenderer.invoke('forge:detect', projectId, force),
    /** Re-fetches; without force a fetch in the last 30 s is reused. */
    refresh: (projectId?: string, force?: boolean): Promise<void> => ipcRenderer.invoke('forge:refresh', projectId, force),
    setLink: (projectId: string, link: ForgeLink | null): Promise<void> => ipcRenderer.invoke('forge:set-link', projectId, link),
    tokens: (): Promise<{ rows: { provider: ForgeLink['provider']; host: string; has: boolean; projects: string[] }[]; gh: boolean }> => ipcRenderer.invoke('forge:tokens'),
    setToken: (provider: ForgeLink['provider'], host: string, token: string): Promise<void> => ipcRenderer.invoke('forge:set-token', provider, host, token),
    removeToken: (provider: ForgeLink['provider'], host: string): Promise<void> => ipcRenderer.invoke('forge:remove-token', provider, host),
    hasToken: (provider: ForgeLink['provider'], host: string): Promise<boolean> => ipcRenderer.invoke('forge:has-token', provider, host),
    importGh: (): Promise<void> => ipcRenderer.invoke('forge:import-gh'),
    test: (provider: ForgeLink['provider'], host: string): Promise<string> => ipcRenderer.invoke('forge:test', provider, host),
    create: (o: { projectId: string; title: string; body?: string; labels?: string; images?: { name: string; type: string; data: Uint8Array }[]; assign?: { employeeId?: string; role?: string } }):
      Promise<{ number: number; url: string; opened?: boolean; queued?: boolean; warning?: string }> => ipcRenderer.invoke('forge:create', o),
    assign: (o: { projectId: string; number: number; employeeId?: string; role?: string; note?: string }): Promise<{ employeeId: string; warning?: string }> => ipcRenderer.invoke('forge:assign', o),
    fileDraft: (projectId: string, id: string): Promise<{ number: number; url: string; warning?: string }> => ipcRenderer.invoke('forge:file-draft', projectId, id),
    discardDraft: (projectId: string, id: string): Promise<void> => ipcRenderer.invoke('forge:discard-draft', projectId, id),
    /** Drops the write that stopped the outbox (shown as blocked) and sends the rest. */
    dropOp: (projectId: string, opId: string): Promise<void> => ipcRenderer.invoke('forge:drop-op', projectId, opId),
    /** A project's issues, drafts or outbox changed. */
    onChange: (cb: (projectId: string) => void) => on('forge:change', cb),
  },
  // Code: the editor's files (inside a project or a MyIDE worktree only), the git tree, review and merge.
  code: {
    /** The file's text, the hash of its bytes, and the checkout it is in (root, branch). */
    read: (path: string): Promise<{ text: string; hash: string; root: string; branch: string }> => ipcRenderer.invoke('code:read', path),
    /** Saves only if the file still has `hash` on disk ("changed on disk" otherwise); resolves with the new hash. */
    write: (path: string, text: string, hash: string): Promise<string> => ipcRenderer.invoke('code:write', path, text, hash),
    /** True for an existing file the editor may open (inside a project or a MyIDE worktree). */
    exists: (path: string): Promise<boolean> => ipcRenderer.invoke('code:exists', path),
    /** Installed IDEs ('WebStorm', 'VS Code'), and opening a file at a line in one. */
    ides: (): Promise<string[]> => ipcRenderer.invoke('code:ides'),
    openIn: (ide: string, path: string, line: number): Promise<void> => ipcRenderer.invoke('code:open-in', ide, path, line),
  },
  git: {
    /** Files under root as [relative path, status letter]; git: false when root is not a repository. */
    tree: (root: string): Promise<{ git: boolean; files: [string, string][] }> => ipcRenderer.invoke('git:tree', root),
    /** Watches root; the callback gets the watch id on a (debounced) change. */
    watch: (root: string): Promise<number> => ipcRenderer.invoke('git:watch', root),
    unwatch: (id: number): void => ipcRenderer.send('git:unwatch', id),
    onChanged: (cb: (id: number) => void) => on('git:changed', cb),
    /** The project's checkouts; the first is the main one. */
    worktrees: (projectId: string): Promise<{ path: string; branch: string }[]> => ipcRenderer.invoke('git:worktrees', projectId),
    /** The project's myide/* branches. */
    branches: (projectId: string): Promise<string[]> => ipcRenderer.invoke('git:branches', projectId),
    diff: (projectId: string, branch: string): Promise<{ base: string; files: { status: string; path: string; old?: string }[] }> => ipcRenderer.invoke('git:diff', projectId, branch),
    diffFile: (projectId: string, branch: string, path: string, old?: string): Promise<{ original: string; modified: string }> => ipcRenderer.invoke('git:diff-file', projectId, branch, path, old),
    /** `git merge --no-ff` into the main checkout; refuses when it has uncommitted changes. */
    merge: (projectId: string, branch: string): Promise<{ ok: boolean; message: string; conflicts?: string[] }> => ipcRenderer.invoke('git:merge', projectId, branch),
    /** Deletes the branch; without removeWorktree it refuses (and names the worktree) while one has it checked out. */
    discard: (projectId: string, branch: string, removeWorktree = false): Promise<{ ok: boolean; worktree?: string; lost?: string[]; message: string }> => ipcRenderer.invoke('git:discard', projectId, branch, removeWorktree),
  },
  // Read-back (macOS say or a tts component) and dictation (macOS or an installed whisper-cli).
  speech: {
    get: (): Promise<SpeechStatus> => ipcRenderer.invoke('speech:get'),
    /** Refuses an engine that is not installed; the previous one stays in use. */
    set: (patch: SpeechPatch): Promise<SpeechStatus> => ipcRenderer.invoke('speech:set', patch),
    /** Read-back engines with their voices, and the installed Whisper models. */
    options: (): Promise<SpeechOptions> => ipcRenderer.invoke('speech:options'),
    /** Reads a summary aloud (stopping any other); ignored while read-back is off unless force. Resolves when done, with a note if it fell back to the macOS voice. */
    speak: (text: string, force = false, voice = ''): Promise<string> => ipcRenderer.invoke('speech:speak', text, force, voice),
    stop: (): Promise<void> => ipcRenderer.invoke('speech:stop'),
    /** A 16 kHz mono WAV to text. */
    transcribe: (wav: Uint8Array): Promise<string> => ipcRenderer.invoke('speech:transcribe', wav),
    onChange: (cb: (s: SpeechStatus) => void) => on('speech:change', cb),
    onSpeaking: (cb: (speaking: boolean) => void) => on('speech:speaking', cb),
    /** An engine's helper changed state (starting, downloading or loading a model, ready, error). */
    onEngine: (cb: (id: string) => void) => on('speech:engine', cb),
    // Cloned voices (Qwen3-TTS): MyIDE's copies in ~/.myide/components/qwen3-tts/voices.
    clones: (): Promise<Clone[]> => ipcRenderer.invoke('speech:clones'),
    /** The native file picker; null when cancelled. */
    pickClip: (): Promise<Clip | null> => ipcRenderer.invoke('speech:pick-clip'),
    /** Spotlight search of the home folder for voice clips, best first, at most 100. */
    findClips: (): Promise<Clip[]> => ipcRenderer.invoke('speech:find-clips'),
    /** Plays an offered clip (speech.stop ends it). */
    preview: (path: string): Promise<string> => ipcRenderer.invoke('speech:preview', path),
    /** A sample in a voice described in words; resolves to the WAV to preview or save. */
    design: (description: string, text: string): Promise<string> => ipcRenderer.invoke('speech:design', description, text),
    addClone: (path: string, name: string, transcript: string): Promise<Clone> => ipcRenderer.invoke('speech:add-clone', path, name, transcript),
    renameClone: (from: string, to: string): Promise<string> => ipcRenderer.invoke('speech:rename-clone', from, to),
    removeClone: (name: string): Promise<void> => ipcRenderer.invoke('speech:remove-clone', name),
    setCloneText: (name: string, text: string): Promise<void> => ipcRenderer.invoke('speech:clone-text', name, text),
  },
  // Optional components (feature 23) in ~/.myide/components.
  components: {
    list: (): Promise<ComponentRow[]> => ipcRenderer.invoke('components:list'),
    /** Downloads on this click only; resolves to the installed path. */
    install: (id: string): Promise<string> => ipcRenderer.invoke('components:install', id),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('components:remove', id),
    /** Uses an existing install that detection found. */
    use: (id: string, path: string): Promise<void> => ipcRenderer.invoke('components:use', id, path),
    reveal: (): Promise<string> => ipcRenderer.invoke('components:reveal'),
    /** "Use existing Python…" for a Python engine: a file picker, then a check that it imports the engine. Resolves to the path, or '' if cancelled. */
    pickPython: (id: string): Promise<string> => ipcRenderer.invoke('components:pick-python', id),
    onProgress: (cb: (id: string, got: number, total: number, text?: string) => void) => on('components:progress', cb),
    onChange: (cb: () => void) => on('components:change', cb),
  },
  // Action buttons (global in ~/.myide, project ones in <repo>/.myide) and their schedules.
  buttons: {
    /** Global plus that project's buttons, and the installed commands and skills. */
    list: (projectId?: string): Promise<{ buttons: Button[]; palette: PaletteItem[] }> => ipcRenderer.invoke('buttons:list', projectId),
    save: (b: Partial<Button> & Pick<Button, 'label' | 'command' | 'target' | 'scope'>): Promise<Button> => ipcRenderer.invoke('buttons:save', b),
    /** Also deletes its schedules. */
    delete: (id: string): Promise<void> => ipcRenderer.invoke('buttons:delete', id),
    /** Sends the command to the target; resolves to the employee id that runs it. */
    run: (b: Pick<Button, 'command' | 'target' | 'label'>, projectId: string, o: { employeeId?: string; input?: string } = {}): Promise<string> => ipcRenderer.invoke('buttons:run', b, projectId, o),
  },
  schedules: {
    list: (): Promise<{ paused: boolean; awake: boolean; schedules: (Schedule & { next?: number })[] }> => ipcRenderer.invoke('schedules:list'),
    save: (s: Partial<Schedule> & Pick<Schedule, 'buttonId' | 'projectId' | 'days' | 'time' | 'missed'>): Promise<Schedule> => ipcRenderer.invoke('schedules:save', s),
    delete: (id: string): Promise<void> => ipcRenderer.invoke('schedules:delete', id),
    pause: (paused: boolean): Promise<void> => ipcRenderer.invoke('schedules:pause', paused),
    onChange: (cb: () => void) => on('schedules:change', cb),
  },
  // Asset studio (Higgsfield): model list and balance, prompt writing, requests, gallery, save to project.
  assets: {
    catalog: (): Promise<{ catalog: Catalog | null; approveAbove: number; role: boolean }> => ipcRenderer.invoke('assets:catalog'),
    /** One read-only haiku turn: balance and image models. */
    refresh: (): Promise<Catalog> => ipcRenderer.invoke('assets:refresh'),
    guide: (model: string): Promise<{ file: string; text: string }> => ipcRenderer.invoke('assets:guide', model),
    writePrompt: (o: { model: string; type: string; ratio: string; settings?: Record<string, string>; short: string; parentPrompt?: string }): Promise<{ prompt: string; guide: string }> => ipcRenderer.invoke('assets:write-prompt', o),
    /** Creates the request folder; the returned turn goes to the designer (employees.hire or send). */
    request: (o: { projectId: string; type: string; model: string; ratio: string; settings?: Record<string, string>; count: number; short: string; prompt: string;
      parent?: { request: string; version: number }; reference?: { name: string; data: Uint8Array; acceptedWarning: boolean } }): Promise<{ request: AssetRequest; turn: string }> => ipcRenderer.invoke('assets:request', o),
    list: (projectId: string): Promise<(AssetRequest & { thumbs: string[]; dir: string })[]> => ipcRenderer.invoke('assets:list', projectId),
    targets: (projectId: string, id: string, version: number): Promise<{ kind: string; note: string; targets: { label: string; rel: string; size?: number; exists: boolean }[] }> => ipcRenderer.invoke('assets:targets', projectId, id, version),
    save: (projectId: string, id: string, version: number, overwrite = false): Promise<string[]> => ipcRenderer.invoke('assets:save', projectId, id, version, overwrite),
    reveal: (id: string, version: number): Promise<void> => ipcRenderer.invoke('assets:reveal', id, version),
    setLine: (credits: number): Promise<void> => ipcRenderer.invoke('assets:set-line', credits),
    installRole: (): Promise<string> => ipcRenderer.invoke('assets:install-role'),
    onChange: (cb: (projectId: string) => void) => on('assets:change', cb),
  },
  // Personal to-dos (~/.myide/todos.json) and This Mac's change journal.
  todos: {
    list: (): Promise<Todo[]> => ipcRenderer.invoke('todos:list'),
    /** "text #tag @role": an @role also hires that This Mac employee; error says why it was not assigned. */
    add: (text: string): Promise<{ todo: Todo; error?: string }> => ipcRenderer.invoke('todos:add', text),
    update: (id: string, patch: Partial<Pick<Todo, 'text' | 'done' | 'due' | 'priority' | 'tags' | 'role' | 'employeeId'>>): Promise<Todo> => ipcRenderer.invoke('todos:update', id, patch),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('todos:remove', id),
    /** Hires a This Mac employee with that role for the to-do. */
    assign: (id: string, role: string): Promise<Todo> => ipcRenderer.invoke('todos:assign', id, role),
    /** Its commands with their output, and its snapshots. */
    log: (id: string): Promise<string> => ipcRenderer.invoke('todos:log', id),
    diff: (id: string, path: string): Promise<string> => ipcRenderer.invoke('todos:diff', id, path),
    rollback: (id: string, path: string): Promise<void> => ipcRenderer.invoke('todos:rollback', id, path),
    /** Puts back what the last rollback of `path` overwrote. */
    undoRollback: (id: string, path: string): Promise<void> => ipcRenderer.invoke('todos:undo-rollback', id, path),
    /** Copies the This Mac roles into ~/.claude/agents (never over an existing file). */
    installRoles: (): Promise<string> => ipcRenderer.invoke('todos:install-roles'),
    onChange: (cb: () => void) => on('todos:change', cb),
  },
  menuState: (state: MenuState): void => ipcRenderer.send('menu:state', state),
  /** App commands from keyboard shortcuts, e.g. 'new-terminal' (Cmd+T). */
  onCommand: (cb: (name: string) => void) => on('command', cb),
};

contextBridge.exposeInMainWorld('myide', api);

export type MyIDEApi = typeof api;
declare global {
  interface Window { myide: MyIDEApi }
}
