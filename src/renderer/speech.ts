import type { Row } from '../main/components';
import type { Clip, Clone, Engine, SpeechOptions, SpeechStatus, Voice } from '../main/speech';
import { ask, errText, field as labelled, formSheet, h, key } from './dom';
import { openPanel } from './registry';

// Read-back and dictation for any panel: speakButton(textFn) reads a summary aloud in the chosen
// engine (hidden while read-back is off); micButton(input) records, transcribes with the installed
// whisper-cli and inserts the text (hidden until Local Whisper and a model are installed).

const api = window.myide;
let status: SpeechStatus = { on: false, engine: 'say', voice: '', rate: 0, dictation: false, dictate: { engine: 'macos', model: '' } };

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
let redraw: (() => void) | null = null; // the open Voice & read-back section, if any
const refetch = () => void api.speech.get().then((s) => { status = s; sync(); });
refetch();
api.speech.onChange((s) => { status = s; sync(); redraw?.(); });
api.components.onChange(() => { refetch(); redraw?.(); }); // engines and dictation depend on components


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
// A helper started, is fetching or loading a model, or failed. Not while a line plays: a redraw would drop its lit Stop key.
let engineChanged = false;
api.speech.onEngine(async () => {
  if (!active) { redraw?.(); return; }
  engineChanged = true; // redrawn when the line ends; meanwhile only the engine LEDs change
  for (const e of (await api.speech.options()).engines) {
    const led = document.querySelector<HTMLElement>(`label[for="Readbackengine-${e.id.replace(/\W/g, '_')}"] .led`);
    if (led) [led.dataset.state, led.textContent] = engineLed(e);
  }
});
api.speech.onSpeaking((on) => { if (!on && engineChanged) { engineChanged = false; redraw?.(); } });

/** A speaker key that runs `run` (a line read aloud or a clip played), lit as Stop until it ends; `onNote` gets any note or error. */
function playKey(label: string, run: () => Promise<string>, onNote?: (note: string) => void): HTMLButtonElement {
  const b = key('', null, { className: 'key key--sm sp-key' });
  b.dataset.label = label;
  idle(b);
  b.onclick = async () => {
    if (active === b) { await api.speech.stop(); return; }
    await api.speech.stop();
    active = b;
    icon(b, 'stop', 'Stop');
    b.classList.add('key--lit');
    try { onNote?.(await run()); } catch (e) { onNote?.(errText(e)); } finally { if (active === b) { idle(b); active = null; } }
  };
  return b;
}

