import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isDeepStrictEqual } from 'node:util';

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
const grants: { employeeId: string; tool: string; input: unknown }[] = [];
const control = new Map<string, Tool>();
let seq = 0;

export function onApproval(cb: (a: Approval) => void): void { onNew = cb; }
// Fires when a pending item disappears without resolveApproval (the turn was interrupted and the CLI hung up).
export function onApprovalGone(cb: (id: string) => void): void { onGone = cb; }
export function pendingApprovals(): Approval[] { return [...pending.values()].map((p) => p.a); }
export function resolveApproval(id: string, allow: boolean, message?: string): void {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (p.a.timedOut && allow && p.a.kind !== 'question') grants.push({ employeeId: p.a.employeeId, tool: p.a.tool, input: p.a.input });
  p.answer(allow, message);
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

function employeeTools(employeeId: string, res: ServerResponse): Map<string, Tool> {
  return new Map<string, Tool>([
    ['approve', {
      description: 'Permission prompt: asks David to allow or deny a tool call.',
      inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } } },
      run: async (args) => {
        const tool = String(args?.tool_name ?? '');
        const input = args?.input ?? {};
        const plan = tool === 'ExitPlanMode';
        const g = grants.findIndex((x) => x.employeeId === employeeId && x.tool === tool && isDeepStrictEqual(x.input, input));
        if (g >= 0) { grants.splice(g, 1); return text(JSON.stringify({ behavior: 'allow', updatedInput: input })); }
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
  const id = /^\/mcp\/([^/]+)$/.exec(url.pathname)?.[1];
  let key: string | undefined;
  try { key = id && decodeURIComponent(id); } catch { return reply(res, 400); }
  const tok = url.searchParams.get('token');
  if (!key || !sameToken(tok, key === 'control' ? controlToken : tokens.get(key))) return reply(res, 401);
  if (req.method !== 'POST') return reply(res, 405); // no server-initiated SSE stream
  let body = '';
  req.on('error', () => {}); // a client hanging up mid-body
  req.on('data', (c) => { body += c; if (body.length > 4e6) req.destroy(); });
  req.on('end', async () => {
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
      resolve({ port });
    });
  });
}
