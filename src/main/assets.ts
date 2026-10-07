// Asset studio: Higgsfield image requests. Generation goes through the designer employee (the renderer
// hires or messages it with the turn built here); the designer reports back through two MyIDE MCP
// tools, and MyIDE saves the files under <project>/assets/generated/<request>/ with request.json.
// The model list, the balance and the prompt writer are one-off `claude -p` turns run from here.
import { nativeImage, shell } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { EXT, sniff } from './attach';
import { listEmployees } from './employees';
import { addApproval, registerEmployeeTool, setApproveGate } from './mcp';
import { listProjects, readConfig, writeConfig } from './projects';
import { spawnEnv } from './pty';
import { broadcast, handle, readJSON, STATE_DIR, writeJSON } from './store';

export interface ModelInfo { id: string; name: string; provider: string; description: string; ratios: string[]; params: { name: string; options: string[]; default?: string }[]; refs: string[] }
export interface Catalog { fetchedAt: number; checkedAt?: number; server: string; credits?: number; plan?: string; models: ModelInfo[] }
export interface Version { file: string; jobId?: string; url?: string }
export interface AssetRequest {
  id: string; projectId: string; createdAt: number; type: string; model: string; modelName: string;
  ratio: string; settings: Record<string, string>; count: number; short: string; prompt: string;
  parent?: { request: string; version: number }; reference?: string;
  status: 'pending' | 'approval' | 'done' | 'failed'; credits?: number; error?: string; versions: Version[]; saved?: string[];
}

const CATALOG = 'higgsfield-models.json';
const GUIDES = join(STATE_DIR, 'prompt-guides');
export const HF_SERVER = 'mcp__claude_ai_Higgsfield';
const HF = `${HF_SERVER}__`;
// Higgsfield tools that spend credits, publish, upload or change the account, besides generate_image. Employees are denied
// them outright (src/main/employees.ts); the one-off turns are denied these and generate_image.
// ponytail: a list by name, so a new spending tool is only caught by spendGate (asks David); add it here when Higgsfield ships one.
export const HF_DENY = ['generate_image_batch', 'generate_video', 'generate_video_batch', 'generate_audio', 'generate_audio_batch', 'generate_3d',
  'execute_preset', 'upscale_image', 'upscale_video', 'remove_background', 'outpaint_image', 'reframe', 'motion_control', 'voice_change', 'dubbing',
  'ads_studio_generate', 'ads_studio_create_brand', 'ads_studio_add_product', 'ads_studio_update_product', 'ai_influencer_generate', 'build_ai_influencer',
  'create_voice', 'create_voice_from_confirmed_audio', 'shorts_studio_create', 'shorts_studio_create_preset', 'scene_builder_3d_create_project',
  'scene_builder_3d_generate_angles', 'scene_builder_3d_generate_video', 'scene_builder_3d_run_python', 'scene_builder_3d_import_asset',
  'apps_invoke', 'sandbox_exec', 'create_website', 'deploy_website', 'publish_website', 'rename_website', 'website_db', 'website_secrets', 'website_repo_access',
  'tiktok_connect', 'tiktok_reconnect', 'tiktok_prepare_publish', 'tiktok_music_tune', 'participate_in_contest', 'video_analysis_create', 'virality_predictor',
  'media_import_url', 'media_upload_widget', 'create_project', 'create_folder', 'manage_reference_elements', 'update_preferences', 'select_workspace',
  'cancel_trial_auto_renewal'].map((t) => HF + t);
const SPENDERS = [HF + 'generate_image', HF + 'media_upload', HF + 'media_confirm', ...HF_DENY];
// What an employee may call without asking: reads, and waiting on jobs. generate_image goes through spendGate; anything else asks David.
const HF_READ = new Set(['balance', 'models_explore', 'jobs_wait', 'job_display', 'show_generations', 'show_generation_by_ids', 'show_medias',
  'show_plans_and_credits', 'transactions', 'get_preferences', 'list_workspaces', 'list_projects', 'list_folders', 'list_project_assets'].map((t) => HF + t));
const ICONISH = /icon|logo/i;
const ID = /^[\w-]{1,80}$/;

