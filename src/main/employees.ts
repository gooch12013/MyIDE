import { BrowserWindow, Notification } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { HF_DENY, HF_SERVER } from './assets';
import { saveAttachments, worktreeImage } from './attach';
import { installHooks } from './attribution';
import type { ClaudeEvent, TaskState } from './claude/parse';
import { runTurn, type Turn, type TurnOpts } from './claude/transport';
import { account, listAccounts, usageOf } from './accounts';
import { frontmatter } from './buttons';
import { providers, runTurnFor, talkCommandFor } from './transports';
import { claudeInfo } from './claude/version';
import { planCommands } from './mac';
import { addApproval, clearGrants, employeeMcpConfig, grantCommands, hookUrl, onApproval, onApprovalGone, pendingApprovals, registerControlTool, registerEmployeeTool, resolveApproval, startMcp, type Approval } from './mcp';
import { aboveCeiling, autoPick, GOAL_TRIES, goalStep, pickStarts, slowedCap, type AutoRule, type Mode, type Pick, type QItem, type Usage } from './org';
import { listProjects, projectById, readConfig, writeConfig } from './projects';
import { onPtyExit } from './pty';
import { broadcast, handle, lockDown, readJSON, slug, STATE_DIR, writeJSON, writePrivate } from './store';
import { addWorktree, branchExists, checkRepo, git, removeWorktree } from './worktree';
import * as tracks from './tracks';

export type EmployeeState = 'idle' | 'queued' | 'working' | 'needs-you' | 'done' | 'failed' | 'interrupted' | 'talking';
export type { Mode, Pick, Usage };
export type IssueRef = { provider: 'github' | 'forgejo'; repo: string; number: number; title: string; url: string };
export interface Employee {
  id: string; projectId: string; role: string; name: string; worktree: string; branch: string;
  sessionId?: string; model: string; effort?: string; state: EmployeeState; task?: string;
  progress?: { done: number; total: number; current?: string; next: string[] };
  lastText?: string; error?: string; updatedAt: number;
  // Org: depth 1 is hired by David; a lead may hire reports (assign_task) up to maxReports running at once.
  parentId?: string; depth: number; lead?: boolean; maxReports?: number; contractor?: boolean; mode: Mode;
  // issue: the forge issue it holds (forge writes go there by default); more: related issues it took on, on the same branch.
  // forIssue: hired for an issue, so MyIDE fires it and its reports once its issues are closed.
  issue?: IssueRef; more?: IssueRef[]; forIssue?: boolean;
  accountId: string; provider: 'claude' | 'codex' | 'gemini';
  /** A model above the ceiling, waiting on David's approval; the next turn waits with it. */
  held?: Pick;
  /** This Mac: the plan from its last ExitPlanMode, the commands in it, and when David hit GO. */
  plan?: { text: string; commands: string[]; approvedAt?: number };
}
// ceiling (myide-ceiling: model or model/effort): the highest pick this role may give its reports without David; else its own model.
export interface Role { name: string; description: string; model?: string; effort?: string; mode?: Mode; account?: string; shared?: boolean; maxTurns?: number; addDirs?: string[]; lead?: boolean; maxReports?: number; readOnly?: boolean; ceiling?: Pick; source: 'user' | 'project' }
/** Per-project org settings, kept in that project's state.json. Priority and pause live in config.json projects[]. */
export interface ProjectOrg { model?: string; effort?: string; mode?: Mode; ceiling?: Pick; maxDepth?: number }
type Issue = IssueRef;
type Result = Extract<ClaudeEvent, { type: 'result' }>;
// Stored beside the public fields: the role file, the parser's task list, turns waiting to run.
// paused: David interrupted, so pending turns wait for his next send or talk.
// ended: the state the last turn ended in, shown again once a late approval is answered.
// heldFor: the ceiling and who asked, so the approval can be raised again after a restart.
// wakeups: turns a lead ran on its reports' results since David last spoke to it (runaway bound).
// A pending turn with images David attached carries their stored paths.
// quiet: a scheduled run; it notifies only when it fails or needs David, never when it is done.
type Pending = string | { text: string; images?: string[]; quiet?: boolean };
// go: This Mac's next turn runs the approved plan (permission mode default, these commands granted once).
// goal: what the employee works toward until it says GOAL DONE (goal mode); goalTries: automatic continues spent on it.
// closedOut: the last issue it held was closed (not handed on), so an employee hired for issues can be let go.
interface Emp extends Employee { goal?: string; goalTries?: number; closedOut?: boolean; roleFile?: string; tasks?: TaskState; pending: Pending[]; queuedAt?: number; paused?: boolean; ended?: EmployeeState; heldFor?: { ceiling: Pick; by: string }; wakeups?: number; go?: string[] }

const HOOKS = join(STATE_DIR, 'hooks');
const GOAL_END = 'End the last message of every turn with one of these lines on its own: GOAL DONE (the goal is met), GOAL BLOCKED: <why> (only David can unblock it), or WAITING (reports you lead are still working on it).';
const GOAL_RULES = 'Goal mode: you have a goal, not a single step. Keep working until it is met. When you have a question, ask David with ask_human '
  + 'and carry on with his answer: never guess, and never end a turn on a question in your text. A lead hands its reports goals too: every assign_task says what done means. '
  + `A message from David overrides or narrows the goal. ${GOAL_END} A turn that ends without one of them is sent on automatically.`;
const TALK_NOTE = 'This is Talk: David is typing to you live in a terminal, so answer him here rather than with ask_human. Your MyIDE tools work here too.';
const TALK_LEAD_NOTE = 'While Talk is open, your reports\' results wait and reach you as a turn when it ends. list_reports shows their state and last message now.';
const NO_ATTRIBUTION = 'No AI attribution anywhere: no Co-Authored-By trailer, no "Generated with Claude Code" line and no Claude-Session line in commits, pull requests, issues or comments. Everything goes out as the user.';
const CONTINUE = 'Continue where you left off.';
const DEFAULT_MODEL = 'sonnet';
// A lead that has run this many turns on its reports' results without David saying anything is paused.
const MAX_WAKEUPS = 20;

const emps = new Map<string, Emp>();
const orgs = new Map<string, ProjectOrg>();
const turns = new Map<string, Turn>();
const changeCbs: ((e: Employee) => void)[] = [];
const removedCbs: ((id: string) => void)[] = [];
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
const view = ({ roleFile, tasks, pending, queuedAt, paused, ended, heldFor, wakeups, go, goal, goalTries, closedOut, ...e }: Emp): Employee => e;
/** Every issue `e` holds, the main one first. */
const held = (e: Employee): Issue[] => [e.issue, ...(e.more ?? [])].filter((i): i is Issue => !!i);
const holds = (e: Employee, n: number) => held(e).some((i) => i.number === n);
const put = (file: string, data: object) => writePrivate(file, JSON.stringify(data, null, 2));

