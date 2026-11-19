'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { normalizeSpec, svgLayerSpecs, SpecError } = require('../../lib/motion');

test('single-comp shorthand becomes compositions[]', async () => {
  const { spec } = await normalizeSpec({ name: 'Short', width: 1080, height: 1920, fps: 30, duration: 5, layers: [{ type: 'null' }] });
  assert.strictEqual(spec.compositions.length, 1);
  assert.strictEqual(spec.compositions[0].width, 1080);
  assert.strictEqual(spec.compositions[0].layers.length, 1);
});

test('path data is converted in shapes, masks and keyframes', async () => {
  const { spec } = await normalizeSpec({ compositions: [{ id: 'm', layers: [
    { type: 'shape', shapes: [{ type: 'path', d: 'M0 0 L10 0 L10 10 Z M20 20 L30 20 L30 30 Z', fill: '#fff' },
      { type: 'path', path: [{ t: 0, v: 'M0 0 L10 0 L10 10 Z' }, { t: 1, v: 'M0 0 L20 0 L20 20 Z' }], stroke: '#fff' }] },
    { type: 'solid', masks: [{ d: 'M0 0 L100 0 L100 100 Z', mode: 'subtract' }] },
  ] }] });
  const [shape, solid] = spec.compositions[0].layers;
  assert.strictEqual(shape.shapes[0].paths.length, 2);
  assert.ok(!shape.shapes[0].d);
  assert.deepStrictEqual(shape.shapes[1].path[1].v.vertices, [[0, 0], [20, 0], [20, 20]]);
  assert.strictEqual(solid.masks[0].path.vertices.length, 3);
});

test('svg layers become shape layers plus parented text layers', async () => {
  const { spec, warnings } = await normalizeSpec({ compositions: [{ layers: [
    { type: 'svg', name: 'Logo', svg: '<svg width="100" height="50"><rect width="100" height="50" fill="#f00"/><text x="50" y="40" text-anchor="middle">AE</text></svg>', transform: { position: [960, 540] } },
  ] }] });
  const layers = spec.compositions[0].layers;
  assert.strictEqual(layers.length, 2);
  assert.strictEqual(layers[0].type, 'text');
  assert.strictEqual(layers[0].parent, layers[1].id);
  assert.strictEqual(layers[0].text.anchor, 'baseline');
  assert.strictEqual(layers[0].text.justification, 'center');
  assert.strictEqual(layers[1].type, 'shape');
  assert.strictEqual(layers[1].shapes[0].fill.color, '#ff0000');
  assert.deepStrictEqual(warnings, []);
});

test('inline data assets are written to local files', async () => {
  const png1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const { spec } = await normalizeSpec({ assets: [{ id: 'dot', data: png1x1 }], compositions: [{ layers: [{ type: 'image', asset: 'dot' }, { type: 'footage', data: png1x1, name: 'inline' }] }] });
  assert.strictEqual(spec.assets.length, 2);
  for (const a of spec.assets) { assert.ok(fs.existsSync(a.path), a.path); assert.ok(a.path.endsWith('.png')); }
  assert.ok(spec.compositions[0].layers[1].asset.startsWith('__asset'));
});

test('validation lists every structural problem', async () => {
  await assert.rejects(() => normalizeSpec({ compositions: [{ id: 'a', width: 2, fps: 'x', layers: [{ type: 'precomp' }, 5] }, { id: 'a', layers: 'nope' }] }), (e) => {
    assert.ok(e instanceof SpecError);
    const s = e.problems.join('\n');
    assert.match(s, /width must be ≥ 4/);
    assert.match(s, /fps must be a number/);
    assert.match(s, /duplicate composition id "a"/);
    assert.match(s, /layers must be an array/);
    assert.match(s, /precomp layer needs "comp"/);
    assert.match(s, /layers\[1\] must be an object/);
    return true;
  });
  await assert.rejects(() => normalizeSpec('[1,2]'), SpecError);
  await assert.rejects(() => normalizeSpec({ layers: 'x' }), SpecError);
});

test('svgLayerSpecs builds an import-ready layer list', () => {
  const r = svgLayerSpecs('<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="5"/></svg>', { name: 'Dot', width: 100, position: [100, 100] });
  assert.strictEqual(r.layers.length, 1);
  assert.strictEqual(r.width, 100);
  assert.deepStrictEqual(r.layers[0].transform.position, [100, 100]);
});

test('mixed gradient layers are split so each gradient gets its own layer', async () => {
  const { splitGradientLayers } = require('../../lib/motion');
  const grad = { colors: ['#f00', '#00f'] };
  const layer = { type: 'shape', id: 'badge', name: 'Badge', transform: { position: [1, 2] }, shapes: [
    { type: 'path', name: 'Curve', d: 'x', stroke: '#fff' },
    { type: 'rect', name: 'Plate', gradient: grad, stroke: { color: '#000', width: 2 } },
    { type: 'group', name: 'G', items: [{ type: 'ellipse', fill: '#0f0' }, { type: 'ellipse', gradient: { colors: ['#111', '#222'] } }] },
  ] };
  const out = splitGradientLayers(layer, () => 'x');
  assert.deepStrictEqual(out.map((l) => l.id), ['badge', 'badge__part2', 'badge__part3', 'badge__part4']);
  // run 1: plain curve + plate stroke (stroke draws above the plate gradient); G's plain ellipse sits
  // below the plate gradient in z-order, so it gets its own run
  assert.deepStrictEqual(out[0].shapes.map((s) => s.name), ['Curve', 'Plate']);
  assert.deepStrictEqual(out[2].shapes.map((s) => s.name), ['G']);
  assert.ok(out[2].shapes[0].items[0].fill && !out[2].shapes[0].items[0].gradient);
  assert.ok(out[0].shapes[1].stroke && !out[0].shapes[1].gradient);
  assert.ok(out[1].shapes[0].gradient && !out[1].shapes[0].stroke);
  assert.strictEqual(out[3].shapes[0].items.length, 1);
  // parts follow the main layer through parenting (identity transform, opacity copied)
  assert.strictEqual(out[3].parent, 'badge');
  assert.deepStrictEqual(out[3].transform, { anchorPoint: [0, 0], position: [0, 0] });
  assert.strictEqual(out[0].parent, undefined);
  assert.deepStrictEqual(out[0].transform, { position: [1, 2] });
  const op = splitGradientLayers({ type: 'shape', name: 'O', transform: { position: [5, 5], opacity: 50 }, expressions: { 'Transform/Rotation': 'time', opacity: 'value' }, shapes: [{ type: 'rect', fill: '#fff' }, { type: 'rect', gradient: grad }] });
  assert.deepStrictEqual(op[1].transform, { anchorPoint: [0, 0], position: [0, 0], opacity: 50 });
  assert.deepStrictEqual(op[1].expressions, { opacity: 'value' });
  // a layer with a single gradient and nothing else is untouched
  assert.strictEqual(splitGradientLayers({ type: 'shape', shapes: [{ type: 'rect', gradient: grad }] }).length, 1);
});
