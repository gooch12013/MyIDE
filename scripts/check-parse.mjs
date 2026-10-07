// Feeds the recorded spike streams through src/main/claude/parse.ts. Usage: node scripts/check-parse.mjs
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { makeParser } from '../src/main/claude/parse.ts';

const lines = (f) => readFileSync(f, 'utf8').split('\n').filter(Boolean);
const gz = (f) => gunzipSync(readFileSync(f)).toString().split('\n').filter(Boolean);
const feed = (p, ls) => ls.flatMap((l) => p.push(l));
const lastTasks = (evs) => evs.filter((e) => e.type === 'tasks').at(-1).tasks;

// Turn 1 of spike D: 4 tasks created, each in_progress then completed.
let p = makeParser();
let evs = feed(p, lines('spikes/D/fixtures/task_events.jsonl'));
const counts = evs.filter((e) => e.type === 'tasks').map((e) => `${e.tasks.filter((t) => t.status === 'completed').length}/${e.tasks.length}`);
assert.deepEqual(counts.slice(0, 4), ['0/1', '0/2', '0/3', '0/4']);
assert.equal(counts.at(-1), '4/4');
assert.deepEqual(lastTasks(evs).map((t) => t.id), ['1', '2', '3', '4']);
assert.equal(lastTasks(evs)[0].subject, 'Create a.txt containing "alpha"');
assert.ok(evs.some((e) => e.type === 'tasks' && e.tasks[0].status === 'in_progress'));
assert.equal(evs.filter((e) => e.type === 'tool').length, 12);

// State carried into the next turn; a TaskList snapshot replaces it.
const p2 = makeParser(p.tasks());
evs = feed(p2, lines('spikes/D/fixtures/tasklist_result.jsonl'));
assert.equal(lastTasks(evs).length, 5);
assert.ok(lastTasks(evs).every((t) => t.status === 'completed'));

// Whole recorded runs: init, text, result; turn 2 resumes with turn 1's tasks.
p = makeParser();
evs = feed(p, gz('spikes/D/raw_run1.jsonl.gz'));
const init = evs.find((e) => e.type === 'init');
assert.equal(init.model, 'claude-haiku-4-5-20251001');
assert.ok(init.sessionId && init.tools.includes('TaskCreate') && init.mcpServers.some((s) => s.status === 'failed'));
const res = evs.at(-1);
assert.equal(res.type, 'result');
assert.ok(res.ok && !res.interrupted && res.sessionId === init.sessionId);
evs = feed(makeParser(p.tasks()), gz('spikes/D/raw_run2_resume.jsonl.gz'));
assert.equal(lastTasks(evs).length, 5);

// Rate limits (spike G).
const [rate] = makeParser().push(readFileSync('spikes/G/rate_limit_event-sample.json', 'utf8'));
assert.deepEqual(rate, { type: 'rate', fiveHour: 0.11, sevenDay: 0.43, resetsAt: new Date(1791346200e3).toISOString() });

// SIGINT mid-turn (spike B): error_during_execution reads as interrupted.
const r = feed(makeParser(), gz('spikes/B/raw_applynow1.jsonl.gz')).at(-1);
assert.ok(r.type === 'result' && !r.ok && r.interrupted);

// Unknown and broken lines are ignored.
assert.deepEqual(makeParser().push('{"type":"something_new","x":1}'), []);
assert.deepEqual(makeParser().push('not json'), []);

console.log('parse ok');
