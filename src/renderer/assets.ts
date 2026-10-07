import type { AssetRequest, Catalog, ModelInfo } from '../main/assets';
import { ask, errText, h, key } from './dom';
import { led } from './employees';
import { activeProject } from './projects';
import { registerPanel } from './registry';
import { micButton } from './speech';

const api = window.myide;
type Listed = AssetRequest & { thumbs: string[]; dir: string };
const TYPES = ['Logo', 'App icon', 'Illustration', 'Photo', 'Background', 'Banner'];
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const day = (t: number) => new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' });
let segN = 0;

/** A row of radio keys; `get` reads the checked value. */
function seg(label: string, options: string[], value: string, onchange?: () => void): { el: HTMLFieldSetElement; get(): string } {
  const name = `as-seg-${++segN}`;
  const el = h('fieldset', { className: 'seg' }, h('legend', { className: 'legend', textContent: label }));
  for (const o of options) {
    const id = `${name}-${o.replace(/\W/g, '_')}`;
    el.append(h('input', { type: 'radio', name, id, value: o, checked: o === value, onchange: onchange ?? null }), h('label', { className: 'key key--sm', htmlFor: id, textContent: o }));
  }
  if (!options.includes(value) && el.querySelector('input')) (el.querySelector('input') as HTMLInputElement).checked = true;
  return { el, get: () => (el.querySelector('input:checked') as HTMLInputElement | null)?.value ?? '' };
}

const field = (label: string, ...kids: (Node | string)[]) => h('label', { className: 'field' }, h('span', { className: 'legend', textContent: label }), ...kids);
const box = (title: string, ...kids: (Node | string)[]) => h('section', { className: 'as-box' }, h('h2', { className: 'legend as-box-title', textContent: title }), ...kids);