const project = (id: string) => {
  const p = listProjects().find((x) => x.id === id);
  if (!p) throw new Error('No such project');
  return p;
};
const genDir = (root: string, id = '') => join(root, 'assets', 'generated', id);
const baseName = (r: AssetRequest, version: number) => `${r.type.replace(/\W+/g, '-')}-${r.id}-v${version}${extname(r.versions[version - 1]?.file ?? '.png')}`;
export const approveAbove = (): number => Number((readConfig() as { assets?: { approveAbove?: number } }).assets?.approveAbove ?? 40);

// ---- pure helpers (scripts/check-assets.mjs) ----

/** The guide file for a model id: `<id>.md`, else the longest guide name that starts the id (nano-banana.md for nano_banana_pro), else general.md. */
export function guideFor(modelId: string, files: string[]): string {
  const norm = (s: string) => s.toLowerCase().replace(/\.md$/, '').replace(/[^a-z0-9]/g, '');
  const id = norm(modelId);
  return files.find((f) => norm(f) === id)
    ?? files.filter((f) => f !== 'general.md' && id.startsWith(norm(f))).sort((a, b) => b.length - a.length)[0]
    ?? 'general.md';
}

/** A JSON object in a tool result's text (some results add prose after it). */
function jsonIn(t: string): any {
  try { return JSON.parse(t); } catch { /* fall through */ }
  try { return JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)); } catch { return undefined; }
}

/** From a stream-json capture: the Higgsfield server's status at init, the balance and the models_explore items. */
export function readCapture(lines: any[]): { server?: string; balance?: { credits?: number; subscription_plan_type?: string }; items?: any[] } {
  const names = new Map<string, string>();
  const out: ReturnType<typeof readCapture> = {};
  for (const ev of lines) {
    if (ev?.type === 'system' && ev.subtype === 'init') out.server = (ev.mcp_servers ?? []).find((s: any) => /higgsfield/i.test(s.name))?.status;
    for (const c of Array.isArray(ev?.message?.content) ? ev.message.content : []) {
      if (c.type === 'tool_use') names.set(c.id, c.name);
      if (c.type !== 'tool_result' || c.is_error) continue;
      const j = jsonIn(typeof c.content === 'string' ? c.content : (c.content ?? []).map((x: any) => x.text ?? '').join(''));
      const name = names.get(c.tool_use_id) ?? '';
      if (name.endsWith('__balance') && j) out.balance = j;
      if (name.endsWith('__models_explore') && Array.isArray(j?.items)) out.items = [...(out.items ?? []), ...j.items];
    }
  }
  return out;
}

/** models_explore items down to what the form needs: image models, ratios, option parameters, reference roles. */
export function compact(items: any[]): ModelInfo[] {
  // A model with a required parameter (a style id, a product) needs a workflow the form does not offer.
  return items.filter((m) => m?.output_type === 'image' && typeof m.id === 'string' && m.aspect_ratios?.length && !(m.parameters ?? []).some((p: any) => p.required === 'required')).map((m) => ({
    id: m.id, name: m.name || m.id, provider: m.provider_name ?? '', description: m.description ?? '', ratios: m.aspect_ratios,
    params: (m.parameters ?? []).filter((p: any) => Array.isArray(p.options) && p.options.length > 1 && ['resolution', 'quality', 'variant'].includes(p.name))
      .map((p: any) => ({ name: p.name, options: p.options.map(String), default: p.default === undefined ? undefined : String(p.default) })),
    refs: (m.medias ?? []).flatMap((x: any) => x.roles ?? []).filter((r: string) => r !== 'mask'),
  }));
}

