// Checks src/main/thread.ts: session parsing, one employee's part of an issue labelled, and GitHub's timeline.
// Usage: node scripts/check-thread.mjs
import assert from 'node:assert/strict';
import { chat, ghTimeline, parseTranscript } from '../src/main/thread.ts';

const at = (m) => new Date(Date.UTC(2026, 9, 8, 10, m)).toISOString();
const ms = (m) => Date.parse(at(m));
const line = (type, content, m) => JSON.stringify({ type, timestamp: at(m), message: { content } });

const jsonl = [
  line('user', 'Work on o/r#5: Fix it\n\nhttps://x\n\nHow to read the issue...', 1),
  line('assistant', [{ type: 'text', text: 'Reading it.' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }], 2),
  line('user', [{ type: 'tool_result', content: 'a\nb' }], 3),
  'not json',
  JSON.stringify({ type: 'user', isMeta: true, timestamp: at(3), message: { content: 'meta' } }),
  line('user', 'Report engineer-1 (id 9, branch myide/engineer-1) finished: done', 4),
  line('user', 'Keep going toward your goal (1 of 8). End the last message...', 5),
  line('user', 'please also check the CSV', 6),
  line('user', 'David answered your question: yes\nContinue.', 7),
  line('assistant', 'All set.\n\nGOAL DONE', 8),
].join('\n');

const entries = parseTranscript(jsonl);
assert.equal(entries.length, 9);
assert.deepEqual(entries.map((e) => e.role), ['user', 'assistant', 'tool', 'tool', 'user', 'user', 'user', 'user', 'assistant']);
assert.equal(entries[2].text, 'Bash {"command":"ls"}');
assert.equal(entries[3].text, '→ a\nb');

// The holder's part: labels by what MyIDE sent; an unknown user line is David's.
const holder = chat(entries, { from: ms(0) });
assert.deepEqual(holder.map((l) => l.who), ['assign', 'agent', 'tool', 'tool', 'report', 'auto', 'you', 'myide', 'agent']);
assert.equal(holder[4].name, 'engineer-1');

// A second, related issue given to a busy employee is an assignment too.
assert.equal(chat(parseTranscript(line('user', 'Also work on o/r#6: Related. You hold it now alongside #5', 1)), { from: 0 })[0].who, 'assign');

// A time window: only what falls inside it.
assert.deepEqual(chat(entries, { from: ms(4), to: ms(6) }).map((l) => l.who), ['report', 'auto', 'you']);

// A report's part: an unknown user line is its lead's, unless David sent it.
const report = chat(entries, { from: ms(0), lead: 'lead-1', mine: [{ at: ms(6) - 1000, text: 'please also check the CSV' }] });
assert.equal(report.find((l) => l.text === 'please also check the CSV').who, 'you');
const report2 = chat(entries, { from: ms(0), lead: 'lead-1' });
assert.equal(report2.find((l) => l.text === 'please also check the CSV').who, 'lead');
assert.equal(report2.find((l) => l.text === 'please also check the CSV').name, 'lead-1');

// Sent by David but not in the transcript yet: shown at the end, queued. An old unmatched one is not.
const q = chat(entries, { from: ms(0), mine: [{ at: ms(9), text: 'one more thing' }, { at: ms(2), text: 'never ran' }] });
assert.equal(q.at(-1).text, 'one more thing');
assert.equal(q.at(-1).queued, true);
assert.equal(q.filter((l) => l.queued).length, 1);

// The same text sent twice matches twice, then nothing is left queued.
const twice = parseTranscript([line('user', 'go', 1), line('user', 'go', 2)].join('\n'));
const t2 = chat(twice, { from: 0, lead: 'pm', mine: [{ at: ms(1), text: 'go' }, { at: ms(2), text: 'go' }] });
assert.deepEqual(t2.map((l) => [l.who, !!l.queued]), [['you', false], ['you', false]]);

// GitHub's timeline: closes, reopens, PRs that mention the issue and their merges; everything else dropped.
const ev = ghTimeline([
  { event: 'labeled', created_at: at(1) },
  { event: 'cross-referenced', created_at: at(2), source: { issue: { number: 7, title: 'fix: it', html_url: 'u7', pull_request: { merged_at: at(5) } } } },
  { event: 'cross-referenced', created_at: at(3), source: { issue: { number: 8, title: 'an issue, not a PR' } } },
  { event: 'closed', created_at: at(6), actor: { login: 'dg' }, state_reason: 'completed' },
  { event: 'reopened', created_at: at(7) },
  { event: 'closed', created_at: at(8), state_reason: 'not_planned' },
]);
assert.deepEqual(ev.map((e) => e.text), ['PR #7 fix: it', 'PR #7 merged', 'Closed by dg', 'Reopened', 'Closed as not planned']);
assert.equal(ev[1].at, ms(5));
assert.equal(ev[0].url, 'u7');
assert.deepEqual(ghTimeline({ message: 'Not Found' }), []);

console.log('check-thread: ok');
