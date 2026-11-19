'use strict';
/*
 * Audio analysis for editing to sound: beats / tempo / bars / energy sections for music, phrase and
 * pause timing for voice-over, the hit point of sound effects.
 *
 * Input is a loudness envelope sampled at `fps` values per second — from After Effects' "Convert Audio
 * to Keyframes" (any format AE can open) or decoded here from WAV/PCM files (exact, and works even when
 * the WAV header is damaged).
 */
const fs = require('fs');

/** RMS envelope of a PCM / float WAV file. Tolerates truncated files and wrong chunk sizes. */
function readWavEnvelope(file, fps = 50) {
  const b = fs.readFileSync(file);
  if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let o = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (o + 8 <= b.length) {
    const id = b.toString('ascii', o, o + 4), sz = b.readUInt32LE(o + 4);
    if (id === 'fmt ') {
      let tag = b.readUInt16LE(o + 8);
      const bits = b.readUInt16LE(o + 22);
      if (tag === 0xfffe && sz >= 40) tag = b.readUInt16LE(o + 32); // WAVE_FORMAT_EXTENSIBLE → sub-format
      fmt = { tag, ch: b.readUInt16LE(o + 10), sr: b.readUInt32LE(o + 12), bits };
    }
    if (id === 'data') { dataOff = o + 8; dataLen = Math.min(sz, b.length - dataOff); break; }
    o += 8 + sz + (sz & 1);
  }
  if (!fmt || dataOff < 0) throw new Error('WAV file has no fmt/data chunk');
  if (fmt.tag !== 1 && fmt.tag !== 3) throw new Error('compressed WAV (format ' + fmt.tag + ') is not supported here');
  const bps = fmt.bits / 8, frameBytes = bps * fmt.ch;
  const n = Math.floor(dataLen / frameBytes);
  const read = fmt.tag === 3
    ? (i) => (bps === 8 ? b.readDoubleLE(i) : b.readFloatLE(i))
    : bps === 1 ? (i) => (b[i] - 128) / 128
      : bps === 2 ? (i) => b.readInt16LE(i) / 32768
        : bps === 3 ? (i) => ((b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)) << 8 >> 8) / 8388608
          : (i) => b.readInt32LE(i) / 2147483648;
  const hop = fmt.sr / fps, frames = Math.floor(n / hop);
  const env = new Array(frames);
  for (let f = 0; f < frames; f++) {
    const s0 = Math.floor(f * hop), s1 = Math.min(n, Math.floor((f + 1) * hop));
    let sum = 0;
    for (let s = s0; s < s1; s++) {
      let v = 0;
      for (let c = 0; c < fmt.ch; c++) v += read(dataOff + s * frameBytes + c * bps);
      v /= fmt.ch;
      sum += v * v;
    }
    env[f] = Math.round(Math.sqrt(sum / Math.max(1, s1 - s0)) * 1000) / 10; // 0–100
  }
  return { fps, duration: n / fmt.sr, both: env, sampleRate: fmt.sr, channels: fmt.ch, declaredDuration: (b.readUInt32LE(dataOff - 4) / frameBytes) / fmt.sr };
}

const mean = (a, i0 = 0, i1 = a.length) => { let s = 0; for (let i = i0; i < i1; i++) s += a[i]; return i1 > i0 ? s / (i1 - i0) : 0; };
const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))] : 0; };
const r2 = (n) => Math.round(n * 100) / 100;
const r3 = (n) => Math.round(n * 1000) / 1000;

/** Onset strength: rise of the (log) loudness over the recent past. */
function onsetStrength(e, fps) {
  const k = Math.max(1, Math.round(fps * 0.05));
  const o = new Array(e.length).fill(0);
  for (let i = 1; i < e.length; i++) {
    let m = 0, n = 0;
    for (let j = Math.max(0, i - k); j < i; j++) { m += e[j]; n++; }
    o[i] = Math.max(0, e[i] - (n ? m / n : e[i]));
  }
  return o;
}

function pickPeaks(o, fps, { minGap = 0.1, k = 1.0, floor = 0.02 } = {}) {
  const w = Math.max(1, Math.round(fps * 0.05)), win = Math.round(fps * 0.5), gap = Math.round(fps * minGap);
  const max = Math.max(...o, 1e-9);
  const out = [];
  let last = -1e9;
  for (let i = 1; i < o.length - 1; i++) {
    const v = o[i];
    if (v < floor * max) continue;
    let isMax = true;
    for (let j = Math.max(0, i - w); j <= Math.min(o.length - 1, i + w); j++) if (o[j] > v || (o[j] === v && j < i)) { isMax = false; break; }
    if (!isMax) continue;
    const a = Math.max(0, i - win), b = Math.min(o.length, i + win + 1);
    const m = mean(o, a, b);
    let sd = 0; for (let j = a; j < b; j++) sd += (o[j] - m) ** 2;
    sd = Math.sqrt(sd / (b - a));
    if (v < m + k * sd) continue;
    if (i - last < gap) { if (out.length && v > out[out.length - 1].v) { out[out.length - 1] = { i, v }; last = i; } continue; }
    out.push({ i, v });
    last = i;
  }
  return out.map((p) => ({ i: p.i, t: p.i / fps, strength: p.v / max }));
}