/** The designer turn for a request. `parentJob` is the Higgsfield job id of the version it iterates on. */
export function designerTurn(r: AssetRequest, dir: string, line: number, refRole: string, parentJob?: string): string {
  const params = { model: r.model, aspect_ratio: r.ratio, ...r.settings };
  return [
    `Asset studio request ${r.id}: ${r.count} version${r.count === 1 ? '' : 's'} of a ${r.type}, Higgsfield model ${r.modelName} (${r.model}).`,
    `generate_image params besides prompt and count: ${JSON.stringify(params)}.`,
    parentJob ? `Reference: this iterates on an earlier version. Pass medias: [{"value": "${parentJob}", "role": "${refRole}"}]. No upload needed.` : '',
    r.reference ? `Reference: David's own image at ${join(dir, r.reference)}. Upload it with media_upload and media_confirm, then pass the media id in medias with role "${refRole}".` : '',
    'Prompt, use it exactly as written:',
    '"""', r.prompt, '"""',
    `Steps: 1) preflight with generate_image and get_cost: true (spends nothing). 2) Call mcp__myide__asset_cost with {"requestId": "${r.id}", "credits": <total for all ${r.count}>}; David's approval line is ${line} credits. Generate only if it answers "generate".`,
    `3) Generate (count at most 4 per call), use_unlim false. 4) Wait with jobs_wait until every job is finished. 5) Call mcp__myide__asset_result with {"requestId": "${r.id}", "images": [{"url", "jobId"}...], "credits", "balance"}. If anything fails, call asset_result with "error". Keep provenance marks and metadata; MyIDE downloads the files.`,
  ].filter(Boolean).join('\n');
}

type Target = { label: string; rel: string; size?: number };

