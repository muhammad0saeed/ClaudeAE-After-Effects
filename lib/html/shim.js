'use strict';
/*
 * Virtual-time shim injected into the page before any of its scripts run.
 * Freezes the real clock and lets the converter step time frame by frame:
 *   window.__cae.advance(ms)  → runs due timers, requestAnimationFrame callbacks, and seeks
 *                               CSS / Web Animations, SVG SMIL and <video> to the new time.
 * Math.random is seeded so every run produces identical frames.
 */
const SHIM = String.raw`(() => {
  if (window.__cae) return;
  let now = 0;
  const EPOCH = 1735689600000; // fixed wall clock: 2025-01-01T00:00:00Z
  const RealDate = Date;
  function VDate(...args) {
    if (!(this instanceof VDate)) return new RealDate(EPOCH + now).toString();
    return args.length ? new RealDate(...args) : new RealDate(EPOCH + now);
  }
  VDate.prototype = RealDate.prototype;
  VDate.now = () => EPOCH + now;
  VDate.parse = RealDate.parse;
  VDate.UTC = RealDate.UTC;
  window.Date = VDate;
  const perfNow = () => now;
  try { Object.defineProperty(performance, 'now', { value: perfNow, configurable: true }); } catch (e) { performance.now = perfNow; }

  let seed = 0x2f6b9c1d;
  Math.random = function () { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

  const raf = new Map(); let rafId = 0;
  window.requestAnimationFrame = (cb) => { const id = ++rafId; raf.set(id, cb); return id; };
  window.cancelAnimationFrame = (id) => { raf.delete(id); };
  const timers = new Map(); let timerId = 0;
  const schedule = (fn, delay, args, repeat) => { const id = ++timerId; const d = Math.max(0, Number(delay) || 0); timers.set(id, { fn, at: now + d, args, repeat: repeat ? Math.max(1, d) : 0 }); return id; };
  window.setTimeout = (fn, d, ...a) => schedule(fn, d, a, false);
  window.setInterval = (fn, d, ...a) => schedule(fn, d, a, true);
  window.clearTimeout = window.clearInterval = (id) => { timers.delete(id); };
  window.requestIdleCallback = (fn) => schedule(() => fn({ didTimeout: false, timeRemaining: () => 50 }), 1, [], false);
  window.cancelIdleCallback = (id) => timers.delete(id);

  const animStart = new WeakMap();
  const errors = [];
  const run = (fn, args) => { try { typeof fn === 'function' ? fn(...(args || [])) : (0, eval)(String(fn)); } catch (e) { if (errors.length < 20) errors.push(String(e && e.stack || e)); } };

  function seekAnimations() {
    let list = [];
    try { list = document.getAnimations(); } catch (e) { }
    for (const a of list) {
      try {
        if (!animStart.has(a)) { animStart.set(a, now); a.pause(); }
        a.currentTime = Math.max(0, now - animStart.get(a));
      } catch (e) { }
    }
    for (const svg of document.querySelectorAll('svg')) {
      try { if (svg.animationsPaused && !svg.animationsPaused()) svg.pauseAnimations(); svg.setCurrentTime(now / 1000); } catch (e) { }
    }
    for (const v of document.querySelectorAll('video')) {
      try {
        if (!v.__caeStart && v.__caeStart !== 0) { v.__caeStart = now; v.pause(); }
        const t = (now - v.__caeStart) / 1000;
        if (Math.abs(v.currentTime - t) > 0.001) v.currentTime = Math.min(t, v.duration || t);
      } catch (e) { }
    }
  }

  window.__cae = {
    get now() { return now; },
    errors,
    advance(target) {
      target = Math.max(now, Number(target) || 0);
      for (let guard = 0; guard < 100000; guard++) {
        let next = null;
        for (const [id, t] of timers) if (t.at <= target && (!next || t.at < next[1].at || (t.at === next[1].at && id < next[0]))) next = [id, t];
        if (!next) break;
        const [id, t] = next;
        now = Math.max(now, t.at);
        if (t.repeat) t.at += t.repeat; else timers.delete(id);
        run(t.fn, t.args);
      }
      now = target;
      const cbs = Array.from(raf.values()); raf.clear();
      for (const cb of cbs) run(cb, [now]);
      seekAnimations();
      return now;
    },
    pending() { return { timers: timers.size, raf: raf.size }; },
  };
  document.addEventListener('DOMContentLoaded', () => seekAnimations());
})();`;

module.exports = { SHIM };