// ---- This Mac: a built-in pseudo-project, no repo and no worktrees; its employees plan read-only, then run on GO ----

export const MAC = { id: 'mac', name: 'This Mac', path: join(STATE_DIR, 'mac'), colour: '#8fa3b8' };
const isMac = (e: { projectId: string }) => e.projectId === MAC.id;
const goTurns = new Set<string>(); // This Mac employees whose running turn is a GO
const quietTurns = new Set<string>(); // employees whose running turn is a scheduled run
const MAC_RULES = 'You work on David\'s Mac itself (shell, files, settings, his servers and services), not in a code repository. '
  + 'Every task starts in plan mode: investigate read-only, then call ExitPlanMode with your plan. In the plan put every command you will run, '
  + 'exactly as you will run it, one per line (a heredoc is one command), in a single ```bash block, and list each file you will edit with its full path. '
  + 'Put how to undo it under a heading "## Undo", after the commands: Undo commands are never pre-approved. Use ```text for output you quote. '
  + 'David approves the plan (GO); your next turn runs with exactly those commands allowed once each, and anything else waits for him. '
  + 'Never print keychain secrets or tokens. Do not touch git repositories unless the task asks. Servers\' own approval rules apply.';

/** This Mac's settings: the usual denies plus the change journal hooks (snapshot before an edit, log every Bash call). */
// Credentials (under the home folder) a This Mac employee never reads, whatever David approves. Read rules also cover Grep and Glob.
const SECRETS = ['.ssh/id_*', '.ssh/*key*', '.appstoreconnect/**', '.config/googleplay/**', '.codex/auth.json', '.gemini/**', '.claude.json',
  '.claude/.credentials*', '.aws/**', '.netrc', '.config/gh/hosts.yml', 'Library/Keychains/**'];
function macSettings(e: Emp): object {
  const base = employeeSettings() as { permissions: { allow: string[]; deny: string[] } };
  const post = (fail: string) => `curl -sf --max-time 60 -H 'Content-Type: application/json' --data-binary @- '${hookUrl(e.id)}' >/dev/null 2>&1 || ${fail}`;
  return {
    ...base,
    // Web search and fetch run free; curl and wget can write files, so on This Mac they wait for the plan's GO like any command.
    permissions: { ...base.permissions, allow: base.permissions.allow.filter((r) => !/^Bash\((curl|wget) /.test(r)), deny: [...base.permissions.deny,
      // The journal, the to-do logs, and the folder's own project settings (an allow rule written there would apply next turn).
      ...[join(STATE_DIR, 'journal/**'), join(STATE_DIR, 'todos/**'), join(MAC.path, '.claude/**')].flatMap((g) => ['Edit', 'Write'].map((t) => `${t}(/${g})`)),
      ...SECRETS.map((g) => `Read(/${join(homedir(), g)})`),
      // ponytail: the common readers only; a shell reaches a file other ways too, so such a command still needs David's GO.
      ...['cat', 'less', 'head', 'tail', 'cp'].flatMap((c) => SECRETS.map((g) => `Bash(${c} *${g.replace(/\*+$/, '')}*)`)),
    ] },
    hooks: {
      PreToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: post(`{ echo 'MyIDE could not snapshot this file into the change journal, so the edit was blocked.' >&2; exit 2; }`) }] }],
      PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: post('true') }] }],
    },
  };
}
const roleOf = (e: Emp) => { try { return e.roleFile ? parseRole(e.roleFile, 'user') : null; } catch { return null; } }; // null: role file gone

