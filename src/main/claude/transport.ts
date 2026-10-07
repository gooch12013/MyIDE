// One `claude -p` process per turn, in the employee's worktree; the next turn chains on with --resume.
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readImage } from '../attach';
import { MCP_TOOL_TIMEOUT_MS } from '../mcp';
import { spawnEnv } from '../pty';
import { makeParser, type ClaudeEvent, type TaskState } from './parse';

type Result = Extract<ClaudeEvent, { type: 'result' }>;
export interface TurnOpts {
  cwd: string; prompt: string; sessionId?: string; model: string; effort?: string;
  settingsPath: string; mcpConfigPath: string; appendSystemPrompt?: string; prevTasks?: TaskState;
  maxTurns?: number; // the role's myide-max-turns; Claude only
  images?: string[]; // stored image files sent with the prompt as image blocks
  onEvent?(e: ClaudeEvent): void;
  env?: Record<string, string>; // the account's env (CLAUDE_CONFIG_DIR for extra accounts; empty for the default)
  permissionMode?: 'plan' | 'default'; // This Mac: plan (read-only) until David's GO
  addDirs?: string[]; // This Mac: folders the role reads outside its cwd
}
export interface Turn { done: Promise<Result>; interrupt(): void }

// Never --bare (skips the user's own setup) or --tools "" (inlines every MCP schema and overflows the prompt).
export function runTurn(o: TurnOpts): Turn {
  // With images the turn is one stream-json user message on stdin, then stdin closed (the prompt argument is not used).
  const stdin = o.images?.length ? JSON.stringify({ type: 'user', message: { role: 'user', content: [
    ...o.images.map((f) => { const i = readImage(f); return { type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } }; }),
    { type: 'text', text: o.prompt }] } }) + '\n' : undefined;
  const args = [
    '-p', ...(stdin ? ['--input-format', 'stream-json'] : [o.prompt.startsWith('-') ? ' ' + o.prompt : o.prompt]), // a leading dash would read as a flag
    '--output-format', 'stream-json', '--verbose',
    ...(o.sessionId ? ['--resume', o.sessionId] : []),
    '--model', o.model, ...(o.effort ? ['--effort', o.effort] : []), ...(o.maxTurns ? ['--max-turns', String(o.maxTurns)] : []),
    ...(o.permissionMode ? ['--permission-mode', o.permissionMode] : []), ...(o.addDirs?.length ? ['--add-dir', ...o.addDirs] : []), // --add-dir is variadic: a flag must follow
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
      env = { ...env, ...o.env, MCP_TOOL_TIMEOUT: String(MCP_TOOL_TIMEOUT_MS) }; // otherwise an approval is dropped after 60 s
      child = spawn('claude', args, { cwd: o.cwd, env, stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] }); // a piped stdin left open stalls the CLI
      if (stdin) { child.stdin!.on('error', () => {}); child.stdin!.end(stdin); }
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
