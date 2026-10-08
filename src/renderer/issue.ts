// The Issue panel: one issue's dashboard. Once the issue is given to an employee: what waits on David, the team's action
// items and progress, the conversation with whoever holds it (each report's folded below), a reply box, and the timeline.
// The forge thread sits below, folded; until the issue is assigned it is open and the panel reads as before.
import type { DockviewPanelApi } from 'dockview-core';
import type { ChatLine, IssueDetail, TrackRow } from '../preload/preload';
import { attachBox, thumb } from './attach';
import { ask, errText, h, key, okKey, setKids } from './dom';
import { linkify } from './editor';
import { api, chip, cue, led, needsBox, openEmployee, teamOf, type Employee } from './employees';
import { splitUrls } from './issue-view';
import { openAssign } from './issues';
import { openPanel, registerPanel } from './registry';
import { micButton, speakButton } from './speech';

const FORGE = { github: 'GitHub', forgejo: 'Forgejo' } as const;
type Thread = TrackRow['threads'][number];

/** Issue panels by "project#number": a second click on the same issue focuses the open one. */
const openIssues = new Map<string, DockviewPanelApi>();
export function openIssue(projectId: string, number: number): void {
  const open = openIssues.get(`${projectId}#${number}`);
  if (open) open.setActive();
  else openPanel('issue', { projectId, number });
}

/** Plain text with its web links clickable (opened in the browser). Issue text is Markdown; it shows as written.
 *  ponytail: no Markdown rendering or inline images; a renderer if reading raw Markdown gets in the way. */
const withLinks = (text: string): (Node | string)[] => splitUrls(text).map((p) => (p.url
  ? h('a', { href: p.url, textContent: p.url, onclick: (ev) => { ev.preventDefault(); void api.terminal.openUrl(p.url!); } })
  : p.text ?? ''));
