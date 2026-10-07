import { BrowserWindow, ipcMain, Notification } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { installHooks } from './attribution';
import type { ClaudeEvent, TaskState } from './claude/parse';
import { runTurn, type Turn, type TurnOpts } from './claude/transport';
import { account, claudeConfigDir, listAccounts, usageOf } from './accounts';
import { runTurnFor, talkCommandFor } from './transports';
import { claudeInfo } from './claude/version';
import { addApproval, employeeMcpConfig, onApproval, onApprovalGone, onIssuePost, pendingApprovals, registerControlTool, registerEmployeeTool, resolveApproval, startMcp, type Approval } from './mcp';
import { aboveCeiling, autoPick, layered, pickStarts, slowedCap, type AutoRule, type Mode, type Pick, type QItem, type Usage } from './org';
import { listProjects, readConfig, writeConfig } from './projects';
import { onPtyExit } from './pty';
import { lockDown, readJSON, STATE_DIR, writeJSON, writePrivate } from './store';
import { addWorktree, branchExists, checkRepo, removeWorktree } from './worktree';

export type EmployeeState = 'idle' | 'queued' | 'working' | 'needs-you' | 'done' | 'failed' | 'interrupted' | 'talking';
export type { Mode, Pick, Usage };
export interface Employee {
  id: string; projectId: string; role: string; name: string; worktree: string; branch: string;
  sessionId?: string; model: string; effort?: string; state: EmployeeState; task?: string;
  progress?: { done: number; total: number; current?: string; next: string[] };
  lastText?: string; error?: string; updatedAt: number;
  // Org: depth 1 is hired by David; a lead may hire reports (assign_task) up to maxReports running at once.
  parentId?: string; depth: number; lead?: boolean; maxReports?: number; contractor?: boolean; mode: Mode;
  issue?: { provider: 'github' | 'forgejo'; repo: string; number: number; title: string; url: string };
  accountId: string; provider: 'claude' | 'codex' | 'gemini';
  /** A model above the ceiling, waiting on David's approval; the next turn waits with it. */
  held?: Pick;
}
export interface Role { name: string; description: string; model?: string; effort?: string; mode?: Mode; account?: string; shared?: boolean; source: 'user' | 'project' }
/** Per-project org settings, kept in that project's state.json. Priority and pause live in config.json projects[]. */
export interface ProjectOrg { model?: string; effort?: string; mode?: Mode; ceiling?: Pick; maxDepth?: number }
type Issue = NonNullable<Employee['issue']>;
type Result = Extract<ClaudeEvent, { type: 'result' }>;
// Stored beside the public fields: the role file, the parser's task list, turns waiting to run.
// paused: David interrupted, so pending turns wait for his next send or talk.
// ended: the state the last turn ended in, shown again once a late approval is answered.
// heldFor: the ceiling and who asked, so the approval can be raised again after a restart.
interface Emp extends Employee { roleFile?: string; tasks?: TaskState; pending: string[]; queuedAt?: number; paused?: boolean; ended?: EmployeeState; heldFor?: { ceiling: Pick; by: string } }

const HOOKS = join(STATE_DIR, 'hooks');
const NO_ATTRIBUTION = 'No AI attribution anywhere: no Co-Authored-By trailer, no "Generated with Claude Code" line and no Claude-Session line in commits, pull requests, issues or comments. Everything goes out as the user.';
const CONTINUE = 'Continue where you left off.';
const DEFAULT_MODEL = 'sonnet';

const emps = new Map<string, Emp>();
const orgs = new Map<string, ProjectOrg>();
const turns = new Map<string, Turn>();
const changeCbs: ((e: Employee) => void)[] = [];
// Why MyIDE interrupted a running turn, so its result is read correctly.
const why = new Map<string, 'user' | 'model' | 'talk' | 'fire' | 'bare' | 'quit' | 'pause'>();
const talkPtys = new Map<string, string>(); // Talk terminal PTY id -> employee id
let focus: () => BrowserWindow | null = () => null;
let mcpReady = false;
let quitting = false;

