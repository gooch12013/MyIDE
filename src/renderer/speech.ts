import type { Row } from '../main/components';
import type { SpeechStatus } from '../main/speech';
import { errText, h, key } from './dom';
import { openPanel } from './registry';

// Read-back and dictation for any panel: speakButton(textFn) reads a summary aloud through macOS
// `say` (hidden while read-back is off); micButton(input) records, transcribes with the installed
// whisper-cli and inserts the text (hidden until Local Whisper and a model are installed).

const api = window.myide;
let status: SpeechStatus = { on: false, voice: '', rate: 0, dictation: false };

// Buttons can sit in pop-out windows, so they are tracked here rather than styled by a body class.
const speakers = new Set<WeakRef<HTMLButtonElement>>();
const mics = new Set<WeakRef<HTMLButtonElement>>();
function sync(): void {
  for (const [set, show] of [[speakers, status.on], [mics, status.dictation]] as const) {
    for (const ref of set) {
      const b = ref.deref();
      if (b) b.hidden = !show; else set.delete(ref);
    }
  }
}
void api.speech.get().then((s) => { status = s; sync(); });
api.speech.onChange((s) => { status = s; sync(); });

const ICON = {
  speaker: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
};
const icon = (b: HTMLButtonElement, name: keyof typeof ICON, label: string) => {
  b.innerHTML = `<svg class="sp-ic" viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;
  b.setAttribute('aria-label', label);
  b.title = label;
};

// One utterance at a time: whichever button started it shows Stop until it ends.
let active: HTMLButtonElement | null = null;
const idle = (b: HTMLButtonElement) => { icon(b, 'speaker', b.dataset.label!); b.classList.remove('key--lit'); };
api.speech.onSpeaking((on) => { if (!on && active) { idle(active); active = null; } });

/** A speaker key that reads `textFn()` aloud, or stops it. Give it summaries only, never code or transcripts. `force` works while read-back is off (Test voice). */
export function speakButton(textFn: () => string, label = 'Read aloud', force = false): HTMLButtonElement {
  const b = key('', null, { className: 'key key--sm sp-key' });
  b.dataset.label = label;
  idle(b);
  b.onclick = async () => {
    if (active === b) { await api.speech.stop(); return; }
    await api.speech.stop();
    active = b;
    icon(b, 'stop', 'Stop reading');
    b.classList.add('key--lit');
    try { await api.speech.speak(textFn(), force); } finally { if (active === b) { idle(b); active = null; } }
  };
  if (!force) { b.hidden = !status.on; speakers.add(new WeakRef(b)); }
  return b;
}

/** A 16 kHz mono 16-bit WAV of a recording, which is what whisper-cli reads. */
async function toWav(blob: Blob): Promise<Uint8Array> {
  const ctx = new AudioContext();
  const buf = await ctx.decodeAudioData(await blob.arrayBuffer()).finally(() => void ctx.close());
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(buf.duration * 16000)), 16000);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  const pcm = (await off.startRendering()).getChannelData(0);
  const v = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const ascii = (at: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
  ascii(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ascii(36, 'data'); v.setUint32(40, pcm.length * 2, true);
  pcm.forEach((x, i) => v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x)) * 0x7fff, true));
  return new Uint8Array(v.buffer);
}

/** A mic key for a text box: click to record, click again to transcribe into the box at the cursor. Hidden until Local Whisper is installed. */
export function micButton(input: HTMLInputElement | HTMLTextAreaElement, onError: (msg: string) => void = () => {}): HTMLButtonElement {
  const b = key('', null, { className: 'key key--sm sp-key' });
  icon(b, 'mic', 'Dictate');
  let rec: MediaRecorder | null = null;
  b.onclick = async () => {
    if (rec) { rec.stop(); return; }
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { onError('MyIDE has no access to the microphone. Allow it in System Settings > Privacy & Security > Microphone.'); return; }
    const chunks: Blob[] = [];
    rec = new MediaRecorder(stream);
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      rec = null;
      b.classList.remove('key--lit');
      icon(b, 'mic', 'Transcribing…');
      b.disabled = true;
      try {
        const text = await api.speech.transcribe(await toWav(new Blob(chunks, { type: chunks[0]?.type })));
        if (text) {
          const at = input.selectionStart ?? input.value.length, end = input.selectionEnd ?? at;
          const pad = at > 0 && !/\s$/.test(input.value.slice(0, at)) ? ' ' : '';
          input.setRangeText(pad + text, at, end, 'end');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.focus();
        }
      } catch (e) { onError(errText(e)); }
      b.disabled = false;
      icon(b, 'mic', 'Dictate');
    };
    rec.start();
    b.classList.add('key--lit');
    icon(b, 'stop', 'Stop and transcribe');
  };
  b.hidden = !status.dictation;
  mics.add(new WeakRef(b));
  return b;
}

/** Shows the Components section of Preferences, opening Preferences if needed. */
export function openComponents(): void {
  if (window.dispatchEvent(new CustomEvent('myide:prefs-section', { detail: 'components', cancelable: true }))) openPanel('preferences', { section: 'components' });
}

/** "Install X to use this" with a key to the Components row, for a feature whose component is missing. */
export const needsComponent = (name: string): HTMLElement =>
  h('p', { className: 'sp-need' }, `Install ${name} to use this. `, key('Optional components', openComponents));

// ---- Preferences sections ----

const field = (props: Partial<HTMLInputElement>) => h('input', { className: 'input', ...props });
function pref(name: string, hint: string, ...ctl: Node[]): HTMLElement {
  return h('div', { className: 'pref' },
    h('div', { className: 'pref-label' }, h('span', { className: 'pref-name', textContent: name }), ...(hint ? [h('span', { className: 'pref-hint', textContent: hint })] : [])),
    h('div', { className: 'pref-ctl' }, ...ctl));
}

/** Preferences > Voice & read-back. */
export async function voiceSection(say: (t: string) => void): Promise<Node[]> {
  const [s, voices] = await Promise.all([api.speech.get(), api.speech.voices()]);
  const set = async (patch: Partial<SpeechStatus>) => { try { status = await api.speech.set(patch); sync(); } catch (e) { say(errText(e)); } };

  const on = field({ type: 'checkbox', className: 'switch', checked: s.on });
  on.onchange = () => void set({ on: on.checked });

  const voice = h('select', { className: 'input select' }, new Option('System voice', ''),
    ...voices.map((v) => new Option(`${v.name} (${v.lang})`, v.name, false, v.name === s.voice)));
  voice.setAttribute('aria-label', 'Voice');
  voice.onchange = () => void set({ voice: voice.value });

  const rate = field({ type: 'range', min: '120', max: '320', step: '10', value: String(s.rate || 180), className: 'range' });
  rate.setAttribute('aria-label', 'Speed in words per minute');
  const out = h('output', { className: 'pref-value', value: s.rate ? `${s.rate} wpm` : 'System' });
  rate.oninput = () => { out.value = `${rate.value} wpm`; };
  rate.onchange = () => void set({ rate: Number(rate.value) });
  const sysRate = key('System speed', () => { rate.value = '180'; out.value = 'System'; void set({ rate: 0 }); });

  const sample = 'MyIDE will read summaries like this one. Engineer one needs approval to merge.';
  const box = h('textarea', { className: 'input grow', rows: 2, placeholder: 'Dictated text appears here' });
  box.setAttribute('aria-label', 'Dictation test');
  return [
    h('p', { className: 'psec-lede', textContent: 'Speech runs on this Mac. Read-back uses macOS voices; nothing needs installing. Only summaries are read, never code.' }),
    pref('Read aloud', 'Off by default. On shows a speaker key on summaries.', h('label', { className: 'toggle' }, on, 'Read-back')),
    pref('Voice', 'Any voice from System Settings > Accessibility > Spoken Content.', voice),
    pref('Speed', '', rate, out, sysRate),
    pref('Test voice', 'Plays even while read-back is off.', speakButton(() => sample, 'Test voice', true)),
    s.dictation
      ? pref('Dictation', 'Mic keys in text boxes record and transcribe with Local Whisper. macOS dictation (press Fn twice) works everywhere too.', box, micButton(box, say))
      : pref('Dictation', 'macOS dictation (press Fn twice) works in every text box. Local Whisper adds mic keys that transcribe on this Mac.', needsComponent('Local Whisper')),
    pref('Other voices', 'Kokoro and Qwen3-TTS voices are coming. Until then read-back uses macOS voices.', key('Optional components', openComponents)),
  ];
}

const mb = (n?: number) => (n === undefined ? '' : n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);
const progressText = new Map<string, string>();

/** Preferences > Optional components. */
export async function componentsSection(say: (t: string) => void): Promise<Node[]> {
  const wrap = h('div', {});
  await table(wrap, say);
  return [
    h('p', { className: 'psec-lede', textContent: 'MyIDE works without any of these. Built-in fallbacks: macOS dictation and macOS voices. Nothing downloads until you click Install; each comes from its publisher.' }),
    wrap,
    pref('Install location', 'An existing install stays where it is; MyIDE only uses it.', h('span', { className: 'path', textContent: '~/.myide/components' }), key('Reveal in Finder', () => void api.components.reveal())),
  ];
}

async function table(wrap: HTMLElement, say: (t: string) => void): Promise<void> {
  const list: Row[] = await api.components.list();
  const act = (fn: () => Promise<unknown>) => async () => {
    wrap.inert = true; // one action at a time
    try { await fn(); } catch (err) { say(errText(err)); }
    await table(wrap, say);
    wrap.inert = false;
  };
  const td = (l: string, ...kids: (Node | string)[]) => { const c = h('td', {}, ...kids); c.dataset.l = l; return c; };

  const rows = list.map((r) => {
    const led = h('span', { className: 'led' });
    led.dataset.state = r.state === 'missing' ? 'idle' : r.installedVersion && r.installedVersion !== r.version ? 'queued' : 'working';
    led.textContent = r.state === 'installed' ? (r.installedVersion !== r.version ? 'Update available' : 'Installed')
      : r.state === 'existing' ? 'Using existing' : r.status === 'coming-soon' ? 'Coming soon' : r.status === 'build-needed' ? 'Build needed' : 'Not installed';
    const where = r.path ? h('span', { className: 'acct-sub', textContent: r.path, title: r.path }) : '';
    const prog = h('span', { className: 'comp-prog', textContent: progressText.get(r.id) ?? '' });
    prog.dataset.comp = r.id;

    const keys: Node[] = [];
    const canDownload = !!r.url && !r.status;
    if (canDownload && r.state !== 'installed') {
      keys.push(key('Install', act(async () => { say(`Downloading ${r.name}…`); await api.components.install(r.id); say(`${r.name} installed.`); }),
        { title: `Downloads ${mb(r.size)} from ${new URL(r.url!).host} into ~/.myide/components/${r.id}` }));
    }
    if (r.state === 'installed' && r.installedVersion !== r.version) keys.push(key('Update', act(async () => { await api.components.install(r.id); say(`${r.name} updated.`); })));
    if (r.state === 'missing' || r.state === 'existing') {
      for (const p of r.found) keys.push(key(`Use existing at ${p.replace(/^\/Users\/[^/]+/, '~')}`, act(async () => { await api.components.use(r.id, p); say(`${r.name}: using ${p}.`); }), { title: p }));
    }
    if (r.state !== 'missing') {
      keys.push(h('button', {
        type: 'button', className: 'btn btn--quiet rm', textContent: 'Remove',
        title: r.state === 'existing' ? 'Stop using it. The files stay where they are.' : 'Deletes its folder in ~/.myide/components.',
        onclick: act(async () => { await api.components.remove(r.id); say(`${r.name} removed.`); }),
      }));
    }
    const notes = [r.note, r.advanced, r.sizeNote].filter(Boolean).join(' ');
    return h('tr', {},
      h('th', { scope: 'row' }, r.name, h('span', { className: 'acct-sub', textContent: r.kind }), where),
      td('Adds', r.adds, ...(notes ? [h('span', { className: 'acct-sub comp-note', textContent: notes })] : []),
        h('a', { className: 'acct-sub', href: r.licenceUrl, textContent: `Licence: ${r.licence}`, onclick: (e: MouseEvent) => { e.preventDefault(); void api.terminal.openUrl(r.licenceUrl); } })),
      td('Download', r.size ? mb(r.size) : '—', ...(r.disk ? [h('span', { className: 'acct-sub', textContent: `${mb(r.disk)} on disk` })] : [])),
      td('Status', led, prog),
      td('Actions', h('span', { className: 'acct-keys comp-keys' }, ...keys)));
  });
  const tbl = h('table', { className: 'ptbl comp-tbl' },
    h('thead', {}, h('tr', {}, ...['Component', 'What it adds', 'Download', 'Status', ''].map((t) => h('th', { scope: 'col', textContent: t })))),
    h('tbody', {}, ...rows));
  wrap.replaceChildren(tbl);
}

api.components.onProgress((id, got, total) => {
  const t = total ? `${Math.floor((got / total) * 100)}%` : mb(got);
  progressText.set(id, got >= total && total ? '' : t);
  for (const el of document.querySelectorAll<HTMLElement>(`.comp-prog[data-comp="${CSS.escape(id)}"]`)) el.textContent = progressText.get(id)!;
});
