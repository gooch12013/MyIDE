// An issue's conversation, with no Electron or file access so scripts/check-thread.mjs runs it in plain node:
// a Claude Code session file as lines, one employee's part of an issue labelled by who said it, and GitHub's timeline.

export type Entry = { role: 'user' | 'assistant' | 'tool'; text: string; at?: string; images?: string[] };
/** you: David. lead: the report's lead. report: a report's result to its lead. assign: the issue prompt.
 *  auto: MyIDE's own nudge (keep going, continue). myide: a note from MyIDE (an answer, an approval). */
export type Who = 'you' | 'agent' | 'tool' | 'lead' | 'report' | 'assign' | 'auto' | 'myide';
export type ChatLine = Entry & { who: Who; name?: string; queued?: boolean };
export type Said = { at: number; text: string };

/** The session transcript Claude Code wrote (one JSON object a line), as plain lines with tool names. */
export function parseTranscript(jsonl: string): Entry[] {
  const out: Entry[] = [];
  const short = (s: string) => (s.length > 500 ? s.slice(0, 500) + '…' : s);
  for (const line of jsonl.split('\n')) {
    let d: any;
    try { d = JSON.parse(line); } catch { continue; }
    if ((d.type !== 'user' && d.type !== 'assistant') || d.isMeta || !d.message) continue;
    const at = d.timestamp;
    const c = d.message.content;
    if (typeof c === 'string') { out.push({ role: d.type, text: c, at }); continue; }
    const blocks = Array.isArray(c) ? c : [];
    // Images David attached, kept with the message they went with (the CLI also adds an "[Image: source: ...]" note).
    const images = blocks.filter((b: any) => b.type === 'image' && b.source?.type === 'base64').map((b: any) => `data:${b.source.media_type};base64,${b.source.data}`);
    if (images.length) out.push({ role: d.type, text: '', at, images });
    for (const b of blocks) {
      if (b.type === 'text' && /^\[Image: source: /.test(b.text ?? '')) continue;
      if (b.type === 'text' && b.text?.trim()) out.push({ role: d.type, text: b.text, at });
      else if (b.type === 'tool_use') out.push({ role: 'tool', text: `${b.name} ${short(JSON.stringify(b.input ?? {}))}`, at });
      else if (b.type === 'tool_result') {
        const t = typeof b.content === 'string' ? b.content : (b.content ?? []).map((x: any) => x.text ?? '').join('\n');
        if (t.trim()) out.push({ role: 'tool', text: `→ ${short(t)}`, at });
      }
    }
  }
  return out;
}

const key = (s: string) => s.trim().slice(0, 300);
// MyIDE's own turns, by the text employees.ts sends (keep in step with it).
const AUTO = /^(Keep going toward your goal \(|Continue where you left off\.)/;
const NOTE = /^(David (approved|declined|answered|denied)|GO: David approved|The approved hire|MyIDE could not send)/;
const REPORT = /^Report (\S+) \(id /;
const ASSIGN = /^(Also work|Work) on \S+#\d+: /;

/** One employee's part of an issue: its lines from `from` to `to` (ms), each user line labelled. `mine` is what David sent
 *  it; one not in the transcript yet shows at the end as queued. Without a lead (the issue's holder) an unknown user line
 *  is David's (typed in Talk, or sent before tracking began); a report's is its lead's. */
export function chat(entries: Entry[], o: { from: number; to?: number; mine?: Said[]; lead?: string }): ChatLine[] {
  const mine = o.mine ?? [];
  const seen = new Set<Said>();
  const out: ChatLine[] = [];
  let t = 0;
  for (const e of entries) {
    t = Date.parse(e.at ?? '') || t; // a line with no time sits with the one before it
    if (t < o.from || (o.to !== undefined && t > o.to)) continue;
    if (e.role !== 'user') { out.push({ ...e, who: e.role === 'tool' ? 'tool' : 'agent' }); continue; }
    const k = key(e.text);
    const m = mine.find((s) => !seen.has(s) && k && key(s.text) === k);
    if (m) { seen.add(m); out.push({ ...e, who: 'you' }); continue; }
    const r = REPORT.exec(e.text);
    out.push(r ? { ...e, who: 'report', name: r[1] }
      : ASSIGN.test(e.text) ? { ...e, who: 'assign' }
      : AUTO.test(e.text) ? { ...e, who: 'auto' }
      : NOTE.test(e.text) ? { ...e, who: 'myide' }
      : o.lead ? { ...e, who: 'lead', name: o.lead }
      : { ...e, who: 'you' });
  }
  const last = Date.parse([...entries].reverse().find((e) => e.role === 'user')?.at ?? '') || 0; // the last prompt that ran
  for (const s of mine) {
    if (!seen.has(s) && s.at >= o.from && s.at >= last - 2000) out.push({ role: 'user', text: s.text, at: new Date(s.at).toISOString(), who: 'you', queued: true });
  }
  return out;
}

export type GhEvent = { at: number; text: string; url?: string };
/** GitHub's issue timeline as dashboard events: closed and reopened, and each PR that mentions the issue, with its merge. */
export function ghTimeline(raw: unknown): GhEvent[] {
  const out: GhEvent[] = [];
  for (const x of Array.isArray(raw) ? raw : []) {
    const at = Date.parse(x?.created_at ?? '');
    const who = x?.actor?.login ? ` by ${x.actor.login}` : '';
    if (x?.event === 'closed' && at) out.push({ at, text: `Closed${x.state_reason === 'not_planned' ? ' as not planned' : ''}${who}` });
    else if (x?.event === 'reopened' && at) out.push({ at, text: `Reopened${who}` });
    else if (x?.event === 'cross-referenced' && x.source?.issue?.pull_request) {
      const p = x.source.issue;
      if (at) out.push({ at, text: `PR #${p.number} ${p.title ?? ''}`.trim(), url: p.html_url });
      const merged = Date.parse(p.pull_request.merged_at ?? '');
      if (merged) out.push({ at: merged, text: `PR #${p.number} merged`, url: p.html_url });
    }
  }
  return out;
}