const projDir = (projectId: string) => join('projects', projectId);
const settingsFile = (e: Emp) => join(STATE_DIR, projDir(e.projectId), 'settings', `${e.id}.json`);
const mcpFile = (e: Emp) => join(STATE_DIR, projDir(e.projectId), 'mcp', `${e.id}.json`);
const talkPromptFile = (e: Emp) => join(STATE_DIR, projDir(e.projectId), 'talk', `${e.id}.md`);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'employee';
const view = ({ roleFile, tasks, pending, queuedAt, paused, ended, heldFor, ...e }: Emp): Employee => e;
const put = (file: string, data: object) => writePrivate(file, JSON.stringify(data, null, 2));
const broadcast = (channel: string, ...args: unknown[]) => {
  for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send(channel, ...args);
};

// ---- state ----

function save(projectId: string): void {
  writeJSON(join(projDir(projectId), 'state.json'), { org: orgs.get(projectId) ?? {}, employees: [...emps.values()].filter((e) => e.projectId === projectId) });
}

function emit(e: Emp): void {
  e.updatedAt = Date.now();
  save(e.projectId);
  const v = view(e);
  broadcast('employees:change', v);
  for (const cb of changeCbs) { try { cb(v); } catch (err) { console.error(err); } }
}

/** Every change to an employee (B's forge panel follows assignments with it). */
export function onEmployeeChange(cb: (e: Employee) => void): void { changeCbs.push(cb); }

