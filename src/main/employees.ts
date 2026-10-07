import { BrowserWindow, ipcMain, Notification } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { installHooks } from './attribution';
import type { ClaudeEvent, TaskState } from './claude/parse';
import { runTurn, type Turn, type TurnOpts } from './claude/transport';
import { claudeInfo } from './claude/version';
import { employeeMcpConfig, onApproval, onApprovalGone, pendingApprovals, registerControlTool, resolveApproval, startMcp, type Approval } from './mcp';
import { listProjects, readConfig } from './projects';
import { onPtyExit } from './pty';
import { lockDown, readJSON, STATE_DIR, writeJSON, writePrivate } from './store';
import { addWorktree, branchExists, checkRepo, removeWorktree } from './worktree';

export type EmployeeState = 'idle' | 'queued' | 'working' | 'needs-you' | 'done' | 'failed' | 'interrupted' | 'talking';
export interface Employee {
  id: string; projectId: string; role: string; name: string; worktree: string; branch: string;
  sessionId?: string; model: string; effort?: string; state: EmployeeState; task?: string;
  progress?: { done: number; total: number; current?: string; next: string[] };
  lastText?: string; error?: string; updatedAt: number;
}
export interface Role { name: string; description: string; model?: string; effort?: string; source: 'user' | 'project' }
type Result = Extract<ClaudeEvent, { type: 'result' }>;
// Stored beside the public fields: the role file, the parser's task list, turns waiting to run.
// paused: David interrupted, so pending turns wait for his next send or talk.
// ended: the state the last turn ended in, shown again once a late approval is answered.
interface Emp extends Employee { roleFile?: string; tasks?: TaskState; pending: string[]; queuedAt?: number; paused?: boolean; ended?: EmployeeState }

const HOOKS = join(STATE_DIR, 'hooks');
const CLAUDE_PROJECTS = join(homedir(), '.claude', 'projects'); // default account; CLAUDE_CONFIG_DIR is never set
const NO_ATTRIBUTION = 'No AI attribution anywhere: no Co-Authored-By trailer, no "Generated with Claude Code" line and no Claude-Session line in commits, pull requests, issues or comments. Everything goes out as the user.';
const CONTINUE = 'Continue where you left off.';
const DEFAULT_MODEL = 'sonnet';

const emps = new Map<string, Emp>();
const turns = new Map<string, Turn>();
// Why MyIDE interrupted a running turn, so its result is read correctly.
const why = new Map<string, 'user' | 'model' | 'talk' | 'fire' | 'bare' | 'quit'>();
const talkPtys = new Map<string, string>(); // Talk terminal PTY id -> employee id
let focus: () => BrowserWindow | null = () => null;
let mcpReady = false;
let quitting = false;

const projDir = (projectId: string) => join('projects', projectId);
const settingsFile = (e: Emp) => join(STATE_DIR, projDir(e.projectId), 'settings', `${e.id}.json`);
const mcpFile = (e: Emp) => join(STATE_DIR, projDir(e.projectId), 'mcp', `${e.id}.json`);
const talkPromptFile = (e: Emp) => join(STATE_DIR, projDir(e.projectId), 'talk', `${e.id}.md`);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'employee';
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const view = ({ roleFile, tasks, pending, queuedAt, paused, ended, ...e }: Emp): Employee => e;
const put = (file: string, data: object) => writePrivate(file, JSON.stringify(data, null, 2));
const broadcast = (channel: string, ...args: unknown[]) => {
  for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send(channel, ...args);
};

// ---- state ----

function save(projectId: string): void {
  writeJSON(join(projDir(projectId), 'state.json'), { employees: [...emps.values()].filter((e) => e.projectId === projectId) });
}

function emit(e: Emp): void {
  e.updatedAt = Date.now();
  save(e.projectId);
  broadcast('employees:change', view(e));
}