const when = (t?: string | number) => {
  const d = t === undefined || t === '' ? undefined : new Date(t);
  if (!d || isNaN(+d)) return '';
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const holdsIt = (e: Employee, n: number) => [e.issue, ...(e.more ?? [])].some((i) => i?.number === n);

/** One conversation: lines by who said them, tool steps folded in runs. Lines arrive whole each time and are appended
 *  when the old ones are unchanged (a transcript only grows); David's queued messages sit at the end. */
function chatView(root: () => string): { el: HTMLElement; set(lines: ChatLine[]): void; reset(): void } {
  const list = h('ol', { className: 'chat' });
  const queued = h('div', { className: 'chat-queued' });
  const el = h('div', { className: 'chat-box' }, list, queued);
  const LIMIT = 300; // lines drawn at first; Show earlier draws the rest
  let shown: ChatLine[] = [];
  let all = false;
  let run: { ol: HTMLElement; sum: HTMLElement; n: number } | undefined; // the tool steps run at the end
  const k = (l?: ChatLine) => (l ? `${l.at}|${l.who}|${l.text.length}|${l.text.slice(0, 40)}` : '');

  const lineEl = (l: ChatLine): HTMLElement => {
    const li = h('li', { className: `chat-line chat-${l.who}` });
    const head = (label: string) => h('div', { className: 'chat-head' }, h('span', { className: 'chat-who', textContent: label }), h('span', { className: 'chat-at', textContent: when(l.at) }));
    const text = () => h('div', { className: 'chat-text' }, ...(l.who === 'you' ? [l.text] : linkify(l.text, root())));
    const pics = l.images?.length ? [h('div', { className: 'iss-thumbs' }, ...l.images.map((src, n) => thumb(src, `Image ${n + 1}`)))] : [];
    if (l.who === 'auto' || l.who === 'myide') li.append(h('span', { className: 'chat-at', textContent: when(l.at) }), ` ${l.who === 'auto' ? l.text.split('. ')[0] : l.text}`);
    else if (l.who === 'assign') li.append(h('details', {}, h('summary', {}, head(`Assigned: ${l.text.split('\n')[0]}`)), text()));
    else li.append(head(l.who === 'you' ? (l.queued ? 'You · queued' : 'You') : l.who === 'agent' ? 'Agent' : l.who === 'lead' ? `From ${l.name}` : `Report from ${l.name}`), text(), ...pics);
    return li;
  };
  const add = (l: ChatLine) => {
    if (l.who !== 'tool') { run = undefined; list.append(lineEl(l)); return; }
    if (!run) {
      const ol = h('ol', { className: 'chat-steps' });
      const sum = h('summary', {});
      list.append(h('li', { className: 'chat-line chat-tool' }, h('details', {}, sum, ol)));
      run = { ol, sum, n: 0 };
    }
    run.ol.append(h('li', { textContent: l.text }));
    run.sum.textContent = `${++run.n} step${run.n === 1 ? '' : 's'}`;
  };
  const draw = (lines: ChatLine[]) => {
    run = undefined;
    const from = all ? 0 : Math.max(0, lines.length - LIMIT);
    list.replaceChildren(...(from ? [h('li', { className: 'chat-line chat-myide' }, key(`Show ${from} earlier`, () => { all = true; draw(shown); }))] : []));
    lines.slice(from).forEach(add);
  };
  return {
    el,
    set(lines) {
      const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      const real = lines.filter((l) => !l.queued);
      if (shown.length && real.length >= shown.length && k(real[shown.length - 1]) === k(shown.at(-1))) real.slice(shown.length).forEach(add);
      else draw(real);
      shown = real;
      queued.replaceChildren(...lines.filter((l) => l.queued).map(lineEl));
      if (!real.length && !queued.childElementCount) list.replaceChildren(h('li', { className: 'chat-line chat-myide', textContent: 'Nothing yet. It starts when its first turn runs.' }));
      if (atEnd) el.scrollTop = el.scrollHeight;
    },
    reset() { shown = []; all = false; run = undefined; list.replaceChildren(); queued.replaceChildren(); },
  };
}

registerPanel('issue', {
  title: 'Issue',
  create(el, params, panel) {
    el.classList.add('iss-one');
    const projectId = typeof params.projectId === 'string' ? params.projectId : '';
    const number = Number(params.number);
    if (!projectId || !Number.isInteger(number) || number < 1) {
      el.append(h('p', { className: 'files-note', textContent: 'Open an issue from the Issues panel.' }));
      return {};
    }
    const pk = `${projectId}#${number}`;
    openIssues.set(pk, panel);
    panel.setTitle(`#${number}`);

    const status = h('p', { className: 'pref-status' });
    status.setAttribute('aria-live', 'polite');
    const say = (t: string) => { status.textContent = t; };

    let track: TrackRow | undefined;
    let detail: IssueDetail | undefined;
    let everyone: Employee[] = [];
    let forgeName = 'the forge'; // GitHub or Forgejo, from the project's link
    void api.forge.issues(projectId).then((snaps) => { if (snaps[0]) { forgeName = FORGE[snaps[0].provider]; drawHead(); drawForge(); } }).catch(() => {});
    const alive = (id: string) => everyone.find((x) => x.id === id);
    /** Each employee's latest part of this issue, in the order they joined. */
    const parts = (): Thread[] => [...new Map((track?.threads ?? []).map((t) => [t.employeeId, t])).values()].sort((a, b) => a.from - b.from);
    /** Who is on it now: hired, with its part still open. */
    const onIt = () => parts().filter((t) => t.to === undefined && alive(t.employeeId)).map((t) => alive(t.employeeId)!);

    // ---- head ----
    const head = h('header', { className: 'iss-one-head' });
    const drawHead = () => {
      const i = detail;
      const open = i ? i.state === 'open' : true;
      const holder = everyone.find((e) => e.projectId === projectId && holdsIt(e, number));
      const title = i?.title ?? track?.title ?? '';
      panel.setTitle(`#${number} ${title}`.slice(0, 40));
      head.replaceChildren(
        h('h1', { className: 'iss-one-title' }, h('span', { className: 'iss-ref', textContent: `#${number}` }), ` ${title}`),
        h('div', { className: 'iss-one-meta' }, ...(i ? [led(open ? 'working' : 'done', open ? 'Open' : 'Closed'),
          ...i.labels.map((l) => h('span', { className: 'iss-label', textContent: l })),
          h('span', { className: 'iss-age', textContent: [i.author && `by ${i.author}`, i.assignees.length ? `assigned ${i.assignees.join(', ')}` : '', i.updated && `updated ${when(i.updated)}`].filter(Boolean).join(' · ') })] : []),
          holder ? h('button', { type: 'button', className: 'iss-emp', textContent: holder.name, title: `Open ${holder.name}`, onclick: () => void openEmployee(holder.id) })
            : open ? key('Assign…', () => void assignIt()) : '',
          ...(i?.prs ?? []).map((pr) => h('a', { href: pr.url, className: 'iss-pr', textContent: `PR #${pr.number} ${pr.state}`, onclick: (ev) => { ev.preventDefault(); void api.terminal.openUrl(pr.url); } })),
          ...(i ? [key(`Open on ${forgeName}`, () => void api.terminal.openUrl(i.url))] : [])),
        ...(i?.note ? [h('p', { className: 'files-note', textContent: i.note })] : []));
    };
    const assignIt = async () => {
      const s = (await api.forge.issues(projectId))[0];
      const row = s?.issues.find((x) => x.number === number);
      if (s && row) void openAssign(s, row); else say('This issue is not in the forge list yet; refresh the Issues panel.');
    };

    // ---- needs you, progress and action items ----
    const needs = needsBox((all) => teamOf(onIt().map((e) => e.id), all));
    const bar = h('progress', { className: 'iss-bar-progress' });
    bar.setAttribute('aria-label', 'Action items done');
    const barText = h('span', { className: 'pref-hint' });
    const items = h('div', { className: 'iss-items' });
    const progressBox = h('section', { className: 'box iss-progress' }, h('h2', { className: 'legend box-title', textContent: 'Action items' }),
      h('div', { className: 'iss-bar-row' }, bar, barText), items);
    const drawProgress = () => {
      const team = onIt();
      progressBox.hidden = !team.length;
      let done = 0, total = 0;
      for (const e of team) {
        const p = e.progress;
        if (p?.total) { total += p.total; done += e.state === 'done' ? p.total : Math.min(p.done, p.total); }
      }
      bar.max = total || 1;
      bar.value = done;
      bar.hidden = !total;
      barText.textContent = total ? `${done} of ${total} done, across ${team.length} employee${team.length === 1 ? '' : 's'}` : 'No action items listed yet.';
      items.replaceChildren(...team.map((e) => {
        const p = e.progress;
        const c = cue(e);
        const rows: HTMLElement[] = [];
        const row = (title: string, state: string, ledEl?: HTMLElement) => { const li = h('li', { className: 'cue' }, h('span', { className: 'cue-num' }), h('span', { className: 'cue-title', textContent: title }), ledEl ?? ''); li.dataset.cue = state; return li; };
        if (p?.current && p.done < p.total) rows.push(row(p.current, 'current', led(e.state)));
        const next = p?.next ?? [];
        next.slice(0, 6).forEach((t) => rows.push(row(t, 'pending')));
        if (next.length > 6) rows.push(row(`and ${next.length - 6} more`, 'pending'));
        if (!rows.length) rows.push(row(c.text || e.task || 'No items', 'done', led(e.state)));
        return h('div', { className: 'iss-member' },
          h('div', { className: 'iss-member-head' }, led(e.state), key(e.name, () => void openEmployee(e.id), { title: `Open ${e.name}` }), chip(e),
            h('span', { className: 'o-cue-count', textContent: c.count })),
          h('ol', { className: 'cuelist' }, ...rows));
      }));
    };

    // ---- conversation: the holder's, then each other part folded ----
    type Part = { id: string; chat: ReturnType<typeof chatView>; box: HTMLElement; who: HTMLElement; reply?: ReturnType<typeof composer>; fold?: HTMLDetailsElement };
    const composer = (to: () => Employee | undefined) => {
      const box = h('textarea', { className: 'input', rows: 3 });
      const attach = attachBox(box, say);
      let busy = false;
      const send = key('Send', async () => {
        const e = to();
        const text = box.value.trim();
        if (!e || busy) return;
        if (!text) { say(attach.images.length ? 'Add a line of text to go with the images.' : 'Write a message first.'); return; }
        busy = true;
        const images = attach.payload();
        box.value = ''; // emptied first, refilled if the send fails, so nothing typed meanwhile is lost
        try {
          await api.employees.send(e.id, text, images);
          attach.clear();
          say(`Sent to ${e.name}. It runs as its next turn.`);
          soon();
        } catch (err) { box.value = text + (box.value ? `\n${box.value}` : ''); say(errText(err)); } finally { busy = false; }
      }, { className: 'key key--sm key--lit' });
      okKey(box, send);
      const el = h('div', { className: 'iss-reply' }, box, attach.el, h('div', { className: 'pref-ctl' }, micButton(box, say), send,
        h('span', { className: 'pref-hint', textContent: 'Alt+Enter sends. Nothing goes to GitHub.' })));
      return {
        el,
        sync() {
          const e = to();
          box.disabled = send.disabled = !e;
          box.placeholder = e ? `Message ${e.name}: a reply, an answer or a new direction` : 'Its part of this issue has ended; the conversation is kept here.';
          box.setAttribute('aria-label', e ? `Message ${e.name}` : 'Message');
        },
      };
    };
    const whoLine = (t: Thread) => {
      const e = alive(t.employeeId);
      return [e ? led(e.state) : led('idle', t.to ? 'Gone' : 'Fired'), h('span', { className: 'iss-part-name', textContent: t.name }),
        h('span', { className: 'pref-hint', textContent: [t.role, t.lead ? `under ${t.lead}` : '', `since ${when(t.from)}`].filter(Boolean).join(' · ') }),
        ...(e ? [chip(e), h('span', { className: 'iss-part-cue', textContent: cue(e).text })] : [])];
    };
    const parts$ = new Map<string, Part>(); // by employee id, kept across redraws so a fold stays open
    let mainId = '';
    const mainWho = h('div', { className: 'iss-part-head' });
    const mainChat = chatView(() => parts().find((t) => t.employeeId === mainId)?.worktree ?? '');
    const mainReply = composer(() => alive(mainId));
    let mainLast = '';
    const convo = h('section', { className: 'box iss-convo' },
      h('div', { className: 'iss-convo-head' }, h('h2', { className: 'legend box-title', textContent: 'Conversation' }),
        speakButton(() => mainLast, 'Read the last reply aloud')),
      mainWho, mainChat.el, mainReply.el);
    const others = h('div', { className: 'iss-parts' });
    const drawParts = () => {
      const all = parts();
      const holderPart = all.find((t) => t.employeeId === track?.holderId) ?? all.at(-1);
      if ((holderPart?.employeeId ?? '') !== mainId) { mainId = holderPart?.employeeId ?? ''; mainChat.reset(); mainLast = ''; }
      convo.hidden = !holderPart;
      if (holderPart) mainWho.replaceChildren(...whoLine(holderPart));
      mainReply.sync();
      const rest = all.filter((t) => t.employeeId !== mainId);
      for (const id of parts$.keys()) if (!rest.some((t) => t.employeeId === id)) parts$.delete(id);
      setKids(others, rest.map((t) => {
        let p = parts$.get(t.employeeId);
        if (!p) {
          const chat = chatView(() => t.worktree);
          const who = h('span', { className: 'iss-part-head' });
          // An ended part takes no reply: the message would land in whatever the employee works on now, off this page.
          const reply = composer(() => (parts().find((x) => x.employeeId === t.employeeId)?.to === undefined ? alive(t.employeeId) : undefined));
          const fold = h('details', { className: 'iss-part' }, h('summary', {}, who), chat.el, reply.el);
          fold.ontoggle = () => { if (fold.open) void loadPart(t.employeeId); };
          p = { id: t.employeeId, chat, box: fold, who, reply, fold };
          parts$.set(t.employeeId, p);
        }
        p.who.replaceChildren(...whoLine(t));
        p.reply!.sync();
        return p.box;
      }));
    };
    const loadPart = async (id: string) => {
      const p = parts$.get(id);
      if (!p) return;
      try { p.chat.set(await api.tracks.thread(projectId, number, id)); } catch (e) { say(errText(e)); }
    };
    const loadThreads = async () => {
      const id = mainId;
      if (!id) return;
      try {
        const lines = await api.tracks.thread(projectId, number, id);
        if (id !== mainId) return; // the holder changed while this loaded
        mainChat.set(lines);
        mainLast = [...lines].reverse().find((l) => l.who === 'agent')?.text ?? '';
      } catch (e) { say(errText(e)); }
      for (const p of parts$.values()) if (p.fold?.open) await loadPart(p.id);
    };
    // Turns write often; the transcripts are read at most every 1.5 s, and only while the panel shows.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const soon = () => { timer ??= setTimeout(() => { timer = undefined; if (panel.isVisible) void loadThreads(); }, 1500); };

    // ---- timeline ----
    const timeline = h('ol', { className: 'iss-timeline' });
    const timelineBox = h('section', { className: 'box iss-time' }, h('h2', { className: 'legend box-title', textContent: 'Timeline' }), timeline);
    const drawTimeline = () => {
      const ev = [...(track?.events ?? []).map((e) => ({ ...e, url: undefined as string | undefined })), ...(detail?.events ?? [])].sort((a, b) => b.at - a.at);
      timelineBox.hidden = !ev.length;
      timeline.replaceChildren(...ev.map((e) => h('li', {}, h('span', { className: 'chat-at', textContent: when(e.at) }), ' ',
        e.url ? h('a', { href: e.url, textContent: e.text, onclick: (x) => { x.preventDefault(); void api.terminal.openUrl(e.url!); } }) : e.text)));
    };

    // ---- the forge thread, folded once the issue is assigned ----
    const body = h('div', { className: 'iss-one-text' });
    const thread = h('ol', { className: 'iss-one-thread' });
    const comment = h('textarea', { className: 'input', rows: 4, placeholder: 'Comment as you, on the forge' });
    comment.setAttribute('aria-label', `Comment on #${number}`);
    const ghKeys = h('div', { className: 'pref-ctl' });
    const ghSum = h('summary', { className: 'legend' });
    const gh = h('details', { className: 'box iss-gh' }, ghSum, body, thread, comment, ghKeys);
    let ghTouched = false; // once David opens or folds it, redraws leave it
    let ghAuto = false; // what a redraw last set; a toggle to anything else is David's
    gh.addEventListener('toggle', () => { if (gh.open !== ghAuto) ghTouched = true; });
    let busy = false; // one forge write at a time: a double click posts once
    const post = async () => {
      const text = comment.value.trim();
      if (!text) return say('Write a comment first.');
      if (busy) return;
      busy = true;
      comment.value = ''; // emptied before the write goes out, refilled if it fails, so a second click finds nothing to send
      try { say((await api.forge.comment(projectId, number, text)).msg); await loadDetail(); } catch (e) { comment.value = text; say(errText(e)); } finally { busy = false; }
    };
    const closeIt = async () => {
      if (busy || !(await ask(`Close #${number}?`, 'It closes as completed. A comment in the box above is posted first.', 'Close issue'))) return;
      busy = true;
      const text = comment.value.trim();
      comment.value = '';
      try {
        const said = text ? `${(await api.forge.comment(projectId, number, text)).msg} ` : '';
        say(said + (await api.forge.close(projectId, number)).msg);
        await loadDetail();
      } catch (e) { comment.value = text; say(errText(e)); } finally { busy = false; }
    };
    const commentKey = key('Comment', () => void post());
    okKey(comment, commentKey);
    const drawForge = () => {
      const i = detail;
      if (!i) return;
      const n = i.comments?.length ?? 0;
      ghSum.textContent = `${forgeName === 'the forge' ? 'Forge' : forgeName}: description and ${n} comment${n === 1 ? '' : 's'}`;
      body.replaceChildren(...withLinks(i.body?.trim() || '(No description.)'));
      thread.replaceChildren(...(i.comments ?? []).map((c) => h('li', { className: 'iss-one-comment' },
        h('div', { className: 'iss-age', textContent: `${c.author} · ${when(c.at)}` }), h('div', { className: 'iss-one-text' }, ...withLinks(c.body)))));
      ghKeys.replaceChildren(commentKey, ...(i.state === 'open' ? [key('Close issue', () => void closeIt())] : []));
      if (!ghTouched) gh.open = ghAuto = !track;
    };

    // ---- loading ----
    let seen = ''; // the issue's updated time when last loaded: a forge change reloads only when it moved
    let loads = 0; // a slower, older load never overwrites a newer one
    const loadDetail = async () => {
      const n = ++loads;
      try {
        const i = await api.forge.issue(projectId, number);
        if (n !== loads) return;
        detail = i;
        seen = i.updated ?? '';
        drawHead(); drawForge(); drawTimeline();
      } catch (e) { if (n === loads) say(errText(e)); }
    };
    const drawAll = () => { drawHead(); drawProgress(); drawParts(); drawTimeline(); drawForge(); void needs.draw(); };
    const loadTrack = async () => {
      const [ts, all] = await Promise.all([api.tracks.list(projectId), api.employees.list()]);
      track = ts.find((t) => t.number === number);
      everyone = all;
      drawAll();
      soon();
    };

    const grid = h('div', { className: 'iss-dash' },
      h('div', { className: 'iss-dash-main' }, convo, others),
      h('div', { className: 'iss-dash-side' }, progressBox, timelineBox));
    el.append(head, needs.el, grid, gh, status);
    convo.hidden = progressBox.hidden = timelineBox.hidden = true;
    void loadTrack().then(() => { if (mainId) void loadThreads(); });
    void loadDetail();

    const team = () => new Set(onIt().map((e) => e.id));
    const offs = [
      api.tracks.onChange((pid) => { if (pid === projectId) void loadTrack(); }),
      api.employees.onChange((e) => {
        everyone = [...everyone.filter((x) => x.id !== e.id), e];
        if (e.projectId !== projectId) return;
        drawHead(); drawProgress(); drawParts();
        if (team().has(e.id) || e.id === mainId) soon();
      }),
      api.employees.onRemoved(() => void loadTrack()),
      api.approvals.onChange(() => void needs.draw()),
      api.forge.onChange((pid) => {
        if (pid !== projectId) return;
        void needs.draw();
        void api.forge.issues(projectId).then((snaps) => {
          const u = snaps[0]?.issues.find((x) => x.number === number)?.updatedAt;
          if (u && u !== seen) void loadDetail();
        });
      }),
    ];
    return {
      onShow: () => { if (mainId) void loadThreads(); },
      dispose() { clearTimeout(timer); offs.forEach((f) => f()); openIssues.delete(pk); },
    };
  },
});