/** A speaker key that reads `textFn()` aloud, or stops it. Give it summaries only, never code or transcripts. `force` works while read-back is off (Test voice); `onNote` gets any fallback note. */
export function speakButton(textFn: () => string, label = 'Read aloud', force = false, onNote?: (note: string) => void): HTMLButtonElement {
  const b = playKey(label, () => api.speech.speak(textFn(), force), onNote);
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
    // Never left recording: it stops (and transcribes) after 5 minutes or when its window is hidden.
    const doc = b.ownerDocument;
    const hidden = () => { if (doc.hidden) rec?.stop(); };
    const cap = setTimeout(() => rec?.stop(), 5 * 60_000);
    doc.addEventListener('visibilitychange', hidden);
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.onstop = async () => {
      clearTimeout(cap);
      doc.removeEventListener('visibilitychange', hidden);
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

let focusComp = '';
/** Shows the Components section of Preferences (scrolled to component `id`), opening Preferences if needed. */
export function openComponents(id = ''): void {
  focusComp = id;
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

let segN = 0;
/** Radio keys, each with an LED and its label under the name; the checked one is lit. */
function seg(label: string, items: { id: string; name: string; led: [string, string] }[], value: string, onpick: (id: string) => void): HTMLFieldSetElement {
  const name = `sp-seg-${++segN}`;
  const el = h('fieldset', { className: 'seg sp-seg' });
  el.setAttribute('aria-label', label);
  for (const it of items) {
    const id = `${label.replace(/\W/g, '')}-${it.id.replace(/\W/g, '_')}`; // stable, so focus survives a redraw
    const led = h('span', { className: 'led', textContent: it.led[1] });
    led.dataset.state = it.led[0];
    el.append(h('input', { type: 'radio', name, id, value: it.id, checked: it.id === value, onchange: () => onpick(it.id) }),
      h('label', { className: 'key key--sm sp-opt', htmlFor: id }, h('span', { textContent: it.name }), led));
  }
  return el;
}

const LANG = new Intl.DisplayNames(['en'], { type: 'language' });
const langName = (l: string) => { try { return l ? LANG.of(l.replace('_', '-')) ?? l : 'Cloned voices'; } catch { return l; } };
/** Voices grouped by language, English first. */
function voiceGroups(voices: Voice[]): HTMLOptGroupElement[] {
  const by = new Map<string, Voice[]>();
  for (const v of voices) { const g = langName(v.lang); by.set(g, [...(by.get(g) ?? []), v]); }
  const en = (g: string) => (/English/.test(g) ? 0 : g === 'Cloned voices' ? 2 : 1);
  return [...by].sort(([a], [b]) => en(a) - en(b) || a.localeCompare(b))
    .map(([g, vs]) => h('optgroup', { label: g }, ...vs.map((v) => new Option(v.label, v.id))));
}

const engineLed = (e: Engine): [string, string] => e.state === 'builtin' ? ['working', 'Built in'] : e.state === 'missing' ? ['idle', 'Not installed']
  : e.status === 'error' ? ['failed', 'Error'] : e.status === 'downloading' ? ['queued', 'Downloading model']
  : e.status === 'loading' || e.status === 'starting' ? ['queued', 'Loading model'] : ['working', e.status === 'ready' ? 'Ready' : e.state === 'existing' ? 'Using existing' : 'Installed'];

/** Install (a private Python with the engine) and "Use existing Python…" keys for a Python engine, with its install progress. */
function pythonKeys(id: string, name: string, say: (t: string) => void, done: () => void = () => {}): Node[] {
  const prog = h('span', { className: 'comp-prog', textContent: progressText.get(id) ?? '' });
  prog.dataset.comp = id;
  return [
    key('Install', async () => { say(`Installing ${name}…`); try { await api.components.install(id); say(`${name} installed.`); } catch (e) { say(errText(e)); } progressText.delete(id); done(); },
      { title: `Makes a private Python in ~/.myide/components/${id} with uv and installs ${name}'s packages from PyPI` }),
    key('Use existing Python…', async () => { try { const p = await api.components.pickPython(id); if (p) say(`${name}: using ${p}.`); } catch (e) { say(errText(e)); } done(); },
      { title: 'Pick a Python that already has mlx-audio installed' }),
    prog,
  ];
}

// Picked in the UI but not installed: read-back (or dictation) keeps its working engine and switches when this is ready.
let pendingEngine = '', pendingDictate = '';

/** Preferences > Voice & read-back. */
export async function voiceSection(say: (t: string) => void): Promise<Node[]> {
  const wrap = h('div', { className: 'sp-voice' });
  let opts: SpeechOptions, seq = 0;
  // Cloned voices (Qwen3-TTS): MyIDE's copies, the last Spotlight search, and the voice-design box.
  let clones: Clone[] = [], found: Clip[] | null = null, designOpen = false, generating = false, designed = '';
  let designDesc = '', designText = 'Hello, this is my new voice. Engineer one needs approval to merge.';
  const set = async (patch: Parameters<typeof api.speech.set>[0]) => {
    try { status = await api.speech.set(patch); sync(); return true; } catch (e) { say(errText(e)); return false; } finally { void draw(); }
  };
  const draw = async () => {
    const n = ++seq;
    const [o, st, cl] = await Promise.all([api.speech.options(), api.speech.get(), api.speech.clones()]);
    if (n !== seq) return; // a newer draw is on its way
    opts = o; status = st; clones = cl;
    // An engine that just became ready takes over from the one that was holding its place.
    if (pendingEngine && pendingEngine !== status.engine && opts.engines.find((e) => e.id === pendingEngine)?.state !== 'missing') {
      const id = pendingEngine;
      pendingEngine = '';
      if (await set({ engine: id })) return; // set redraws
    }
    if (pendingDictate === 'whisper' && opts.whisper !== 'missing' && opts.models.length) {
      pendingDictate = '';
      if (await set({ dictate: { engine: 'whisper' } })) return;
    }
    const focused = document.activeElement?.id;
    wrap.replaceChildren(...build());
    if (focused) (wrap.querySelector(`#${CSS.escape(focused)}`) as HTMLElement | null)?.focus();
  };
  redraw = () => { if (wrap.isConnected) void draw(); };

  const secs = (d?: number) => (d === undefined ? 'Length unknown' : `${d.toFixed(1)} s`);
  const fileName = (p: string) => p.split('/').pop() ?? p;

  /** Name and transcript for a clip, then MyIDE copies it into its voices folder. */
  function addSheet(c: Clip, hint: string): void {
    const name = h('input', { className: 'input', required: true, maxLength: 40, value: c.name, placeholder: 'e.g. David' });
    const text = h('textarea', { className: 'input', rows: 3, value: c.transcript, placeholder: 'What is said in the clip; improves the clone' });
    formSheet('Add voice', [h('p', { className: 'pref-hint sp-path', textContent: c.path }), labelled('Name', name), labelled('Transcript', text, hint)], async () => {
      const v = await api.speech.addClone(c.path, name.value, text.value);
      say(`Added ${v.name}. Pick it under Voice to use it.`);
      void draw();
      return '';
    }, 'Add', 'sp-sheet');
  }
  const addFound = (c: Clip) => addSheet(c, c.transcript ? `From ${fileName(c.path).replace(/\.[^.]+$/, '')}.txt next to the clip. Check it matches.` : 'Optional. What is said in the clip, word for word.');

  function cloneRows(s: SpeechStatus, engine: Engine): Node[] {
    const live = s.engine === engine.id, installed = engine.state !== 'missing';
    const rows: Node[] = [
      h('h3', { className: 'legend psec-sub', textContent: 'Cloned voices' }),
      pref('Your voices', 'Qwen3-TTS clones a voice from a short clip (3 to 30 s) and, ideally, what is said in it. MyIDE keeps its own copy in ~/.myide/components/qwen3-tts/voices; originals are never moved or changed.',
        key('Add voice…', async () => { try { const c = await api.speech.pickClip(); if (c) addFound(c); } catch (e) { say(errText(e)); } }),
        key(found ? 'Search again' : 'Find voices on this Mac', async () => {
          say('Searching your home folder with Spotlight…');
          try { found = await api.speech.findClips(); say(`${found.length} clip${found.length === 1 ? '' : 's'} found. Nothing is copied until you press Add.`); } catch (e) { say(errText(e)); }
          void draw();
        }),
        key('Design a voice…', () => { designOpen = !designOpen; void draw(); }, { className: `key key--sm${designOpen ? ' key--lit' : ''}` })),
    ];
    if (!clones.length) rows.push(h('p', { className: 'sp-need', textContent: 'No cloned voices yet.' }));
    for (const c of clones) {
      const text = h('textarea', { className: 'input grow', rows: 2, id: `sp-clone-${c.name.replace(/\W/g, '_')}`, value: c.transcript, placeholder: 'What is said in the clip; improves the clone' });
      text.setAttribute('aria-label', `Transcript of ${c.name}`);
      text.oninput = () => { c.transcript = text.value; };
      text.onchange = () => void api.speech.setCloneText(c.name, text.value).then(() => say(`Saved ${c.name}'s transcript.`), (e) => say(errText(e)));
      const test = playKey(`Test ${c.name}`, () => api.speech.speak(`Hello, this is ${c.name}. Engineer one needs approval to merge.`, true, `clone:${c.name}`), say);
      if (!live) { test.disabled = true; test.title = `Install ${engine.name} to hear it`; }
      const rename = key('Rename…', () => {
        const name = h('input', { className: 'input', required: true, maxLength: 40, value: c.name });
        formSheet(`Rename ${c.name}`, [labelled('Name', name)], async () => { const n = await api.speech.renameClone(c.name, name.value); say(`Renamed ${c.name} to ${n}.`); void draw(); return ''; }, 'Rename', 'sp-sheet');
      });
      const remove = h('button', { type: 'button', className: 'btn btn--quiet rm', textContent: 'Remove', onclick: async () => {
        if (!await ask(`Remove ${c.name}?`, 'Deletes MyIDE’s copy of the clip and its transcript. The recording it came from is not touched.', 'Remove', true)) return;
        try { await api.speech.removeClone(c.name); say(`Removed ${c.name}.`); } catch (e) { say(errText(e)); }
        void draw();
      } });
      const row = pref(c.name, secs(c.duration), text, test, rename, remove);
      row.dataset.clone = c.name;
      rows.push(row);
    }
    if (designOpen) {
      const desc = h('textarea', { className: 'input grow', rows: 2, id: 'sp-design-desc', value: designDesc, placeholder: 'e.g. warm older British man, calm, slightly gravelly' });
      desc.setAttribute('aria-label', 'Voice description');
      desc.oninput = () => { designDesc = desc.value; };
      const line = h('input', { className: 'input grow', id: 'sp-design-text', value: designText });
      line.setAttribute('aria-label', 'Sample sentence');
      line.oninput = () => { designText = line.value; };
      const gen = key(generating ? 'Stop' : 'Generate', async () => {
        if (generating) { await api.speech.stop(); return; }
        generating = true; designed = '';
        say('Designing the voice…');
        void draw();
        try { designed = await api.speech.design(designDesc, designText); say('Designed. Play it, then Save as voice to keep it.'); } catch (e) { say(errText(e)); }
        generating = false;
        void draw();
      }, { className: `key key--sm${generating ? ' key--lit' : ''}`, disabled: !installed });
      if (!installed) gen.title = `Install ${engine.name} first`;
      const made = designed ? [playKey('Play the designed voice', () => api.speech.preview(designed), say),
        key('Save as voice…', () => addSheet({ path: designed, name: '', transcript: designText, score: 0 }, 'The sentence the designed voice says. Keep it as is.'))] : [];
      rows.push(pref('Design a voice', 'Describe a voice in words and Qwen3-TTS makes a sample of it; save the sample to reuse the voice. The first design downloads the VoiceDesign model (4.5 GB) from Hugging Face.',
        desc, line, gen, ...made));
    }
    if (found) {
      rows.push(h('h3', { className: 'legend psec-sub', textContent: `Clips on this Mac (${found.length})` }));
      if (!found.length) rows.push(h('p', { className: 'sp-need', textContent: 'Spotlight found no WAV clips of 3 to 30 seconds in your home folder.' }));
      for (const c of found) {
        const snip = c.transcript ? `“${c.transcript.length > 90 ? `${c.transcript.slice(0, 90)}…` : c.transcript}”` : 'No transcript next to it.';
        const row = pref(fileName(c.path), `${c.path.replace(/^\/Users\/[^/]+/, '~')} · ${secs(c.duration)}`,
          h('span', { className: 'sp-snip', textContent: snip }), playKey(`Play ${fileName(c.path)}`, () => api.speech.preview(c.path), say), key('Add…', () => addFound(c)));
        row.dataset.clip = c.path;
        rows.push(row);
      }
    }
    return rows;
  }

  function build(): Node[] {
    const s = status;
    const on = field({ type: 'checkbox', className: 'switch', checked: s.on });
    on.onchange = () => void set({ on: on.checked });

    // ---- read-back engine and its voices ----
    const chosen = opts.engines.find((e) => e.id === (pendingEngine || s.engine)) ?? opts.engines[0];
    const active = opts.engines.find((e) => e.id === s.engine)!;
    const engines = seg('Read-back engine', opts.engines.map((e) => ({ id: e.id, name: e.name, led: engineLed(e) })), chosen.id, async (id) => {
      const e = opts.engines.find((x) => x.id === id)!;
      pendingEngine = e.state === 'missing' ? id : '';
      if (e.state !== 'missing' && id !== s.engine) await set({ engine: id }); else void draw();
    });
    const engineNote: Node[] = [];
    if (chosen.state === 'missing') {
      engineNote.push(h('p', { className: 'sp-need' }, `${chosen.name} is not installed. Read-back keeps using ${active.name} until it is ready.`,
        ...(chosen.canInstall ? pythonKeys(chosen.id, chosen.name, say) : [key(`Install ${chosen.name}`, () => openComponents(chosen.id))])));
    } else if (chosen.status === 'error') {
      engineNote.push(h('p', { className: 'sp-need' }, `${chosen.name}: ${chosen.error ?? 'failed'}. Read-back used the macOS system voice instead.`));
    } else if (chosen.status === 'downloading') {
      engineNote.push(h('p', { className: 'sp-need' }, `Downloading ${chosen.name}'s model from Hugging Face. This happens once per model; then lines take about a second.`));
    }

    const voice = h('select', { className: 'input select', disabled: chosen.id !== s.engine },
      ...(chosen.id === 'say' ? [new Option('System voice', '')] : []), ...voiceGroups(chosen.voices));
    voice.value = chosen.id === s.engine ? s.voice : chosen.voices[0]?.id ?? '';
    voice.setAttribute('aria-label', `${chosen.name} voice`);
    voice.onchange = () => void set({ voice: voice.value });
    const voiceHint = chosen.id === 'say' ? 'Any voice from System Settings > Accessibility > Spoken Content.'
      : chosen.id === s.engine ? `${chosen.voices.length} voices.` : `${chosen.name}'s voices, available once it is installed.`;

    const rate = field({ type: 'range', min: '120', max: '320', step: '10', value: String(s.rate || 180), className: 'range' });
    rate.setAttribute('aria-label', 'Speed in words per minute');
    const out = h('output', { className: 'pref-value', value: s.rate ? `${s.rate} wpm` : 'System' });
    rate.oninput = () => { out.value = `${rate.value} wpm`; };
    rate.onchange = () => void set({ rate: Number(rate.value) });
    const sysRate = key('System speed', () => { rate.value = '180'; out.value = 'System'; void set({ rate: 0 }); });

    // ---- dictation engine and its model ----
    const dChosen = pendingDictate || s.dictate.engine;
    const wLed: [string, string] = opts.whisper === 'missing' ? ['idle', 'Not installed'] : !opts.models.length ? ['queued', 'No model'] : ['working', opts.whisper === 'existing' ? 'Using existing' : 'Installed'];
    const dict = seg('Dictation engine', [{ id: 'macos', name: 'macOS dictation', led: ['working', 'Built in'] }, { id: 'whisper', name: 'Local Whisper', led: wLed }], dChosen, async (id) => {
      const ready = id === 'macos' || (opts.whisper !== 'missing' && opts.models.length > 0);
      pendingDictate = ready ? '' : id;
      if (ready && id !== s.dictate.engine) await set({ dictate: { engine: id as 'macos' | 'whisper' } }); else void draw();
    });
    const dictRows: Node[] = [];
    if (dChosen === 'whisper' && s.dictate.engine !== 'whisper') {
      const need = opts.whisper === 'missing' ? ['Local Whisper', 'whisper'] : ['a Whisper model', 'whisper-model'];
      dictRows.push(h('p', { className: 'sp-need' }, `Install ${need[0]} to use it. Dictation keeps using macOS dictation until then.`, key(`Install ${need[0].replace(/^a /, '')}`, () => openComponents(need[1]))));
    }
    if (s.dictate.engine === 'whisper') {
      const model = h('select', { className: 'input select' }, ...opts.models.map((m) => new Option(m.label, m.path)));
      model.value = s.dictate.model;
      model.title = s.dictate.model;
      model.setAttribute('aria-label', 'Whisper model');
      model.onchange = () => void set({ dictate: { model: model.value } });
      const box = h('textarea', { className: 'input grow', rows: 2, placeholder: 'Dictated text appears here' });
      box.setAttribute('aria-label', 'Dictation test');
      dictRows.push(pref('Model', 'Whisper models installed on this Mac.', model), pref('Try it', 'Mic keys in text boxes record and transcribe on this Mac.', box, micButton(box, say)));
    }

    const sample = 'MyIDE will read summaries like this one. Engineer one needs approval to merge.';
    return [
      h('p', { className: 'psec-lede', textContent: 'Speech runs on this Mac. macOS voices and macOS dictation are built in; other engines are optional components. Only summaries are read, never code.' }),
      pref('Read aloud', 'Off by default. On shows a speaker key on summaries.', h('label', { className: 'toggle' }, on, 'Read-back')),
      h('h3', { className: 'legend psec-sub', textContent: 'Read-back' }),
      pref('Engine', `In use: ${active.name}.`, engines, ...engineNote),
      pref('Voice', voiceHint, voice),
      pref('Speed', '', rate, out, sysRate),
      pref('Test voice', `Plays a sample in ${active.name}${chosen.id === s.engine && s.voice ? `, ${chosen.voices.find((v) => v.id === s.voice)?.label ?? s.voice}` : ''}, even while read-back is off.`,
        speakButton(() => sample, 'Test voice', true, (note) => say(note))),
      ...(chosen.id === 'qwen3-tts' ? cloneRows(s, chosen) : []),
      h('h3', { className: 'legend psec-sub', textContent: 'Dictation' }),
      pref('Engine', 'macOS dictation (press Fn twice) works in every text box. Local Whisper adds mic keys that transcribe on this Mac.', dict),
      ...dictRows,
    ];
  }
  await draw();
  return [wrap];
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
    if (r.pip && r.state !== 'installed') {
      keys.push(...pythonKeys(r.id, r.name, say, () => void table(wrap, say)).slice(0, 2));
    } else if (canDownload && r.state !== 'installed') {
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
    const tr = h('tr', {},
      h('th', { scope: 'row' }, r.name, h('span', { className: 'acct-sub', textContent: r.kind === 'tts' ? 'read-back voices' : r.kind }), where),
      td('Adds', r.adds, ...(notes ? [h('span', { className: 'acct-sub comp-note', textContent: notes })] : []),
        h('a', { className: 'acct-sub', href: r.licenceUrl, textContent: `Licence: ${r.licence}`, onclick: (e: MouseEvent) => { e.preventDefault(); void api.terminal.openUrl(r.licenceUrl); } })),
      td('Download', r.size ? mb(r.size) : '—', ...(r.disk ? [h('span', { className: 'acct-sub', textContent: `${mb(r.disk)} on disk` })] : [])),
      td('Status', led, prog),
      td('Actions', h('span', { className: 'acct-keys comp-keys' }, ...keys)));
    tr.dataset.comp = r.id;
    return tr;
  });
  const tbl = h('table', { className: 'ptbl comp-tbl' },
    h('thead', {}, h('tr', {}, ...['Component', 'What it adds', 'Download', 'Status', ''].map((t) => h('th', { scope: 'col', textContent: t })))),
    h('tbody', {}, ...rows));
  wrap.replaceChildren(tbl);
  const hit = focusComp && wrap.querySelector<HTMLElement>(`tr[data-comp="${CSS.escape(focusComp)}"]`);
  focusComp = '';
  if (hit) { hit.classList.add('comp-hit'); hit.scrollIntoView({ block: 'center' }); }
}

api.components.onProgress((id, got, total, text) => {
  const t = text ? text.slice(0, 80) : total ? `${Math.floor((got / total) * 100)}%` : mb(got);
  progressText.set(id, got >= total && total ? '' : t);
  for (const el of document.querySelectorAll<HTMLElement>(`.comp-prog[data-comp="${CSS.escape(id)}"]`)) el.textContent = progressText.get(id)!;
});