/** Loads every project's employees. A turn that was running when MyIDE quit is now 'interrupted' (send resumes it). */
function load(): void {
  for (const p of listProjects()) {
    for (const e of readJSON<{ employees?: Emp[] }>(join(projDir(p.id), 'state.json'), {}).employees ?? []) {
      e.pending ??= [];
      if (e.state === 'working' || e.state === 'needs-you') e.state = 'interrupted';
      if (e.state === 'talking') e.state = 'idle'; // the Talk terminal died with the app
      emps.set(e.id, e);
    }
    save(p.id);
  }
}

// ---- roles ----

function parseRole(file: string, source: Role['source']): (Role & { file: string }) | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(file, 'utf8'));
  if (!m) return null;
  const f: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) f[kv[1]] = kv[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  if (!f.name) return null;
  const model = f.model && f.model !== 'inherit' ? f.model : undefined;
  return { name: f.name, description: f.description ?? '', model, effort: f.effort || undefined, source, file };
}

/** Roles from ~/.claude/agents and <project>/.claude/agents; a project role overrides a user role of the same name. */
function roles(projectId: string): (Role & { file: string })[] {
  const project = listProjects().find((p) => p.id === projectId);
  const out = new Map<string, Role & { file: string }>();
  const dirs: [string, Role['source']][] = [[join(homedir(), '.claude', 'agents'), 'user']];
  if (project) dirs.push([join(project.path, '.claude', 'agents'), 'project']);
  for (const [dir, source] of dirs) {
    let files: string[] = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { continue; }
    for (const f of files) {
      try { const r = parseRole(join(dir, f), source); if (r) out.set(r.name, r); } catch { /* unreadable file: skip */ }
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function systemPrompt(e: Emp): string {
  let body = '';
  try { body = readFileSync(e.roleFile!, 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim(); } catch { /* role file gone */ }
  let voice = '';
  try { voice = readFileSync(join(STATE_DIR, 'voice.md'), 'utf8').trim(); } catch { /* optional */ }
  return [body, NO_ATTRIBUTION, voice].filter(Boolean).join('\n\n');
}

// ---- turns and the queue ----

function caps(): { global: number; perProject: number } {
  const c = (readConfig() as { caps?: { global?: number; perProject?: number } }).caps;
  return { global: c?.global ?? 3, perProject: c?.perProject ?? 2 };
}

/** Starts waiting turns, oldest first, while there are free slots; the rest show 'queued'. */
function schedule(): void {
  if (!mcpReady || quitting) return; // every turn needs the MCP server's port
  const cap = caps();
  const waiting = [...emps.values()].filter((e) => e.pending.length && !e.paused && !turns.has(e.id) && e.state !== 'talking')
    .sort((a, b) => (a.queuedAt ?? 0) - (b.queuedAt ?? 0));
  for (const e of waiting) {
    const inProject = [...turns.keys()].filter((id) => emps.get(id)?.projectId === e.projectId).length;
    if (turns.size < cap.global && inProject < cap.perProject) start(e);
    else if (e.state !== 'queued') { e.state = 'queued'; emit(e); }
  }
}

function setProgress(e: Emp, tasks: TaskState): void {
  e.tasks = tasks;
  e.progress = {
    done: tasks.filter((t) => t.status === 'completed').length,
    total: tasks.length,
    current: tasks.find((t) => t.status === 'in_progress')?.subject,
    next: tasks.filter((t) => t.status === 'pending').map((t) => t.subject),
  };
}

function start(e: Emp): void {
  const prompt = e.pending.shift()!;
  const queuedAt = e.queuedAt;
  if (!e.pending.length) e.queuedAt = undefined;
  let turn: Turn;
  const onEvent: TurnOpts['onEvent'] = (ev) => {
    if (ev.type === 'init') {
      e.sessionId = ev.sessionId;
      // --bare (or a future bare default) drops MyIDE's server; working without approvals is worse than stopping.
      if (!ev.mcpServers.some((s) => s.name === 'myide')) { why.set(e.id, 'bare'); turn.interrupt(); }
      emit(e);
    } else if (ev.type === 'tasks') { setProgress(e, ev.tasks); emit(e); }
    else if (ev.type === 'text' && ev.text.trim()) { e.lastText = ev.text.trim().slice(-2000); emit(e); }
  };
  try {
    put(settingsFile(e), employeeSettings());
    put(mcpFile(e), employeeMcpConfig(e.id)); // rewritten each turn: the server's port changes per launch
    turn = runTurn({
      cwd: e.worktree, prompt, sessionId: e.sessionId, model: e.model, effort: e.effort,
      settingsPath: settingsFile(e), mcpConfigPath: mcpFile(e), appendSystemPrompt: systemPrompt(e), prevTasks: e.tasks, onEvent,
    });
  } catch (err) {
    // Keep the prompt; it runs when David next sends or talks.
    e.pending.unshift(prompt);
    e.queuedAt = queuedAt;
    e.paused = true;
    e.state = 'failed';
    e.error = (err as Error).message;
    emit(e);
    notify(e);
    return;
  }
  turns.set(e.id, turn);
  e.state = 'working';
  e.error = undefined;
  e.ended = undefined;
  emit(e);
  turn.done.then((r) => finish(e, r), (err) => finish(e, { type: 'result', ok: false, interrupted: false, text: String(err), sessionId: e.sessionId ?? '' }));
}

function finish(e: Emp, r: Result): void {
  turns.delete(e.id);
  const w = why.get(e.id);
  why.delete(e.id);
  if (!emps.has(e.id)) return schedule(); // fired
  if (r.sessionId) e.sessionId = r.sessionId;
  if (r.text && !r.interrupted) e.lastText = r.text.slice(-2000); // an interrupted result's text is a CLI diagnostic
  if (w === 'talk') e.state = 'talking';
  else if (w === 'bare') { e.state = 'failed'; e.error = 'This Claude Code version runs -p without MyIDE\'s MCP server (bare mode), so the employee was stopped.'; }
  else if (w === 'model' && r.interrupted) { e.pending.unshift(CONTINUE); e.queuedAt = 0; e.state = 'queued'; }
  else if (r.interrupted) e.state = 'interrupted';
  else if (r.ok) e.state = e.pending.length ? 'queued' : 'done';
  else { e.state = 'failed'; e.error = r.text || 'The turn failed.'; }
  // The CLI gave up waiting (approve answered deny), but David still has to answer it.
  if (e.state !== 'talking' && pendingApprovals().some((a) => a.employeeId === e.id && a.timedOut)) {
    e.ended = e.state;
    e.state = 'needs-you';
    broadcast('approvals:change', pendingApprovals()); // the renderer learns timedOut here
  }
  emit(e);
  // Interrupts MyIDE asked for are not news; one that came from an error is. Nothing is news at quit.
  if (w === 'quit') return;
  if (e.state === 'done' || e.state === 'failed' || (e.state === 'interrupted' && !w)) notify(e);
  schedule();
}

function employeeSettings(): object {
  return {
    attribution: { commit: '', pr: '' },
    permissions: {
      deny: [
        // Forge access goes through MyIDE's forge tool only.
        'Bash(gh *)', 'Bash(env gh *)', 'Bash(command gh *)', 'Bash(*/gh *)', 'Bash(tea *)', 'Bash(curl *api.github.com*)',
        // The commit-msg hook strips attribution; skipping hooks would skip that.
        'Bash(git commit --no-verify*)', 'Bash(git commit *--no-verify*)', 'Bash(git commit -n*)', 'Bash(git commit * -n*)',
      ],
    },
  };
}

// ---- notifications ----

const LABEL: Partial<Record<EmployeeState, string>> = { 'needs-you': 'needs you', done: 'is done', failed: 'failed', interrupted: 'was interrupted' };

// Held until clicked or closed: a notification that is garbage-collected loses its click handler.
const shown = new Set<Notification>();

function notify(e: Emp, body?: string): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: `${e.name} ${LABEL[e.state] ?? e.state}`, body: (body ?? e.error ?? e.lastText ?? e.task ?? '').slice(0, 200) });
  shown.add(n);
  n.on('close', () => shown.delete(n));
  n.on('click', () => {
    shown.delete(n);
    const w = focus();
    if (!w) return;
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
    w.webContents.send('employees:open', e.id);
  });
  n.show();
}

// ---- actions ----

function get(id: string): Emp {
  const e = emps.get(id);
  if (!e) throw new Error('No such employee');
  return e;
}

function send(id: string, text: string): void {
  const e = get(id);
  if (typeof text !== 'string' || !text.trim()) throw new Error('Nothing to send');
  e.pending.push(text);
  e.queuedAt ??= Date.now();
  e.paused = false;
  save(e.projectId);
  schedule();
}

/** A turn that answers something David just did; it goes ahead of anything already queued. */
function followUp(e: Emp, text: string): void {
  e.pending.unshift(text);
  e.queuedAt ??= Date.now();
  e.paused = false;
  save(e.projectId);
  schedule();
}

async function hire(o: { projectId: string; role: string; task: string; model?: string; effort?: string }): Promise<Employee> {
  const project = listProjects().find((p) => p.id === o.projectId);
  if (!project) throw new Error('No such project');
  await checkRepo(project.path, project.name);
  const role = roles(o.projectId).find((r) => r.name === o.role);
  if (!role) throw new Error(`No role named ${o.role}`);
  if (typeof o.task !== 'string' || !o.task.trim()) throw new Error('Give the employee a task');
  const base = slug(role.name);
  const taken = (name: string) => [...emps.values()].some((e) => e.projectId === o.projectId && e.name === name)
    || existsSync(join(STATE_DIR, 'worktrees', o.projectId, name));
  let n = 1;
  while (taken(`${base}-${n}`) || await branchExists(project.path, `myide/${base}-${n}`)) n++;
  const name = `${base}-${n}`;
  const worktree = join(STATE_DIR, 'worktrees', o.projectId, name);
  await addWorktree(project.path, worktree, `myide/${name}`, HOOKS);
  const e: Emp = {
    id: randomUUID(), projectId: o.projectId, role: role.name, name, worktree, branch: `myide/${name}`,
    model: o.model || role.model || DEFAULT_MODEL, effort: o.effort || role.effort, state: 'idle', task: o.task.trim(),
    updatedAt: Date.now(), roleFile: role.file, pending: [],
  };
  emps.set(e.id, e);
  emit(e);
  send(e.id, e.task!);
  return view(e);
}

function interrupt(id: string, reason: 'user' | 'model' | 'talk' | 'fire' | 'quit'): Promise<unknown> | undefined {
  const t = turns.get(id);
  if (!t) return;
  why.set(id, reason);
  t.interrupt();
  return t.done.catch(() => {});
}

/** Pauses background turns; the renderer opens terminal `ptyId` in cwd and types command. Talk ends when that PTY exits. */
async function talk(id: string): Promise<{ cwd: string; command: string; ptyId: string }> {
  const e = get(id);
  if (!e.sessionId) throw new Error(`${e.name} has no session yet; wait for its first turn to start.`);
  await interrupt(id, 'talk');
  e.state = 'talking';
  e.paused = false;
  emit(e);
  put(settingsFile(e), employeeSettings());
  writePrivate(talkPromptFile(e), systemPrompt(e));
  const ptyId = `terminal-${randomUUID().slice(0, 8)}`;
  talkPtys.set(ptyId, e.id);
  // exec: when claude exits so does the PTY, which ends Talk. env -u: a shell rc must not switch accounts.
  const command = ['exec env -u CLAUDE_CONFIG_DIR claude --resume', shq(e.sessionId), '--settings', shq(settingsFile(e)),
    '--model', shq(e.model), ...(e.effort ? ['--effort', shq(e.effort)] : []),
    '--append-system-prompt-file', shq(talkPromptFile(e)), '--disallowedTools Task ScheduleWakeup CronCreate RemoteTrigger'].join(' ');
  return { cwd: e.worktree, command, ptyId };
}

function talkEnded(ptyId: string): void {
  const e = emps.get(talkPtys.get(ptyId) ?? '');
  if (!talkPtys.delete(ptyId) || !e) return;
  if (e.state === 'talking') { e.state = 'idle'; emit(e); }
  schedule();
}

async function fire(id: string, o: { removeWorktree?: boolean }): Promise<void> {
  const e = get(id);
  const project = listProjects().find((p) => p.id === e.projectId);
  emps.delete(id);
  save(e.projectId);
  broadcast('employees:removed', id);
  for (const a of pendingApprovals()) if (a.employeeId === id) resolveApproval(a.id, false, 'Employee fired');
  await interrupt(id, 'fire');
  rmSync(settingsFile(e), { force: true });
  rmSync(mcpFile(e), { force: true });
  rmSync(talkPromptFile(e), { force: true });
  if (o?.removeWorktree && project) await removeWorktree(project.path, e.worktree, e.branch);
}

/** The session transcript Claude Code itself wrote, as plain lines with tool names. */
function transcript(id: string): { role: 'user' | 'assistant' | 'tool'; text: string; at?: string }[] {
  const e = get(id);
  if (!e.sessionId) return [];
  const name = `${e.sessionId}.jsonl`;
  // Claude Code names the folder after the cwd with every non-alphanumeric character as '-'; scan if that guess misses.
  let file = join(CLAUDE_PROJECTS, e.worktree.replace(/[^a-zA-Z0-9]/g, '-'), name);
  if (!existsSync(file)) {
    let dirs: string[] = [];
    try { dirs = readdirSync(CLAUDE_PROJECTS); } catch { /* none yet */ }
    const d = dirs.find((d) => existsSync(join(CLAUDE_PROJECTS, d, name)));
    if (!d) return [];
    file = join(CLAUDE_PROJECTS, d, name);
  }
  const out: { role: 'user' | 'assistant' | 'tool'; text: string; at?: string }[] = [];
  const short = (s: string) => (s.length > 500 ? s.slice(0, 500) + '…' : s);
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    let d: any;
    try { d = JSON.parse(line); } catch { continue; }
    if ((d.type !== 'user' && d.type !== 'assistant') || d.isMeta || !d.message) continue;
    const at = d.timestamp;
    const c = d.message.content;
    if (typeof c === 'string') { out.push({ role: d.type, text: c, at }); continue; }
    for (const b of Array.isArray(c) ? c : []) {
      if (b.type === 'text' && b.text?.trim()) out.push({ role: d.type, text: b.text, at });
      else if (b.type === 'tool_use') out.push({ role: 'tool', text: `${b.name} ${short(JSON.stringify(b.input ?? {}))}`, at });
      else if (b.type === 'tool_result') {
        const t = typeof b.content === 'string' ? b.content : (b.content ?? []).map((x: any) => x.text ?? '').join('\n');
        if (t.trim()) out.push({ role: 'tool', text: `→ ${short(t)}`, at });
      }
    }
  }
  return out;
}

