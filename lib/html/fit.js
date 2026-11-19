'use strict';
/*
 * Turns per-frame samples into a small set of eased keyframes.
 *   fitTrack(times, values, { tol })  →  { value } (static)  |  { keyframes: [{ t, v, ease }] }
 * Values are numbers or equal-length number arrays. Each moving segment (between holds and
 * direction changes) is matched against standard eases and, failing that, a fitted cubic-bezier;
 * motion that matches no curve falls back to Ramer–Douglas–Peucker simplified linear keys.
 */

const NAMED = {
  easeInSine: [0.12, 0, 0.39, 0], easeOutSine: [0.61, 1, 0.88, 1], easeInOutSine: [0.37, 0, 0.63, 1],
  easeInQuad: [0.11, 0, 0.5, 0], easeOutQuad: [0.5, 1, 0.89, 1], easeInOutQuad: [0.45, 0, 0.55, 1],
  easeInCubic: [0.32, 0, 0.67, 0], easeOutCubic: [0.33, 1, 0.68, 1], easeInOutCubic: [0.65, 0, 0.35, 1],
  easeInQuart: [0.5, 0, 0.75, 0], easeOutQuart: [0.25, 1, 0.5, 1], easeInOutQuart: [0.76, 0, 0.24, 1],
  easeInQuint: [0.64, 0, 0.78, 0], easeOutQuint: [0.22, 1, 0.36, 1], easeInOutQuint: [0.83, 0, 0.17, 1],
  easeInExpo: [0.7, 0, 0.84, 0], easeOutExpo: [0.16, 1, 0.3, 1], easeInOutExpo: [0.87, 0, 0.13, 1],
  easeInCirc: [0.55, 0, 1, 0.45], easeOutCirc: [0, 0.55, 0.45, 1], easeInOutCirc: [0.85, 0, 0.15, 1],
  easeInBack: [0.36, 0, 0.66, -0.56], easeOutBack: [0.34, 1.56, 0.64, 1], easeInOutBack: [0.68, -0.6, 0.32, 1.6],
  ease: [0.25, 0.1, 0.25, 1], easeIn: [0.42, 0, 1, 1], easeOut: [0, 0, 0.58, 1], easeInOut: [0.42, 0, 0.58, 1], easyEase: [0.333, 0, 0.667, 1],
};

/** cubic-bezier(x1,y1,x2,y2) evaluated at progress x ∈ [0,1] */
function bezier(p, x) {
  const [x1, y1, x2, y2] = p;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bx = (t) => 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t;
  const by = (t) => 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t;
  let lo = 0, hi = 1, t = x;
  for (let i = 0; i < 40; i++) { t = (lo + hi) / 2; if (bx(t) < x) lo = t; else hi = t; }
  return by(t);
}

const isArr = Array.isArray;
const dims = (v) => (isArr(v) ? v.length : 1);
const at = (v, d) => (isArr(v) ? v[d] : v);
function sameValue(a, b, tol) { for (let d = 0; d < dims(a); d++) if (Math.abs(at(a, d) - at(b, d)) > tol) return false; return true; }

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
function segmentError(times, values, i0, i1, ease, span) {
  const t0 = span ? span[0] : times[i0], t1 = span ? span[1] : times[i1], v0 = values[i0], v1 = values[i1];
  let err = 0;
  for (let i = i0 + 1; i < i1; i++) {
    const p = clamp01((times[i] - t0) / (t1 - t0));
    const e = typeof ease === 'string' ? (ease === 'linear' ? p : bezier(NAMED[ease], p)) : bezier(ease, p);
    for (let d = 0; d < dims(v0); d++) {
      const model = at(v0, d) + e * (at(v1, d) - at(v0, d));
      err = Math.max(err, Math.abs(model - at(values[i], d)));
    }
  }
  return err;
}

function rmsError(times, values, i0, i1, p, span) {
  const t0 = span ? span[0] : times[i0], t1 = span ? span[1] : times[i1], v0 = values[i0], v1 = values[i1];
  let sum = 0, n = 0;
  for (let i = i0 + 1; i < i1; i++) {
    const e = bezier(p, clamp01((times[i] - t0) / (t1 - t0)));
    for (let d = 0; d < dims(v0); d++) { const m = at(v0, d) + e * (at(v1, d) - at(v0, d)) - at(values[i], d); sum += m * m; n++; }
  }
  return n ? Math.sqrt(sum / n) : 0;
}

