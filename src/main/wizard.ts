// The role wizard: an interview as one-off `claude -p` turns (no MCP servers, no tools, resumed in its own temp folder),
// then a role file saved to ~/.claude/agents or the project's .claude/agents. The pure part is in role-file.ts.
import { app, shell } from 'electron';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { listAccounts } from './accounts';
import { codexInfo } from './acp/codex';
import { geminiInfo } from './acp/gemini';
import { dropTranscript, NO_CONNECTORS, oneShot } from './assets';
import { claudeInfo } from './claude/version';
import { MAC, parseRole, roles } from './employees';
import { projectById, readConfig } from './projects';
import { ADVANCED, draftOf, check, parseRoleText, prose, renderRole, replyOf, type Draft, type Reply, type WizardCtx } from './role-file';
import { handle, STATE_DIR } from './store';
import { providers } from './transports';

type Where = 'user' | 'project';
export type Ctx = WizardCtx & { project?: { id: string; name: string }; taken: Record<Where, string[]>; model: string };

// Every built-in tool: the interview only talks. With these denied, claude 2.1.292's init lists no tools at all (checked).
const NO_TOOLS = ['Task', 'Agent', 'Bash', 'BashOutput', 'KillShell', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Read', 'Glob', 'Grep', 'LS',
  'WebFetch', 'WebSearch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TaskStop', 'ToolSearch', 'Skill', 'SlashCommand', 'ExitPlanMode', 'EnterWorktree',
  'ExitWorktree', 'Monitor', 'CronCreate', 'CronDelete', 'CronList', 'DesignSync', 'ListAgents', 'PushNotification', 'RemoteTrigger', 'ReportFindings',
  'ScheduleWakeup', 'SendMessage', 'Workflow', 'Artifact', 'ArtifactData', 'ArtifactComments'];
