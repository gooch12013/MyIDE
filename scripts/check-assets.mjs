// Checks the asset studio's pure helpers in src/main/assets.ts: guide lookup, reading a stream-json
// capture of the read-only Higgsfield turn, the model list, the designer turn and project output paths.
// Usage: node scripts/check-assets.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

const tmp = mkdtempSync(join(tmpdir(), 'myide-assets-check-'));
process.env.MYIDE_HOME = join(tmp, 'home');
const stub = join(tmp, 'stub.cjs');
writeFileSync(stub, 'module.exports = new Proxy({}, { get: () => new Proxy(function () {}, { get: () => () => {} }) });');
const out = join(tmp, 'assets.cjs');
await build({ entryPoints: ['src/main/assets.ts'], outfile: out, bundle: true, platform: 'node', format: 'cjs', logLevel: 'error', alias: { electron: stub, 'node-pty': stub } });
const a = createRequire(import.meta.url)(out);

// Guides: exact file, then the longest family prefix, then general.md.
const files = ['general.md', 'nano-banana.md', 'gpt-image.md', 'flux.md', 'seedream.md', 'nano_banana_pro.md'];
assert.equal(a.guideFor('nano_banana_pro', files), 'nano_banana_pro.md');
assert.equal(a.guideFor('nano_banana_2_1', files), 'nano-banana.md');
assert.equal(a.guideFor('gpt_image_2_5', files), 'gpt-image.md');
assert.equal(a.guideFor('flux_kontext', files), 'flux.md');
assert.equal(a.guideFor('seedream_v4_5', files), 'seedream.md');
assert.equal(a.guideFor('soul_2', files), 'general.md');

// A capture shaped like the real haiku turn: init, ToolSearch, balance, models_explore (with trailing prose).
const items = [
  { id: 'nano_banana_pro', name: 'Nano Banana Pro', provider_name: 'Google', output_type: 'image', aspect_ratios: ['1:1', '16:9'],
    parameters: [{ name: 'resolution', options: ['1k', '2k', '4k'], default: '2k' }, { name: 'seed', type: 'number' }], medias: [{ roles: ['image_references', 'mask'] }] },
  { id: 'autosprite', name: 'AutoSprite', output_type: 'image', aspect_ratios: [], parameters: [] },
  { id: 'kling_video', name: 'Kling', output_type: 'video', aspect_ratios: ['16:9'] },
  { id: 'ms_image', name: 'DTC Ads', output_type: 'image', aspect_ratios: ['1:1'], parameters: [{ name: 'style_id', required: 'required' }] },
];
const lines = [
  { type: 'system', subtype: 'init', mcp_servers: [{ name: 'myide', status: 'connected' }, { name: 'claude.ai Higgsfield', status: 'pending' }] },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't0', name: 'ToolSearch' }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't0', content: [{ type: 'tool_reference', tool_name: 'x' }] }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__claude_ai_Higgsfield__balance' }, { type: 'tool_use', id: 't2', name: 'mcp__claude_ai_Higgsfield__models_explore' }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"credits":1200,"subscription_plan_type":"plus"}' }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: JSON.stringify({ items, has_more: false }) + '\n\nUnlim configs: none' }] }] } },
  { type: 'result', result: 'ok' },
];
const c = a.readCapture(lines);
assert.equal(c.server, 'pending');
assert.equal(c.balance.credits, 1200);
assert.equal(c.items.length, 4);
assert.deepEqual(a.readCapture([{ type: 'system', subtype: 'init', mcp_servers: [] }]), { server: undefined });
const models = a.compact(c.items);
assert.deepEqual(models.map((m) => m.id), ['nano_banana_pro']); // video, ratio-less and required-parameter models dropped
assert.deepEqual(models[0].params, [{ name: 'resolution', options: ['1k', '2k', '4k'], default: '2k' }]);
assert.deepEqual(models[0].refs, ['image_references']);

// The designer turn carries the id, the exact prompt, the cost gate and the parent's job id.
const req = { id: 'r1', projectId: 'p', createdAt: 0, type: 'App icon', model: 'nano_banana_pro', modelName: 'Nano Banana Pro', ratio: '1:1',
  settings: { resolution: '2k' }, count: 4, short: 's', prompt: 'A buoy icon.', status: 'pending', versions: [] };
const turn = a.designerTurn(req, '/x', 40, 'image_references', 'job-9');
for (const s of ['r1', 'A buoy icon.', 'mcp__myide__asset_cost', 'mcp__myide__asset_result', '40 credits', '"value": "job-9"', '"resolution":"2k"', 'get_cost: true']) assert.ok(turn.includes(s), s);
assert.ok(!a.designerTurn(req, '/x', 40, 'image_references').includes('job-9'));

// Project outputs: Expo paths from app.json, defaults otherwise; web favicon set; plain copy.
const expo = join(tmp, 'expo');
mkdirSync(expo);
writeFileSync(join(expo, 'app.json'), JSON.stringify({ expo: { icon: './assets/icon.png', android: { adaptiveIcon: { foregroundImage: './assets/fg.png', backgroundColor: '#111317' } },
  plugins: [['expo-splash-screen', { image: './assets/splash.png' }]] } }));
let t = a.projectTargets(expo, 'App icon', 'x.png');
assert.equal(t.kind, 'expo');
assert.deepEqual(t.targets.map((x) => [x.rel, x.size]), [['assets/icon.png', 1024], ['assets/fg.png', 1024], ['assets/splash.png', 1024], ['assets/images/favicon.png', 48]]);
assert.match(t.note, /#111317/);
assert.deepEqual(a.projectTargets(expo, 'Photo', 'p.jpg').targets, [{ label: 'Image', rel: 'assets/images/p.jpg' }]);
const web = join(tmp, 'web');
mkdirSync(web);
writeFileSync(join(web, 'package.json'), '{"dependencies":{"vite":"1"}}');
t = a.projectTargets(web, 'Logo', 'x.png');
assert.equal(t.kind, 'web');
assert.deepEqual(t.targets.map((x) => x.size), [16, 32, 180, 192, 512]);
assert.ok(t.targets.every((x) => x.rel.startsWith('public/')));
assert.deepEqual(a.projectTargets(join(tmp, 'nothing'), 'Logo', 'l.png'), { kind: 'plain', targets: [{ label: 'Image', rel: 'assets/l.png' }], note: '' });

rmSync(tmp, { recursive: true, force: true });
console.log('check-assets: ok');
process.exit(0); // pty.ts's login-shell probe may still be running