/** Where a picked image goes in the project: Expo's icon set, a web favicon set, or a plain copy. */
export function projectTargets(root: string, type: string, base: string): { kind: 'expo' | 'web' | 'plain'; targets: Target[]; note: string } {
  const read = (f: string) => { try { return JSON.parse(readFileSync(join(root, f), 'utf8')); } catch { return undefined; } };
  const pkg = read('package.json');
  const appJson = read('app.json');
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const dynamic = ['app.config.js', 'app.config.ts'].find((f) => existsSync(join(root, f)));
  const rel = (p: unknown, d: string) => (typeof p === 'string' && p ? p.replace(/^\.\//, '') : d);
  if (appJson?.expo || deps.expo) {
    if (!ICONISH.test(type)) return { kind: 'expo', targets: [{ label: 'Image', rel: `assets/images/${base}` }], note: '' };
    const e = appJson?.expo ?? {};
    const splashPlugin = (e.plugins ?? []).find((p: unknown) => Array.isArray(p) && p[0] === 'expo-splash-screen')?.[1];
    const a = e.android?.adaptiveIcon ?? {};
    return {
      kind: 'expo',
      targets: [
        { label: 'App icon', rel: rel(e.icon, 'assets/images/icon.png'), size: 1024 },
        { label: 'Adaptive icon foreground', rel: rel(a.foregroundImage, 'assets/images/adaptive-icon.png'), size: 1024 },
        { label: 'Splash', rel: rel(splashPlugin?.image ?? e.splash?.image, 'assets/images/splash-icon.png'), size: 1024 },
        { label: 'Web favicon', rel: rel(e.web?.favicon, 'assets/images/favicon.png'), size: 48 },
      ],
      note: [a.backgroundColor ? `Adaptive icon background stays ${a.backgroundColor} (app.json).` : 'Adaptive icon background: set expo.android.adaptiveIcon.backgroundColor in app.json.',
        dynamic ? `${dynamic} found: these are the paths app.json or Expo's defaults name; check they match.` : ''].filter(Boolean).join(' '),
    };
  }
  if (pkg || existsSync(join(root, 'index.html'))) {
    const pub = existsSync(join(root, 'static')) && !existsSync(join(root, 'public')) ? 'static' : 'public';
    if (!ICONISH.test(type)) return { kind: 'web', targets: [{ label: 'Image', rel: `${pub}/images/${base}` }], note: '' };
    return {
      kind: 'web',
      targets: [[16, 'favicon-16x16.png'], [32, 'favicon-32x32.png'], [180, 'apple-touch-icon.png'], [192, 'icon-192.png'], [512, 'icon-512.png']]
        .map(([size, f]) => ({ label: `Favicon ${size}`, rel: `${pub}/${f}`, size: size as number })),
      note: `Link them from your HTML head (rel="icon" sizes 16 and 32, rel="apple-touch-icon").`,
    };
  }
  return { kind: 'plain', targets: [{ label: 'Image', rel: `assets/${base}` }], note: '' };
}

// ---- the spend gate ----

// Generation allowed by asset_cost (within the line, or David approved): request id -> what may still be generated.
const spends = new Map<string, { employeeId: string; model: string; left: number }>();
export const allowSpend = (requestId: string, employeeId: string, model: string, count: number): void => { spends.set(requestId, { employeeId, model, left: count }); };

/** Answers an employee's permission prompt for a Higgsfield tool: 'allow', a deny message, or undefined to ask David. */
export function spendGate(employeeId: string, tool: string, input: any): string | undefined {
  if (!tool.startsWith(HF)) return undefined;
  if (HF_READ.has(tool)) return 'allow';
  if (HF_DENY.includes(tool)) return `${tool.slice(HF.length)} spends credits or publishes; MyIDE does not let employees call it.`;
  if (tool !== HF + 'generate_image') return undefined;
  if (input?.get_cost === true) return 'allow'; // the preflight spends nothing
  const n = input?.count === undefined ? 1 : Number(input.count);
  if (!Number.isInteger(n) || n < 1) return 'generate_image needs a whole-number count.';
  for (const [id, s] of spends) {
    if (s.employeeId !== employeeId || s.left < n || (input?.model !== undefined && input.model !== s.model)) continue;
    s.left -= n;
    if (!s.left) spends.delete(id);
    return 'allow';
  }
  return 'No approved cost covers this: call mcp__myide__asset_cost for the request first, then generate at most the approved count with its model.';
}

// ---- requests on disk ----

/** request.json lives in the project, so its file names are checked before any is joined to a path. */
function valid(r: AssetRequest): AssetRequest {
  if (!Array.isArray(r?.versions) || !r.versions.every((v) => /^v\d+\.(png|jpg|jpeg|webp|gif)$/.test(v?.file))) throw new Error('request.json names a file it should not');
  if (r.reference !== undefined && !/^reference\.\w+$/.test(r.reference)) throw new Error('request.json names a reference it should not');
  return r;
}

function find(id: string): { dir: string; r: AssetRequest } {
  if (typeof id !== 'string' || !ID.test(id)) throw new Error('Bad request id');
  for (const p of listProjects()) {
    const dir = genDir(p.path, id);
    if (existsSync(join(dir, 'request.json'))) return { dir, r: valid(JSON.parse(readFileSync(join(dir, 'request.json'), 'utf8'))) };
  }
  throw new Error(`No asset request ${id}`);
}
const put = (dir: string, r: AssetRequest) => { writeFileSync(join(dir, 'request.json'), JSON.stringify(r, null, 2) + '\n'); broadcast('assets:change', r.projectId); };

function list(projectId: string): (AssetRequest & { thumbs: string[]; dir: string })[] {
  const root = genDir(project(projectId).path);
  let ids: string[] = [];
  try { ids = readdirSync(root); } catch { return []; }
  return ids.filter((d) => ID.test(d) && existsSync(join(root, d, 'request.json'))).flatMap((d) => {
    try {
      const r = valid(JSON.parse(readFileSync(join(root, d, 'request.json'), 'utf8')));
      // ponytail: thumbnails are rebuilt on every list; cache them beside the file if galleries get big.
      const thumbs = r.versions.map((v) => { const im = nativeImage.createFromPath(join(root, d, v.file)); return im.isEmpty() ? '' : im.resize({ width: 320 }).toDataURL(); });
      return [{ ...r, thumbs, dir: join(root, d) }];
    } catch { return []; }
  }).sort((a, b) => b.createdAt - a.createdAt);
}

// Hosts generated images are downloaded from (subdomains included), https only.
// ponytail: Higgsfield's own domain; no generation was run to see its CDN host, so a download that names another host fails loudly: add that host here.
const IMAGE_HOSTS = ['higgsfield.ai'];
const fromHiggsfield = (url: string): boolean => {
  try { const u = new URL(url); return u.protocol === 'https:' && IMAGE_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`)); } catch { return false; }
};
const MAX_DOWNLOAD = 64e6;
/** Saves an image as v<n>.<ext>, the extension from its bytes; anything that is not a PNG, JPEG, GIF or WebP, or over 64 MB, is refused. */
export async function download(url: string, dir: string, n: number): Promise<string> {
  if (!/^data:image\//.test(url) && !fromHiggsfield(url)) throw new Error(`Not an https image URL from Higgsfield: ${url.slice(0, 80)}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) for ${url.slice(0, 80)}`);
  const tooBig = () => new Error(`Image over ${MAX_DOWNLOAD / 1e6} MB: ${url.slice(0, 80)}`);
  if (Number(res.headers.get('content-length')) > MAX_DOWNLOAD) throw tooBig();
  const parts: Uint8Array[] = [];
  let got = 0;
  for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
    if ((got += c.length) > MAX_DOWNLOAD) throw tooBig(); // leaving the loop cancels the download
    parts.push(c);
  }
  const buf = Buffer.concat(parts);
  const type = sniff(buf);
  if (!type) throw new Error(`Not a PNG, JPEG, GIF or WebP image: ${url.slice(0, 80)}`);
  const file = `v${n}.${EXT[type]}`;
  writeFileSync(join(dir, file), buf); // the bytes as delivered: provenance marks and metadata kept
  return file;
}

function newRequest(o: {
  projectId: string; type: string; model: string; ratio: string; settings?: Record<string, string>; count: number; short: string; prompt: string;
  parent?: { request: string; version: number }; reference?: { name: string; data: Uint8Array; acceptedWarning: boolean };
}): { request: AssetRequest; turn: string } {
  const p = project(o.projectId);
  const count = Math.round(Number(o.count));
  if (!(count >= 1 && count <= 8)) throw new Error('Versions: 1 to 8');
  if (typeof o.prompt !== 'string' || !o.prompt.trim()) throw new Error('Write the prompt first');
  const model = catalog()?.models.find((m) => m.id === o.model);
  const settings = Object.fromEntries(Object.entries(o.settings ?? {}).filter(([k, v]) => /^\w+$/.test(k) && typeof v === 'string'));
  const d = new Date();
  const id = `${d.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}-${randomBytes(2).toString('hex')}`;
  const dir = genDir(p.path, id);
  mkdirSync(dir, { recursive: true });
  const r: AssetRequest = {
    id, projectId: p.id, createdAt: d.getTime(), type: String(o.type || 'image'), model: String(o.model), modelName: model?.name ?? String(o.model),
    ratio: String(o.ratio), settings, count, short: String(o.short ?? ''), prompt: o.prompt.trim(), status: 'pending', versions: [],
  };
  let parentJob: string | undefined;
  if (o.parent) {
    const parent = find(o.parent.request).r;
    parentJob = parent.versions[o.parent.version - 1]?.jobId;
    if (!parentJob) throw new Error('That version has no Higgsfield job id to iterate from');
    r.parent = { request: parent.id, version: o.parent.version };
  }
  if (o.reference) {
    // Higgsfield may use uploaded inputs for training (feature 24): the form makes David confirm first.
    if (!o.reference.acceptedWarning) throw new Error('Confirm the upload warning before sending a reference image');
    const ext = extname(o.reference.name).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) throw new Error('Reference must be PNG, JPEG or WebP');
    if (o.reference.data.length > 20e6) throw new Error('Reference over 20 MB');
    r.reference = `reference${ext}`;
    writeFileSync(join(dir, r.reference), o.reference.data);
  }
  put(dir, r);
  return { request: r, turn: designerTurn(r, dir, approveAbove(), model?.refs[0] ?? 'image_references', parentJob) };
}

/** Writes a version into the project's own paths. Existing files are only replaced with `overwrite` (the renderer asks first). */
export async function saveToProject(projectId: string, id: string, version: number, overwrite = false): Promise<string[]> {
  const p = project(projectId);
  const { dir, r } = find(id);
  const v = r.versions[version - 1];
  if (!v) throw new Error('No such version');
  const { targets } = projectTargets(p.path, r.type, baseName(r, version));
  const root = realpathSync(p.path);
  const there = (f: string) => { try { return lstatSync(f); } catch { return undefined; } };
  const written: string[] = [];
  for (const t of targets) {
    const dst = resolve(p.path, t.rel);
    if (!dst.startsWith(p.path + sep)) throw new Error(`${t.rel} is outside the project`);
    mkdirSync(dirname(dst), { recursive: true });
    // The paths come from the project's own app.json: a linked folder or file may not lead outside it.
    if (!(realpathSync(dirname(dst)) + sep).startsWith(root + sep)) throw new Error(`${t.rel} leads outside the project through a link`);
    const st = there(dst);
    if (st?.isSymbolicLink()) throw new Error(`${t.rel} is a symbolic link; MyIDE does not write through links`);
    if (st && !overwrite) throw new Error(`${t.rel} already exists`);
    if (t.size) await promisify(execFile)('/usr/bin/sips', ['-s', 'format', 'png', '-z', String(t.size), String(t.size), join(dir, v.file), '--out', dst]);
    else copyFileSync(join(dir, v.file), dst);
    written.push(t.rel);
  }
  r.saved = [...new Set([...(r.saved ?? []), ...written])];
  put(dir, r);
  return written;
}

// ---- one-off claude -p turns ----

/** One `claude -p` turn in a throwaway folder on the user's own CLI and login; resolves with every stream-json line.
 *  `dir`: run there instead and leave it (the role wizard resumes its session from the same folder). */
export async function oneShot(prompt: string, args: string[], timeoutMs = 180_000, dir?: string): Promise<{ lines: any[]; ok: boolean; text: string }> {
  const cwd = dir ?? mkdtempSync(join(tmpdir(), 'myide-assets-'));
  try {
    const child = spawn('claude', ['-p', prompt, '--output-format', 'stream-json', '--verbose', ...args], { cwd, env: await spawnEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    const lines: any[] = [];
    let stderr = '';
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    createInterface({ input: child.stdout }).on('line', (l) => { try { lines.push(JSON.parse(l)); } catch { /* not JSON */ } });
    const timer = setTimeout(() => child.kill('SIGINT'), timeoutMs);
    await new Promise<void>((done) => { child.on('close', () => done()); child.on('error', (e) => { stderr = e.message; done(); }); });
    clearTimeout(timer);
    const result = lines.find((l) => l.type === 'result');
    return { lines, ok: !!result && !result.is_error, text: typeof result?.result === 'string' ? result.result : stderr.trim() || 'claude gave no result' };
  } finally {
    if (!dir) rmSync(cwd, { recursive: true, force: true });
  }
}

const catalog = (): Catalog | null => readJSON<Catalog | null>(CATALOG, null);

/** A cheap haiku turn that only reads: Higgsfield's balance and image models, cached in ~/.myide/higgsfield-models.json. */
async function refresh(): Promise<Catalog> {
  const ask = `Load the tools with ToolSearch query "select:${HF}balance,${HF}models_explore". Then call ${HF}balance with {}, and ${HF}models_explore with {"action":"list","type":"image","limit":100}. Call nothing else. Then reply with exactly: ok`;
  const r = await oneShot(ask, ['--model', 'haiku', '--allowedTools', 'ToolSearch', `${HF}balance`, `${HF}models_explore`, '--disallowedTools', 'Task', 'Bash', 'Write', 'Edit', ...SPENDERS]);
  const c = readCapture(r.lines);
  if (!c.server || !c.items?.length) { // keep the last model list; only the connector status is new
    writeJSON(CATALOG, { fetchedAt: 0, models: [], ...catalog(), server: c.server ?? 'none', checkedAt: Date.now() });
    broadcast('assets:change', '');
  }
  if (!c.server) throw new Error('Higgsfield is not connected to Claude Code. Connect it at claude.ai (Customize, Connectors), then refresh.');
  if (!c.items?.length) throw new Error(c.server === 'pending' ? 'Higgsfield was still connecting. Refresh again in a moment.' : `Higgsfield is ${c.server} but returned no models${r.ok ? '' : `: ${r.text.slice(0, 300)}`}`);
  // init often reports 'pending' because the connector finishes connecting mid-turn; answering tools proves it connected
  const cat: Catalog = { fetchedAt: Date.now(), checkedAt: Date.now(), server: 'connected', credits: c.balance?.credits, plan: c.balance?.subscription_plan_type, models: compact(c.items) };
  writeJSON(CATALOG, cat);
  broadcast('assets:change', '');
  return cat;
}

/** Copies the shipped guides into ~/.myide/prompt-guides, never over David's edits. */
function guides(): string[] {
  mkdirSync(GUIDES, { recursive: true, mode: 0o700 });
  const shipped = join(__dirname, 'prompt-guides');
  for (const f of readdirSync(shipped)) if (!existsSync(join(GUIDES, f))) copyFileSync(join(shipped, f), join(GUIDES, f));
  return readdirSync(GUIDES).filter((f) => f.endsWith('.md'));
}
function guide(model: string): { file: string; text: string } {
  const file = join(GUIDES, guideFor(model, guides()));
  return { file, text: readFileSync(file, 'utf8') };
}

async function writePrompt(o: { model: string; type: string; ratio: string; settings?: Record<string, string>; short: string; parentPrompt?: string }): Promise<{ prompt: string; guide: string }> {
  if (typeof o.short !== 'string' || !o.short.trim()) throw new Error('Say what you need first');
  const m = catalog()?.models.find((x) => x.id === o.model);
  const g = guide(o.model);
  const ask = [
    `Write one image-generation prompt for the Higgsfield model ${m?.name ?? o.model} (${o.model}).`,
    `Asset: ${o.type}. Aspect ratio ${o.ratio}.${Object.entries(o.settings ?? {}).map(([k, v]) => ` ${k} ${v}.`).join('')}`,
    o.parentPrompt ? `This iterates on an image made from this prompt, sent as the reference:\n"""\n${o.parentPrompt}\n"""\nThe change David wants: ${o.short}` : `What David wants: ${o.short}`,
    'Follow this guide for the model:', '"""', g.text, '"""',
    'Reply with only the prompt text: no preamble, no quotes, no headings. Under 180 words. Use no tools.',
  ].join('\n');
  // No MCP servers at all (the claude.ai connectors included), and Higgsfield denied by name too.
  const r = await oneShot(ask, ['--model', 'sonnet', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--disallowedTools', 'Task', 'Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', HF_SERVER, ...SPENDERS]);
  if (!r.ok) throw new Error(r.text.slice(0, 300));
  return { prompt: r.text.trim(), guide: g.file };
}

/** Copies the shipped designer role into ~/.claude/agents, only when David clicks; never over an existing file. */
const roleFile = () => join(homedir(), '.claude', 'agents', 'designer.md');
function installRole(): string {
  const dst = roleFile();
  if (existsSync(dst)) return `A designer role already exists at ${dst}; left as it is.`;
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(join(__dirname, 'agents', 'designer.md'), dst);
  return `Installed ${dst}.`;
}

// ---- the designer's tools ----

// Only the designer role sees the asset tools.
const designerOnly = (employeeId: string): boolean => listEmployees().find((e) => e.id === employeeId)?.role === 'designer';

function registerTools(): void {
  registerEmployeeTool('asset_cost',
    'Asset studio: report a request\'s preflighted credit cost before generating. Answers "generate" or "declined"; over David\'s approval line it waits for him.',
    { type: 'object', properties: { requestId: { type: 'string' }, credits: { type: 'number' } }, required: ['requestId', 'credits'] },
    async (employeeId, a) => {
      const { dir, r } = find(a?.requestId);
      const credits = Number(a?.credits);
      if (!(credits >= 0)) throw new Error('credits must be a number');
      r.credits = credits;
      const line = approveAbove();
      if (credits <= line) { put(dir, r); allowSpend(r.id, employeeId, r.model, r.count); return `generate: ${credits} credits is within David's ${line} credit line. Generate at most ${r.count} with ${r.model}.`; }
      r.status = 'approval';
      put(dir, r);
      // ponytail: no timeout of its own; past MCP_TOOL_TIMEOUT (15 min) the CLI gives up and the answer only updates request.json.
      const allow = await new Promise<boolean>((done) => addApproval({
        employeeId, tool: 'asset_cost', input: { requestId: r.id, credits }, kind: 'permission',
        text: `Spend ${credits} Higgsfield credits on ${r.count} × ${r.modelName} (${r.type})? Over your ${line} credit approval line.`,
      }, (ok) => done(ok)));
      const now = find(r.id);
      now.r.status = allow ? 'pending' : 'failed';
      if (!allow) now.r.error = 'Declined: over the credit line';
      put(now.dir, now.r);
      if (allow) allowSpend(r.id, employeeId, r.model, r.count);
      return allow ? `generate: David approved the spend. Generate at most ${r.count} with ${r.model}.` : 'declined: David declined the spend. Do not generate.';
    }, designerOnly);
  registerEmployeeTool('asset_result',
    'Asset studio: hand back a request\'s generated images (url and Higgsfield jobId each) or an error. MyIDE downloads and saves them unchanged.',
    { type: 'object', properties: {
      requestId: { type: 'string' },
      images: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' }, jobId: { type: 'string' } }, required: ['url'] } },
      credits: { type: 'number' }, balance: { type: 'number' }, error: { type: 'string' },
    }, required: ['requestId'] },
    async (_employeeId, a) => {
      const { dir, r } = find(a?.requestId);
      const images = Array.isArray(a?.images) ? a.images : [];
      if (r.versions.length + images.length > r.count) throw new Error(`Request ${r.id} asked for ${r.count} image${r.count === 1 ? '' : 's'}; ${r.versions.length + images.length} is too many. Nothing was saved.`);
      spends.delete(r.id); // its approval is used up
      if (Number.isFinite(a?.credits)) r.credits = a.credits;
      if (Number.isFinite(a?.balance)) { const c = catalog(); if (c) writeJSON(CATALOG, { ...c, credits: a.balance }); }
      const errors: string[] = a?.error ? [String(a.error)] : [];
      for (const img of images) {
        try { r.versions.push({ file: await download(String(img?.url), dir, r.versions.length + 1), jobId: img?.jobId ? String(img.jobId) : undefined, url: String(img.url).slice(0, 2000) }); }
        catch (e) { errors.push((e as Error).message); }
      }
      r.status = r.versions.length ? 'done' : 'failed';
      r.error = errors.join('; ') || undefined;
      put(dir, r);
      return `Saved ${r.versions.length} file(s) in ${dir}.${errors.length ? ` Problems: ${r.error}` : ''}`;
    }, designerOnly);
}