/** Tempo from the autocorrelation of the onset curve (60–200 BPM, mild preference around 120). */
function tempo(o, fps) {
  const m = mean(o), x = o.map((v) => v - m);
  const minLag = Math.floor((fps * 60) / 200), maxLag = Math.ceil((fps * 60) / 60);
  let ac0 = 0; for (let i = 0; i < x.length; i++) ac0 += x[i] * x[i];
  if (ac0 <= 0 || x.length < maxLag * 2) return null;
  const ac = [];
  for (let L = minLag; L <= maxLag; L++) { let s = 0; for (let i = L; i < x.length; i++) s += x[i] * x[i - L]; ac[L] = s / ac0; }
  let best = -1, bestScore = -Infinity;
  for (let L = minLag; L <= maxLag; L++) {
    const bpm = (60 * fps) / L, w = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    // reinforce with the double period (a true beat also correlates at 2× its lag)
    const sc = (ac[L] + 0.5 * (ac[2 * L] !== undefined ? ac[2 * L] : 0)) * w;
    if (sc > bestScore) { bestScore = sc; best = L; }
  }
  let lag = best;
  if (ac[best - 1] !== undefined && ac[best + 1] !== undefined) {
    const a = ac[best - 1], b = ac[best], c = ac[best + 1], d = a - 2 * b + c;
    if (d < 0) lag = best + (0.5 * (a - c)) / d;
  }
  return { bpm: (60 * fps) / lag, period: lag, confidence: Math.max(0, Math.min(1, ac[best])) };
}

/** Dynamic-programming beat tracker (Ellis 2007): beats that sit on onsets and keep a steady period. */
function trackBeats(o, period, tightness = 100) {
  const n = o.length;
  const sd = Math.sqrt(mean(o.map((v) => v * v))) || 1;
  const on = o.map((v) => v / sd);
  const score = new Array(n).fill(0), back = new Array(n).fill(-1);
  const lo = Math.round(period / 2), hi = Math.round(period * 2);
  for (let i = 0; i < n; i++) {
    let best = 0, bj = -1;
    for (let j = i - hi; j <= i - lo; j++) {
      if (j < 0) continue;
      const pen = -tightness * Math.log((i - j) / period) ** 2;
      const s = score[j] + pen;
      if (bj < 0 || s > best) { best = s; bj = j; }
    }
    score[i] = on[i] + (bj >= 0 ? best : 0);
    back[i] = bj;
  }
  // best end within the last period
  let end = n - 1, bs = -Infinity;
  for (let i = Math.max(0, n - Math.round(period)); i < n; i++) if (score[i] > bs) { bs = score[i]; end = i; }
  const beats = [];
  for (let i = end; i >= 0; i = back[i]) { beats.unshift(i); if (back[i] < 0) break; }
  return beats;
}

/**
 * @param {{fps:number, both:number[], duration?:number}} env
 * @param {{kind?: 'auto'|'music'|'voiceover'|'sfx', start?: number}} opts  start = source time of env[0]
 */