registerPanel('assets', {
  title: 'Asset studio',
  create(el, params) {
    el.classList.add('studio');
    const projectId = typeof params.projectId === 'string' ? params.projectId : activeProject()?.id ?? '';
    let cat: Catalog | null = null;
    let requests: Listed[] = [];
    let current: string | null = null; // request shown in Results
    let pick: { request: string; version: number } | null = null; // version to iterate from or save
    let parent: { request: string; version: number } | null = null; // set by Iterate, sent with the next Generate
    let reference: { name: string; data: Uint8Array } | null = null;

    // ---- request form ----
    const notice = h('div', { className: 'as-notice' });
    const type = seg('Asset type', TYPES, 'App icon');
    const model = h('select', { className: 'input select' });
    const modelNote = h('span', { className: 'pref-hint as-src' });
    const refreshKey = key('Refresh', () => void refresh());
    const opts = h('div', { className: 'as-opts' });
    let ratio = seg('Aspect ratio', ['1:1'], '1:1');
    let paramSegs: { name: string; el: HTMLFieldSetElement; get(): string }[] = [];
    const count = seg('Versions', ['1', '2', '3', '4', '5', '6', '7', '8'], '4');
    const short = h('textarea', { className: 'input', rows: 3, placeholder: 'Short is fine, e.g. a surfer checking the tide.' });
    const refInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', className: 'as-file' });
    const refName = h('span', { className: 'pref-hint' });
    const refOk = h('input', { type: 'checkbox' });
    const refWarn = h('label', { className: 'check as-warn' }, refOk,
      'Higgsfield may use uploaded images to train its models. Send only images you are free to share.');
    refWarn.hidden = true;
    const refClear = key('Remove', () => { reference = null; refInput.value = ''; syncRef(); });
    const syncRef = () => { refWarn.hidden = refClear.hidden = !reference; refName.textContent = reference ? reference.name : 'No reference image'; refOk.checked = false; };
    refInput.onchange = async () => {
      const f = refInput.files?.[0];
      reference = f ? { name: f.name, data: new Uint8Array(await f.arrayBuffer()) } : null;
      syncRef();
    };
    const writeKey = h('button', { type: 'button', className: 'key key--go', textContent: 'Write prompt', onclick: () => void write() });
    const form = h('div', { className: 'as-col as-req' },
      notice,
      h('div', { className: 'seg' }, type.el),
      field('Higgsfield model', model, h('span', { className: 'as-row' }, modelNote, refreshKey)),
      opts, count.el,
      field('What do you need', short), micButton(short, (t) => say(t, true)),
      h('div', { className: 'field' }, h('span', { className: 'legend', textContent: 'Reference image (optional)' }), refInput, h('span', { className: 'as-row' }, refName, refClear), refWarn),
      writeKey);
    syncRef();

    function drawModels(): void {
      const was = model.value;
      model.replaceChildren(...(cat?.models ?? []).map((m) => new Option(`${m.name}${m.provider ? ` · ${m.provider}` : ''}`, m.id)));
      if (cat?.models.some((m) => m.id === was)) model.value = was;
      else if (cat?.models.some((m) => m.id === 'nano_banana_pro')) model.value = 'nano_banana_pro';
      modelNote.replaceChildren(cat ? led('done', 'Live') : led('idle', 'Not loaded'),
        cat ? ` ${cat.models.length} image models from Higgsfield at ${clock(cat.fetchedAt)}.` : ' Load the model list from Higgsfield (a read-only check, no credits).');
      refreshKey.textContent = cat ? 'Refresh' : 'Load models';
      drawOptions();
      drawBalance();
    }
    const chosen = (): ModelInfo | undefined => cat?.models.find((m) => m.id === model.value);
    function drawOptions(): void {
      const m = chosen();
      ratio = seg('Aspect ratio', m?.ratios ?? ['1:1'], ratio.get() || '1:1');
      paramSegs = (m?.params ?? []).map((p) => ({ name: p.name, ...seg(p.name[0].toUpperCase() + p.name.slice(1), p.options, p.default ?? p.options[0]) }));
      opts.replaceChildren(...paramSegs.map((s) => s.el), ratio.el);
      tailored.textContent = `Tailored for ${m?.name ?? model.value ?? 'the model'}`;
      void api.assets.guide(model.value || 'general').then((g) => { guidePath.textContent = g.file; }).catch(() => {});
    }
    model.onchange = drawOptions;
    const settings = () => Object.fromEntries(paramSegs.map((s) => [s.name, s.get()]));

    // ---- written prompt ----
    const tailored = h('span', { className: 'lcd-tag' });
    const guidePath = h('span', { className: 'path' });
    const prompt = h('textarea', { className: 'input as-prompt', rows: 9, placeholder: 'Write prompt fills this in. Edit it before generating.' });
    const parentNote = h('p', { className: 'pref-hint' });
    const lineInput = h('input', { type: 'number', min: '0', step: '1', className: 'input num' });
    lineInput.setAttribute('aria-label', 'Approval line in credits');
    lineInput.onchange = () => void api.assets.setLine(Number(lineInput.value)).catch((e) => say(errText(e), true));
    const balance = h('span', { className: 'as-balance' });
    const genKey = h('button', { type: 'button', className: 'key key--go', textContent: 'Generate', onclick: () => void generate() });
    const status = h('p', { className: 'as-status' });
    status.setAttribute('aria-live', 'polite');
    const say = (t: string, err = false) => { status.textContent = t; status.classList.toggle('is-err', err); };
    const promptBox = box('Written prompt',
      h('p', { className: 'as-row' }, tailored, h('span', { className: 'pref-hint' }, 'Guide: ', guidePath, '. Edit it to change how every prompt for this model is written.')),
      prompt, parentNote,
      h('div', { className: 'as-row as-gen' }, genKey,
        h('span', { className: 'pref-hint' }, 'The designer checks the cost first; over ', lineInput, ' credits asks you.'), balance),
      status);
    const drawBalance = () => { balance.replaceChildren(h('span', { className: 'legend', textContent: 'Higgsfield credits ' }), h('b', { textContent: cat?.credits === undefined ? '?' : String(cat.credits) })); };

    // ---- results, iterate, save ----
    const resMeta = h('p', { className: 'pref-hint' });
    const resGrid = h('ol', { className: 'as-grid' });
    const refBox = h('div', { className: 'as-ref' });
    const change = h('input', { className: 'input', placeholder: 'warmer light, tighter beam', autocomplete: 'off' });
    change.setAttribute('aria-label', 'What to change');
    const iterKey = key('Write change', () => void iterate());
    const vtree = h('ul', { className: 'as-vtree' });
    const outHead = h('p', { className: 'pref-hint' });
    const outFiles = h('ul', { className: 'as-out' });
    const outNote = h('p', { className: 'pref-hint' });
    const saveKey = key('Write files', () => void save());
    const outStatus = h('p', { className: 'as-status' });
    const gallery = h('ul', { className: 'as-gallery' });

    el.append(
      h('div', { className: 'as-layout' },
        form,
        h('div', { className: 'as-col' }, promptBox, box('Results', resMeta, resGrid)),
        h('div', { className: 'as-col' },
          box('Iterate', refBox, h('div', { className: 'as-row' }, change, iterKey),
            h('h3', { className: 'legend', textContent: 'Version history' }), vtree,
            h('p', { className: 'pref-hint', textContent: 'Pick any version to branch from it. Every round keeps its prompt.' })),
          box('Save to project', outHead, outFiles, outNote, saveKey, outStatus))),
      box('Project assets', gallery));

    const byId = (id: string) => requests.find((r) => r.id === id);
    const label = (r: AssetRequest, v?: number) => `${r.id.slice(9, 13)}${v ? ` v${v}` : ''}`;

    function verCard(r: Listed, i: number): HTMLLIElement {
      const v = i + 1;
      const picked = pick?.request === r.id && pick.version === v;
      const img = r.thumbs[i] ? h('img', { src: r.thumbs[i], alt: `${r.type} version ${v}` }) : h('span', { className: 'pref-hint', textContent: r.versions[i].file });
      const li = h('li', { className: `as-ver${picked ? ' is-picked' : ''}` }, h('div', { className: 'as-art' }, img),
        h('div', { className: 'as-row' }, h('b', { className: 'as-vid', textContent: `v${v}` }),
          key(picked ? 'Picked' : 'Pick', () => { pick = { request: r.id, version: v }; draw(); }), key('Show', () => void api.assets.reveal(r.id, v))));
      return li;
    }

    async function draw(): Promise<void> {
      const r = current ? byId(current) : requests[0];
      if (r) current = r.id;
      resMeta.textContent = r ? `${label(r)} · ${r.modelName} · ${r.ratio}${Object.values(r.settings).map((s) => ` · ${s}`).join('')} · ${r.count} asked`
        + `${r.credits !== undefined ? ` · ${r.credits} credits` : ''} · ${clock(r.createdAt)} · ${r.status === 'pending' ? 'with the designer' : r.status === 'approval' ? 'waiting for your approval' : r.status}${r.error ? `: ${r.error}` : ''}` : 'Nothing generated yet.';
      resGrid.replaceChildren(...(r ? r.versions.map((_, i) => verCard(r, i)) : []));

      // iterate: the picked version
      const pr = pick && byId(pick.request);
      refBox.replaceChildren(...(pr && pick ? [h('div', { className: 'as-art as-art--sm' }, pr.thumbs[pick.version - 1] ? h('img', { src: pr.thumbs[pick.version - 1], alt: '' }) : ''),
        h('div', {}, h('b', { className: 'as-vid', textContent: label(pr, pick.version) }), h('p', { className: 'pref-hint', textContent: 'Sent as the reference image with your change.' }))]
        : [h('p', { className: 'pref-hint', textContent: 'Pick a version to iterate on or save.' })]));
      iterKey.disabled = !pr || !pr.versions[pick!.version - 1]?.jobId;

      // version history: requests nested under the request they iterate on
      const kids = (pid?: string): HTMLLIElement[] => requests.filter((x) => (x.parent?.request ?? undefined) === pid).reverse().map((x) => {
        const b = h('button', { type: 'button', className: 'as-vnode', onclick: () => { current = x.id; void draw(); } },
          h('b', { textContent: label(x) }), h('small', { textContent: `${x.parent ? `from v${x.parent.version} · ` : ''}${x.short || x.prompt}`.slice(0, 80) }));
        b.setAttribute('aria-current', String(x.id === current));
        const sub = kids(x.id);
        return h('li', {}, b, ...(sub.length ? [h('ul', {}, ...sub)] : []));
      });
      vtree.replaceChildren(...kids(undefined));

      // save to project
      saveKey.disabled = !pr;
      outFiles.replaceChildren();
      outNote.textContent = '';
      if (pr && pick) {
        try {
          const t = await api.assets.targets(projectId, pr.id, pick.version);
          outHead.textContent = `${label(pr, pick.version)} as a ${t.kind === 'expo' ? 'Expo app' : t.kind === 'web' ? 'website' : 'project'} ${pr.type.toLowerCase()}:`;
          outFiles.replaceChildren(...t.targets.map((x) => h('li', {}, h('span', { className: 'legend', textContent: `${x.label}${x.size ? ` · ${x.size}px` : ' · original'}` }),
            h('span', { className: 'path', textContent: x.rel }), x.exists ? h('small', { className: 'as-warn-text', textContent: 'replaces the existing file' }) : '')));
          outNote.textContent = t.note;
        } catch (e) { outHead.textContent = errText(e); }
      } else outHead.textContent = 'Pick a version first.';

      // gallery: every version, newest first, with the prompt that made it
      const items = requests.flatMap((x) => x.versions.map((_, i) => h('li', { className: 'as-gal' },
        h('button', { type: 'button', className: 'as-art as-art--sm', onclick: () => { current = x.id; pick = { request: x.id, version: i + 1 }; void draw(); } },
          x.thumbs[i] ? h('img', { src: x.thumbs[i], alt: `${x.type} ${label(x, i + 1)}` }) : ''),
        h('div', { className: 'as-gal-text' }, h('b', { textContent: `${x.type} ${label(x, i + 1)}` }),
          h('span', { className: 'pref-hint', textContent: `${x.modelName} · ${x.ratio} · ${day(x.createdAt)}${x.saved?.length ? ` · saved to ${x.saved.join(', ')}` : ''}` }),
          h('p', { className: 'as-gal-prompt', textContent: x.prompt })))));
      gallery.replaceChildren(...(items.length ? items : [h('li', { className: 'pref-hint', textContent: 'Nothing generated for this project yet.' })]));
    }

    async function load(): Promise<void> {
      if (!projectId) { notice.replaceChildren(h('p', { className: 'pref-hint', textContent: 'Open a project to make assets for it.' })); return; }
      try { requests = await api.assets.list(projectId); } catch (e) { say(errText(e), true); }
      await draw();
    }

    async function checkRole(): Promise<boolean> {
      const roles = projectId ? await api.employees.roles(projectId).catch(() => []) : [];
      const has = roles.some((r) => r.name === 'designer');
      notice.replaceChildren(...(has ? [] : [h('p', { className: 'pref-warn', textContent: 'No designer role yet. It is the contractor that runs Higgsfield for you.' }),
        key('Install designer role', async () => { try { say(await api.assets.installRole()); void checkRole(); } catch (e) { say(errText(e), true); } })]));
      return has;
    }

    async function refresh(): Promise<void> {
      refreshKey.disabled = true;
      say('Asking Higgsfield for its models and your balance (read-only)…');
      try { cat = await api.assets.refresh(); drawModels(); say(`Loaded ${cat.models.length} models.`); }
      catch (e) { say(errText(e), true); }
      finally { refreshKey.disabled = false; }
    }

    async function write(): Promise<void> {
      writeKey.disabled = true;
      say('Writing the prompt…');
      try {
        const r = await api.assets.writePrompt({ model: model.value, type: type.get(), ratio: ratio.get(), settings: settings(), short: short.value });
        prompt.value = r.prompt;
        parent = null;
        parentNote.textContent = '';
        say('Edit the prompt if you like, then Generate.');
      } catch (e) { say(errText(e), true); }
      finally { writeKey.disabled = false; }
    }

    async function iterate(): Promise<void> {
      const pr = pick && byId(pick.request);
      if (!pr || !pick) return;
      iterKey.disabled = true;
      say('Writing the change into the prompt…');
      try {
        const r = await api.assets.writePrompt({ model: pr.model, type: pr.type, ratio: pr.ratio, settings: pr.settings, short: change.value, parentPrompt: pr.prompt });
        model.value = pr.model;
        drawOptions();
        prompt.value = r.prompt;
        parent = { ...pick };
        parentNote.textContent = `Iterating on ${label(pr, pick.version)}: it goes to Higgsfield as the reference.`;
        say('Edit the prompt if you like, then Generate.');
      } catch (e) { say(errText(e), true); }
      finally { iterKey.disabled = false; }
    }

    async function generate(): Promise<void> {
      if (!(await checkRole())) return say('Install the designer role first.', true);
      if (reference && !refOk.checked) return say('Tick the upload warning to send the reference image, or remove it.', true);
      genKey.disabled = true;
      try {
        const { request, turn } = await api.assets.request({
          projectId, type: type.get(), model: model.value, ratio: ratio.get(), settings: settings(), count: Number(count.get()), short: short.value, prompt: prompt.value,
          parent: parent ?? undefined, reference: reference ? { ...reference, acceptedWarning: refOk.checked } : undefined,
        });
        const designer = (await api.employees.list(projectId)).find((e) => e.role === 'designer');
        if (designer) await api.employees.send(designer.id, turn);
        else await api.employees.hire({ projectId, role: 'designer', task: turn });
        current = request.id;
        parent = null;
        parentNote.textContent = '';
        say(`Sent ${label(request)} to the designer.`);
        await load();
      } catch (e) { say(errText(e), true); }
      finally { genKey.disabled = false; }
    }

    async function save(): Promise<void> {
      if (!pick) return;
      saveKey.disabled = true;
      try {
        const t = await api.assets.targets(projectId, pick.request, pick.version);
        const replace = t.targets.filter((x) => x.exists).map((x) => x.rel);
        if (replace.length && !(await ask(`Replace ${replace.length} existing file${replace.length === 1 ? '' : 's'}?`, replace.join('\n'), 'Replace', true))) return;
        outStatus.textContent = `Wrote ${(await api.assets.save(projectId, pick.request, pick.version, replace.length > 0)).join(', ')}.`;
      }
      catch (e) { outStatus.textContent = errText(e); }
      finally { saveKey.disabled = false; }
    }

    const offs = [
      api.assets.onChange((id) => { if (id === projectId) { void load(); void api.assets.catalog().then((c) => { cat = c.catalog; drawBalance(); }); } }),
      api.employees.onChange((e) => { if (e.projectId === projectId && e.role === 'designer' && e.state !== 'working') say(`Designer: ${e.state}${e.error ? `, ${e.error}` : ''}.`, e.state === 'failed'); }),
    ];
    void api.assets.catalog().then((c) => { cat = c.catalog; lineInput.value = String(c.approveAbove); drawModels(); });
    void checkRole();
    void load();
    return { onShow: () => void load(), dispose: () => offs.forEach((off) => off()) };
  },
});
