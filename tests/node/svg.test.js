'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parsePathData, svgToShapes, parseCssColor, parseTransform } = require('../../lib/svg');

const near = (a, b, eps = 1e-3) => {
  if (Array.isArray(a)) { assert.strictEqual(a.length, b.length, 'length'); a.forEach((x, i) => near(x, b[i], eps)); return; }
  assert.ok(Math.abs(a - b) <= eps, `expected ${b}, got ${a}`);
};

test('straight closed path', () => {
  const [p] = parsePathData('M0 0 L100 0 L100 100 Z');
  assert.deepStrictEqual(p.vertices, [[0, 0], [100, 0], [100, 100]]);
  assert.strictEqual(p.closed, true);
  p.inTangents.concat(p.outTangents).forEach((t) => near(t, [0, 0]));
});

test('explicit return to start is merged, not duplicated', () => {
  const [p] = parsePathData('M0 0 L100 0 L100 100 L0 0 Z');
  assert.strictEqual(p.vertices.length, 3);
});

test('cubic tangents are relative to their vertex', () => {
  const [p] = parsePathData('M 10 10 C 20 0 40 0 50 10');
  assert.strictEqual(p.closed, false);
  near(p.vertices, [[10, 10], [50, 10]]);
  near(p.outTangents[0], [10, -10]);
  near(p.inTangents[1], [-10, -10]);
});

test('relative, H/V, S, Q, T commands', () => {
  const [a] = parsePathData('m10 10 h50 v20 h-50 z');
  near(a.vertices, [[10, 10], [60, 10], [60, 30], [10, 30]]);
  const [s] = parsePathData('M0 0 C 0 10 10 10 10 0 S 20 -10 20 0');
  near(s.outTangents[1], [0, -10]); // reflected control point
  const [q] = parsePathData('M0 0 Q 50 50 100 0 T 200 0');
  near(q.vertices, [[0, 0], [100, 0], [200, 0]]);
  near(q.outTangents[0], [100 / 3, 100 / 3]);
  near(q.outTangents[1], [100 / 3, -100 / 3]); // T reflects the quadratic control point
});

test('packed numbers and exponents', () => {
  const [p] = parsePathData('M.5.5L1e2-1.5e1');
  near(p.vertices, [[0.5, 0.5], [100, -15]]);
});

test('arc flags may be packed', () => {
  const a = parsePathData('M0 0 a50 50 0 0150 0');
  const b = parsePathData('M0 0 a50 50 0 0 1 50 0');
  assert.deepStrictEqual(a, b);
  near(a[0].vertices[a[0].vertices.length - 1], [50, 0]);
});

test('full circle from two arcs', () => {
  const [p] = parsePathData('M 0 50 A 50 50 0 1 1 100 50 A 50 50 0 1 1 0 50 Z');
  assert.strictEqual(p.closed, true);
  for (const v of p.vertices) near(Math.hypot(v[0] - 50, v[1] - 50), 50, 1e-2);
});

test('multiple subpaths', () => {
  const ps = parsePathData('M0 0 L10 0 L10 10 Z M20 20 L30 20 L30 30 Z');
  assert.strictEqual(ps.length, 2);
  near(ps[1].vertices[0], [20, 20]);
});

test('bad path data throws a readable error', () => {
  assert.throws(() => parsePathData('L 10'), /must start with a command|expected a number/);
});

test('colours', () => {
  assert.deepStrictEqual(parseCssColor('#f00'), { hex: '#ff0000', alpha: 1 });
  assert.deepStrictEqual(parseCssColor('rgba(0, 128, 255, 0.5)'), { hex: '#0080ff', alpha: 0.5 });
  assert.strictEqual(parseCssColor('hsl(120, 100%, 50%)').hex, '#00ff00');
  assert.strictEqual(parseCssColor('tomato').hex, '#ff6347');
  assert.deepStrictEqual(parseCssColor('none'), { none: true });
});

