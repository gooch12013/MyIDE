import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { STATE_DIR, writePrivate } from './store';

// One streamable-HTTP MCP server for every employee, JSON responses only (no SSE), hand-rolled like
// spikes A and N. /mcp/<employeeId>?token=… serves `approve` and `ask_human`; /mcp/control?token=…
// serves whatever registerControlTool added.

// timedOut: the CLI could not wait any longer, so `approve` already answered deny ("waiting for David").
// The item stays pending; an allow then grants that exact call once (see `grants`).
export type Approval = { id: string; employeeId: string; tool: string; input: unknown; kind: 'permission' | 'plan' | 'question'; text?: string; createdAt: number; timedOut?: boolean };

// `claude -p` gives up on an MCP tool call after 60 s unless MCP_TOOL_TIMEOUT is set (measured on
// 2.1.292). E must put this in every turn's spawn env; approve answers just before it runs out.
// ponytail: 15 min is the value tested to hold (a 300 s approval survived); raise only after testing a longer one.
export const MCP_TOOL_TIMEOUT_MS = 900_000;
const ANSWER_BY_MS = MCP_TOOL_TIMEOUT_MS - 60_000;
type Tool = { description: string; inputSchema: object; run: (args: any) => Promise<unknown> };

let port = 0;
const controlToken = randomBytes(24).toString('hex');
const tokens = new Map<string, string>(); // employeeId -> token
const pending = new Map<string, { a: Approval; answer(allow: boolean, message?: string): void }>();
let onNew: (a: Approval) => void = () => {};
let onGone: (id: string) => void = () => {};
// Late allows: the next `approve` for the same employee, tool and input is allowed at once, then forgotten.
// `cmd`: a GO on a This Mac plan; matches a Bash call by its command alone (the description the model adds varies).
// A late allow lapses after GRANT_TTL_MS: the retry it is for comes in the follow-up turn, not half a day later.
const grants: { employeeId: string; tool: string; input: unknown; cmd?: boolean; at: number }[] = [];
const GRANT_TTL_MS = 30 * 60_000;
const control = new Map<string, Tool>();
// Org tools (assign_task, forge, ...): `show` decides per employee whether tools/list offers it.
const extra = new Map<string, { description: string; inputSchema: object; run(employeeId: string, args: any): Promise<unknown>; show(employeeId: string): boolean }>();
// POST /issue from ~/.myide/bin/issue; its URL and token are in ~/.myide/issue-endpoint.json.
const issueToken = randomBytes(24).toString('hex');
let onIssue: (project: string, title: string) => Promise<{ number: number; url: string }> = async () => { throw new Error('forge not available'); };
let seq = 0;

export function onApproval(cb: (a: Approval) => void): void { onNew = cb; }
// Fires when a pending item disappears without resolveApproval (the turn was interrupted and the CLI hung up).
export function onApprovalGone(cb: (id: string) => void): void { onGone = cb; }
export function pendingApprovals(): Approval[] { return [...pending.values()].map((p) => p.a); }
export function resolveApproval(id: string, allow: boolean, message?: string): void {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (p.a.timedOut && allow && p.a.kind !== 'question') grants.push({ employeeId: p.a.employeeId, tool: p.a.tool, input: p.a.input, at: Date.now() });
  p.answer(allow, message);
}

/** A GO on a plan: each command is allowed once, exactly as written; anything else still reaches David. */
export function grantCommands(employeeId: string, commands: string[]): void {
  for (const command of commands) grants.push({ employeeId, tool: 'Bash', input: { command }, cmd: true, at: Date.now() });
}
/** Drops a GO's unused commands once its turn ends; `all` (a fired employee) drops its late allows too. */
export function clearGrants(employeeId: string, all = false): void {
  for (let i = grants.length - 1; i >= 0; i--) if (grants[i].employeeId === employeeId && (all || grants[i].cmd)) grants.splice(i, 1);
}

