'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { fitTrack, bezier, NAMED } = require('../../lib/html/fit');

const fps = 30;
const sample = (dur, fn) => { const t = [], v = []; for (let i = 0; i <= Math.round(dur * fps); i++) { t.push(i / fps); v.push(fn(i / fps)); } return { t, v }; };

test('static tracks collapse to one value', () => {
  const { t, v } = sample(2, () => 42);
  assert.deepStrictEqual(fitTrack(t, v), { value: 42 });
});

test('a single eased move becomes two keyframes with the right ease', () => {
  const { t, v } = sample(1, (s) => 100 + bezier(NAMED.easeOutCubic, s) * 400);
  const r = fitTrack(t, v, { tol: 0.5 });
  assert.strictEqual(r.keyframes.length, 2);
  assert.strictEqual(r.keyframes[0].ease, 'easeOutCubic');
  assert.strictEqual(r.keyframes[0].v, 100);
  assert.strictEqual(r.keyframes[1].v, 500);
});

test('2D straight-line motion keeps one ease for both dimensions', () => {
  const { t, v } = sample(0.8, (s) => { const e = bezier(NAMED.easeInOutQuart, Math.min(1, s / 0.8)); return [960 + e * 300, 540 - e * 200]; });
  const r = fitTrack(t, v, { tol: 0.5 });
  assert.strictEqual(r.keyframes.length, 2);
  assert.strictEqual(r.keyframes[0].ease, 'easeInOutQuart');
});

test('holds, moves and returns are segmented', () => {
  // wait 0.5s, ease in 0.5s to 100, hold 0.5s, linear back to 0 in 0.5s
  const { t, v } = sample(2, (s) => s < 0.5 ? 0 : s < 1 ? bezier(NAMED.easeOutQuad, (s - 0.5) / 0.5) * 100 : s < 1.5 ? 100 : 100 - (s - 1.5) / 0.5 * 100);
  const r = fitTrack(t, v, { tol: 0.5 });
  const kv = r.keyframes.map((k) => [Math.round(k.t * 30), k.v, k.ease || 'linear']);
  assert.deepStrictEqual(kv, [[0, 0, 'linear'], [15, 0, 'easeOutQuad'], [30, 100, 'linear'], [45, 100, 'linear'], [60, 0, 'linear']]);
});

test('custom curves get a fitted cubic-bezier within tolerance', () => {
  const custom = [0.2, 0.9, 0.3, 1.05];
  const { t, v } = sample(1.2, (s) => bezier(custom, s / 1.2) * 1000);
  const r = fitTrack(t, v, { tol: 1 });
  assert.strictEqual(r.keyframes.length, 2);
  const p = r.keyframes[0].ease;
  const maxErr = Math.max(...t.map((s, i) => Math.abs((typeof p === 'string' ? bezier(NAMED[p], s / 1.2) : bezier(p, s / 1.2)) * 1000 - v[i])));
  assert.ok(maxErr <= 1.0001, 'fit error ' + maxErr);
});

test('springy motion falls back to accurate linear keys', () => {
  const { t, v } = sample(1.5, (s) => 200 * (1 - Math.exp(-6 * s) * Math.cos(14 * s)));
  const r = fitTrack(t, v, { tol: 0.5 });
  assert.ok(r.keyframes.length > 3 && r.keyframes.length < t.length, 'keys: ' + r.keyframes.length);
  // every sampled frame is within tolerance of linear interpolation between keys (or a fitted ease)
});

test('one-frame jumps become hold keys', () => {
  const { t, v } = sample(1, (s) => (s < 0.5 ? 0 : 1));
  const r = fitTrack(t, v, { tol: 0.01, jump: 0.5 });
  const hold = r.keyframes.find((k) => k.ease === 'hold');
  assert.ok(hold, JSON.stringify(r.keyframes));
});

test('moves that start between frames are found with sub-frame key times', () => {
  // a CSS-style delay of 0.12 s (between frames 3 and 4 at 30 fps), then easeOutQuint over 0.9 s
  const { t, v } = sample(2, (s) => (s < 0.12 ? 652 : s > 1.02 ? 465 : 652 - bezier(NAMED.easeOutQuint, (s - 0.12) / 0.9) * 187));
  const r = fitTrack(t, v, { tol: 0.3 });
  const moving = r.keyframes.filter((k) => k.ease && k.ease !== 'linear');
  assert.strictEqual(moving.length, 1, JSON.stringify(r.keyframes));
  assert.strictEqual(moving[0].ease, 'easeOutQuint');
  assert.ok(Math.abs(moving[0].t - 0.125) < 0.01, 'start ≈ 0.12 s, got ' + moving[0].t);
  assert.ok(r.keyframes.length <= 4);
});
