'use strict';
/*
 * After Effects integration tests for the ClaudeAE engine.
 * Requires After Effects to be installed (it is launched if it is not running).
 * Everything is created inside a "ClaudeAE Tests" folder which is removed at the end.
 *
 *   node tests/ae/engine.test.js            (auto transport: bridge if running, else CLI)
 *   CLAUDEAE_TRANSPORT=cli node tests/ae/engine.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Transport } = require('../../lib/transport');
const { test, run, near, assert } = require('./harness');

const T = new Transport();
const FOLDER = 'ClaudeAE Tests';
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeae-test-'));
let compId, warningsSeen = [];

async function ae(method, params) {
  const r = await T.call(method, params);
  if (r.warnings.length) warningsSeen.push({ method, warnings: r.warnings });
  return r;
}
const kf = (prop) => prop.keyframes;

test('ping', async () => {
  const r = await ae('ping', {});
  assert.ok(/^\d+\./.test(r.result.version), 'version');
  console.log('      transport=' + r.transport + ' AE ' + r.result.version);
});

test('create_comp with a full layer stack', async () => {
  const r = await ae('create_comp', {
    name: 'CT Main', width: 1280, height: 720, fps: 30, duration: 6, backgroundColor: '#101018', folder: FOLDER,
    markers: [{ time: 1, comment: 'intro' }],
    layers: [
      { id: 'title', type: 'text', name: 'Title', inPoint: 0.5, outPoint: '150f',
        text: { content: 'Hello Claude', font: 'Arial-BoldMT', fontSize: 96, color: '#ffffff', justification: 'center', tracking: 20 },
        transform: { position: [640, 300], opacity: [{ t: 0.5, v: 0, ease: 'easeOutCubic' }, { t: 1.5, v: 100 }] } },
      { id: 'card', type: 'shape', name: 'Card', parent: 'rig',
        shapes: [{ type: 'rect', name: 'Card BG', size: [400, 200], roundness: 24, fill: '#ff5a1f', stroke: { color: '#ffffff', width: 4, lineCap: 'round', dashes: [12, 6] },
          trimPaths: { end: [{ t: 0, v: 0, ease: 'easeInOut' }, { t: 1, v: 100 }] } }],
        transform: { position: [0, 0], scale: [{ t: 0, v: [0, 0], ease: 'easeOutBack' }, { t: 1, v: [100, 100] }] } },
      { id: 'dot', type: 'shape', name: 'Dot',
        shapes: [{ type: 'ellipse', radius: 40, fill: { color: '#22d3ee', opacity: 80 } }, { type: 'star', points: 5, outerRadius: 60, innerRadius: 25, fill: '#facc15', transform: { position: [150, 0] } }],
        transform: { position: [{ t: 0, v: [100, 100], ease: 'easeInOut' }, { t: 2, v: [400, 500] }] } },
      { id: 'rig', type: 'null', name: 'Rig', transform: { position: [640, 420] } },
      { id: 'fx', type: 'adjustment', name: 'Glow FX', effects: [{ name: 'Gaussian Blur', properties: { Blurriness: [{ t: 0, v: 20 }, { t: 1, v: 0 }] } }] },
      { id: 'bg', type: 'solid', name: 'BG', color: '#1e293b', masks: [{ rect: [40, 40, 1200, 640], roundness: 30, feather: 10 }] },
    ],
  });
  compId = r.result.comp.id;
  assert.strictEqual(r.result.layers.length, 6);
  assert.deepStrictEqual(r.result.layers.map((l) => l.name), ['Title', 'Card', 'Dot', 'Rig', 'Glow FX', 'BG']);
  assert.deepStrictEqual(r.result.layers.map((l) => l.index), [1, 2, 3, 4, 5, 6]);
});

test('get_comp reflects order, parenting, timing, markers', async () => {
  const r = await ae('get_comp', { comp: compId });
  const c = r.result;
  assert.strictEqual(c.width, 1280); assert.strictEqual(c.fps, 30); near(c.duration, 6);
  assert.strictEqual(c.bgColor, '#101018');
  assert.strictEqual(c.markers[0].comment, 'intro');
  const byName = Object.fromEntries(c.layers.map((l) => [l.name, l]));
  assert.strictEqual(byName.Card.parent.name, 'Rig');
  near(byName.Title.inPoint, 0.5); near(byName.Title.outPoint, 5);
  assert.strictEqual(byName.Title.type, 'text');
  assert.strictEqual(byName['Glow FX'].type, 'adjustment');
  assert.deepStrictEqual(byName['Glow FX'].effects, ['Gaussian Blur']);
  assert.strictEqual(byName.BG.masks, 1);
  assert.ok(byName.Dot.animated.some((s) => s.startsWith('Transform/Position')), 'Dot position animated');
});

test('bezier eases are converted to AE speed/influence', async () => {
  const op = (await ae('get_property', { comp: compId, layer: 'Title', path: 'opacity' })).result;
  assert.strictEqual(op.numKeys, 2);
  near(op.keyframes[0].t, 0.5); near(op.keyframes[1].t, 1.5);
  assert.strictEqual(op.keyframes[0].out, 'bezier');
  near(op.keyframes[0].easeOut.influence, 33, 0.01);
  near(op.keyframes[0].easeOut.speed, 100 / 0.33, 0.05);
  near(op.keyframes[1].easeIn.influence, 32, 0.01);
  near(op.keyframes[1].easeIn.speed, 0, 0.001);

  const pos = (await ae('get_property', { comp: compId, layer: 'Dot', path: 'Transform/Position' })).result;
  near(pos.keyframes[0].easeOut.influence, 42, 0.01);
  near(pos.keyframes[0].easeOut.speed, 0, 0.001);
  near(pos.keyframes[1].v, [400, 500]);

  const sc = (await ae('get_property', { comp: compId, layer: 'Card', path: 'scale' })).result;
  near(sc.keyframes[0].easeOut[0].speed, 1.56 * 100 / 0.34, 0.05);
  near(sc.keyframes[0].easeOut[0].influence, 34, 0.01);
  const mid = (await ae('get_property', { comp: compId, layer: 'Card', path: 'scale', time: 0.5 })).result.valueAtTime;
  assert.ok(mid[0] > 95, 'easeOutBack should be past ~95% at the midpoint, got ' + mid[0]);
});

test('linear segments stay linear next to bezier segments', async () => {
  await ae('set_property', { comp: compId, layer: 'Rig', path: 'rotation', keyframes: [
    { t: 0, v: 0, ease: 'linear' }, { t: 1, v: 90, ease: 'easeOutQuad' }, { t: 2, v: 180, ease: 'hold' }, { t: 3, v: 270 }] });
  const r = (await ae('get_property', { comp: compId, layer: 'Rig', path: 'rotation' })).result;
  assert.strictEqual(r.keyframes[0].out, 'linear');
  assert.strictEqual(r.keyframes[1]['in'], 'linear');
  assert.strictEqual(r.keyframes[1].out, 'bezier');
  assert.strictEqual(r.keyframes[2]['in'], 'bezier');
  assert.strictEqual(r.keyframes[2].out, 'hold');
  const half = (await ae('get_property', { comp: compId, layer: 'Rig', path: 'rotation', time: 0.5 })).result.valueAtTime;
  near(half, 45, 0.01);
  const held = (await ae('get_property', { comp: compId, layer: 'Rig', path: 'rotation', time: 2.9 })).result.valueAtTime;
  near(held, 180, 0.01);
});

test('frame and timecode times', async () => {
  await ae('set_property', { comp: compId, layer: 'Rig', path: 'opacity', keyframes: [{ t: '15f', v: 0 }, { t: '00:00:01:15', v: 100 }] });
  const r = (await ae('get_property', { comp: compId, layer: 'Rig', path: 'opacity' })).result;
  near(r.keyframes[0].t, 0.5); near(r.keyframes[1].t, 1.5);
});

test('shape contents are built in the right structure', async () => {
  const r = (await ae('get_layer', { comp: compId, layer: 'Card', all: true, depth: 8 })).result;
  const paths = r.properties.map((p) => p.path);
  const has = (s) => assert.ok(paths.some((p) => p === s), 'missing ' + s + '\n' + paths.filter((p) => p.startsWith('Contents')).join('\n'));
  has('Contents/Card BG/Contents/Rectangle Path 1/Size');
  has('Contents/Card BG/Contents/Trim Paths 1/End');
  has('Contents/Card BG/Contents/Stroke 1/Stroke Width');
  has('Contents/Card BG/Contents/Fill 1/Color');
  const size = r.properties.find((p) => p.path === 'Contents/Card BG/Contents/Rectangle Path 1/Size');
  near(size.value, [400, 200]);
  const fill = r.properties.find((p) => p.path === 'Contents/Card BG/Contents/Fill 1/Color');
  assert.strictEqual(fill.value, '#ff5a1f');
  const dash = r.properties.find((p) => /Stroke 1\/Dashes\/Dash$/.test(p.path));
  assert.ok(dash, 'dash added'); near(dash.value, 12);
  const dot = (await ae('get_layer', { comp: compId, layer: 'Dot', all: true })).result;
  const ell = dot.properties.find((p) => /Ellipse Path 1\/Size$/.test(p.path));
  near(ell.value, [80, 80]);
  const star = dot.properties.find((p) => /Polystar Path 1\/Points$/.test(p.path));
  near(star.value, 5);
});

test('text layer: font, size, anchor centered', async () => {
  const r = (await ae('get_layer', { comp: compId, layer: 'Title' })).result;
  assert.strictEqual(r.textDocument.text, 'Hello Claude');
  assert.strictEqual(r.textDocument.font, 'Arial-BoldMT');
  near(r.textDocument.fontSize, 96);
  assert.strictEqual(r.textDocument.fillColor, '#ffffff');
  assert.strictEqual(r.textDocument.justification, 'center');
  const ap = r.properties.find((p) => p.path === 'Transform/Anchor Point');
  assert.ok(ap, 'anchor point modified');
  // centred anchor: x ~ 0 for centre-justified text, y negative (above baseline)
  near(ap.value[0], r.sourceRect.left + r.sourceRect.width / 2, 1);
  near(ap.value[1], r.sourceRect.top + r.sourceRect.height / 2, 1);
});

test('missing font falls back with a warning', async () => {
  const r = await ae('add_layers', { comp: compId, layers: [{ type: 'text', name: 'Fallback', text: { content: 'x', font: 'DefinitelyNotAFont-Bold' } }] });
  assert.ok(r.warnings.some((w) => /Font not installed/.test(w)), JSON.stringify(r.warnings));
  await ae('delete_layers', { comp: compId, layers: ['Fallback'] });
});

test('text animator with range selector', async () => {
  await ae('add_layers', { comp: compId, layers: [{ type: 'text', name: 'Typewriter', text: { content: 'TYPE ON', fontSize: 60, animators: [
    { name: 'Reveal', properties: { opacity: 0, position: [0, 40] }, selector: { basedOn: 'characters', shape: 'rampUp', start: [{ t: 0, v: 0 }, { t: 1, v: 100 }], easeHigh: 50 } }] } }] });
  const r = (await ae('get_layer', { comp: compId, layer: 'Typewriter', depth: 10 })).result;
  const start = r.properties.find((p) => /Reveal\/Selectors\/Range Selector 1\/Start$/.test(p.path) && p.numKeys);
  assert.ok(start && start.numKeys === 2, 'selector start keyed: ' + r.properties.map((p) => p.path).join(', '));
  const op = r.properties.find((p) => /Reveal\/Properties\/Opacity$/.test(p.path));
  near(op.value, 0);
  const shape = r.properties.find((p) => /Advanced\/Shape$/.test(p.path));
  near(shape.value, 2);
  // the modified-only listing stays small (no hidden animator properties)
  assert.ok(r.properties.length < 25, 'listing too long: ' + r.properties.length);
});

test('track matte, blend mode, 3D, expressions', async () => {
  const r = await ae('add_layers', { comp: compId, layers: [
    { id: 'm', type: 'shape', name: 'Matte', shapes: [{ type: 'ellipse', size: [300, 300], fill: '#ffffff' }], transform: { position: [640, 360] } },
    { id: 'tex', type: 'solid', name: 'Texture', color: '#8b5cf6', blendMode: 'screen', threeD: true, trackMatte: { layer: 'm', type: 'alpha' },
      expressions: { 'Transform/Rotation': 'time * 45' } },
  ] });
  assert.deepStrictEqual(r.result.layers.map((l) => l.name), ['Matte', 'Texture']);
  const c = (await ae('get_comp', { comp: compId })).result;
  const tex = c.layers.find((l) => l.name === 'Texture');
  assert.strictEqual(tex.blendMode, 'screen');
  assert.strictEqual(tex.threeD, true);
  assert.strictEqual(tex.trackMatte.type, 'alpha');
  assert.strictEqual(tex.trackMatte.layer, 'Matte');
  const matte = c.layers.find((l) => l.name === 'Matte');
  assert.strictEqual(matte.enabled, false);
  const rot = (await ae('get_property', { comp: compId, layer: 'Texture', path: 'rotation', time: 2 })).result;
  assert.strictEqual(rot.expression, 'time * 45');
  near(rot.valueAtTime, 90);
});

test('bad expression is reported as a warning, not a crash', async () => {
  const r = await ae('set_property', { comp: compId, layer: 'Texture', path: 'opacity', expression: 'thisIsNot(valid' });
  assert.ok(r.warnings.some((w) => /Expression error/.test(w)), JSON.stringify(r.warnings));
  await ae('set_property', { comp: compId, layer: 'Texture', path: 'opacity', expression: '' });
});

test('update_layer edits text, colour, timing, effects', async () => {
  await ae('update_layer', { comp: compId, layer: 'Title', set: { text: { content: 'Updated!', color: '#22c55e' }, inPoint: 1, outPoint: 4, effects: [{ name: 'Drop Shadow', properties: { Distance: 12, Softness: 20 } }] } });
  const r = (await ae('get_layer', { comp: compId, layer: 'Title' })).result;
  assert.strictEqual(r.textDocument.text, 'Updated!');
  assert.strictEqual(r.textDocument.fillColor, '#22c55e');
  near(r.inPoint, 1); near(r.outPoint, 4);
  assert.deepStrictEqual(r.effects, ['Drop Shadow']);
  // updating an existing effect by name changes it instead of adding a second one
  await ae('update_layer', { comp: compId, layer: 'Title', set: { effects: [{ name: 'Drop Shadow', properties: { Distance: 30 } }] } });
  const r2 = (await ae('get_property', { comp: compId, layer: 'Title', path: 'Effects/Drop Shadow/Distance' })).result;
  near(r2.value, 30);
  const s = (await ae('update_layer', { comp: compId, layer: 'BG', set: { color: '#334155' } })).result;
  assert.strictEqual(s.color, '#334155');
});

test('move, duplicate, select, delete', async () => {
  const m = (await ae('move_layer', { comp: compId, layer: 'BG', to: 'top' })).result;
  assert.strictEqual(m.index, 1);
  await ae('move_layer', { comp: compId, layer: 'BG', to: 'bottom' });
  const d = (await ae('duplicate_layer', { comp: compId, layer: 'Dot', count: 2, name: 'Dot Copy', offset: '10f' })).result;
  assert.strictEqual(d.layers.length, 2);
  near(d.layers[1].startTime, 20 / 30);
  await ae('select_layers', { comp: compId, layers: ['Dot'] });
  const c = (await ae('get_comp', { comp: compId })).result;
  assert.ok(c.layers.find((l) => l.name === 'Dot').selected);
  const del = (await ae('delete_layers', { comp: compId, layers: ['Dot Copy 1', 'Dot Copy 2'] })).result;
  assert.deepStrictEqual(del.deleted, ['Dot Copy 1', 'Dot Copy 2']);
});

test('import_file places footage at an exact time with fit', async () => {
  const svg = path.join(OUT, 'logo.svg');
  fs.writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100"><rect x="0" y="0" width="200" height="100" fill="#ff00ff"/></svg>');
  const r = (await ae('import_file', { path: svg, comp: compId, time: '2s', duration: 1.5, fit: 'contain', folder: FOLDER })).result;
  assert.strictEqual(r.item.type, 'image');
  near(r.layer.inPoint, 2); near(r.layer.outPoint, 3.5);
  const sc = (await ae('get_property', { comp: compId, layer: r.layer.index, path: 'scale' })).result;
  near(sc.value[0], Math.min(1280 / 200, 720 / 100) * 100, 0.01);
  // re-import reuses the existing project item
  const r2 = (await ae('import_file', { path: svg })).result;
  assert.strictEqual(r2.item.id, r.item.id);
});

test('gradient fill renders with the requested colours', async () => {
  const g = await ae('create_comp', { name: 'CT Gradient', width: 200, height: 100, fps: 30, duration: 1, folder: FOLDER, open: false, layers: [
    { type: 'shape', name: 'Grad', shapes: [{ type: 'rect', size: [200, 100], gradient: { gradientType: 'linear', start: [-100, 0], end: [100, 0], colors: ['#ff0000', '#0000ff'] } }], transform: { position: [100, 50] } }] });
  const png = path.join(OUT, 'grad.png');
  const r = await ae('render_frame', { comp: g.result.comp.id, time: 0, path: png });
  assert.ok(await waitFile(png), 'png written');
  const { decodePng } = require('../../lib/png');
  const img = decodePng(fs.readFileSync(png));
  const px = (x, y) => { const i = (y * img.width + x) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2]]; };
  const left = px(3, 50), right = px(196, 50);
  assert.ok(left[0] > 200 && left[2] < 60, 'left should be red, got ' + left);
  assert.ok(right[2] > 200 && right[0] < 60, 'right should be blue, got ' + right);
  assert.strictEqual(r.result.width, 200);
});

test('import_motion: new comps with precomp + assets', async () => {
  const svg = path.join(OUT, 'asset.svg');
  fs.writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="30" fill="#0ea5e9"/></svg>');
  const spec = {
    format: 'claude-motion', version: 1, name: 'CT Motion', defaultEase: 'easeInOutCubic',
    assets: [{ id: 'icon', path: svg }],
    compositions: [
      { id: 'main', name: 'CT Motion Main', width: 640, height: 360, fps: 24, duration: 4, backgroundColor: '#000000', layers: [
        { type: 'precomp', comp: 'badge', name: 'Badge', inPoint: 1, transform: { position: [320, 180] } },
        { type: 'footage', asset: 'icon', name: 'Icon', transform: { position: [80, 80] } },
      ] },
      { id: 'badge', name: 'CT Badge', width: 200, height: 200, fps: 24, duration: 2, layers: [
        { type: 'shape', name: 'Ring', shapes: [{ type: 'ellipse', size: [180, 180], stroke: { color: '#fff', width: 8 }, trimPaths: { end: [{ t: 0, v: 0 }, { t: 1, v: 100 }] } }], transform: { position: [100, 100] } },
      ] },
    ],
  };
  const r = (await ae('import_motion', { spec, open: false })).result;
  assert.strictEqual(r.comps.length, 2);
  assert.strictEqual(r.main.name, 'CT Motion Main');
  const main = (await ae('get_comp', { comp: r.main.itemId })).result;
  near(main.fps, 24);
  const badge = main.layers.find((l) => l.name === 'Badge');
  assert.strictEqual(badge.type, 'precomp');
  near(badge.inPoint, 1); near(badge.startTime, 1); near(badge.outPoint, 3);
  const trim = (await ae('get_property', { comp: 'CT Badge', layer: 'Ring', path: 'Contents/Ellipse/Contents/Trim Paths 1/End' })).result;
  assert.strictEqual(trim.keyframes[0].out, 'bezier', 'defaultEase applied');
  // tidy: move the generated folder into the test folder
  await ae('run_script', { code: `var f = null; for (var i = 1; i <= app.project.numItems; i++) { var it = app.project.item(i); if (it instanceof FolderItem && it.name === ${JSON.stringify(r.folder)}) f = it; } var t = null; for (var j = 1; j <= app.project.numItems; j++) { var x = app.project.item(j); if (x instanceof FolderItem && x.name === ${JSON.stringify(FOLDER)}) t = x; } if (f && t) f.parentFolder = t; true;` });
});

test('import_motion: flatten into an existing comp at a time offset', async () => {
  const spec = { compositions: [{ id: 'm', width: 1280, height: 720, fps: 30, duration: 2, layers: [
    { type: 'text', name: 'Flat Text', text: { content: 'Offset' }, transform: { opacity: [{ t: 0, v: 0 }, { t: 1, v: 100 }] } }] }] };
  const r = (await ae('import_motion', { spec, mode: 'flatten', comp: compId, time: 3, folder: false, open: false })).result;
  assert.strictEqual(r.layersCreated, 1);
  const l = (await ae('get_layer', { comp: compId, layer: 'Flat Text' })).result;
  near(l.inPoint, 3); near(l.outPoint, 5);
  const op = l.properties.find((p) => p.path === 'Transform/Opacity');
  near(op.keyframes[0].t, 3); near(op.keyframes[1].t, 4);
});

test('import_motion: precomp mode drops the motion into the target at a time', async () => {
  const spec = { name: 'CT Drop', compositions: [{ id: 'x', name: 'CT Drop Comp', width: 320, height: 180, fps: 30, duration: 1, layers: [{ type: 'solid', color: '#ffffff' }] }] };
  const r = (await ae('import_motion', { spec, comp: compId, time: 2.5, open: false })).result;
  assert.strictEqual(r.mode, 'precomp');
  near(r.layer.inPoint, 2.5); near(r.layer.outPoint, 3.5);
  await ae('run_script', { code: `var f=null,t=null; for (var i=1;i<=app.project.numItems;i++){var it=app.project.item(i); if (it instanceof FolderItem){ if(it.name===${JSON.stringify(r.folder)}) f=it; if(it.name===${JSON.stringify(FOLDER)}) t=it; }} if(f&&t) f.parentFolder=t; true;` });
});

test('markers, precompose, batch, run_script, list_effects, list_fonts', async () => {
  const m = (await ae('add_markers', { comp: compId, markers: [{ time: 2, comment: 'beat', duration: 0.5 }] })).result;
  assert.strictEqual(m.count, 1);
  const p = (await ae('precompose', { comp: compId, layers: ['Dot'], name: 'CT Dot Pre' })).result;
  assert.strictEqual(p.comp.numLayers, 1);
  await ae('run_script', { code: `app.project.itemByID(${p.comp.id}).parentFolder = (function(){ for (var i=1;i<=app.project.numItems;i++){var it=app.project.item(i); if (it instanceof FolderItem && it.name===${JSON.stringify(FOLDER)}) return it;} })(); true;` });
  const b = (await ae('batch', { commands: [{ method: 'ping' }, { method: 'get_comp', params: { comp: compId } }, { method: 'nope' }, { method: 'ping' }] })).result;
  assert.strictEqual(b.results.length, 3);
  assert.strictEqual(b.results[2].ok, false);
  const s = (await ae('run_script', { code: 'var c = app.project.itemByID(' + compId + '); [c.name, c.numLayers > 3]' })).result;
  assert.deepStrictEqual(s, ['CT Main', true]);
  const fx = (await ae('list_effects', { query: 'gaussian' })).result;
  assert.ok(fx.effects.some((e) => e.matchName === 'ADBE Gaussian Blur 2'));
  const fonts = (await ae('list_fonts', { query: 'arial', limit: 3 })).result;
  assert.ok(fonts.families.length >= 1);
});

test('errors are clean and descriptive', async () => {
  await assert.rejects(() => T.call('get_layer', { comp: compId, layer: 'Nope' }), /Layer not found: Nope/);
  await assert.rejects(() => T.call('get_comp', { comp: 'No Such Comp' }), /Composition not found/);
  await assert.rejects(() => T.call('set_property', { comp: compId, layer: 'BG', path: 'Transform/Wobble', value: 1 }), /Property not found: "Wobble"/);
  await assert.rejects(() => T.call('create_comp', { name: 'x', duration: 0 }), /duration must be > 0/);
  await assert.rejects(() => T.call('no_such_method', {}), /Unknown method/);
});

test('undo reverts the last Claude action', async () => {
  await ae('add_layers', { comp: compId, layers: [{ type: 'null', name: 'Undo Me' }] });
  let c = (await ae('get_comp', { comp: compId })).result;
  assert.ok(c.layers.some((l) => l.name === 'Undo Me'));
  await ae('undo', { steps: 1 });
  c = (await ae('get_comp', { comp: compId })).result;
  assert.ok(!c.layers.some((l) => l.name === 'Undo Me'), 'layer removed by undo');
});

test('render_frame of the main comp', async () => {
  const png = path.join(OUT, 'main.png');
  await ae('render_frame', { comp: compId, time: 1.2, path: png });
  assert.ok(await waitFile(png), 'png written');
  console.log('      frame: ' + png);
});

async function waitFile(f, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (fs.statSync(f).size > 0) { await new Promise((r) => setTimeout(r, 150)); return true; } } catch (_) { }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function cleanup() {
  if (process.env.KEEP) return;
  try {
    await T.call('run_script', { code: `(function(){ var n = 0; for (var i = app.project.numItems; i >= 1; i--) { var it = app.project.item(i); if (it instanceof FolderItem && it.name === ${JSON.stringify(FOLDER)}) { it.remove(); n++; } } for (var j = app.project.numItems; j >= 1; j--) { var s = app.project.item(j); if (s instanceof FolderItem && s.name === "Solids" && s.numItems === 0) s.remove(); } return n; })()` });
    await T.call('run_script', { code: `(function(){ for (var i = app.project.numItems; i >= 1; i--) { var it = app.project.item(i); if (it instanceof FootageItem && it.mainSource instanceof SolidSource && it.usedIn.length === 0) it.remove(); } for (var j = app.project.numItems; j >= 1; j--) { var s = app.project.item(j); if (s instanceof FolderItem && s.numItems === 0 && s.name === "Solids") s.remove(); } return app.project.numItems; })()` });
  } catch (e) { console.log('cleanup failed: ' + e.message); }
}

(async () => {
  const res = await run(process.argv[2]);
  await cleanup();
  if (warningsSeen.length) console.log('\nwarnings seen:\n' + warningsSeen.map((w) => '  ' + w.method + ': ' + w.warnings.join(' | ')).join('\n'));
  process.exit(res.fail ? 1 : 0);
})();