// Claude Code hooks in an employee's settings POST their JSON to /hook/<employeeId>?token=… (This Mac's change journal).
let onHook: (employeeId: string, body: any) => Promise<void> | void = () => {};
export function onEmployeeHook(fn: (employeeId: string, body: any) => Promise<void> | void): void { onHook = fn; }
export function hookUrl(employeeId: string): string {
  let t = tokens.get(employeeId);
  if (!t) tokens.set(employeeId, (t = randomBytes(24).toString('hex')));
  return `http://127.0.0.1:${port}/hook/${encodeURIComponent(employeeId)}?token=${t}`;
}
// POST /todo from ~/.myide/bin/todo, same token as /issue; answers the text the script prints.
let onTodo: (text: string) => Promise<string> = async () => { throw new Error('to-dos not available'); };
export function onTodoPost(fn: (text: string) => Promise<string>): void { onTodo = fn; }

// Answers a permission prompt before grants or David: 'allow', a deny message, or undefined to carry on (the asset studio's spend gate).
let gate: (employeeId: string, tool: string, input: any) => string | undefined = () => undefined;
export function setApproveGate(fn: typeof gate): void { gate = fn; }

export function registerEmployeeTool(name: string, description: string, schema: object,
  run: (employeeId: string, args: any) => Promise<unknown>, show: (employeeId: string) => boolean = () => true): void {
  extra.set(name, { description, inputSchema: schema, run, show });
}

/** MyIDE's own employee tools by exact name (not `approve`): callers may run them without asking David. */
export const ownTool = (name: string): boolean => name === 'ask_human' || extra.has(name);

export function onIssuePost(fn: (project: string, title: string) => Promise<{ number: number; url: string }>): void { onIssue = fn; }

/** A NEEDS YOU item no tool call waits on (e.g. a lead hiring above the ceiling); `answer` runs when David decides. */
export function addApproval(a: Omit<Approval, 'id' | 'createdAt'>, answer: (allow: boolean, message?: string) => void): Approval {
  const approval: Approval = { ...a, id: `ap${++seq}`, createdAt: Date.now() };
  pending.set(approval.id, { a: approval, answer });
  onNew(approval);
  return approval;
}

export function registerControlTool(name: string, description: string, schema: object, run: (args: any) => Promise<unknown>): void {
  control.set(name, { description, inputSchema: schema, run });
}

export function employeeMcpConfig(employeeId: string): object {
  if (!port) throw new Error('startMcp() has not finished');
  let t = tokens.get(employeeId);
  if (!t) tokens.set(employeeId, (t = randomBytes(24).toString('hex')));
  return { mcpServers: { myide: { type: 'http', url: `http://127.0.0.1:${port}/mcp/${encodeURIComponent(employeeId)}?token=${t}` } } };
}

// For the IDE's own control client (E/U wire it up); same shape as employeeMcpConfig.
export function controlMcpConfig(): object {
  return { mcpServers: { myide: { type: 'http', url: `http://127.0.0.1:${port}/mcp/control?token=${controlToken}` } } };
}

const text = (s: string) => ({ content: [{ type: 'text', text: s }] });

// Holds the tools/call until resolveApproval. `res` closing first means the CLI gave up on it.
function hold(res: ServerResponse, a: Omit<Approval, 'id' | 'createdAt'>, reply: (allow: boolean, message?: string) => unknown): Promise<unknown> {
  return new Promise((resolve) => {
    const approval: Approval = { ...a, id: `ap${++seq}`, createdAt: Date.now() };
    const timer = setTimeout(() => {
      approval.timedOut = true;
      resolve(reply(false, 'waiting for David'));
    }, ANSWER_BY_MS);
    pending.set(approval.id, { a: approval, answer: (allow, message) => { clearTimeout(timer); resolve(reply(allow, message)); } });
    res.on('close', () => {
      clearTimeout(timer);
      if (approval.timedOut || !pending.delete(approval.id)) return;
      onGone(approval.id);
      resolve(undefined);
    });
    onNew(approval);
  });
}

// An asset request id (asset_cost, asset_result) belongs to the first employee that reports on it: the one the request went to.
// ponytail: in memory, so after a restart the first caller binds it again.
const requestOwners = new Map<string, string>();
function ownRequest(employeeId: string, requestId: unknown): void {
  if (typeof requestId !== 'string') return;
  if (!requestOwners.has(requestId)) requestOwners.set(requestId, employeeId);
  if (requestOwners.get(requestId) !== employeeId) throw new Error('That asset request belongs to another employee.');
}