async function claudeTest(): Promise<{ ok: boolean; detail: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'myide-test-'));
  try {
    const settingsPath = join(dir, '.settings.json');
    const mcpPath = join(dir, '.mcp-config.json');
    put(settingsPath, employeeSettings());
    put(mcpPath, employeeMcpConfig('claude-test'));
    const turn = runTurn({ cwd: dir, prompt: 'Reply with exactly: ok', model: 'haiku', settingsPath, mcpConfigPath: mcpPath });
    const timer = setTimeout(() => turn.interrupt(), 90_000);
    const r = await turn.done.finally(() => clearTimeout(timer));
    return { ok: r.ok, detail: r.ok ? `Claude replied: ${r.text.trim().slice(0, 200)}` : r.text || 'No reply' };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- wiring ----

function onNewApproval(a: Approval): void {
  broadcast('approvals:change', pendingApprovals());
  const e = emps.get(a.employeeId);
  if (!e) return;
  e.state = 'needs-you';
  emit(e);
  notify(e, a.text ?? a.tool);
}

/** After an approval is answered or dropped: back to 'working' if its turn is still running, else done, once nothing else waits. */
function approvalGone(): void {
  broadcast('approvals:change', pendingApprovals());
  const waiting = new Set(pendingApprovals().map((a) => a.employeeId));
  for (const e of emps.values()) {
    if (e.state !== 'needs-you' || waiting.has(e.id)) continue;
    e.state = turns.has(e.id) ? 'working' : e.pending.length && !e.paused ? 'queued' : e.ended ?? 'done';
    emit(e);
  }
}

/** David answered an item whose turn already ended (timed out). mcp.ts now allows that exact call once; a follow-up turn retries it. */
function allowedLate(a: Approval, message?: string): void {
  const e = emps.get(a.employeeId);
  if (!e) return;
  if (a.kind === 'question') return followUp(e, `David answered your question: ${message ?? ''}\nContinue.`);
  followUp(e, `David approved: ${a.text ?? a.tool}. Run exactly that again now (it will be allowed), then continue.`);
}

/** Stops running turns at quit; their saved 'working' state loads as 'interrupted'. */
export function stopAllTurns(): void {
  quitting = true;
  for (const id of turns.keys()) void interrupt(id, 'quit');
}

/** `win` gives the main window, which a notification click brings forward. */
export function registerEmployeesIpc(win: () => BrowserWindow | null): void {
  focus = win;
  lockDown();
  installHooks(join(__dirname, 'hooks', 'chain'), HOOKS);
  load();
  onApproval(onNewApproval);
  onApprovalGone(approvalGone);
  onPtyExit(talkEnded);
  void startMcp().then(() => { mcpReady = true; schedule(); }, (err) => console.error('MCP server failed to start', err));

  const h = (channel: string, fn: (...a: any[]) => unknown) => ipcMain.handle(channel, (_e, ...a) => fn(...a));
  h('employees:list', (projectId?: string) => [...emps.values()].filter((e) => !projectId || e.projectId === projectId).map(view));
  h('employees:roles', (projectId: string) => roles(projectId).map(({ file, ...r }) => r));
  h('employees:hire', hire);
  h('employees:send', send);
  h('employees:set-model', async (id: string, o: { model?: string; effort?: string; now?: boolean }) => {
    const e = get(id);
    if (o.model) e.model = o.model;
    if (o.effort !== undefined) e.effort = o.effort || undefined;
    emit(e);
    if (o.now) await interrupt(id, 'model');
  });
  h('employees:interrupt', (id: string) => {
    const e = get(id);
    e.paused = true; // queued messages wait for the next send or talk
    save(e.projectId);
    return interrupt(id, 'user');
  });
  h('employees:talk', talk);
  h('employees:fire', fire);
  h('employees:transcript', transcript);
  h('approvals:list', () => pendingApprovals());
  h('approvals:resolve', (id: string, allow: boolean, message?: string) => {
    const a = pendingApprovals().find((x) => x.id === id);
    resolveApproval(id, !!allow, message);
    if (a?.timedOut && allow) allowedLate(a, message); // deny of a timed-out item just clears it
    approvalGone();
  });
  h('claude:info', claudeInfo);
  h('claude:test', claudeTest);

  registerControlTool('status', 'List MyIDE employees with their state, task and progress. Optional projectId filter.',
    { type: 'object', properties: { projectId: { type: 'string' } } },
    async (a: { projectId?: string }) => [...emps.values()].filter((e) => !a?.projectId || e.projectId === a.projectId).map((e) => ({
      id: e.id, name: e.name, project: listProjects().find((p) => p.id === e.projectId)?.name, state: e.state, model: e.model,
      task: e.task, progress: e.progress, error: e.error,
    })));
  registerControlTool('needs_you', 'List what is waiting on the user: pending approvals and questions, plus failed or interrupted employees.',
    { type: 'object', properties: {} },
    async () => ({
      approvals: pendingApprovals().map((a) => ({ id: a.id, employee: emps.get(a.employeeId)?.name, kind: a.kind, tool: a.tool, text: a.text })),
      employees: [...emps.values()].filter((e) => e.state === 'failed' || e.state === 'interrupted').map((e) => ({ id: e.id, name: e.name, state: e.state, error: e.error })),
    }));
}
