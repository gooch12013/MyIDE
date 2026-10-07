// The personal to-do list (~/.myide/todos.json), its This Mac assignments, and the change journal and command log
// fed by the This Mac employees' hooks (see macSettings in employees.ts).
import { BrowserWindow, ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { hireEmployee, MAC } from './employees';
import { diffSnap, rollback, snapshot, type Snap } from './mac';
import { onEmployeeHook, onTodoPost } from './mcp';
import { readJSON, STATE_DIR, writeJSON } from './store';

export interface Todo {
  id: string; text: string; done: boolean; due?: string; priority: 'high' | 'normal' | 'low'; tags: string[];
  role?: string; employeeId?: string; createdAt: number;
  journal: Snap[]; // files snapshotted before this to-do's employee edited them, oldest first
}

const JOURNAL = join(STATE_DIR, 'journal');
const LOGS = join(STATE_DIR, 'todos');
/** The roles shipped in build/agents; installed into ~/.claude/agents only by the Install button. */
export const MAC_ROLES = ['sysadmin', 'lab-ops', 'assistant', 'desktop'];

const list = (): Todo[] => readJSON<Todo[]>('todos.json', []);
function save(todos: Todo[]): void {
  writeJSON('todos.json', todos);
  for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send('todos:change');
}
function change(id: string, fn: (t: Todo) => void): Todo {
  const todos = list();
  const t = todos.find((x) => x.id === id);
  if (!t) throw new Error('No such to-do');
  fn(t);
  save(todos);
  return t;
}

function log(id: string, text: string): void {
  mkdirSync(LOGS, { recursive: true, mode: 0o700 });
  appendFileSync(join(LOGS, `${id}.log`), `[${new Date().toLocaleString()}] ${text.trimEnd()}\n`, { mode: 0o600 });
}

/** `renew ASC key #mac @sysadmin`: #words are tags, an @word assigns that This Mac role. */
async function add(raw: string): Promise<{ todo: Todo; error?: string }> {
  const role = /(?:^|\s)@([\w-]+)/.exec(raw)?.[1];
  const tags = [...raw.matchAll(/(?:^|\s)#([\w-]+)/g)].map((m) => m[1]);
  const text = raw.replace(/(?:^|\s)[@#][\w-]+/g, '').trim().replace(/^(["'])(.*)\1$/, '$2');
  if (!text) throw new Error('Nothing to add');
  const todo: Todo = { id: randomUUID().slice(0, 8), text, done: false, priority: 'normal', tags, createdAt: Date.now(), journal: [] };
  save([...list(), todo]);
  if (!role) return { todo };
  try { return { todo: await assign(todo.id, role) }; } catch (e) { return { todo, error: (e as Error).message }; }
}

/** Hires a This Mac employee for the to-do; it plans read-only and comes back in NEEDS YOU. */
async function assign(id: string, role: string): Promise<Todo> {
  const t = list().find((x) => x.id === id);
  if (!t) throw new Error('No such to-do');
  let e;
  try { e = await hireEmployee({ projectId: MAC.id, role, task: t.text }); } catch (err) {
    const m = (err as Error).message;
    throw new Error(/No role named/.test(m) && MAC_ROLES.includes(role) ? `${m}. Install the This Mac roles from the To-dos panel first.` : m);
  }
  log(id, `assigned to ${e.name}`);
  return change(id, (x) => { x.role = role; x.employeeId = e.id; });
}

/** The first snapshot this to-do took of `path`: what it was before the to-do touched it. */
function firstSnap(id: string, path: string): Snap {
  const s = list().find((x) => x.id === id)?.journal.find((j) => j.path === path);
  if (!s) throw new Error('No snapshot of that file for this to-do');
  return s;
}

function installRoles(): string {
  const dir = join(homedir(), '.claude', 'agents');
  mkdirSync(dir, { recursive: true });
  const out = MAC_ROLES.map((r) => {
    const dst = join(dir, `${r}.md`);
    if (existsSync(dst)) return `${r}: already there, left as it is`;
    copyFileSync(join(__dirname, 'agents', `${r}.md`), dst);
    return `${r}: installed`;
  });
  return `${dir}: ${out.join('; ')}.`;
}

/** Hook JSON from a This Mac employee: snapshot before Edit/Write, log after Bash. */
function onHook(employeeId: string, b: any): void {
  const t = list().find((x) => x.employeeId === employeeId);
  const key = t?.id ?? `employee-${employeeId}`;
  const input = b?.tool_input ?? {};
  if (b?.hook_event_name === 'PreToolUse') {
    const path = input.file_path ?? input.notebook_path;
    if (typeof path !== 'string' || !path.startsWith('/') || b.permission_mode === 'plan') return;
    // Claude Code's own plan file (plan mode writes it under the account's config dir, beside projects/<cwd>/<session>.jsonl).
    const conf = typeof b.transcript_path === 'string' ? dirname(dirname(dirname(b.transcript_path))) : join(homedir(), '.claude');
    if (path.startsWith(join(conf, 'plans') + '/')) return;
    const s = snapshot(JOURNAL, path, `to-do ${key}`);
    if (!s) return; // inside a git repo
    log(key, `snapshot ${path} (${s.existed ? 'before edit' : 'new file'}, ${s.commit.slice(0, 8)})`);
    if (t) change(t.id, (x) => { x.journal.push(s); });
  } else if (b?.hook_event_name === 'PostToolUse' && b.tool_name === 'Bash') {
    const r = b.tool_response ?? {};
    const out = [r.stdout, r.stderr].filter((x) => typeof x === 'string' && x.trim()).join('\n');
    log(key, `$ ${input.command ?? ''}${r.interrupted ? ' (interrupted)' : ''}\n${out.length > 4000 ? `${out.slice(0, 4000)}\n…` : out}`);
  }
}

export function registerTodosIpc(): void {
  // The quick-add script: ~/.myide/bin/todo "what" [@role].
  try {
    mkdirSync(join(STATE_DIR, 'bin'), { recursive: true, mode: 0o700 });
    copyFileSync(join(__dirname, 'bin', 'todo'), join(STATE_DIR, 'bin', 'todo'));
    chmodSync(join(STATE_DIR, 'bin', 'todo'), 0o700);
  } catch (e) { console.error('Could not install the todo script', e); }
  onTodoPost(async (text) => {
    const r = await add(text);
    return r.error ? `Added "${r.todo.text}", but not assigned: ${r.error}` : `Added "${r.todo.text}"${r.todo.employeeId ? `; ${r.todo.role} is planning it` : ''}.`;
  });
  onEmployeeHook(onHook);

  const h = (channel: string, fn: (...a: any[]) => unknown) => ipcMain.handle(channel, (_e, ...a) => fn(...a));
  h('todos:list', list);
  h('todos:add', add);
  h('todos:update', (id: string, p: Partial<Pick<Todo, 'text' | 'done' | 'due' | 'priority' | 'tags' | 'role' | 'employeeId'>>) => change(id, (t) => {
    if (typeof p.text === 'string' && p.text.trim()) t.text = p.text.trim();
    if (typeof p.done === 'boolean') t.done = p.done;
    if (p.due !== undefined) t.due = /^\d{4}-\d{2}-\d{2}$/.test(String(p.due)) ? p.due : undefined;
    if (p.priority && ['high', 'normal', 'low'].includes(p.priority)) t.priority = p.priority;
    if (Array.isArray(p.tags)) t.tags = p.tags.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
    if (typeof p.role === 'string') t.role = p.role;
    if (typeof p.employeeId === 'string') t.employeeId = p.employeeId;
  }));
  h('todos:remove', (id: string) => save(list().filter((t) => t.id !== id)));
  h('todos:assign', assign);
  h('todos:log', (id: string) => { try { return readFileSync(join(LOGS, `${id}.log`), 'utf8').slice(-100_000); } catch { return ''; } });
  h('todos:diff', (id: string, path: string) => diffSnap(JOURNAL, firstSnap(id, path)));
  h('todos:rollback', (id: string, path: string) => {
    const now = rollback(JOURNAL, firstSnap(id, path), `to-do ${id}`);
    log(id, `rolled back ${path}${now ? ` (the state before rollback is ${now.commit.slice(0, 8)} in the journal)` : ''}`);
  });
  h('todos:install-roles', installRoles);
}