function refineBezier(times, values, i0, i1, start, span) {
  let p = start.slice(), err = rmsError(times, values, i0, i1, p, span);
  for (const step of [0.2, 0.1, 0.05, 0.02, 0.01, 0.005, 0.002]) {
    let improved = true;
    for (let iter = 0; improved && iter < 60; iter++) {
      improved = false;
      for (let k = 0; k < 4; k++) {
        for (const dir of [-1, 1]) {
          const q = p.slice();
          q[k] += dir * step;
          q[k] = k % 2 === 0 ? Math.min(1, Math.max(0, q[k])) : Math.min(2.5, Math.max(-1.5, q[k]));
          const e = rmsError(times, values, i0, i1, q, span);
          if (e < err - 1e-12) { p = q; err = e; improved = true; }
        }
      }
    }
  }
  return p;
}

function bestEase(times, values, i0, i1, tol, span) {
  let best = { ease: 'linear', err: segmentError(times, values, i0, i1, 'linear', span) };
  if (best.err <= tol * 0.25) return best;
  const ranked = [];
  for (const name of Object.keys(NAMED)) {
    const err = segmentError(times, values, i0, i1, name, span);
    ranked.push({ name, err });
    if (err < best.err) best = { ease: name, err };
  }
  if (best.err > tol && i1 - i0 >= 4) {
    // fit a free cubic-bezier: multi-start coordinate descent on RMS error, judged by max error
    ranked.sort((x, y) => x.err - y.err);
    const starts = ranked.slice(0, 3).map((r) => NAMED[r.name]).concat([[0.25, 0.75, 0.25, 1], [0.5, 0, 0.5, 1], [0.2, 1.2, 0.3, 1]]);
    for (const st of starts) {
      const p = refineBezier(times, values, i0, i1, st, span).map((x) => Math.round(x * 1000) / 1000);
      const err = segmentError(times, values, i0, i1, p, span);
      if (err < best.err) best = { ease: p, err };
      if (best.err <= tol * 0.5) break;
    }
  }
  return best;
}

/**
 * Moves rarely start exactly on a frame (CSS delays, timers). Search the start/end times inside the
 * first/last frame interval (continuous coordinate descent) for the span where one ease fits best.
 */
function optimiseSpan(times, values, i0, i1, ease, shiftStart, shiftEnd) {
  const lo0 = times[i0], hi0 = shiftStart ? times[i0 + 1] : times[i0];
  const lo1 = shiftEnd ? times[i1 - 1] : times[i1], hi1 = times[i1];
  let span = [lo0, hi1], err = rmsError(times, values, i0, i1, typeof ease === 'string' ? NAMED[ease] : ease, span);
  const P = typeof ease === 'string' ? NAMED[ease] : ease;
  let step = Math.max(hi0 - lo0, hi1 - lo1) / 2;
  for (let it = 0; it < 14 && step > 1e-6; it++) {
    let improved = false;
    for (const k of [0, 1]) {
      if ((k === 0 && !shiftStart) || (k === 1 && !shiftEnd)) continue;
      for (const dir of [-1, 1]) {
        const c = span.slice();
        c[k] += dir * step;
        if (k === 0) c[0] = Math.min(hi0, Math.max(lo0, c[0])); else c[1] = Math.min(hi1, Math.max(lo1, c[1]));
        const e = rmsError(times, values, i0, i1, P, c);
        if (e < err - 1e-12) { span = c; err = e; improved = true; }
      }
    }
    if (!improved) step /= 2;
  }
  return span;
}

function bestEaseShifted(times, values, i0, i1, tol, shiftStart, shiftEnd) {
  const base = bestEase(times, values, i0, i1, tol);
  if (base.err <= tol * 0.25 || (!shiftStart && !shiftEnd) || i1 - i0 < 3) return base;
  const ranked = Object.keys(NAMED).map((name) => ({ name, err: segmentError(times, values, i0, i1, name) })).sort((x, y) => x.err - y.err).slice(0, 6);
  let best = null;
  for (const r of ranked) {
    const span = optimiseSpan(times, values, i0, i1, r.name, shiftStart, shiftEnd);
    const err = segmentError(times, values, i0, i1, r.name, span);
    if (!best || err < best.err) best = { ease: r.name, err, span };
  }
  if (best.err > tol) {
    // free cubic-bezier on the best span
    const refined = bestEase(times, values, i0, i1, tol, best.span);
    if (refined.err < best.err) best = Object.assign(refined, { span: best.span });
  }
  return best.err < base.err ? best : base;
}

const HOLD_EPS = 1e-6;

/** Cut points at the edges of holds (runs of identical values). */
function holdCuts(values) {
  const n = values.length, cuts = new Set([0, n - 1]);
  for (let i = 1; i < n; i++) {
    const still = sameValue(values[i], values[i - 1], HOLD_EPS);
    const prevStill = i > 1 ? sameValue(values[i - 1], values[i - 2], HOLD_EPS) : !still;
    if (still !== prevStill) cuts.add(i - 1);
  }
  return Array.from(cuts).sort((x, y) => x - y);
}