// ponytail: a list by name; a new built-in that acts still meets permission mode "default", which has no prompt tool in -p,
// so it is refused, and the folder is an empty temp dir. --tools "" would be tighter but is off limits.
const LOCKDOWN = ['--permission-mode', 'default', '--setting-sources', 'project,local', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disallowedTools', ...NO_TOOLS];
type Session = { cwd: string; sessionId?: string; ac: AbortController };
const sessions = new Map<string, Session>();

const project = (id?: string) => (id === MAC.id ? MAC : projectById(id));
const dirFor = (where: Where, projectId?: string): string => {
  if (where === 'user') return join(homedir(), '.claude', 'agents');
  const p = project(projectId);
  if (!p) throw new Error('No project open to save into');
  return join(p.path, '.claude', 'agents');
};
function names(dir: string): string[] {
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { return []; }
  return files.flatMap((f) => { try { const r = parseRole(join(dir, f), 'user'); return r ? [r.name, f.slice(0, -3)] : [f.slice(0, -3)]; } catch { return []; } });
}

async function context(projectId?: string): Promise<Ctx> {
  const [c, x, g] = await Promise.all([claudeInfo(), codexInfo(), geminiInfo()]);
  const p = project(projectId);
  const all = providers();
  return {
    providers: Object.fromEntries(Object.entries(all).map(([id, v]) => [id, { label: v.label, models: v.models, efforts: v.efforts }])),
    accounts: listAccounts().map(({ id, name, provider, allowAuto }) => ({ id, name, provider, allowAuto })),
    installed: { claude: !!c.version, codex: !!x.path, gemini: !!g.path },
    project: p && { id: p.id, name: p.name },
    taken: { user: names(dirFor('user')), project: p ? names(dirFor('project', p.id)) : [] },
    model: (readConfig() as { wizard?: { model?: string } }).wizard?.model || 'sonnet',
  };
}

/** A cheap look at the project: its top-level names and package.json dependencies. */
function stack(projectId?: string): string {
  const p = project(projectId);
  if (!p || p.id === MAC.id) return '';
  let top: string[] = [];
  try { top = readdirSync(p.path).filter((f) => !f.startsWith('.') || f === '.github').slice(0, 60); } catch { /* gone */ }
  let deps: string[] = [];
  try { const j = JSON.parse(readFileSync(join(p.path, 'package.json'), 'utf8')); deps = Object.keys({ ...j.dependencies, ...j.devDependencies }).slice(0, 40); } catch { /* none */ }
  return JSON.stringify({ name: p.name, files: top, deps });
}

function systemPrompt(ctx: Ctx, projectId?: string): string {
  const facts = {
    providers: Object.fromEntries(Object.entries(ctx.providers).map(([id, p]) => [id, { label: p.label, installed: ctx.installed[id], models: p.models.map(([m]) => m), efforts: p.efforts.map(([e]) => e) }])),
    accounts: ctx.accounts, existingRoles: [...new Set([...ctx.taken.user, ...ctx.taken.project])],
  };
  return [
    'You are the role wizard inside MyIDE, a desktop app where David runs AI employees on his code projects. You interview David to write a ROLE: a reusable job description file that MyIDE hires employees from. Each employee works in its own git worktree of a project, gets tasks from David or from a lead, and reports back with its final message.',
    'How to interview:',
    '- Ask at most 2 short questions per turn. Give 2 to 5 suggested answers as "choices" whenever sensible; David may pick or type his own. Use "multi": true when several can apply.',
    '- Questions are only about the job: purpose, responsibilities, how to work, definition of done, what to report back, and what it may and may not do.',
    '- Never ask about these settings in a question: AI, account, model, effort, mode, lead, max reports, shared, read-only, max turns, where to save. As soon as you understand the job, put your suggestions in "settings"; MyIDE shows them as a settings card. David\'s picks come back in his messages as "Settings: {...}"; respect them.',
    '- Your first reply never has a draft: ask your 1 or 2 most useful questions and give your settings. After that, stop asking once you have enough (usually 2 to 4 turns) and send the draft. When David says to draft it, send the draft at once, filling gaps with sensible defaults.',
    '- Employees reach GitHub and Forgejo only through MyIDE\'s forge tool: reads (list_issues, get_issue, list_prs, pr_status) and writes (comment, open_pr, set_labels, draft_issue); gh and tea are blocked. Their commits carry no AI attribution.',
    'Reply with one or two plain sentences for David, then exactly one ```json block:',
    '{"ask": [{"q": "...", "choices": ["..."], "multi": false}], "settings": null or {"provider", "account", "model", "effort", "mode", "lead", "maxReports", "shared", "readOnly", "maxTurns"}, "draft": null or {...}}',
    'The draft: {"name": "kebab-case", "description": "one sentence: when to hire this role", "body": "markdown in the second person (You are ...), with short sections: purpose, responsibilities, how to work, definition of done, what to report back", "rules": ["plain rules of what it may and may not do"], "firstTask": "a sensible first task", and every settings key}. With a draft, "ask" is [].',
    'Settings: mode "pinned" runs the exact model and effort; "manager" lets its lead pick per task; "auto" lets MyIDE pick per task. Suggest the cheapest model that fits: haiku for mechanical work, sonnet for most coding, opus for architecture or hard debugging. effort only from that provider\'s list (none for haiku). lead: it may hire reports of other roles, at most maxReports at once (default 3). shared: a contractor, released after it reports to its lead (one-shot helpers); false keeps it on the project. readOnly: MyIDE blocks its file edits (reviewers, auditors, researchers). maxTurns: a cap on agent turns per task, or null for none. account: an id from the list below, on an installed AI; prefer Claude unless David asks. An account with allowAuto false cannot be used when a lead hires this role.',
    'Never use tools. Never write files.',
    `MyIDE facts: ${JSON.stringify(facts)}`,
    stack(projectId) ? `The project: ${stack(projectId)}` : 'No project: the role is for all projects.',
  ].join('\n');
}

export async function turn(o: { id: string; projectId?: string; message: string }): Promise<{ text: string; reply?: Reply }> {
  if (typeof o?.message !== 'string' || !o.message.trim()) throw new Error('Say something first');
  let s = sessions.get(o.id);
  if (!s) sessions.set(o.id, (s = { cwd: mkdtempSync(join(tmpdir(), 'myide-wizard-')), ac: new AbortController() }));
  const ctx = await context(o.projectId);
  try {
    const r = await oneShot(o.message, ['--model', ctx.model, '--system-prompt', systemPrompt(ctx, o.projectId), '--max-turns', '2', ...LOCKDOWN,
      ...(s.sessionId ? ['--resume', s.sessionId] : [])], { timeoutMs: 240_000, dir: s.cwd, env: NO_CONNECTORS, signal: s.ac.signal });
    if (s.ac.signal.aborted) throw new Error('Cancelled');
    if (!r.ok) throw new Error(r.text.slice(0, 300));
    s.sessionId = r.lines.find((l) => l.type === 'result')?.session_id ?? s.sessionId;
    return { text: prose(r.text), reply: replyOf(r.text, ctx) };
  } finally {
    if (sessions.get(o.id) !== s) clean(s); // ended while the turn ran: the killed child may have written more
  }
}

function clean(s: Session): void {
  s.ac.abort();
  dropTranscript(s.cwd);
  rmSync(s.cwd, { recursive: true, force: true });
}
/** Ends an interview: kills a running turn, removes its temp folder and Claude Code's transcript of it. */
export function end(id: string): void {
  const s = sessions.get(id);
  sessions.delete(id);
  if (s) clean(s);
}

/** An existing role as a draft, for "Edit role with wizard". */
async function read(projectId: string | undefined, name: string): Promise<{ draft?: Draft; advanced?: true; where: Where; file: string }> {
  const r = roles(projectId ?? '').find((x) => x.name === name);
  if (!r) throw new Error(`No role named ${name}`);
  try { return { draft: parseRoleText(readFileSync(r.file, 'utf8'), await context(projectId)), where: r.source, file: r.file }; }
  catch (e) { if ((e as Error).message === ADVANCED) return { advanced: true, where: r.source, file: r.file }; throw e; }
}

/** Templates to start from: David's own in ~/.myide/role-templates (not starting with "_"), then the shipped templates, then the shipped roles. */
async function templates(): Promise<{ file: string; draft: Draft }[]> {
  const ctx = await context();
  return [join(STATE_DIR, 'role-templates'), join(__dirname, 'role-templates'), join(__dirname, 'agents')].flatMap((dir) => {
    let files: string[] = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('_')).sort(); } catch { return []; }
    return files.flatMap((f) => {
      try { const draft = parseRoleText(readFileSync(join(dir, f), 'utf8'), ctx); return draft.name && draft.body ? [{ file: join(dir, f), draft }] : []; } catch { return []; }
    });
  });
}