test('transforms compose left to right', () => {
  const m = parseTransform('translate(10 20) scale(2)');
  near(m, [2, 0, 0, 2, 10, 20]);
  const r = parseTransform('rotate(90 50 50)');
  near([r[0], r[1], r[2], r[3]], [0, 1, -1, 0]);
  near([r[4], r[5]], [100, 0]);
});

test('svgToShapes: primitives, groups, paint, centre origin', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" width="400" height="200">
    <style>.accent { fill: #22d3ee }</style>
    <rect id="bg" x="0" y="0" width="200" height="100" rx="10" fill="#111"/>
    <g id="icons" transform="translate(100 50)" opacity="0.5">
      <circle class="accent" r="20"/>
      <line x1="-30" y1="0" x2="30" y2="0" stroke="red" stroke-width="2" stroke-linecap="round"/>
    </g>
    <path d="M0 0 L10 10" fill="none" stroke="none"/>
    <text x="100" y="90" font-size="12" font-family="Inter, sans-serif" text-anchor="middle" fill="#fff">Hello</text>
  </svg>`;
  const r = svgToShapes(svg);
  assert.strictEqual(r.width, 400); assert.strictEqual(r.height, 200);
  // later SVG siblings come first (on top) in AE
  assert.strictEqual(r.items[0].name, 'icons');
  assert.strictEqual(r.items[1].name, 'bg');
  const bg = r.items[1];
  assert.strictEqual(bg.fill.color, '#111111');
  near(bg.paths[0].vertices[0], [-200 + 20, -100]); // scaled x2, rx 10 → 20, centred
  const icons = r.items[0];
  assert.strictEqual(icons.transform.opacity, 50);
  const circle = icons.items[1], line = icons.items[0];
  assert.strictEqual(circle.fill.color, '#22d3ee');
  near(circle.paths[0].vertices[0], [40, 0]); // centre of viewBox maps to origin, r 20 → 40; path starts at 3 o'clock like SVG
  assert.strictEqual(line.stroke.color, '#ff0000');
  assert.strictEqual(line.stroke.width, 4);
  assert.strictEqual(line.stroke.lineCap, 'round');
  assert.ok(!line.fill);
  assert.strictEqual(r.texts.length, 1);
  assert.strictEqual(r.texts[0].content, 'Hello');
  assert.strictEqual(r.texts[0].fontFamily, 'Inter');
  near(r.texts[0].position, [0, 80]);
  near(r.texts[0].fontSize, 24);
  assert.strictEqual(r.texts[0].anchor, 'center');
});

test('svgToShapes: linear gradient in bounding-box units', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
    <defs><linearGradient id="g"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient></defs>
    <rect x="0" y="0" width="100" height="50" fill="url(#g)"/></svg>`;
  const r = svgToShapes(svg, { origin: 'topLeft' });
  const g = r.items[0].gradient;
  assert.deepStrictEqual(g.colors, ['#ff0000', '#0000ff']);
  near(g.start, [0, 0]); near(g.end, [100, 0]);
  assert.strictEqual(g.gradientType, 'linear');
});

test('svgToShapes: use/symbol, evenodd, dash arrays, warnings', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
    <defs><symbol id="s"><rect width="10" height="10" fill="lime"/></symbol></defs>
    <use href="#s" x="50" y="50"/>
    <path d="M0 0H10V10H0Z M2 2H8V8H2Z" fill-rule="evenodd" stroke="#000" stroke-dasharray="4 2"/>
    <rect width="10" height="10" filter="url(#f)"/>
    <foo/>
  </svg>`;
  const r = svgToShapes(svg, { origin: 'topLeft' });
  const used = r.items.find((i) => i.name === 's');
  near(used.items[0].paths[0].vertices[0], [50, 50]);
  const holes = r.items.find((i) => i.name === 'Path');
  assert.strictEqual(holes.paths.length, 2);
  assert.strictEqual(holes.fill.rule, 'evenodd');
  assert.deepStrictEqual(holes.stroke.dashes, [4, 2]);
  assert.ok(r.warnings.some((w) => /filters/.test(w)));
  assert.ok(r.warnings.some((w) => /<foo>/.test(w)));
});