function employeeTools(employeeId: string, res: ServerResponse): Map<string, Tool> {
  const tools = new Map<string, Tool>([
    ['approve', {
      description: 'Permission prompt: asks David to allow or deny a tool call.',
      inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } } },
      run: async (args) => {
        const tool = String(args?.tool_name ?? '');
        const input = args?.input ?? {};
        const plan = tool === 'ExitPlanMode';
        const verdict = gate(employeeId, tool, input);
        if (verdict) return text(JSON.stringify(verdict === 'allow' ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: verdict }));
        const g = grants.findIndex((x) => x.employeeId === employeeId && x.tool === tool && (x.cmd || Date.now() - x.at < GRANT_TTL_MS)
          && (x.cmd ? (x.input as { command: string }).command === input.command : isDeepStrictEqual(x.input, input)));
        // MyIDE's own tools enforce their own caps and approvals; asking David about each assign_task is noise.
        // Exact names only: approve itself, or anything else under mcp__myide__, still asks.
        const own = tool.startsWith('mcp__myide__') && ownTool(tool.slice('mcp__myide__'.length));
        if (g >= 0 || own) { if (g >= 0) grants.splice(g, 1); return text(JSON.stringify({ behavior: 'allow', updatedInput: input })); }
        return hold(res, {
          employeeId, tool, input,
          kind: plan ? 'plan' : 'permission',
          text: plan ? String(input.plan ?? '') : typeof input.command === 'string' ? input.command : JSON.stringify(input),
        }, (allow, message) => text(JSON.stringify(allow
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: message || `David denied ${tool}` })));
      },
    }],
    ['ask_human', {
      description: 'Ask David a question and wait for his typed answer. Use only when you cannot proceed without it.',
      inputSchema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
      run: async (args) => hold(res, { employeeId, tool: 'ask_human', input: args, kind: 'question', text: String(args?.question ?? '') },
        (allow, message) => text(allow ? message ?? '' : `David did not answer${message ? `: ${message}` : '.'}`)),
    }],
  ]);
  for (const [name, t] of extra) {
    if (t.show(employeeId)) tools.set(name, { description: t.description, inputSchema: t.inputSchema, run: (args) => { ownRequest(employeeId, args?.requestId); return t.run(employeeId, args); } });
  }
  return tools;
}

function sameToken(a: string | null, b: string | undefined): boolean {
  if (!a || !b) return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function rpc(m: any, tools: Map<string, Tool>): Promise<object> {
  if (m.method === 'initialize') return { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'myide', version: '0' } };
  if (m.method === 'ping') return {};
  if (m.method === 'tools/list') return { tools: [...tools].map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) };
  if (m.method === 'tools/call') {
    const t = tools.get(m.params?.name);
    if (!t) throw Object.assign(new Error(`Unknown tool: ${m.params?.name}`), { code: -32602 });
    try {
      const r = await t.run(m.params?.arguments ?? {});
      return r && typeof r === 'object' && 'content' in r ? r : text(typeof r === 'string' ? r : JSON.stringify(r ?? null));
    } catch (e) {
      return { ...text(`Error: ${(e as Error).message}`), isError: true };
    }
  }
  throw Object.assign(new Error(`Method not found: ${m.method}`), { code: -32601 });
}

const reply = (res: ServerResponse, status: number) => { if (!res.headersSent) res.writeHead(status).end(); };

function handle(req: IncomingMessage, res: ServerResponse): void {
  // Only the local CLI may call: a browser page sends Origin, and a DNS-rebound one a foreign Host.
  if (req.headers.origin !== undefined || req.headers.host !== `127.0.0.1:${port}`) return reply(res, 403);
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/issue') return postIssue(req, res);
  if (url.pathname === '/todo') return postIssue(req, res, true);
  const hook = /^\/hook\/([^/]+)$/.exec(url.pathname)?.[1];
  if (hook) return postHook(req, res, hook, url.searchParams.get('token'));
  const id = /^\/mcp\/([^/]+)$/.exec(url.pathname)?.[1];
  let key: string | undefined;
  try { key = id && decodeURIComponent(id); } catch { return reply(res, 400); }
  const tok = url.searchParams.get('token');
  if (!key || !sameToken(tok, key === 'control' ? controlToken : tokens.get(key))) return reply(res, 401);
  if (req.method !== 'POST') return reply(res, 405); // no server-initiated SSE stream
  readBody(req, 4e6, async (body) => {
    try {
      let m: any;
      try { m = JSON.parse(body); } catch { return reply(res, 400); }
      if (!m || typeof m !== 'object') return reply(res, 400);
      if (m.id === undefined) return reply(res, 202); // notification
      const tools = key === 'control' ? control : employeeTools(key!, res);
      let out: object;
      try { out = { jsonrpc: '2.0', id: m.id, result: await rpc(m, tools) }; }
      catch (e: any) { out = { jsonrpc: '2.0', id: m.id, error: { code: e.code ?? -32603, message: e.message } }; }
      if (!res.writableEnded && !res.destroyed) res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
    } catch (e) { console.error('MCP request failed', e); reply(res, 500); }
  });
}