// myide-readonly: true in the role denies every file-editing tool (Claude only; the ACP agents ignore the settings file).
// ponytail: Bash can still write files; the role's own rules say not to. A per-command Bash deny list is the upgrade.
function settingsFor(e: Emp): object {
  const s = (isMac(e) ? macSettings(e) : employeeSettings()) as { permissions: { deny: string[] } };
  let ro = false;
  try { ro = !!(e.roleFile && parseRole(e.roleFile, 'user')?.readOnly); } catch { /* role file gone */ }
  return ro ? { ...s, permissions: { ...s.permissions, deny: [...s.permissions.deny, 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'] } } : s;
}

/** GO on a This Mac plan card: the commands come from the text on that card, which must still be the employee's latest plan.
 *  Its pending ExitPlanMode is answered (the plan-mode turn ends), and the next turn runs with those commands allowed. */
function goPlan(a: Approval): void {
  const e = get(a.employeeId);
  if (!isMac(e) || a.kind !== 'plan' || !e.plan) throw new Error('No plan to run');
  if (a.text !== e.plan.text) throw new Error('This is not the plan the employee last proposed. Open its latest plan before GO.');
  for (const x of pendingApprovals()) {
    if (x.employeeId === e.id && x.kind === 'plan') resolveApproval(x.id, false, 'David approved this plan. End your turn now: it runs in your next turn, with exactly the planned commands allowed.');
  }
  e.plan.commands = planCommands(a.text);
  e.plan.approvedAt = Date.now();
  e.go = e.plan.commands;
  const list = e.go.length ? e.go.map((c) => `  ${c}`).join('\n') : '  (none)';
  followUp(e, `GO: David approved your plan. Carry it out now, exactly as planned and in order, file edits included. These commands are pre-approved, once each:\n${list}\n`
    + 'Anything else (a file edit, any other command) you still just call: MyIDE asks David to approve that call, so do not stop or wait for it. '
    + 'When you are done, report what ran and the result.');
  approvalGone();
}

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

/** Hires an employee (todos.ts: a This Mac to-do). */
export const hireEmployee = (o: HireOpts): Promise<Employee> => hire(o);

/** Every change to an employee (B's forge panel follows assignments with it). */
export function onEmployeeChange(cb: (e: Employee) => void): void { changeCbs.push(cb); }
/** An employee was fired. */
export function onEmployeeRemoved(cb: (id: string) => void): void { removedCbs.push(cb); }

/** Every employee, or one project's. */
export const listEmployees = (projectId?: string): Employee[] => [...emps.values()].filter((e) => !projectId || e.projectId === projectId).map(view);

/** David's message as `id`'s next turn (buttons.ts). quiet: a scheduled run, see Pending. */
export const sendToEmployee = (id: string, text: string, o: { quiet?: boolean } = {}): void => send(id, text, undefined, undefined, undefined, o.quiet);

/** Loads every project's employees. A turn that was running when MyIDE quit is now 'interrupted' (send resumes it). */
function load(): void {
  for (const p of [...listProjects(), MAC]) {
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

export function parseRole(file: string, source: Role['source']): (Role & { file: string }) | null {
  const f = frontmatter(file);
  if (!f.name) return null;
  const model = f.model && f.model !== 'inherit' ? f.model : undefined;
  const mode = ['pinned', 'manager', 'auto'].includes(f['myide-mode']) ? f['myide-mode'] as Mode : undefined;
  const maxTurns = Number(f['myide-max-turns']);
  const maxReports = Number(f['myide-max-reports']);
  const addDirs = f['myide-add-dir']?.split(',').map((d) => d.trim().replace(/^~(?=\/|$)/, homedir())).filter(Boolean);
  return {
    addDirs: addDirs?.length ? addDirs : undefined,
    name: f.name, description: f.description ?? '', model, effort: f.effort || undefined, mode, account: f['myide-account'] || undefined,
    shared: f['myide-shared'] === 'true' || undefined, maxTurns: Number.isInteger(maxTurns) && maxTurns > 0 ? maxTurns : undefined, source, file,
    lead: f['myide-lead'] === 'true' || undefined, maxReports: Number.isInteger(maxReports) && maxReports > 0 ? maxReports : undefined,
    readOnly: f['myide-readonly'] === 'true' || undefined,
    ceiling: f['myide-ceiling'] ? { model: f['myide-ceiling'].split('/')[0].trim(), effort: f['myide-ceiling'].split('/')[1]?.trim() || undefined } : undefined,
  };
}

/** Roles from ~/.claude/agents and <project>/.claude/agents; a project role overrides a user role of the same name. */
export function roles(projectId: string): (Role & { file: string })[] {
  const project = projectId === MAC.id ? MAC : projectById(projectId);
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
  return [body, isMac(e) ? MAC_RULES : '', NO_ATTRIBUTION, voice, e.goal ? `${GOAL_RULES}\n\nYour goal:\n${e.goal.slice(0, 4000)}` : ''].filter(Boolean).join('\n\n');
}

// ---- turns and the queue ----

type OrgConfig = {
  caps?: { global?: number; perProject?: number; maxReports?: number; maxDepth?: number; maxLive?: number };
  auto?: { rules?: AutoRule[]; fallback?: string };
  projects?: { id: string; priority?: number; paused?: boolean }[];
};
const orgConfig = (): OrgConfig => readConfig() as OrgConfig;

// maxLive: reports a lead may keep hired (unfired) at once; more hires wait for David.
function caps(): { global: number; perProject: number; maxReports: number; maxDepth: number; maxLive: number } {
  const c = orgConfig().caps;
  return { global: c?.global ?? 3, perProject: c?.perProject ?? 2, maxReports: c?.maxReports ?? 3, maxDepth: c?.maxDepth ?? 3, maxLive: c?.maxLive ?? 6 };
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
  const talking = new Set(talkPtys.values()); // a Talk terminal is open on the session: no background turn alongside it
  const waiting = [...emps.values()].filter((e) => e.pending.length && !e.paused && !e.held && !turns.has(e.id) && e.state !== 'talking' && !talking.has(e.id));
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
  const next = e.pending.shift()!;
  const prompt = typeof next === 'string' ? next : next.text;
  const queuedAt = e.queuedAt;
  if (!e.pending.length) e.queuedAt = undefined;
  let turn: Turn;
  const onEvent: TurnOpts['onEvent'] = (ev) => {
    if (ev.type === 'init') {
      e.sessionId = ev.sessionId;
      tracks.sessionSeen(view(e));
      // --bare (or a future bare default) drops MyIDE's server; working without approvals is worse than stopping.
      if (!ev.mcpServers.some((s) => s.name === 'myide')) { why.set(e.id, 'bare'); turn.interrupt(); }
      emit(e);
    } else if (ev.type === 'tasks') { setProgress(e, ev.tasks); emit(e); }
    else if (ev.type === 'text' && ev.text.trim()) { e.lastText = ev.text.trim().slice(-2000); emit(e); }
  };
  try {
    put(settingsFile(e), settingsFor(e));
    put(mcpFile(e), employeeMcpConfig(e.id)); // rewritten each turn: the server's port changes per launch
    let maxTurns: number | undefined;
    let addDirs: string[] | undefined;
    try { const r = e.roleFile ? parseRole(e.roleFile, 'user') : null; maxTurns = r?.maxTurns; addDirs = r?.addDirs; } catch { /* role file gone */ }
    const go = e.go; // taken by this turn only; the plan turn still ending when David hit GO must not clear it
    if (go) { grantCommands(e.id, go); goTurns.add(e.id); e.go = undefined; }
    if (typeof next !== 'string' && next.quiet) quietTurns.add(e.id); else quietTurns.delete(e.id);
    turn = runTurnFor(e, {
      // This Mac: an explicit mode every turn, and no user settings, so David's own allow rules never run an unplanned command.
      ...(isMac(e) ? { permissionMode: go ? 'default' as const : 'plan' as const, addDirs, settingSources: 'project,local' } : {}),
      cwd: e.worktree, prompt, images: typeof next === 'string' ? undefined : next.images, sessionId: e.sessionId, model: e.model, effort: e.effort, maxTurns,
      settingsPath: settingsFile(e), mcpConfigPath: mcpFile(e), appendSystemPrompt: systemPrompt(e), prevTasks: e.tasks, onEvent,
    });
  } catch (err) {
    // Keep the prompt (and a GO with it); it runs when David next sends or talks.
    if (goTurns.delete(e.id)) { clearGrants(e.id); e.go = e.plan?.commands; }
    quietTurns.delete(e.id);
    e.pending.unshift(next);
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

/** Anyone under `id` (reports, their reports, and so on) still running, queued, held or waiting on David. */
function teamBusy(id: string): boolean {
  return [...emps.values()].some((x) => x.parentId === id && (turns.has(x.id) || x.pending.length > 0 || !!x.held || x.state === 'needs-you' || teamBusy(x.id)));
}

function finish(e: Emp, r: Result): void {
  turns.delete(e.id);
  if (goTurns.delete(e.id)) clearGrants(e.id); // a GO covers one turn; the next one plans again
  const quiet = quietTurns.delete(e.id);
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
  if (e.state === 'queued' && e.paused) e.state = 'interrupted'; // its waiting turns wait for David (runaway pause)
  // Something still waits on David: a call the CLI gave up waiting for, or a card made outside the turn (a hire
  // over the cap, a model above the ceiling). The turn ending must not hide it behind 'done'.
  if (e.state !== 'talking' && pendingApprovals().some((a) => a.employeeId === e.id)) {
    e.ended = e.state;
    e.state = 'needs-you';
    broadcast('approvals:change', pendingApprovals()); // the renderer learns timedOut here
  }
  // Goal mode: a turn that ends short of its goal is sent on (org.ts goalStep). A blocked or stuck goal goes to its lead
  // through the report, or to David as an interrupted employee with the reason.
  let waitingOnReports = false;
  if (e.goal && e.state === 'done' && r.ok && !r.interrupted && !w && !e.paused) {
    const step = goalStep(r.text ?? '', e.goalTries ?? 0, teamBusy(e.id));
    if (step.kind === 'done') { e.goal = undefined; e.goalTries = 0; tracks.note(e, `${e.name}: goal done`); }
    else if (step.kind === 'wait') waitingOnReports = true; // its reports wake it; nothing to report or notify yet
    else if (step.kind === 'continue') {
      e.goalTries = (e.goalTries ?? 0) + 1;
      const text = `Keep going toward your goal (${e.goalTries} of ${GOAL_TRIES}). ${GOAL_END}`;
      e.pending.push(quiet ? { text, quiet } : text); // a scheduled run stays quiet
      e.queuedAt ??= Date.now();
      e.state = 'queued';
    } else {
      const why = step.kind === 'blocked' ? `Goal blocked: ${step.why}` : `Stopped after ${GOAL_TRIES} automatic continues short of its goal.`;
      tracks.note(e, `${e.name}: ${why}`);
      if (!(e.parentId && emps.has(e.parentId))) { e.state = 'interrupted'; e.error = why; } // with a live lead, the lead hears it in the report
    }
  }
  if (e.state === 'failed') tracks.note(e, `${e.name} failed: ${(e.error ?? '').slice(0, 200)}`);
  tracks.turnEnded(e);
  emit(e);
  // Interrupts MyIDE asked for are not news; one that came from an error is. Nothing is news at quit.
  if (w === 'quit') return;
  const ended = e.state === 'done' || e.state === 'failed';
  // A turn that ran to its end reports back even if MyIDE asked to interrupt it just too late.
  if (waitingOnReports) { /* nothing yet */ }
  else if (ended && !r.interrupted && reportBack(e)) {
    // Its lead hears about it, not David. A contractor goes back to the pool once it has reported, unless its goal is still open (blocked).
    if (e.contractor && e.state === 'done' && !e.goal) void releaseContractor(e);
  } else if ((ended || (e.state === 'interrupted' && !w)) && !(quiet && e.state === 'done')) notify(e);
  schedule();
  sweepSoon(e.projectId);
}

/** Pushes a report's final message into its lead's session as the lead's next turn. False if it has no lead.
 *  After MAX_WAKEUPS of these without David's input the lead is paused until he sends it something. */
function reportBack(e: Emp): boolean {
  const lead = e.parentId ? emps.get(e.parentId) : undefined;
  if (!lead) return false;
  const body = e.state === 'failed' ? `failed: ${e.error ?? 'no detail'}` : `finished: ${e.lastText ?? '(no final message)'}`;
  lead.pending.push(`Report ${e.name} (id ${e.id}, branch ${e.branch}${e.contractor ? ', contractor' : ''}) ${body}`);
  lead.queuedAt ??= Date.now();
  lead.wakeups = (lead.wakeups ?? 0) + 1;
  lead.goalTries = 0; // a report finishing is progress toward the lead's goal
  if (lead.wakeups > MAX_WAKEUPS && !lead.paused) {
    lead.paused = true;
    lead.error = `Paused after ${MAX_WAKEUPS} report wake-ups without you. Send it a message to continue.`;
    if (!turns.has(lead.id)) { lead.state = 'interrupted'; emit(lead); }
    notify(lead, `Paused after ${MAX_WAKEUPS} report wake-ups without you. Send it a message to continue.`);
  }
  save(lead.projectId);
  return true;
}

/** A contractor that reported goes back to the pool, unless its worktree holds uncommitted work: then it stays and David hears. */
async function releaseContractor(e: Emp): Promise<void> {
  try {
    if (await git(e.worktree, 'status', '--porcelain')) return notify(e, `${e.name} finished with uncommitted changes in its worktree, so it was kept. Fire it once the work is saved.`);
    await fire(e.id, { removeWorktree: true });
  } catch (err) { console.error('contractor fire', err); }
}

function employeeSettings(): object {
  return {
    attribution: { commit: '', pr: '' },
    permissions: {
      // David's calls: employees run the full gh and tea CLIs, and search and fetch from the web, with no prompt.
      // The forge tool stays for its outbox and the issue cue.
      allow: ['Bash(gh *)', 'Bash(tea *)', 'WebSearch', 'WebFetch', 'Bash(curl *)', 'Bash(wget *)'],
      ask: [HF_SERVER],
      deny: [
        // The commit-msg hook strips attribution; skipping hooks would skip that.
        'Bash(git commit --no-verify*)', 'Bash(git commit *--no-verify*)', 'Bash(git commit *--no-v*)', 'Bash(git commit -n*)', 'Bash(git commit * -n*)',
        'Bash(git * --no-verify*)', 'Bash(git -c *)',
        // The keychain (forge tokens) and MyIDE's own state: the issue endpoint token, configs, other employees' settings.
        // Worktrees live under STATE_DIR too, so the denies name what is not a worktree rather than all of it.
        'Bash(security *)', 'Bash(*myide/bin/issue*)', 'Bash(*myide/bin/todo*)', 'Bash(*issue-endpoint*)',
        // Higgsfield: spending and publishing tools are denied; every other call reaches the approve tool, where generate_image
        // passes only within an asset_cost approval (spendGate in src/main/assets.ts).
        ...HF_DENY,
        ...['*.json', '*.md', 'projects/**', 'accounts/**', 'bin/**', 'hooks/**'].flatMap((g) => ['Read', 'Edit', 'Write'].map((t) => `${t}(/${join(STATE_DIR, g)})`)),
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
function send(id: string, text: string, by?: Emp, pick?: Partial<Pick>, images?: unknown, quiet?: boolean): void {
  const e = get(id);
  if (typeof text !== 'string' || !text.trim()) throw new Error('Nothing to send');
  if (e.mode === 'auto') choose(e, autoFor(text, e), by);
  else if (pick?.model || pick?.effort) choose(e, { model: pick.model || e.model, effort: pick.effort ?? e.effort }, by);
  const paths = saveAttachments(e.projectId, e.name, images);
  e.pending.push(paths.length || quiet ? { text, images: paths.length ? paths : undefined, quiet } : text);
  e.queuedAt ??= Date.now();
  e.paused = false;
  if (by) { e.goal = text.trim(); e.goalTries = 0; } // a lead's message is the report's new goal
  else { e.wakeups = 0; e.goalTries = 0; } // David spoke to it
  save(e.projectId);
  schedule();
}

/** A note for an employee's next turn from MyIDE itself (a dropped forge write, David's answer on an extra hire). */
export function tell(id: string, text: string): void {
  const e = emps.get(id);
  if (!e) return;
  e.pending.push(text);
  e.queuedAt ??= Date.now();
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
  // The effective ceiling is the lower of the project's and the lead's own model: whichever `want` goes above.
  const p = providers()[e.provider] ?? providers().claude;
  const lists = [p.models.map(([m]) => m), p.efforts.map(([x]) => x)] as const;
  const ceiling = [org(e.projectId).ceiling, by && (roleOf(by)?.ceiling ?? { model: by.model, effort: by.effort })].find((c) => c && aboveCeiling(want, c, ...lists));
  if ((by || e.mode === 'auto') && ceiling) return hold(e, want, ceiling, by?.name ?? 'Auto mode');
  e.model = want.model;
  if (want.effort !== undefined) e.effort = want.effort || undefined;
}

function hold(e: Emp, want: Pick, ceiling: Pick, by: string): void {
  e.held = want;
  e.heldFor = { ceiling, by };
  addApproval({
    employeeId: e.id, tool: 'model', input: { model: want.model, effort: want.effort, ceiling }, kind: 'permission',
    text: `${by} wants ${e.name} on ${fmt(want)}, above its ceiling of ${fmt(ceiling)}. Deny runs it at the ceiling.`,
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
  accountId?: string; provider?: Employee['provider']; issue?: Issue; forIssue?: boolean; images?: unknown; quiet?: boolean;
}

// One hire at a time: a lead's parallel assign_task calls would otherwise pick the same free name.
let hiring: Promise<unknown> = Promise.resolve();
function hire(o: HireOpts, by?: Emp): Promise<Employee> {
  const p = hiring.then(() => hireNow(o, by));
  hiring = p.catch(() => {});
  return p;
}

async function hireNow(o: HireOpts, by?: Emp): Promise<Employee> {
  const mac = o.projectId === MAC.id;
  const project = mac ? MAC : projectById(o.projectId);
  if (!project) throw new Error('No such project');
  if (!mac) await checkRepo(project.path, project.name);
  const role = roles(o.projectId).find((r) => r.name === o.role);
  if (!role) throw new Error(`No role named ${o.role}`);
  if (typeof o.task !== 'string' || !o.task.trim()) throw new Error('Give the employee a task');
  const depth = by ? by.depth + 1 : 1;
  if (depth > maxDepth(o.projectId)) throw new Error(`Depth limit: ${project.name} allows ${maxDepth(o.projectId)} levels, and a report of ${by?.name} would be level ${depth}. Do this task yourself or ask David.`);
  const base = slug(role.name, 'employee');
  const taken = (name: string) => [...emps.values()].some((e) => e.projectId === o.projectId && e.name === name)
    || existsSync(join(STATE_DIR, 'worktrees', o.projectId, name));
  let n = 1;
  while (taken(`${base}-${n}`) || (!mac && await branchExists(project.path, `myide/${base}-${n}`))) n++;
  const name = `${base}-${n}`;
  const worktree = mac ? MAC.path : join(STATE_DIR, 'worktrees', o.projectId, name);
  const images = saveAttachments(o.projectId, name, o.images); // checked before the worktree exists
  if (mac) mkdirSync(MAC.path, { recursive: true, mode: 0o700 }); // This Mac's staff share one plain folder
  else await addWorktree(project.path, worktree, `myide/${name}`, HOOKS, by?.branch); // a report starts from its lead's branch
  // Defaults layer: what this hire asked for, then the project's override, then the role's frontmatter.
  const po = org(o.projectId);
  const mode = o.mode || (by && (o.model || o.effort) ? 'manager' : undefined) || po.mode || role.mode;
  let accountId = o.accountId || role.account || 'claude-default';
  // A lead's hire may only land on an account that allows automatic use; otherwise it shares the lead's.
  if (by && !account(accountId)?.allowAuto) accountId = by.accountId;
  const provider = account(accountId)?.provider ?? o.provider ?? 'claude';
  // This Mac's safety rests on Claude Code's plan mode, permission prompt tool and hooks; the ACP agents have no equivalent.
  if (mac && provider !== 'claude') throw new Error('This Mac employees run on Claude only. Pick a Claude account.');
  const e: Emp = {
    id: randomUUID(), projectId: o.projectId, role: role.name, name, worktree, branch: mac ? '' : `myide/${name}`,
    model: DEFAULT_MODEL, state: 'idle', task: o.task.trim(), goal: o.task.trim(), updatedAt: Date.now(), roleFile: role.file, pending: [],
    depth, parentId: by?.id, lead: (o.lead ?? role.lead) || undefined, maxReports: (o.lead ?? role.lead) ? o.maxReports ?? role.maxReports : undefined, contractor: role.shared,
    mode: mode ?? (by ? 'manager' : 'pinned'), accountId, provider, issue: o.issue, forIssue: o.forIssue || undefined,
  };
  emps.set(e.id, e);
  // The layered pick is the starting point; auto re-picks from the task. Whatever a lead or auto picks meets the ceiling.
  const first = { model: o.model || po.model || role.model || DEFAULT_MODEL, effort: o.effort || po.effort || role.effort || undefined };
  e.model = first.model;
  e.effort = first.effort;
  if (e.mode === 'auto') choose(e, autoFor(e.task!, first), by);
  else if (by) choose(e, first, by);
  emit(e);
  e.pending.push(images.length || o.quiet ? { text: e.task!, images: images.length ? images : undefined, quiet: o.quiet } : e.task!);
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
  // Its files first: if any of them fails (the MCP server not up yet), the employee is left as it was, not stuck in 'talking'.
  put(settingsFile(e), settingsFor(e));
  put(mcpFile(e), employeeMcpConfig(e.id));
  writePrivate(talkPromptFile(e), [systemPrompt(e), TALK_NOTE, e.lead ? TALK_LEAD_NOTE : ''].filter(Boolean).join('\n\n'));
  await interrupt(id, 'talk');
  e.closedOut = undefined; // David is talking to it: it stays until he fires it
  e.state = 'talking';
  e.paused = false;
  e.wakeups = 0;
  emit(e);
  const ptyId = `terminal-${randomUUID().slice(0, 8)}`;
  talkPtys.set(ptyId, e.id);
  // exec: when the CLI exits so does the PTY, which ends Talk.
  const command = talkCommandFor(e, { sessionId: e.sessionId, model: e.model, effort: e.effort, settingsPath: settingsFile(e), promptFile: talkPromptFile(e), mcpPath: mcpFile(e), mac: isMac(e) });
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
  const project = projectById(e.projectId);
  emps.delete(id);
  save(e.projectId);
  broadcast('employees:removed', id);
  for (const cb of removedCbs) { try { cb(id); } catch (err) { console.error(err); } }
  for (const a of pendingApprovals()) if (a.employeeId === id) resolveApproval(a.id, false, 'Employee fired');
  clearGrants(id, true); // its late allows go with it
  approvalGone(); // NEEDS YOU drops its cards
  await interrupt(id, 'fire');
  tracks.fired(view(e)); // after the turn stopped, so the kept copy of its session is whole
  rmSync(settingsFile(e), { force: true });
  rmSync(mcpFile(e), { force: true });
  rmSync(talkPromptFile(e), { force: true });
  if (o?.removeWorktree && project) await removeWorktree(project.path, e.worktree, e.branch);
}

// ---- org: leads, reports, issues, projects ----

const TRIAGE = 'How to read the issue: its title, every comment and its linked PRs together are the issue, and the title alone can be the whole spec. '
  + 'Verify the behaviour it names against the code. Never judge it, close it or call it stale or done by its body. '
  + 'If you find it already done or not planned, stop and say so with ask_human, citing file and line; David decides. '
  + 'Read the issue, its comments and linked PRs with the forge tool (get_issue) or gh. Write with either: the forge tool (comment, open_pr, set_labels, close, draft_issue) or gh. Open the PR with "Closes #N" in its body (or "Refs #N" if your role says issues close by hand). Close an issue when David or your role says to.';

function issuePrompt(i: Issue, note?: string, also: Issue[] = []): string {
  const head = also.length
    ? `Also work on ${i.repo}#${i.number}: ${i.title}. You hold it now alongside ${also.map((x) => `#${x.number}`).join(', ')}: related issues go on one branch and one PR.`
    : `Work on ${i.repo}#${i.number}: ${i.title}`;
  return [head, i.url, note ?? '', TRIAGE].filter(Boolean).join('\n\n');
}
/** The goal for everything `e` holds: each issue, then how to read one. */
const issueGoal = (e: Emp) => [`The issues you hold:`, ...held(e).map((i) => `- ${i.repo}#${i.number}: ${i.title} ${i.url}`), TRIAGE].join('\n');

/** `e` takes issue `i` (its main issue if it holds none; else a related one on the same branch). Whoever held it before lets go. */
function give(e: Emp, i: Issue, from?: Emp): void {
  for (const x of emps.values()) {
    if (x === e || x.projectId !== e.projectId || !holds(x, i.number)) continue;
    unhold(x, i.number);
    tracks.released(view(x), i.number, turns.has(x.id));
    if (x !== from) { // David moved it: the old holder stops (a lead handing it down keeps its own goal)
      x.goal = held(x).length ? issueGoal(x) : undefined;
      if (turns.has(x.id) || x.pending.length) tell(x.id, `#${i.number} was given to ${e.name}. Stop work on it.`);
    }
    emit(x);
  }
  if (!e.issue || e.issue.number === i.number) e.issue = i;
  else if (!holds(e, i.number)) e.more = [...(e.more ?? []), i];
  e.closedOut = undefined;
}
function unhold(e: Emp, n: number): void {
  if (e.issue?.number === n) e.issue = e.more?.shift();
  else e.more = e.more?.filter((x) => x.number !== n);
  if (!e.more?.length) e.more = undefined;
}

/** Gives a forge issue to an employee, or hires one from `role` for it. A busy employee takes it on beside what it holds,
 *  on the same branch. forge.ts's assign() posts the start write-back after this returns. */
export async function assignIssue(o: { projectId: string; issue: Employee['issue']; employeeId?: string; role?: string; note?: string }): Promise<Employee> {
  const i = o.issue;
  if (!i) throw new Error('No issue');
  const at = Date.now();
  let e: Emp;
  if (o.employeeId) {
    e = get(o.employeeId);
    const also = held(e).filter((x) => x.number !== i.number);
    give(e, i);
    e.goal = issueGoal(e) + (o.note ? `\n\nDavid's note on #${i.number}: ${o.note}` : ''); // everything it holds is its goal
    e.goalTries = 0;
    send(e.id, issuePrompt(i, o.note, also));
    tracks.assigned(view(e), i, also.length ? `Assigned to ${e.name}, beside ${also.map((x) => `#${x.number}`).join(', ')}` : `Assigned to ${e.name}`, at);
  } else {
    if (!o.role) throw new Error('Pick an employee or a role to hire');
    e = get((await hire({ projectId: o.projectId, role: o.role, task: issuePrompt(i, o.note), issue: i, forIssue: true })).id);
    give(e, i); // whoever held it before lets go
    tracks.assigned(view(e), i, `Hired ${e.name} (${e.role}) for it`, at);
  }
  e.task = `Working #${i.number}: ${i.title}`;
  emit(e);
  return view(e);
}

/** An issue's state on the forge changed: closed ones leave whoever holds them. An employee hired for issues whose
 *  last one closed is let go with its reports (sweep). */
export function issuesClosed(projectId: string, closed: Set<number>, open?: Set<number>): void {
  if (open) tracks.forgeStates(projectId, closed, open);
  for (const e of emps.values()) {
    if (e.projectId !== projectId) continue;
    const gone = held(e).filter((i) => closed.has(i.number));
    if (!gone.length) continue;
    gone.forEach((i) => unhold(e, i.number));
    if (held(e).length) e.goal &&= issueGoal(e);
    else { e.closedOut = true; e.goal = undefined; } // its current turn ends as it will; no more automatic continues
    emit(e);
  }
  sweepSoon(projectId);
}

/** Everyone under `e`, deepest last. */
const below = (e: Emp): Emp[] => [...emps.values()].filter((x) => x.parentId === e.id).flatMap((x) => [x, ...below(x)]);
const still = (x: Emp) => !turns.has(x.id) && !x.pending.length && !x.held && x.state !== 'talking' && x.state !== 'needs-you'
  && ![...talkPtys.values()].includes(x.id) && !pendingApprovals().some((a) => a.employeeId === x.id);
const kept = new Set<string>(); // teams David already heard were kept for uncommitted work
let sweeping: Promise<void> = Promise.resolve();
const sweepSoon = (projectId: string) => { sweeping = sweeping.then(() => sweep(projectId)).catch((err) => console.error('sweep', err)); };

/** Fires an issue team once its issues are closed: an employee hired for issues whose last one closed, with everyone under
 *  it, when all of them are still and none holds an open issue. Worktrees go; branches stay (git keeps unmerged ones).
 *  A worktree with uncommitted changes keeps the whole team, and David hears once. */
async function sweep(projectId: string): Promise<void> {
  if (quitting) return;
  for (const e of [...emps.values()]) {
    if (e.projectId !== projectId || !e.forIssue || !e.closedOut || held(e).length || !emps.has(e.id)) continue;
    const team = [e, ...below(e)];
    if (!team.every((x) => still(x) && !held(x).length)) continue;
    const dirty: string[] = [];
    for (const x of team) if (!isMac(x) && existsSync(x.worktree) && await git(x.worktree, 'status', '--porcelain').catch(() => '?')) dirty.push(x.name);
    if (dirty.length) {
      if (!kept.has(e.id)) { kept.add(e.id); notify(e, `Its issues are closed, but ${dirty.join(', ')} ${dirty.length === 1 ? 'has' : 'have'} uncommitted changes, so the team was kept. Fire it once the work is saved.`); }
      continue;
    }
    // Each await above or below may have given someone new work: check again right before every fire.
    for (const x of team.reverse()) {
      if (!e.closedOut || held(e).length || !emps.has(x.id) || !still(x) || held(x).length) break;
      await fire(x.id, { removeWorktree: true }).catch((err) => { console.error('sweep fire', err); notify(x, `${x.name} was let go, but its worktree could not be removed: ${(err as Error).message}`); });
    }
  }
}

/** Issues held before tracking began: tracked from the prompt that assigned each, with the holder's reports. */
function backfill(): void {
  for (const e of emps.values()) {
    for (const i of held(e)) {
      if (tracks.listTracks(e.projectId).some((t) => t.number === i.number)) continue;
      const lines = e.sessionId && e.provider === 'claude' ? tracks.sessionLines(e.projectId, e.accountId, e.worktree, e.sessionId) : [];
      const start = lines.filter((l) => l.role === 'user' && l.text.startsWith(`Work on ${i.repo}#${i.number}:`)).at(-1);
      const at = Date.parse(start?.at ?? '') || e.updatedAt;
      tracks.assigned(view(e), i, start ? `Assigned to ${e.name}` : `Tracking began: ${e.name} holds it`, at);
      for (const r of emps.values()) if (r.parentId === e.id) tracks.tasked(view(r), view(e), undefined, at);
    }
  }
}

/** The issue numbered `n` that `by` holds; undefined when `n` is unset. */
function heldBy(by: Emp, n: unknown): Issue | undefined {
  if (n === undefined || n === null || n === '') return undefined;
  const i = held(by).find((x) => x.number === Number(n));
  if (!i) throw new Error(`You don't hold #${String(n)}. You hold ${held(by).map((x) => `#${x.number}`).join(', ') || 'no issue'}.`);
  return i;
}

/** After a lead's assign_task or message: an issue handed down moves to the report; a plain task puts the report on the lead's issues. */
function handedOn(by: Emp, r: Emp, issue: Issue | undefined, at: number, hired: boolean): void {
  if (!issue) {
    tracks.tasked(view(r), view(by), hired ? `${by.name} hired ${r.name} (${r.role}, ${fmt(r)})` : `${by.name} gave ${r.name} a task (${fmt(r)})`, at);
    return;
  }
  const also = held(r).filter((x) => x.number !== issue.number);
  give(r, issue, by);
  r.task = `Working #${issue.number}: ${issue.title}`;
  tracks.assigned(view(r), issue, hired ? `${by.name} hired ${r.name} (${r.role}, ${fmt(r)}) for it`
    : `${by.name} gave it to ${r.name}${also.length ? `, beside ${also.map((x) => `#${x.number}`).join(', ')}` : ''}`, at, by.name);
  emit(r);
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
    + 'Caps apply: over a cap it is queued, not refused. Merge its branch into yours when it reports. '
    + 'With issue, it hands that issue (one you hold) to a new hire with a worktree of its own: the hire holds it from then on and you no longer do.',
    { type: 'object', properties: {
      role: { type: 'string', description: 'Role name, as in ~/.claude/agents or the project\'s .claude/agents' },
      task: { type: 'string' }, ...pickSchema,
      lead: { type: 'boolean', description: 'Let this report hire reports of its own. Unset: the role decides.' },
      issue: { type: 'number', description: 'Optional: an issue you hold, handed to this report.' },
    }, required: ['role', 'task'] },
    async (employeeId, a) => {
      const by = get(employeeId);
      if (typeof a?.role !== 'string' || typeof a?.task !== 'string' || !a.task.trim()) throw new Error('Give a role and a task');
      const pick = { model: typeof a.model === 'string' ? a.model : undefined, effort: typeof a.effort === 'string' ? a.effort : undefined };
      const lead = typeof a.lead === 'boolean' ? a.lead : undefined; // unset: the role's myide-lead decides
      const issue = heldBy(by, a.issue);
      const at = Date.now();
      // An issue always gets a fresh hire, so it has a worktree of its own; a plain task may reuse an idle report.
      const idle = issue ? undefined : [...emps.values()].find((r) => r.parentId === by.id && r.role === a.role && (lead === undefined || !!r.lead === lead)
        && !r.pending.length && !turns.has(r.id) && !r.held && (r.state === 'done' || r.state === 'idle'));
      let id: string;
      if (idle) { send(idle.id, a.task.trim(), by, pick); id = idle.id; }
      else {
        const o = { projectId: by.projectId, role: a.role, task: a.task.trim(), ...pick, lead, issue, forIssue: !!issue || undefined };
        const live = [...emps.values()].filter((r) => r.parentId === by.id).length;
        if (live >= caps().maxLive) {
          addApproval({ employeeId: by.id, tool: 'hire', input: o, kind: 'permission',
            text: `${by.name} already has ${live} reports and wants another ${a.role}: ${o.task.slice(0, 300)}` }, (allow) => {
            if (emps.get(by.id) !== by) return;
            if (!allow) return tell(by.id, `David declined the extra ${a.role} hire. Fire a finished report or do the task yourself.`);
            hire(o, by).then((r) => { if (emps.has(r.id)) handedOn(by, get(r.id), issue, Date.now(), true); tell(by.id, `David approved the extra hire: ${r.name} (id ${r.id}) is on it.`); },
              (err) => tell(by.id, `The approved hire failed: ${(err as Error).message}`));
          });
          return `You already have ${live} reports (the limit is ${caps().maxLive}), so this hire waits for David's approval. You hear back as a turn; fire finished reports to make room.`;
        }
        id = (await hire(o, by)).id;
      }
      const r = get(id);
      handedOn(by, r, issue, at, !idle);
      const how = r.held ? `waiting for David to approve ${fmt(r.held)}, above the ceiling`
        : r.state === 'queued' ? 'queued: a cap is full (your max reports, the project, or the account); it starts when a slot frees'
        : 'started';
      return `${idle ? 'Gave the task to' : 'Hired'} ${r.name} (id ${r.id}, branch ${r.branch}, ${fmt(r)}): ${how}.`;
    }, isLead);
  registerEmployeeTool('message', 'Send a direct report its next turn: a follow-up, a fix, or a new task. '
    + 'With issue, it also hands that issue (one you hold) to the report, beside what it holds: related issues share its branch and PR.',
    { type: 'object', properties: { employeeId: { type: 'string' }, text: { type: 'string' }, ...pickSchema,
      issue: { type: 'number', description: 'Optional: an issue you hold, handed to this report.' } }, required: ['employeeId', 'text'] },
    async (employeeId, a) => {
      const by = get(employeeId);
      const r = directReport(by, a?.employeeId);
      const issue = heldBy(by, a?.issue);
      const at = Date.now();
      send(r.id, String(a?.text ?? ''), by, { model: a?.model, effort: a?.effort });
      handedOn(by, r, issue, at, false);
      return `Sent to ${r.name}; it runs as its next turn${r.state === 'queued' ? ' (queued for a slot)' : ''}.`;
    }, isLead);
  registerEmployeeTool('list_reports', 'Your direct reports: id, state, model, task, progress and last message.',
    { type: 'object', properties: {} },
    async (employeeId) => [...emps.values()].filter((r) => r.parentId === employeeId).map((r) => ({
      id: r.id, name: r.name, role: r.role, state: r.held ? 'waiting for approval' : r.state, model: fmt(r), branch: r.branch,
      task: r.task, progress: r.progress && `${r.progress.done} of ${r.progress.total}`, last: r.lastText?.slice(-500),
    })), isLead);
  // The forge tool (reads and writes) is registered by forge.ts.
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
function transcript(id: string): { role: 'user' | 'assistant' | 'tool'; text: string; at?: string; images?: string[] }[] {
  const e = get(id);
  if (e.provider !== 'claude') return [{ role: 'tool', text: `Transcript not available for ${providers()[e.provider]?.label ?? e.provider} yet.` }];
  return e.sessionId ? tracks.sessionLines(e.projectId, e.accountId, e.worktree, e.sessionId) : [];
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
  if (isMac(e) && a.kind === 'plan') e.plan = { text: a.text ?? '', commands: planCommands(a.text ?? '') };
  if (e.state !== 'talking') e.state = 'needs-you'; // Talk keeps its state: the terminal is open on that session
  tracks.note(e, `${e.name} needs you: ${(a.text ?? a.tool).slice(0, 200)}`);
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
  backfill();
  onApproval(onNewApproval);
  onApprovalGone(approvalGone);
  registerOrgTools();
  for (const e of emps.values()) if (e.held && e.heldFor) hold(e, e.held, e.heldFor.ceiling, e.heldFor.by); // approvals live in memory only
  onPtyExit(talkEnded);
  void startMcp().then(() => { mcpReady = true; schedule(); }, (err) => console.error('MCP server failed to start', err));

  handle('employees:list', listEmployees);
  handle('employees:roles', (projectId: string) => roles(projectId).map(({ file, ...r }) => r));
  handle('employees:hire', hire);
  handle('employees:send', (id: string, text: string, images?: unknown) => {
    send(id, text, undefined, undefined, images);
    get(id).closedOut = undefined; // David is talking to it: it stays until he fires it
    tracks.said(get(id), text); // the issue dashboard shows it as David's, queued until its turn runs
  });
  handle('employees:image', (id: string, path: string) => worktreeImage(get(id).worktree, String(path)));
  handle('employees:set-model', async (id: string, o: { model?: string; effort?: string; mode?: Mode; now?: boolean }) => {
    const e = get(id);
    if (o.mode && ['pinned', 'manager', 'auto'].includes(o.mode)) e.mode = o.mode;
    if (o.model) e.model = o.model;
    if (o.effort !== undefined) e.effort = o.effort || undefined;
    emit(e);
    if (o.now) await interrupt(id, 'model');
  });
  handle('employees:interrupt', (id: string) => {
    const e = get(id);
    e.paused = true; // queued messages wait for the next send or talk
    save(e.projectId);
    return interrupt(id, 'user');
  });
  handle('employees:talk', talk);
  handle('employees:fire', fire);
  handle('employees:transcript', transcript);
  // The issue dashboard: tracked issues, and one employee's part of an issue's conversation.
  handle('tracks:list', (projectId?: string) => listProjects().filter((p) => !projectId || p.id === projectId)
    .flatMap((p) => tracks.listTracks(p.id).map((t) => ({ ...t, projectId: p.id }))));
  handle('tracks:thread', (projectId: string, n: number, id: string) => tracks.threadOf(projectId, Number(n), String(id), emps.get(String(id))?.sessionId));
  handle('approvals:list', () => pendingApprovals());
  handle('approvals:resolve', (id: string, allow: boolean, message?: string) => {
    const a = pendingApprovals().find((x) => x.id === id);
    const mac = a?.kind === 'plan' ? emps.get(a.employeeId) : undefined;
    if (mac && isMac(mac)) {
      if (allow) return goPlan(a!);
      mac.plan = undefined; // rejected: the to-do stops offering it
      emit(mac);
    }
    resolveApproval(id, !!allow, message);
    if (a?.timedOut && allow) allowedLate(a, message); // deny of a timed-out item just clears it
    approvalGone();
  });
  handle('org:get', orgState);
  handle('org:set-project', setProject);
  handle('claude:info', claudeInfo);
  handle('claude:test', claudeTest);

  registerControlTool('status', 'List MyIDE employees with their state, task and progress. Optional projectId filter.',
    { type: 'object', properties: { projectId: { type: 'string' } } },
    async (a: { projectId?: string }) => [...emps.values()].filter((e) => !a?.projectId || e.projectId === a.projectId).map((e) => ({
      id: e.id, name: e.name, project: projectById(e.projectId)?.name, state: e.state, model: e.model,
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
