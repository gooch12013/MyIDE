// One `claude -p` process per turn, in the employee's worktree; the next turn chains on with --resume.
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { MCP_TOOL_TIMEOUT_MS } from '../mcp';
import { spawnEnv } from '../pty';
import { makeParser, type ClaudeEvent, type TaskState } from './parse';

type Result = Extract<ClaudeEvent, { type: 'result' }>;
export interface TurnOpts {
  cwd: string; prompt: string; sessionId?: string; model: string; effort?: string;
  settingsPath: string; mcpConfigPath: string; appendSystemPrompt?: string; prevTasks?: TaskState;
  onEvent?(e: ClaudeEvent): void;
}
export interface Turn { done: Promise<Result>; interrupt(): void }

// Never --bare (skips the user's own setup) or --tools "" (inlines every MCP schema and overflows the prompt).
export function runTurn(o: TurnOpts): Turn {
  const args = [
    '-p', o.prompt.startsWith('-') ? ' ' + o.prompt : o.prompt, // a leading dash would read as a flag
    '--output-format', 'stream-json', '--verbose',
    ...(o.sessionId ? ['--resume', o.sessionId] : []),
    '--model', o.model, ...(o.effort ? ['--effort', o.effort] : []),
    '--settings', o.settingsPath, '--mcp-config', o.mcpConfigPath,
    '--permission-prompt-tool', 'mcp__myide__approve',
    ...(o.appendSystemPrompt ? ['--append-system-prompt', o.appendSystemPrompt] : []),
    '--disallowedTools', 'Task', 'ScheduleWakeup', 'CronCreate', 'RemoteTrigger', // no subagents, no self-wakeups that keep a -p turn alive; last: a variadic flag must not swallow anything after it
  ];

  const emit = (e: ClaudeEvent) => { try { o.onEvent?.(e); } catch (err) { console.error(err); } };
  const parser = makeParser(o.prevTasks);
  let child: ChildProcess | undefined;
  let sigint = false;
  let sessionId = o.sessionId ?? '';

  const done = new Promise<Result>((resolve) => {
    let result: Result | undefined;
    let settled = false;
    const finish = (fallback: string) => {
      if (settled) return;
      settled = true;
      const r = result ?? { type: 'result', ok: false, interrupted: false, text: fallback, sessionId } as Result;
      if (sigint && !r.ok) r.interrupted = true;
      if (!result) emit(r);
      resolve(r);
    };
    void spawnEnv().then((env) => {
      if (sigint) return finish('Interrupted before start');
      env = { ...env, MCP_TOOL_TIMEOUT: String(MCP_TOOL_TIMEOUT_MS) }; // otherwise an approval is dropped after 60 s
      child = spawn('claude', args, { cwd: o.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr!.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
      createInterface({ input: child.stdout! }).on('line', (line) => {
        for (const e of parser.push(line)) {
          emit(e);
          if (e.type === 'init') {
            sessionId = e.sessionId;
            const myide = e.mcpServers.find((s) => s.name === 'myide');
            if (myide?.status === 'failed') emit({ type: 'text', text: 'MyIDE MCP server failed to connect: approvals and org tools are unavailable this turn.' });
          }
          if (e.type === 'result') { result = e; if (e.sessionId) sessionId = e.sessionId; }
        }
      });
      child.on('error', (err) => finish(`Could not start claude: ${err.message}`));
      child.on('close', (code, signal) => finish(stderr.trim() || `claude exited (${signal ?? code}) without a result`));
    });
  });

  return {
    done,
    interrupt: () => { sigint = true; child?.kill('SIGINT'); },
  };
}