/** Loads every project's employees. A turn that was running when MyIDE quit is now 'interrupted' (send resumes it). */
function load(): void {
  for (const p of listProjects()) {
    const st = readJSON<{ employees?: Emp[]; org?: ProjectOrg }>(join(projDir(p.id), 'state.json'), {});
    orgs.set(p.id, st.org ?? {});
    for (const e of st.employees ?? []) {
      e.pending ??= [];
      e.depth ??= 1;
      e.mode ??= 'pinned';
      e.accountId ??= 'claude-default';
      e.provider ??= 'claude';
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
  const mode = ['pinned', 'manager', 'auto'].includes(f['myide-mode']) ? f['myide-mode'] as Mode : undefined;
  return {
    name: f.name, description: f.description ?? '', model, effort: f.effort || undefined, mode, account: f['myide-account'] || undefined,
    shared: f['myide-shared'] === 'true' || undefined, source, file,
  };
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

type OrgConfig = {
  caps?: { global?: number; perProject?: number; maxReports?: number; maxDepth?: number };
  auto?: { rules?: AutoRule[]; fallback?: string };
  projects?: { id: string; priority?: number; paused?: boolean }[];
};
const orgConfig = (): OrgConfig => readConfig() as OrgConfig;

function caps(): { global: number; perProject: number; maxReports: number; maxDepth: number } {
  const c = orgConfig().caps;
  return { global: c?.global ?? 3, perProject: c?.perProject ?? 2, maxReports: c?.maxReports ?? 3, maxDepth: c?.maxDepth ?? 3 };
}
const projectConf = (id: string) => orgConfig().projects?.find((p) => p.id === id);
const org = (projectId: string): ProjectOrg => orgs.get(projectId) ?? {};
const maxDepth = (projectId: string) => org(projectId).maxDepth ?? caps().maxDepth;

// An account's own cap, one lower while its five-hour window is past 80% (usage comes from the turns' rate events, via accounts.ts).
const accountCap = (id: string) => slowedCap(account(id)?.cap ?? caps().global, usageOf(id));

/** Starts waiting turns while there are free slots (org.ts pickStarts: priority, caps, accounts, leads); the rest show 'queued'. */
function schedule(): void {
  if (!mcpReady || quitting) return; // every turn needs the MCP server's port
  const c = caps();
  const q = (e: Emp): QItem => ({ id: e.id, projectId: e.projectId, accountId: e.accountId, parentId: e.parentId, queuedAt: e.queuedAt });
  const waiting = [...emps.values()].filter((e) => e.pending.length && !e.paused && !e.held && !turns.has(e.id) && e.state !== 'talking');
  const running = [...turns.keys()].map((id) => emps.get(id)).filter((e): e is Emp => !!e).map(q);
  const starts = pickStarts(waiting.map(q), running, {
    global: c.global, perProject: c.perProject, account: accountCap,
    maxReports: (id) => emps.get(id)?.maxReports ?? c.maxReports,
    paused: (id) => !!projectConf(id)?.paused, priority: (id) => projectConf(id)?.priority ?? 0,
  });
  for (const id of starts) start(emps.get(id)!);
  for (const e of waiting) if (!starts.includes(e.id) && e.state !== 'queued') { e.state = 'queued'; emit(e); }
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
    turn = runTurnFor(e, {
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
  else if ((w === 'model' || w === 'pause') && r.interrupted) { e.pending.unshift(CONTINUE); e.queuedAt = 0; e.state = 'queued'; }
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
  const ended = e.state === 'done' || e.state === 'failed';
  if (ended && !w && reportBack(e)) {
    // Its lead hears about it, not David. A contractor goes back to the pool once it has reported.
    if (e.contractor && e.state === 'done') void fire(e.id, { removeWorktree: true }).catch((err) => console.error('contractor fire', err));
  } else if (ended || (e.state === 'interrupted' && !w)) notify(e);
  schedule();
}

/** Pushes a report's final message into its lead's session as the lead's next turn. False if it has no lead. */
function reportBack(e: Emp): boolean {
  const lead = e.parentId ? emps.get(e.parentId) : undefined;
  if (!lead) return false;
  const body = e.state === 'failed' ? `failed: ${e.error ?? 'no detail'}` : `finished: ${e.lastText ?? '(no final message)'}`;
  lead.pending.push(`Report ${e.name} (id ${e.id}, branch ${e.branch}${e.contractor ? ', contractor, now released' : ''}) ${body}`);
  lead.queuedAt ??= Date.now();
  save(lead.projectId);
  return true;
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

/** A new task for `e` (from David, or from lead `by`): auto mode re-picks from it; a lead's pick applies in manager mode. */
function send(id: string, text: string, by?: Emp, pick?: Partial<Pick>): void {
  const e = get(id);
  if (typeof text !== 'string' || !text.trim()) throw new Error('Nothing to send');
  if (e.mode === 'auto') choose(e, autoFor(text, e), by);
  else if (pick?.model || pick?.effort) choose(e, { model: pick.model || e.model, effort: pick.effort ?? e.effort }, by);
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

const fmt = (p: Pick) => `${p.model}${p.effort ? ` · ${p.effort}` : ''}`;

function autoFor(task: string, e: Pick): Pick {
  const a = orgConfig().auto;
  const p = autoPick(task, a?.rules, a?.fallback);
  return { model: p.model, effort: p.effort ?? e.effort };
}

/** Sets e's model and effort, unless a lead or auto mode picked something above the ceiling: then David approves first
 *  (NEEDS YOU) and e's turns wait. Deny runs at the ceiling. David's own picks never need approval. */
function choose(e: Emp, want: Pick, by?: Emp): void {
  const ceiling = org(e.projectId).ceiling ?? (by ? { model: by.model, effort: by.effort } : undefined);
  if ((by || e.mode === 'auto') && ceiling && aboveCeiling(want, ceiling)) return hold(e, want, ceiling, by?.name ?? 'Auto mode');
  e.model = want.model;
  if (want.effort !== undefined) e.effort = want.effort || undefined;
}

function hold(e: Emp, want: Pick, ceiling: Pick, by: string): void {
  e.held = want;
  e.heldFor = { ceiling, by };
  addApproval({
    employeeId: e.id, tool: 'model', input: { model: want.model, effort: want.effort, ceiling }, kind: 'permission',
    text: `${by} wants ${e.name} on ${fmt(want)}, above this project's ceiling of ${fmt(ceiling)}. Deny runs it at the ceiling.`,
  }, (allow) => {
    if (emps.get(e.id) !== e) return; // fired meanwhile
    const use = allow ? want : ceiling;
    e.model = use.model;
    if (use.effort !== undefined) e.effort = use.effort;
    e.held = e.heldFor = undefined;
    emit(e);
    schedule();
  });
}

interface HireOpts {
  projectId: string; role: string; task: string; model?: string; effort?: string; mode?: Mode; lead?: boolean; maxReports?: number;
  accountId?: string; provider?: Employee['provider']; issue?: Issue;
}

// One hire at a time: a lead's parallel assign_task calls would otherwise pick the same free name.
let hiring: Promise<unknown> = Promise.resolve();
function hire(o: HireOpts, by?: Emp): Promise<Employee> {
  const p = hiring.then(() => hireNow(o, by));
  hiring = p.catch(() => {});
  return p;
}

async function hireNow(o: HireOpts, by?: Emp): Promise<Employee> {
  const project = listProjects().find((p) => p.id === o.projectId);
  if (!project) throw new Error('No such project');
  await checkRepo(project.path, project.name);
  const role = roles(o.projectId).find((r) => r.name === o.role);
  if (!role) throw new Error(`No role named ${o.role}`);
  if (typeof o.task !== 'string' || !o.task.trim()) throw new Error('Give the employee a task');
  const depth = by ? by.depth + 1 : 1;
  if (depth > maxDepth(o.projectId)) throw new Error(`Depth limit: ${project.name} allows ${maxDepth(o.projectId)} levels, and a report of ${by?.name} would be level ${depth}. Do this task yourself or ask David.`);
  const base = slug(role.name);
  const taken = (name: string) => [...emps.values()].some((e) => e.projectId === o.projectId && e.name === name)
    || existsSync(join(STATE_DIR, 'worktrees', o.projectId, name));
  let n = 1;
  while (taken(`${base}-${n}`) || await branchExists(project.path, `myide/${base}-${n}`)) n++;
  const name = `${base}-${n}`;
  const worktree = join(STATE_DIR, 'worktrees', o.projectId, name);
  await addWorktree(project.path, worktree, `myide/${name}`, HOOKS, by?.branch); // a report starts from its lead's branch
  const po = org(o.projectId);
  const asked = { model: o.model, effort: o.effort, mode: o.mode ?? (by && (o.model || o.effort) ? 'manager' as Mode : undefined), accountId: o.accountId };
  const l = layered<{ model: string; effort: string; mode: Mode; accountId: string }>(
    { model: role.model, effort: role.effort, mode: role.mode, accountId: role.account }, { model: po.model, effort: po.effort, mode: po.mode }, asked);
  const accountId = l.accountId ?? 'claude-default';
  const provider = account(accountId)?.provider ?? o.provider ?? 'claude';
  const e: Emp = {
    id: randomUUID(), projectId: o.projectId, role: role.name, name, worktree, branch: `myide/${name}`,
    model: DEFAULT_MODEL, state: 'idle', task: o.task.trim(), updatedAt: Date.now(), roleFile: role.file, pending: [],
    depth, parentId: by?.id, lead: !!o.lead || undefined, maxReports: o.lead ? o.maxReports : undefined, contractor: role.shared,
    mode: l.mode ?? (by ? 'manager' : 'pinned'), accountId, provider, issue: o.issue,
  };
  emps.set(e.id, e);
  // The layered pick is the starting point; auto re-picks from the task. Whatever a lead or auto picks meets the ceiling.
  const first = { model: l.model ?? DEFAULT_MODEL, effort: l.effort };
  e.model = first.model;
  e.effort = first.effort;
  if (e.mode === 'auto') choose(e, autoFor(e.task!, first), by);
  else if (by) choose(e, first, by);
  emit(e);
  e.pending.push(e.task!);
  e.queuedAt = Date.now();
  save(e.projectId);
  schedule();
  return view(e);
}

function interrupt(id: string, reason: 'user' | 'model' | 'talk' | 'fire' | 'quit' | 'pause'): Promise<unknown> | undefined {
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
  // exec: when the CLI exits so does the PTY, which ends Talk.
  const command = talkCommandFor(e, { sessionId: e.sessionId, model: e.model, effort: e.effort, settingsPath: settingsFile(e), promptFile: talkPromptFile(e) });
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

// ---- org: leads, reports, issues, projects ----

// forge.ts imports this module back, so it is loaded on first use, not at startup.
function forgeMod(): typeof import('./forge') | null { try { return require('./forge'); } catch { return null; } }

const TRIAGE = 'How to read the issue: its title, every comment and its linked PRs together are the issue, and the title alone can be the whole spec. '
  + 'Verify the behaviour it names against the code. Never judge it, close it or call it stale or done by its body. '
  + 'If you find it already done or not planned, stop and say so with ask_human, citing file and line; David decides. '
  + 'Write to the forge only through the forge tool (comment, open_pr, set_labels, draft_issue). Open the PR with "Closes #N" in its body; there is no close action.';

function issuePrompt(i: Issue, note?: string): string {
  return [`Work on ${i.repo}#${i.number}: ${i.title}`, i.url, note ?? '', TRIAGE].filter(Boolean).join('\n\n');
}

/** Gives a forge issue to an employee, or hires one from `role` for it. The issue becomes its cue header.
 *  forge.ts's assign() posts the start write-back after this returns. */
export async function assignIssue(o: { projectId: string; issue: Employee['issue']; employeeId?: string; role?: string; note?: string }): Promise<Employee> {
  if (!o.issue) throw new Error('No issue');
  let e: Emp;
  if (o.employeeId) {
    e = get(o.employeeId);
    e.issue = o.issue;
    send(e.id, issuePrompt(o.issue, o.note));
  } else {
    if (!o.role) throw new Error('Pick an employee or a role to hire');
    e = get((await hire({ projectId: o.projectId, role: o.role, task: issuePrompt(o.issue, o.note), issue: o.issue })).id);
  }
  e.task = `Working #${o.issue.number}: ${o.issue.title}`;
  emit(e);
  return view(e);
}

function directReport(by: Emp, id: unknown): Emp {
  const r = emps.get(String(id));
  if (!r || r.parentId !== by.id) throw new Error(`${String(id)} is not one of your direct reports. Use list_reports for their ids.`);
  return r;
}

function registerOrgTools(): void {
  const isLead = (id: string) => !!emps.get(id)?.lead;
  const pickSchema = {
    model: { type: 'string', description: 'Optional: haiku, sonnet or opus. Above your own model (or the project ceiling) waits for David.' },
    effort: { type: 'string', description: 'Optional: low, medium, high, xhigh or max.' },
  };
  registerEmployeeTool('assign_task',
    'Give a task to a report: hires one from a role (or reuses your idle report with that role) in its own worktree, branched from yours. '
    + 'Returns at once with its id. Its final message arrives as your next turn when it finishes, so do not poll or wait. '
    + 'Caps apply: over a cap it is queued, not refused. Merge its branch into yours when it reports.',
    { type: 'object', properties: {
      role: { type: 'string', description: 'Role name, as in ~/.claude/agents or the project\'s .claude/agents' },
      task: { type: 'string' }, ...pickSchema,
      lead: { type: 'boolean', description: 'Let this report hire reports of its own' },
    }, required: ['role', 'task'] },
    async (employeeId, a) => {
      const by = get(employeeId);
      if (typeof a?.role !== 'string' || typeof a?.task !== 'string' || !a.task.trim()) throw new Error('Give a role and a task');
      const pick = { model: typeof a.model === 'string' ? a.model : undefined, effort: typeof a.effort === 'string' ? a.effort : undefined };
      const idle = [...emps.values()].find((r) => r.parentId === by.id && r.role === a.role && !!r.lead === !!a.lead && !r.pending.length && !turns.has(r.id)
        && !r.held && (r.state === 'done' || r.state === 'idle'));
      let id: string;
      if (idle) { send(idle.id, a.task.trim(), by, pick); id = idle.id; }
      else id = (await hire({ projectId: by.projectId, role: a.role, task: a.task.trim(), ...pick, lead: !!a.lead }, by)).id;
      const r = get(id);
      const how = r.held ? `waiting for David to approve ${fmt(r.held)}, above the ceiling`
        : r.state === 'queued' ? 'queued: a cap is full (your max reports, the project, or the account); it starts when a slot frees'
        : 'started';
      return `${idle ? 'Gave the task to' : 'Hired'} ${r.name} (id ${r.id}, branch ${r.branch}, ${fmt(r)}): ${how}.`;
    }, isLead);
  registerEmployeeTool('message', 'Send a direct report its next turn: a follow-up, a fix, or a new task.',
    { type: 'object', properties: { employeeId: { type: 'string' }, text: { type: 'string' }, ...pickSchema }, required: ['employeeId', 'text'] },
    async (employeeId, a) => {
      const by = get(employeeId);
      const r = directReport(by, a?.employeeId);
      send(r.id, String(a?.text ?? ''), by, { model: a?.model, effort: a?.effort });
      return `Sent to ${r.name}; it runs as its next turn${r.state === 'queued' ? ' (queued for a slot)' : ''}.`;
    }, isLead);
  registerEmployeeTool('list_reports', 'Your direct reports: id, state, model, task, progress and last message.',
    { type: 'object', properties: {} },
    async (employeeId) => [...emps.values()].filter((r) => r.parentId === employeeId).map((r) => ({
      id: r.id, name: r.name, role: r.role, state: r.held ? 'waiting for approval' : r.state, model: fmt(r), branch: r.branch,
      task: r.task, progress: r.progress && `${r.progress.done} of ${r.progress.total}`, last: r.lastText?.slice(-500),
    })), isLead);
  registerEmployeeTool('forge', 'Write to the issue you hold: comment, open_pr (put "Closes #N" in the body), set_labels, draft_issue (David files it). There is no close.',
    { type: 'object', properties: { action: { type: 'string', enum: ['comment', 'open_pr', 'set_labels', 'draft_issue'] }, args: { type: 'object' } }, required: ['action'] },
    async (employeeId, a) => {
      const f = forgeMod();
      if (!f) return 'forge not available';
      return f.forgeAction(view(get(employeeId)), a?.action, a?.args ?? {});
    }, (id) => !!emps.get(id)?.issue);
  onIssuePost(async (project, title) => {
    const f = forgeMod();
    if (!f) throw new Error('forge not available');
    return f.quickAddIssue(project, title);
  });
}

type ProjectPatch = { [K in keyof ProjectOrg]?: ProjectOrg[K] | null } & { priority?: number; paused?: boolean };

function orgState() {
  const c = caps();
  return {
    caps: c,
    projects: listProjects().map((p) => ({ id: p.id, priority: projectConf(p.id)?.priority ?? 0, paused: !!projectConf(p.id)?.paused, ...org(p.id), maxDepth: maxDepth(p.id) })),
  };
}

/** Priority and pause go to config.json; the rest to the project's state.json. Pausing interrupts its running turns, freeing their slots. */
async function setProject(id: string, patch: ProjectPatch): Promise<void> {
  if (!listProjects().some((p) => p.id === id)) throw new Error('No such project');
  const { priority, paused, ...rest } = patch ?? {};
  if (priority !== undefined || paused !== undefined) {
    const cfg = readConfig();
    writeConfig({ ...cfg, projects: (cfg.projects ?? []).map((p) => p.id !== id ? p : {
      ...p, ...(Number.isFinite(priority) ? { priority: Math.round(priority!) } : {}), ...(paused !== undefined ? { paused: !!paused } : {}),
    }) });
  }
  if (Object.keys(rest).length) {
    const o = { ...org(id) };
    const ok: Record<string, (v: any) => boolean> = {
      model: (v) => typeof v === 'string', effort: (v) => typeof v === 'string', mode: (v) => ['pinned', 'manager', 'auto'].includes(v),
      ceiling: (v) => typeof v?.model === 'string' && (v.effort === undefined || typeof v.effort === 'string'), maxDepth: (v) => Number.isInteger(v) && v >= 1 && v <= 20,
    };
    for (const [k, v] of Object.entries(rest)) {
      if (!ok[k]) continue;
      if (v === null || v === '') delete (o as any)[k];
      else if (ok[k](v)) (o as any)[k] = v;
    }
    orgs.set(id, o);
    save(id);
  }
  broadcast('org:change', orgState());
  if (paused) await Promise.all([...turns.keys()].filter((t) => emps.get(t)?.projectId === id).map((t) => interrupt(t, 'pause')));
  schedule();
}

/** The session transcript Claude Code itself wrote, as plain lines with tool names. */
function transcript(id: string): { role: 'user' | 'assistant' | 'tool'; text: string; at?: string }[] {
  const e = get(id);
  if (e.provider === 'codex') return [{ role: 'tool', text: 'Transcript not available for Codex yet.' }];
  if (!e.sessionId) return [];
  const CLAUDE_PROJECTS = join(claudeConfigDir(e.accountId), 'projects'); // the account's own store
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
  registerOrgTools();
  for (const e of emps.values()) if (e.held && e.heldFor) hold(e, e.held, e.heldFor.ceiling, e.heldFor.by); // approvals live in memory only
  onPtyExit(talkEnded);
  void startMcp().then(() => { mcpReady = true; schedule(); }, (err) => console.error('MCP server failed to start', err));

  const h = (channel: string, fn: (...a: any[]) => unknown) => ipcMain.handle(channel, (_e, ...a) => fn(...a));
  h('employees:list', (projectId?: string) => [...emps.values()].filter((e) => !projectId || e.projectId === projectId).map(view));
  h('employees:roles', (projectId: string) => roles(projectId).map(({ file, ...r }) => r));
  h('employees:hire', hire);
  h('employees:send', send);
  h('employees:set-model', async (id: string, o: { model?: string; effort?: string; mode?: Mode; now?: boolean }) => {
    const e = get(id);
    if (o.mode && ['pinned', 'manager', 'auto'].includes(o.mode)) e.mode = o.mode;
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
  h('org:get', orgState);
  h('org:set-project', setProject);
  h('claude:info', claudeInfo);
  h('claude:test', claudeTest);

  registerControlTool('status', 'List MyIDE employees with their state, task and progress. Optional projectId filter.',
    { type: 'object', properties: { projectId: { type: 'string' } } },
    async (a: { projectId?: string }) => [...emps.values()].filter((e) => !a?.projectId || e.projectId === a.projectId).map((e) => ({
      id: e.id, name: e.name, project: listProjects().find((p) => p.id === e.projectId)?.name, state: e.state, model: e.model,
      task: e.task, progress: e.progress, error: e.error,
    })));
  registerControlTool('usage', 'Rate-limit usage per AI account: five-hour and seven-day utilization (0 to 1) and reset time.',
    { type: 'object', properties: {} }, async () => listAccounts().map((a) => ({ account: a.name, provider: a.provider, cap: a.cap, ...usageOf(a.id) })));
  registerControlTool('pause', 'Pause or resume a project. Pausing stops its running turns and frees their slots; they continue on resume.',
    { type: 'object', properties: { projectId: { type: 'string' }, paused: { type: 'boolean' } }, required: ['projectId', 'paused'] },
    async (a: { projectId: string; paused: boolean }) => { await setProject(a.projectId, { paused: !!a.paused }); return a.paused ? 'Paused.' : 'Resumed.'; });
  registerControlTool('needs_you', 'List what is waiting on the user: pending approvals and questions, plus failed or interrupted employees.',
    { type: 'object', properties: {} },
    async () => ({
      approvals: pendingApprovals().map((a) => ({ id: a.id, employee: emps.get(a.employeeId)?.name, kind: a.kind, tool: a.tool, text: a.text })),
      employees: [...emps.values()].filter((e) => e.state === 'failed' || e.state === 'interrupted').map((e) => ({ id: e.id, name: e.name, state: e.state, error: e.error })),
    }));
}