function analyzeEnvelope(env, opts = {}) {
  const fps = env.fps, a = env.both || [];
  const start = opts.start || 0;
  const T = (i) => r3(start + i / fps);
  const duration = env.duration || a.length / fps;
  const max = Math.max(...a, 1e-9);
  const e = a.map((v) => Math.log1p((v / max) * 100) / Math.log(101)); // perceptual 0–1
  const out = { duration: r3(duration), fps, peakLevel: r2(max) };
  if (!a.length || max <= 1e-6) { out.kind = 'silence'; out.note = 'No sound was detected.'; return out; }

  const p10 = pct(e, 0.1), p90 = pct(e, 0.9);
  const th = p10 + 0.22 * (p90 - p10);
  const o = onsetStrength(e, fps);

  // sound / silence segments (words and pauses)
  const segs = [];
  let s0 = -1;
  for (let i = 0; i <= e.length; i++) {
    const on = i < e.length && e[i] >= th;
    if (on && s0 < 0) s0 = i;
    if (!on && s0 >= 0) { segs.push([s0, i]); s0 = -1; }
  }
  const merged = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && (s[0] - last[1]) / fps < 0.2) last[1] = s[1]; else merged.push(s.slice());
  }
  const sounds = merged.filter((s) => (s[1] - s[0]) / fps >= 0.08);
  // speech stops for half a second or more many times a minute; music (even staccato drums, whose
  // short gaps between hits stay under ~0.4 s) rarely does
  let pauses = 0;
  for (let k = 1; k < sounds.length; k++) if ((sounds[k][0] - sounds[k - 1][1]) / fps >= 0.5) pauses++;
  const soundSpan = sounds.length ? (sounds[sounds.length - 1][1] - sounds[0][0]) / fps : 0;
  const pausesPerMin = soundSpan > 0 ? (pauses / soundSpan) * 60 : 0;
  const tm = duration >= 6 ? tempo(o, fps) : null;
  let kind = opts.kind && opts.kind !== 'auto' ? opts.kind : null;
  if (!kind) kind = duration < 4 ? 'sfx' : (pauses >= 2 && pausesPerMin >= 4 ? 'voiceover' : 'music');
  out.kind = kind;

  // loudness overview: 4 values per second (0–100), capped at 600 values
  const step = Math.max(1, Math.round(fps / 4), Math.ceil(a.length / 600));
  out.loudness = { every: r3(step / fps), values: [] };
  for (let i = 0; i < e.length; i += step) out.loudness.values.push(Math.round(mean(e, i, Math.min(e.length, i + step)) * 100));

  if (kind === 'voiceover' || opts.phrases) {
    const phrases = [];
    for (const s of sounds) {
      const last = phrases[phrases.length - 1];
      if (last && (s[0] - last[1]) / fps < 0.45) last[1] = s[1]; else phrases.push(s.slice());
    }
    out.phrases = phrases.map(([i0, i1], k) => ({ n: k + 1, start: T(i0), end: T(i1), length: r2((i1 - i0) / fps) }));
    out.pauses = [];
    for (let k = 1; k < phrases.length; k++) out.pauses.push({ start: T(phrases[k - 1][1]), end: T(phrases[k][0]), length: r2((phrases[k][0] - phrases[k - 1][1]) / fps) });
    out.speechStart = sounds.length ? T(sounds[0][0]) : null;
    out.speechEnd = sounds.length ? T(sounds[sounds.length - 1][1]) : null;
  }

  const peaks = pickPeaks(o, fps, { minGap: kind === 'voiceover' ? 0.15 : 0.1 });
  if (kind === 'sfx') {
    let hit = 0; for (let i = 1; i < o.length; i++) if (o[i] > o[hit]) hit = i;
    let loud = 0; for (let i = 1; i < e.length; i++) if (e[i] > e[loud]) loud = i;
    out.hit = T(hit);
    out.loudest = T(loud);
    out.soundStart = sounds.length ? T(sounds[0][0]) : 0;
    out.soundEnd = sounds.length ? T(sounds[sounds.length - 1][1]) : r3(duration);
    out.onsets = peaks.slice(0, 20).map((p) => ({ t: T(p.i), strength: r2(p.strength) }));
    return out;
  }

  if (kind === 'music' && tm) {
    const beatIdx = trackBeats(o, tm.period);
    // drop beats before the music starts / after it ends
    const firstSound = sounds.length ? sounds[0][0] : 0, lastSound = sounds.length ? sounds[sounds.length - 1][1] : e.length;
    const beats = beatIdx.filter((i) => i >= firstSound - tm.period / 2 && i <= lastSound);
    out.bpm = r2(tm.bpm);
    out.tempoConfidence = r2(tm.confidence);
    out.beatInterval = r3(tm.period / fps);
    out.beats = beats.map(T);
    // bar phase: the beat offset (0–3) whose beats carry the most onset energy
    let bestK = 0, bestS = -1;
    for (let k = 0; k < 4; k++) { let s = 0, n = 0; for (let j = k; j < beats.length; j += 4) { s += o[beats[j]] + e[beats[j]] * 0.5; n++; } if (n && s / n > bestS) { bestS = s / n; bestK = k; } }
    out.downbeats = beats.filter((_, j) => j % 4 === bestK).map(T);
    // sections: bars whose loudness jumps or falls clearly against the previous two bars
    const bars = [];
    for (let j = bestK; j + 4 <= beats.length; j += 4) bars.push({ i0: beats[j], i1: beats[j + 4] !== undefined ? beats[j + 4] : Math.min(e.length, beats[j] + Math.round(4 * tm.period)) });
    bars.forEach((b) => { b.energy = mean(e, b.i0, b.i1); });
    out.sections = [];
    for (let j = 2; j < bars.length; j++) {
      const prev = (bars[j - 1].energy + bars[j - 2].energy) / 2, cur = bars[j].energy;
      if (cur > prev * 1.25 && cur - prev > 0.06) out.sections.push({ t: T(bars[j].i0), change: 'louder', amount: r2(cur / Math.max(prev, 1e-3)) });
      else if (cur < prev * 0.75 && prev - cur > 0.06) out.sections.push({ t: T(bars[j].i0), change: 'quieter', amount: r2(cur / Math.max(prev, 1e-3)) });
    }
  } else if (kind === 'music') {
    out.note = 'No steady beat was found; use "onsets" (accents) instead.';
  }
  out.onsets = peaks.filter((p) => p.strength >= 0.25).slice(0, 400).map((p) => ({ t: T(p.i), strength: r2(p.strength) }));
  out.musicStart = sounds.length ? T(sounds[0][0]) : 0;
  out.musicEnd = sounds.length ? T(sounds[sounds.length - 1][1]) : r3(duration);
  return out;
}

module.exports = { readWavEnvelope, analyzeEnvelope, onsetStrength, tempo, trackBeats, pickPeaks };