/** Calls `done` with the whole request body as text; a body over `max` bytes (or a client hanging up mid-body) drops the request. */
function readBody(req: IncomingMessage, max: number, done: (body: string) => void): void {
  const chunks: Buffer[] = [];
  let size = 0;
  req.on('error', () => {});
  req.on('data', (c: Buffer) => { size += c.length; if (size > max) req.destroy(); else chunks.push(c); });
  req.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
}

/** `issue <project> "title"`: JSON { project, title, token } in (the token in the body, never in argv), plain text out. */
function postIssue(req: IncomingMessage, res: ServerResponse, todo = false): void {
  if (req.method !== 'POST') return reply(res, 405);
  readBody(req, 1e5, async (body) => {
    const send = (status: number, t: string) => { if (!res.headersSent) res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }).end(t + '\n'); };
    let m: any;
    try { m = JSON.parse(body); } catch { return send(400, 'MyIDE refused the request (restart it if this persists).'); }
    if (!sameToken(typeof m?.token === 'string' ? m.token : null, issueToken)) return send(401, 'MyIDE refused the request (restart it if this persists).');
    if (todo) {
      if (typeof m.text !== 'string' || !m.text.trim()) return send(400, 'usage: todo "what to do" [@role]');
      try { return send(200, await onTodo(m.text.trim())); } catch (e) { return send(400, (e as Error).message); }
    }
    if (typeof m.project !== 'string' || typeof m.title !== 'string' || !m.title.trim()) return send(400, 'Give a project and a title');
    try {
      const r = await onIssue(m.project, m.title.trim());
      send(200, r.number ? `#${r.number} ${r.url}` : 'Queued: the forge is unreachable; MyIDE files it when it is back.');
    } catch (e) { send(400, (e as Error).message); }
  });
}

/** A hook's JSON in; 200 once MyIDE has handled it (a PreToolUse snapshot is on disk), 500 with the reason otherwise. */
function postHook(req: IncomingMessage, res: ServerResponse, id: string, tok: string | null): void {
  let key: string;
  try { key = decodeURIComponent(id); } catch { return reply(res, 400); }
  if (!sameToken(tok, tokens.get(key))) return reply(res, 401);
  if (req.method !== 'POST') return reply(res, 405);
  // A Write hook carries the whole file it writes. Over the cap curl fails and the hook blocks the edit (never unjournaled).
  // ponytail: 32 MB in memory; send the path only (and read the file here) if bigger files need editing.
  readBody(req, 32e6, async (body) => {
    try { await onHook(key, JSON.parse(body)); reply(res, 200); }
    catch (e) { if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' }).end(String((e as Error).message) + '\n'); }
  });
}

export function startMcp(): Promise<{ port: number }> {
  registerControlTool('ping', 'Check that MyIDE is reachable.', { type: 'object', properties: {} }, async () => 'pong');
  const server = createServer((req, res) => {
    try { handle(req, res); } catch (e) { console.error('MCP request failed', e); reply(res, 500); }
  });
  // Approvals hold a response open for as long as David takes.
  server.requestTimeout = 0;
  server.timeout = 0;
  server.keepAliveTimeout = 24 * 3600_000;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as { port: number }).port;
      writePrivate(join(STATE_DIR, 'issue-endpoint.json'), JSON.stringify({ url: `http://127.0.0.1:${port}/issue`, token: issueToken }) + '\n');
      resolve({ port });
    });
  });
}
