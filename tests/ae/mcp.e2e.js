'use strict';
/*
 * End-to-end: official MCP client → ClaudeAE MCP server → After Effects.
 * Imports every example design, renders frames, imports an SVG, then removes everything it made.
 *   node tests/ae/mcp.e2e.js [--keep] [--out <dir>]
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { test, run, assert } = require('./harness');

const ROOT = path.join(__dirname, '..', '..');
const KEEP = process.argv.includes('--keep');
const outIdx = process.argv.indexOf('--out');
const OUT = outIdx > 0 ? path.resolve(process.argv[outIdx + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'claudeae-e2e-'));
fs.mkdirSync(OUT, { recursive: true });
let client;
const createdFolders = [];
const createdComps = [];

async function call(name, args) {
  const r = await client.callTool({ name, arguments: args || {} });
  const text = r.content.find((c) => c.type === 'text');
  if (r.isError) throw new Error(name + ' failed: ' + (text && text.text));
  let json = null;
  try { json = JSON.parse(text.text); } catch (_) { }
  return { r, json, text: text && text.text, image: r.content.find((c) => c.type === 'image') };
}

test('connect + ae_status', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'mcp-server', 'index.js')], stderr: 'pipe' });
  client = new Client({ name: 'claudeae-e2e', version: '1.0.0' });
  await client.connect(transport);
  const s = await call('ae_status');
  assert.ok(s.json.afterEffects && s.json.afterEffects.version, s.text);
  console.log('      ' + (s.json.connection.bridge.running ? 'bridge' : 'cli') + ' → AE ' + s.json.afterEffects.version);
});

const examples = [
  { file: 'logo-reveal.json', times: [0.6, 1.3, 2.6] },
  { file: 'lower-third.json', times: [0.3, 1.5] },
  { file: 'social-promo-vertical.json', times: [1.0, 4.5] },
];
for (const ex of examples) {
  test('import + render example ' + ex.file, async () => {
    const { json } = await call('ae_import_motion', { file: path.join(ROOT, 'examples', ex.file), open: false });
    createdFolders.push(json.result.folder);
    assert.ok(json.result.layersCreated > 0);
    if (json.warnings) console.log('      warnings: ' + json.warnings.join(' | '));
    const comp = json.result.main.itemId;
    for (const t of ex.times) {
      const savePath = path.join(OUT, ex.file.replace('.json', '') + '-' + String(t).replace('.', '_') + 's.png');
      const fr = await call('ae_render_frame', { comp, time: t, maxSize: 640, savePath });
      assert.ok(fr.image && fr.image.data.length > 1000, 'image returned');
      assert.strictEqual(fr.image.mimeType, 'image/png');
      assert.ok(fs.existsSync(savePath));
    }
  });
}

test('ae_create_comp + ae_import_svg + ae_add_layers with svg d + ae_set_property', async () => {
  const c = await call('ae_create_comp', { name: 'E2E SVG', width: 800, height: 600, duration: 3, backgroundColor: '#e2e8f0', folder: 'ClaudeAE E2E', open: false });
  createdComps.push(c.json.result.comp.id);
  createdFolders.push('ClaudeAE E2E');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#f43f5e"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient></defs>
    <rect x="10" y="10" width="180" height="100" rx="18" fill="url(#g)"/>
    <path d="M40 80 Q100 20 160 80" fill="none" stroke="#fff" stroke-width="8" stroke-linecap="round"/>
    <text x="100" y="104" text-anchor="middle" font-family="Arial" font-weight="bold" font-size="14" fill="#fff">SVG → AE</text></svg>`;
  const s = await call('ae_import_svg', { comp: c.json.result.comp.id, svg, name: 'Badge', width: 600, position: [400, 300], time: 0.5 });
  // text layer + plain-paint part + gradient part (parented to the main part)
  assert.deepStrictEqual(s.json.result.layers.map((l) => l.type), ['text', 'shape', 'shape']);
  assert.strictEqual(s.json.result.layers[2].parent.name, 'Badge');
  await call('ae_add_layers', { comp: c.json.result.comp.id, layers: [{ type: 'shape', name: 'Wave', shapes: [{ type: 'path', d: 'M-300 0 C -150 -80 150 80 300 0', stroke: { color: '#0ea5e9', width: 6 }, trimPaths: { end: [{ t: 0, v: 0, ease: 'easeInOutSine' }, { t: 1.5, v: 100 }] } }], transform: { position: [400, 540] } }] });
  await call('ae_set_property', { comp: c.json.result.comp.id, layer: 'Badge', path: 'scale', keyframes: [{ t: 0.5, v: [0, 0], ease: 'easeOutBack' }, { t: 1.2, v: [100, 100] }] });
  const fr = await call('ae_render_frame', { comp: c.json.result.comp.id, time: 2, maxSize: 800, savePath: path.join(OUT, 'svg-import.png') });
  assert.ok(fr.image);
});

test('errors come back as tool errors', async () => {
  const r = await client.callTool({ name: 'ae_get_layer', arguments: { comp: 'No Such Comp', layer: 1 } });
  assert.strictEqual(r.isError, true);
  assert.match(r.content[0].text, /Composition not found/);
});

(async () => {
  const res = await run(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : undefined);
  if (client && !KEEP) {
    const names = JSON.stringify(createdFolders.filter(Boolean));
    try {
      await call('ae_run_script', { code: `(function(){ var names = ${names}, n = 0; for (var i = app.project.numItems; i >= 1; i--) { var it = app.project.item(i); if (it instanceof FolderItem) for (var k = 0; k < names.length; k++) if (it.name === names[k]) { it.remove(); n++; break; } } for (var j = app.project.numItems; j >= 1; j--) { var s = app.project.item(j); if (s instanceof FootageItem && s.mainSource instanceof SolidSource && s.usedIn.length === 0) s.remove(); } for (var m = app.project.numItems; m >= 1; m--) { var f = app.project.item(m); if (f instanceof FolderItem && f.name === "Solids" && f.numItems === 0) f.remove(); } return n; })()` });
    } catch (e) { console.log('cleanup failed: ' + e.message); }
  }
  if (client) await client.close();
  console.log('frames in ' + OUT);
  process.exit(res.fail ? 1 : 0);
})();