/** Cut points where any dimension reverses direction inside [i0, i1]. */
function reversalCuts(values, i0, i1, tol) {
  const cuts = new Set([i0, i1]);
  for (let d = 0; d < dims(values[i0]); d++) {
    let lastSign = 0;
    for (let i = i0 + 1; i <= i1; i++) {
      const dv = at(values[i], d) - at(values[i - 1], d);
      if (Math.abs(dv) <= tol * 0.02) continue;
      const sg = Math.sign(dv);
      if (lastSign && sg !== lastSign) cuts.add(i - 1);
      lastSign = sg;
    }
  }
  return Array.from(cuts).sort((x, y) => x - y);
}

function rdp(times, values, i0, i1, tol, out) {
  // linear-interpolation Ramer–Douglas–Peucker on time series
  let maxErr = -1, idx = -1;
  const t0 = times[i0], t1 = times[i1];
  for (let i = i0 + 1; i < i1; i++) {
    const p = (times[i] - t0) / (t1 - t0);
    let e = 0;
    for (let d = 0; d < dims(values[i0]); d++) e = Math.max(e, Math.abs(at(values[i0], d) + p * (at(values[i1], d) - at(values[i0], d)) - at(values[i], d)));
    if (e > maxErr) { maxErr = e; idx = i; }
  }
  if (maxErr > tol && idx > 0) { rdp(times, values, i0, idx, tol, out); out.push(idx); rdp(times, values, idx, i1, tol, out); }
}

function round(v, digits) {
  const f = Math.pow(10, digits);
  return isArr(v) ? v.map((x) => Math.round(x * f) / f) : Math.round(v * f) / f;
}

/**
 * @param {number[]} times   seconds, ascending
 * @param {(number|number[])[]} values
 * @param {{tol?: number, digits?: number, jump?: number}} o  tol: max allowed error; jump: change treated as a cut (hold)
 */
function fitTrack(times, values, o = {}) {
  const tol = o.tol !== undefined ? o.tol : 0.5, digits = o.digits !== undefined ? o.digits : 3;
  const n = values.length;
  if (!n) return null;
  let allSame = true;
  for (let i = 1; i < n; i++) if (!sameValue(values[i], values[0], tol * 0.5)) { allSame = false; break; }
  if (allSame) return { value: round(values[0], digits) };

  const cuts = holdCuts(values);
  const keys = [];
  const endTime = new Map();
  const pushKey = (i, ease, t) => {
    const last = keys[keys.length - 1];
    if (last && last.i === i) { if (ease) last.ease = ease; if (t !== undefined) last.t = t; return; }
    keys.push({ i, ease, t });
  };
  const isHoldBefore = (i) => i === 0 || sameValue(values[i], values[i - 1], HOLD_EPS);
  const isHoldAfter = (i) => i === n - 1 || sameValue(values[i], values[i + 1], HOLD_EPS);
  const fitMove = (i0, i1, allowSplit) => {
    if (i1 - i0 === 1) {
      // a one-frame jump that is large compared with the tolerance is a cut, not a move
      const big = !sameValue(values[i0], values[i1], o.jump !== undefined ? o.jump : tol * 40);
      pushKey(i0, big ? 'hold' : 'linear');
      return;
    }
    const best = allowSplit ? bestEaseShifted(times, values, i0, i1, tol, isHoldBefore(i0), isHoldAfter(i1)) : bestEase(times, values, i0, i1, tol);
    if (best.err <= tol) {
      if (best.span) {
        const q = (t) => Math.round(t * 10000) / 10000;
        pushKey(i0, best.ease, q(best.span[0]));
        endTime.set(i1, q(best.span[1]));
      } else pushKey(i0, best.ease);
      return;
    }
    if (allowSplit) {
      const rc = reversalCuts(values, i0, i1, tol);
      if (rc.length > 2) { for (let k = 0; k < rc.length - 1; k++) fitMove(rc[k], rc[k + 1], false); return; }
    }
    const mids = [];
    rdp(times, values, i0, i1, tol, mids);
    pushKey(i0, 'linear');
    for (const m of mids) pushKey(m, 'linear');
  };
  for (let s = 0; s < cuts.length - 1; s++) {
    const i0 = cuts[s], i1 = cuts[s + 1];
    if (sameValue(values[i0], values[i1], HOLD_EPS) && segmentError(times, values, i0, i1, 'linear') <= tol) { pushKey(i0, 'linear'); continue; }
    fitMove(i0, i1, true);
  }
  pushKey(n - 1, null);
  return {
    keyframes: keys.map((k) => {
      const tt = k.t !== undefined ? k.t : (endTime.has(k.i) ? endTime.get(k.i) : times[k.i]);
      const kf = { t: Math.round(tt * 10000) / 10000, v: round(values[k.i], digits) };
      if (k.ease && k.ease !== 'linear') kf.ease = k.ease;
      return kf;
    }),
  };
}

module.exports = { fitTrack, bezier, NAMED };
