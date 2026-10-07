// Turns `claude -p --output-format stream-json --verbose` lines into the few events MyIDE shows.
// Unknown event types and malformed lines are ignored, so a newer CLI that adds events keeps working.

type Status = 'pending' | 'in_progress' | 'completed';
export type TaskState = { id: string; subject: string; status: string }[];
export type ClaudeEvent =
  | { type: 'init'; sessionId: string; model: string; tools: string[]; mcpServers: { name: string; status: string }[] }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; input: unknown }
  | { type: 'tasks'; tasks: { id: string; subject: string; status: Status }[] }
  | { type: 'rate'; fiveHour?: number; sevenDay?: number; resetsAt?: string }
  | { type: 'result'; ok: boolean; interrupted: boolean; text: string; sessionId: string; costUsd?: number };

// The CLI tracks progress with TaskCreate/TaskUpdate/TaskList, one task per call. A task's id only
// arrives in the TaskCreate result, so each call is held by tool_use_id until its result comes back.
// Task ids survive --resume, so the caller keeps tasks() per employee and passes it back in.
export function makeParser(prevTasks: TaskState = []): { push(line: string): ClaudeEvent[]; tasks(): TaskState } {
  const tasks = new Map(prevTasks.map((t) => [String(t.id), { ...t, id: String(t.id) }]));
  const calls = new Map<string, { name: string; input: any }>();
  const snapshot = (): ClaudeEvent => ({ type: 'tasks', tasks: [...tasks.values()].map((t) => ({ ...t, status: t.status as Status })) });

  function push(line: string): ClaudeEvent[] {
    let ev: any;
    try { ev = JSON.parse(line); } catch { return []; }
    if (!ev || typeof ev !== 'object') return [];
    const out: ClaudeEvent[] = [];
    const content: any[] = Array.isArray(ev.message?.content) ? ev.message.content : [];

    if (ev.type === 'system' && ev.subtype === 'init') {
      out.push({
        type: 'init', sessionId: ev.session_id ?? '', model: ev.model ?? '', tools: ev.tools ?? [],
        mcpServers: (ev.mcp_servers ?? []).map((s: any) => ({ name: s.name, status: s.status })),
      });
    } else if (ev.type === 'assistant') {
      for (const c of content) {
        if (c.type === 'text' && c.text) out.push({ type: 'text', text: c.text });
        if (c.type !== 'tool_use') continue;
        out.push({ type: 'tool', name: c.name, input: c.input });
        if (c.name === 'TaskCreate' || c.name === 'TaskUpdate') calls.set(c.id, { name: c.name, input: c.input ?? {} });
        if (c.name === 'TodoWrite' && Array.isArray(c.input?.todos)) { // older CLIs: the whole list each call
          tasks.clear();
          c.input.todos.forEach((t: any, n: number) => tasks.set(String(n + 1), { id: String(n + 1), subject: t.content, status: t.status }));
          out.push(snapshot());
        }
      }
    } else if (ev.type === 'user') {
      const r = ev.tool_use_result;
      if (Array.isArray(r?.tasks)) { // TaskList: a full snapshot
        tasks.clear();
        for (const t of r.tasks) tasks.set(String(t.id), { id: String(t.id), subject: t.subject, status: t.status });
        out.push(snapshot());
      }
      for (const c of content) {
        const call = c.type === 'tool_result' ? calls.get(c.tool_use_id) : undefined;
        if (!call) continue;
        calls.delete(c.tool_use_id);
        if (c.is_error) continue;
        if (call.name === 'TaskCreate') {
          const text = typeof c.content === 'string' ? c.content : (c.content ?? []).map((x: any) => x.text ?? '').join('');
          const id = r?.task?.id ?? /#(\d+)/.exec(text)?.[1];
          if (!id) continue;
          tasks.set(String(id), { id: String(id), subject: r?.task?.subject ?? call.input.subject ?? '', status: 'pending' });
          out.push(snapshot());
        } else if (r?.success !== false) {
          const t = tasks.get(String(call.input.taskId));
          if (!t) continue;
          if (call.input.status === 'deleted') tasks.delete(t.id);
          else { if (call.input.status) t.status = call.input.status; if (call.input.subject) t.subject = call.input.subject; }
          out.push(snapshot());
        }
      }
    } else if (ev.type === 'rate_limit_event') {
      const info = ev.rate_limit_info ?? {};
      const w = info.unifiedWindows ?? {};
      const resets = w.five_hour?.resetsAt ?? info.resetsAt;
      out.push({
        type: 'rate', fiveHour: w.five_hour?.utilization, sevenDay: w.seven_day?.utilization,
        resetsAt: typeof resets === 'number' ? new Date(resets * 1000).toISOString() : resets,
      });
    } else if (ev.type === 'result') {
      // SIGINT still ends with a result: error_during_execution, terminal_reason "aborted_streaming".
      const interrupted = ev.subtype === 'error_during_execution' && /^abort/.test(ev.terminal_reason ?? '');
      out.push({
        type: 'result', ok: !ev.is_error, interrupted, sessionId: ev.session_id ?? '', costUsd: ev.total_cost_usd,
        text: typeof ev.result === 'string' ? ev.result : (ev.errors ?? []).join('\n'),
      });
    }
    return out;
  }

  return { push, tasks: () => [...tasks.values()].map((t) => ({ ...t })) };
}