export function registerAssetsIpc(): void {
  registerTools();
  setApproveGate(spendGate);
  handle('assets:catalog', () => ({ catalog: catalog(), approveAbove: approveAbove(), role: existsSync(roleFile()) }));
  handle('assets:refresh', refresh);
  handle('assets:guide', (model: string) => guide(String(model)));
  handle('assets:write-prompt', writePrompt);
  handle('assets:request', newRequest);
  handle('assets:list', list);
  handle('assets:targets', (projectId: string, id: string, version: number) => {
    const { r } = find(id);
    const t = projectTargets(project(projectId).path, r.type, baseName(r, version));
    return { ...t, targets: t.targets.map((x) => ({ ...x, exists: existsSync(join(project(projectId).path, x.rel)) })) };
  });
  handle('assets:save', (projectId: string, id: string, version: number, overwrite: unknown) => saveToProject(projectId, id, version, overwrite === true));
  handle('assets:reveal', (id: string, version: number) => { const { dir, r } = find(id); shell.showItemInFolder(join(dir, r.versions[version - 1]?.file ?? 'request.json')); });
  handle('assets:set-line', (n: number) => {
    if (!(Number.isInteger(n) && n >= 0)) throw new Error('A whole number of credits');
    const c = readConfig() as Record<string, any>;
    writeConfig({ ...c, assets: { ...c.assets, approveAbove: n } } as ReturnType<typeof readConfig>);
    broadcast('assets:change', '');
  });
  handle('assets:install-role', installRole);
}