/** realpath of `p`'s deepest existing ancestor, with the rest appended: where a write there would really land. */
function landing(p: string): string {
  let x = p;
  while (!existsSync(x) && dirname(x) !== x) x = dirname(x);
  return join(realpathSync(x), relative(x, p));
}

/** Writes the role file (0644, like Claude Code's own agents). An existing file is only replaced with overwrite: true;
 *  otherwise the answer is { exists } and David is asked. `file`: the role being edited; a new name there answers
 *  { rename } first, and with rename: true writes <new>.md and then removes the old file. `template`: the template it
 *  started from. Frontmatter the wizard does not edit comes only from those files, re-read here, never from `raw`. */
async function save(raw: Draft, o: { where: Where; projectId?: string; file?: string; template?: string; overwrite?: boolean; rename?: boolean }): Promise<{ file?: string; exists?: string; rename?: string }> {
  const where: Where = o?.where === 'project' ? 'project' : 'user';
  const ctx = await context(o.projectId);
  const dir = dirFor(where, o.projectId);
  const editing = o.file && dirname(o.file) === dir && existsSync(o.file) ? o.file : undefined;
  const source = editing ?? (await templates()).find((t) => t.file === o.template)?.file;
  const disk = source ? parseRoleText(readFileSync(source, 'utf8'), ctx) : undefined;
  const d = draftOf({ ...raw, extra: disk?.extra, orig: disk?.orig }, ctx);
  const own = editing ? (parseRole(editing, 'user')?.name ?? '') : '';
  const { errors } = check(d, ctx, ctx.taken[where].filter((n) => n !== own && `${n}.md` !== (editing && basename(editing))));
  if (errors.length) throw new Error(errors.join(' '));
  const renamed = !!editing && d.name !== own && join(dir, `${d.name}.md`) !== editing;
  if (renamed && o.rename !== true) return { rename: editing };
  const file = editing && !renamed ? editing : join(dir, `${d.name}.md`);
  const root = where === 'user' ? join(homedir(), '.claude') : project(o.projectId)!.path;
  if (!(landing(dir) + sep).startsWith(landing(root) + sep)) throw new Error(`${dir} leads outside ${root} through a link; MyIDE does not write there`);
  const st = lstatSync(file, { throwIfNoEntry: false });
  if (st?.isSymbolicLink()) throw new Error(`${file} is a symbolic link; MyIDE does not write through links`);
  if (st && o.overwrite !== true) return { exists: file };
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, renderRole(d), { mode: 0o644, flag: st ? 'w' : 'wx' });
  if (renamed) rmSync(editing!, { force: true });
  return { file };
}

export function registerWizardIpc(): void {
  handle('wizard:context', context);
  handle('wizard:turn', turn);
  handle('wizard:end', end);
  handle('wizard:read', read);
  handle('wizard:templates', templates);
  handle('wizard:save', save);
  handle('wizard:reveal', (projectId: string | undefined, name: string) => { const r = roles(projectId ?? '').find((x) => x.name === name); if (r) shell.showItemInFolder(r.file); });
  app.on('before-quit', () => { for (const id of [...sessions.keys()]) end(id); });
}
