'use strict';
/*
 * Per-frame page snapshots → Claude Motion spec (native, editable After Effects layers).
 *
 * Structure:
 *  - every painted element becomes a layer (boxes → shape layers, text → text layers, each inline <svg>
 *    → one shape layer with a group per element, images/video/canvas → footage, paint After Effects
 *    cannot rebuild → a picture captured from the page that keeps the element's movement);
 *  - scene-sized containers and clipping containers with nested clips (or many children) become
 *    pre-compositions, clipped by a matte layer drawn from their overflow box or clip-path;
 *  - smaller clipping containers become shared track mattes.
 * Pre-comps are stage-sized and start at 0, so every layer keeps stage coordinates and comp time.
 */
const path = require('path');
const fs = require('fs');
const { fileURLToPath } = require('url');
const { fitTrack } = require('./fit');
const { parsePathData, parseCssColor, rectPath, ellipsePath, polyPath } = require('../svg');

const PRECOMP_MIN_LAYERS = 8; // a clip container with this many matted layers gets its own comp

const r3 = (n) => Math.round(n * 1000) / 1000;

function color(c) {
  const p = parseCssColor(c);
  if (!p || p.none) return null;
  return { hex: p.hex, alpha: p.alpha === undefined ? 1 : p.alpha };
}
const rgb = (hex) => [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255];
const hex = (v) => '#' + v.map((x) => Math.max(0, Math.min(255, Math.round(x * 255))).toString(16).padStart(2, '0')).join('');

function unwrapAngles(a) {
  const out = a.slice();
  for (let i = 1; i < out.length; i++) {
    while (out[i] - out[i - 1] > 180) out[i] -= 360;
    while (out[i] - out[i - 1] < -180) out[i] += 360;
  }
  return out;
}

// 2D affine matrices as [a, b, c, d, e, f]
const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
function decompose(m) {
  const [a, b, c, d, e, f] = m;
  const sx = Math.hypot(a, b), det = a * d - b * c;
  return { cx: e, cy: f, rot: (Math.atan2(b, a) * 180) / Math.PI, sx, sy: sx ? det / sx : 0, skew: sx && det ? (Math.atan2(a * c + b * d, det) * 180) / Math.PI : 0 };
}
const isIdentity = (m) => Math.abs(m[0] - 1) < 1e-4 && Math.abs(m[1]) < 1e-4 && Math.abs(m[2]) < 1e-4 && Math.abs(m[3] - 1) < 1e-4 && Math.abs(m[4]) < 0.01 && Math.abs(m[5]) < 0.01;

const GENERIC = { 'sans-serif': 'Arial', serif: 'Times New Roman', monospace: 'Courier New', cursive: 'Comic Sans MS', fantasy: 'Impact', 'system-ui': 'Segoe UI', '-apple-system': 'Segoe UI', 'ui-sans-serif': 'Arial', 'ui-serif': 'Times New Roman', 'ui-monospace': 'Consolas', blinkmacsystemfont: 'Segoe UI' };
function fontFamily(list) {
  const fams = String(list || 'Arial').split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''));
  const first = fams[0] || 'Arial';
  return GENERIC[first.toLowerCase()] || first;
}
function fontStyleName(weight, italic) {
  const w = Number(weight) || (weight === 'bold' ? 700 : 400);
  const names = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' };
  const base = names[Math.min(900, Math.max(100, Math.round(w / 100) * 100))];
  if (!italic) return base;
  return base === 'Regular' ? 'Italic' : base + ' Italic';
}
const BLENDS = { multiply: 'multiply', screen: 'screen', overlay: 'overlay', darken: 'darken', lighten: 'lighten', 'color-dodge': 'colorDodge', 'color-burn': 'colorBurn', 'hard-light': 'hardLight', 'soft-light': 'softLight', difference: 'difference', exclusion: 'exclusion', hue: 'hue', saturation: 'saturation', color: 'color', luminosity: 'luminosity', 'plus-lighter': 'add', 'plus-darker': 'linearBurn' };

/** Corners (stage px) of what a sample paints, or null when unknown. */
function cornersOf(s) {
  if (s.kind === 'svg') {
    const bb = s.bbox;
    if (!bb || !s.rootCtm || !s.lm) return null;
    const pad = s.stroke && s.stroke !== 'none' ? (s.strokeWidth || 0) / 2 : 0;
    const M = mul(s.rootCtm, s.lm);
    const x0 = bb[0] - pad, y0 = bb[1] - pad, x1 = bb[0] + bb[2] + pad, y1 = bb[1] + bb[3] + pad;
    return [apply(M, x0, y0), apply(M, x1, y0), apply(M, x1, y1), apply(M, x0, y1)];
  }
  if (s.w === undefined || s.cx === undefined) return null;
  if (s.kind === 'text') { const hw = s.w / 2, hh = s.h / 2; return [[s.cx - hw, s.cy - hh], [s.cx + hw, s.cy - hh], [s.cx + hw, s.cy + hh], [s.cx - hw, s.cy + hh]]; }
  const sx = s.sx === undefined ? 1 : s.sx, sy = s.sy === undefined ? 1 : s.sy;
  const th = ((s.rot || 0) * Math.PI) / 180, co = Math.cos(th), si = Math.sin(th);
  const hw = (s.w / 2) * sx, hh = (s.h / 2) * sy;
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => [s.cx + x * co - y * si, s.cy + x * si + y * co]);
}

/** true when every point lies inside the clip shape (rect with rounded corners / ellipse). */
function insideClip(c, pts, tol = 0.75) {
  if (c.kind !== 'rect' && c.kind !== 'ellipse') return false;
  const th = (-(c.rot || 0) * Math.PI) / 180, co = Math.cos(th), si = Math.sin(th);
  for (const [px, py] of pts) {
    const dx = px - c.cx, dy = py - c.cy;
    let lx = dx * co - dy * si, ly = dx * si + dy * co;
    if (c.kind === 'rect') {
      lx = Math.abs(lx / (Math.abs(c.sx) || 1)); ly = Math.abs(ly / (Math.abs(c.sy) || 1));
      const hw = c.w / 2, hh = c.h / 2;
      if (lx > hw + tol || ly > hh + tol) return false;
      const r = Math.min(c.radius || 0, hw, hh);
      if (r > 0) { const qx = lx - (hw - r), qy = ly - (hh - r); if (qx > 0 && qy > 0 && Math.hypot(qx, qy) > r + tol) return false; }
    } else {
      if (!(c.rx > 0) || !(c.ry > 0)) return false;
      if ((lx / (c.rx + tol)) ** 2 + (ly / (c.ry + tol)) ** 2 > 1) return false;
    }
  }
  return true;
}

/** Rounded rectangle path centred on 0,0 with per-corner radii [tl, tr, br, bl]. */
function roundRectPath(w, h, radii) {
  const k = 0.5522847498;
  const x0 = -w / 2, y0 = -h / 2, x1 = w / 2, y1 = h / 2;
  const lim = (r) => Math.max(0, Math.min(r, w / 2, h / 2));
  const [tl, tr, br, bl] = radii.map(lim);
  const v = [], it = [], ot = [];
  const pt = (x, y, ix, iy, ox, oy) => { v.push([r3(x), r3(y)]); it.push([r3(ix), r3(iy)]); ot.push([r3(ox), r3(oy)]); };
  // clockwise from the top edge after the top-left corner
  pt(x0 + tl, y0, -tl * k, 0, 0, 0);
  pt(x1 - tr, y0, 0, 0, tr * k, 0);
  if (tr) pt(x1, y0 + tr, 0, -tr * k, 0, 0);
  pt(x1, y1 - br, 0, 0, 0, br * k);
  if (br) pt(x1 - br, y1, br * k, 0, 0, 0);
  pt(x0 + bl, y1, 0, 0, -bl * k, 0);
  if (bl) pt(x0, y1 - bl, 0, bl * k, 0, 0);
  pt(x0, y0 + tl, 0, 0, 0, -tl * k);
  // drop duplicate points produced by zero radii
  const out = { vertices: [], inTangents: [], outTangents: [], closed: true };
  for (let i = 0; i < v.length; i++) {
    const j = out.vertices.length - 1;
    if (j >= 0 && out.vertices[j][0] === v[i][0] && out.vertices[j][1] === v[i][1]) { out.outTangents[j] = ot[i]; continue; }
    out.vertices.push(v[i]); out.inTangents.push(it[i]); out.outTangents.push(ot[i]);
  }
  const n = out.vertices.length - 1;
  if (n > 0 && out.vertices[n][0] === out.vertices[0][0] && out.vertices[n][1] === out.vertices[0][1]) { out.inTangents[0] = out.inTangents[n]; out.vertices.pop(); out.inTangents.pop(); out.outTangents.pop(); }
  return out;
}

class Builder {
  constructor({ frames, fps, stage, htmlFile, outDir, rasters }) {
    this.frames = frames;
    this.fps = fps;
    this.stage = stage;
    this.htmlFile = htmlFile;
    this.outDir = outDir;
    this.rasters = rasters || {};
    this.assets = [];
    this.assetIds = new Map();
    this.warnings = new Set();
    this.names = new Map();
  }
  warn(m) { this.warnings.add(m); }

  asset(src, extra) {
    if (this.assetIds.has(src)) return this.assetIds.get(src);
    const id = 'a' + (this.assets.length + 1);
    const a = Object.assign({ id }, extra || {});
    if (/^data:/.test(src)) a.data = src;
    else if (/^file:/.test(src)) a.path = fileURLToPath(src);
    else if (/^https?:/.test(src)) a.url = src;
    else a.path = path.resolve(path.dirname(this.htmlFile), src);
    this.assets.push(a);
    this.assetIds.set(src, id);
    return id;
  }

  uniqueName(base) {
    const n = (this.names.get(base) || 0) + 1;
    this.names.set(base, n);
    return n === 1 ? base : base + ' ' + n;
  }

  // ------------------------------------------------------------------ sampling
  collect() {
    const tracks = new Map(), clips = new Map();
    this.frames.forEach((fr, f) => {
      for (const it of fr.items) {
        let tr = tracks.get(it.id);
        if (!tr) { tr = { id: it.id, kind: it.kind, first: f, last: f, byFrame: new Map() }; tracks.set(it.id, tr); }
        tr.last = f;
        tr.byFrame.set(f, it);
      }
      for (const [cid, c] of Object.entries(fr.clips || {})) {
        let ct = clips.get(cid);
        if (!ct) { ct = { id: cid, first: f, last: f, byFrame: new Map() }; clips.set(cid, ct); }
        ct.last = f;
        ct.byFrame.set(f, c);
      }
    });
    return { tracks, clips };
  }

  /** Samples over [a..b] (default: the track's own span); gaps hold the nearest sample with present=false. */
  series(tr, a = tr.first, b = tr.last) {
    const out = [];
    let last = tr.byFrame.get(tr.first);
    for (let f = a; f <= b; f++) {
      const s = tr.byFrame.get(f);
      if (s) { last = s; out.push({ f, s, present: true }); }
      else out.push({ f, s: last, present: false });
    }
    return out;
  }

  fit(series, get, tol, opts) {
    const times = series.map((x) => x.f / this.fps);
    const values = series.map((x) => get(x.s, x.present));
    const r = fitTrack(times, values, Object.assign({ tol }, opts || {}));
    return r.keyframes ? r.keyframes : r.value;
  }

  timing(first, last) {
    return { inPoint: r3(first / this.fps), outPoint: r3((last + 1) / this.fps) };
  }

  /** position / rotation / scale / opacity tracks from samples carrying cx, cy, rot, sx, sy, opacity */
  transformFor(series, { cx = (s) => [s.cx, s.cy], extraScale = () => [1, 1], opacity = true } = {}) {
    const rots = unwrapAngles(series.map((x) => x.s.rot || 0));
    const tf = {
      position: this.fit(series, (s) => cx(s), 0.3),
      rotation: this.fit(series.map((x, i) => ({ f: x.f, present: x.present, s: { rot: rots[i] } })), (s) => s.rot, 0.15),
      scale: this.fit(series, (s) => { const e = extraScale(s); return [(s.sx === undefined ? 1 : s.sx) * e[0] * 100, (s.sy === undefined ? 1 : s.sy) * e[1] * 100]; }, 0.2),
    };
    if (opacity) tf.opacity = this.fit(series, (s, present) => (present ? Math.max(0, Math.min(1, s.opacity)) * 100 : 0), 0.4, { jump: 20 });
    if (tf.rotation === 0) delete tf.rotation;
    if (Array.isArray(tf.scale) && typeof tf.scale[0] === 'number' && Math.abs(tf.scale[0] - 100) < 0.01 && Math.abs(tf.scale[1] - 100) < 0.01) delete tf.scale;
    if (tf.opacity === 100) delete tf.opacity;
    return tf;
  }

  colorTrack(ser, get) {
    const vals = ser.map((x) => { const c = color(get(x.s)); return c ? rgb(c.hex) : [0, 0, 0]; });
    const r = fitTrack(ser.map((x) => x.f / this.fps), vals, { tol: 0.004, digits: 4 });
    if (r.keyframes) return r.keyframes.map((k) => Object.assign({}, k, { v: hex(k.v) }));
    return hex(r.value);
  }

  effectsFor(series, s0) {
    const fx = [];
    if (series.some((x) => x.s.blur)) fx.push({ name: 'Gaussian Blur', properties: { Blurriness: this.fit(series, (s) => (s.blur || 0) * 2, 0.2), 'Repeat Edge Pixels': true } });
    const sh = s0.fshadow || (s0.shadow && (s0.shadow.x || s0.shadow.y || s0.shadow.blur) ? s0.shadow : null);
    if (sh) {
      const c = color(sh.color) || { hex: '#000000', alpha: 0.5 };
      fx.push({ name: 'Drop Shadow', properties: { 'Shadow Color': c.hex, Opacity: Math.round(c.alpha * 255), Direction: r3((Math.atan2(sh.x, -sh.y) * 180) / Math.PI), Distance: r3(Math.hypot(sh.x, sh.y)), Softness: r3(sh.blur * 1.2) } });
      if (sh.spread) this.warn('box-shadow spread is approximated (After Effects drop shadows have no spread)');
    }
    return fx;
  }

  common(id, s0, kindLabel) {
    const L = { id, name: this.uniqueName(this.labelFor(s0, kindLabel)) };
    if (s0.blend && s0.blend !== 'normal') { if (BLENDS[s0.blend]) L.blendMode = BLENDS[s0.blend]; else this.warn('mix-blend-mode ' + s0.blend + ' is not supported'); }
    if (s0.flat3d) this.warn('CSS 3D transforms are flattened to 2D');
    if (Math.abs(s0.skew || 0) > 0.5) this.warn('CSS skew transforms are approximated (skew is dropped)');
    return L;
  }

  labelFor(s, kind) {
    if (s.kind === 'text') { const t = String(s.text || '').trim(); return t.length > 28 ? t.slice(0, 26) + '…' : t || 'Text'; }
    return (s.label || kind) + (kind ? ' (' + kind + ')' : '');
  }

  // --------------------------------------------------------------- layer kinds
  box(u) {
    const tr = u.tr, ser = this.series(tr), s0 = ser.find((x) => x.present).s;
    if (s0.raster && this.rasters[tr.id]) return this.rasterBox(u, ser, s0);
    const L = Object.assign(this.common(tr.id, s0, 'box'), { type: 'shape' }, this.timing(u.first, u.last));
    const bw = s0.border ? s0.border.w : 0;
    const radii = s0.radii || [s0.radius || 0, s0.radius || 0, s0.radius || 0, s0.radius || 0];
    const uneven = radii.some((r) => Math.abs(r - radii[0]) > 0.5);
    const sizeAnimated = ser.some((x) => Math.abs(x.s.w - s0.w) > 0.01 || Math.abs(x.s.h - s0.h) > 0.01);
    let rect;
    if (uneven && !sizeAnimated) {
      rect = { type: 'path', name: 'Box', path: roundRectPath(Math.max(0, s0.w - bw), Math.max(0, s0.h - bw), radii.map((r) => Math.max(0, r - bw / 2))) };
    } else {
      rect = { type: 'rect', name: 'Box', size: this.fit(ser, (s) => [Math.max(0, s.w - bw), Math.max(0, s.h - bw)], 0.3) };
      const rad = this.fit(ser, (s) => Math.max(0, (s.radius || 0) - bw / 2), 0.3);
      if (rad !== 0) rect.roundness = rad;
      if (uneven) this.warn('boxes with different corner radii that also change size use one radius');
    }
    if (s0.grad) {
      const g = s0.grad;
      const c0 = color(g.colors[0]), c1 = color(g.colors[g.colors.length - 1]);
      const cols = [c0 ? c0.hex : '#000000', c1 ? c1.hex : '#ffffff'];
      if (g.type === 'radial') {
        rect.gradient = { gradientType: 'radial', start: [0, 0], end: this.fit(ser, (s) => [Math.hypot(s.w, s.h) / 2, 0], 0.3), colors: cols };
      } else {
        const th = (g.angle * Math.PI) / 180, dx = Math.sin(th), dy = -Math.cos(th);
        const half = (s) => Math.abs((s.w / 2) * dx) + Math.abs((s.h / 2) * dy);
        rect.gradient = { gradientType: 'linear', start: this.fit(ser, (s) => [-dx * half(s), -dy * half(s)], 0.3), end: this.fit(ser, (s) => [dx * half(s), dy * half(s)], 0.3), colors: cols };
      }
    } else if (s0.bg || ser.some((x) => x.s.bg)) {
      rect.fill = {
        color: this.colorTrack(ser, (s) => s.bg || s0.bg),
        opacity: this.fit(ser, (s) => { const c = color(s.bg); return c ? c.alpha * 100 : 0; }, 0.4),
      };
      if (rect.fill.opacity === 100) delete rect.fill.opacity;
    }
    if (s0.border) {
      if (s0.border.uneven) this.warn('borders that differ per side use the top border');
      const bc = color(s0.border.color);
      rect.stroke = { color: this.colorTrack(ser, (s) => (s.border ? s.border.color : s0.border.color)), width: bw };
      if (bc && bc.alpha < 1) rect.stroke.opacity = r3(bc.alpha * 100);
      if (s0.border.style === 'dashed') rect.stroke.dashes = [bw * 3, bw * 2];
      if (s0.border.style === 'dotted') { rect.stroke.dashes = [0.01, bw * 2]; rect.stroke.lineCap = 'round'; }
    }
    const shapes = [rect];
    // box-shadow used as an outline ring (0 0 0 Npx colour) → a stroke around the box
    const ringAt = (s) => (s.shadow && !s.shadow.x && !s.shadow.y && !s.shadow.blur && s.shadow.spread > 0 ? s.shadow.spread : 0);
    if (ser.some((x) => ringAt(x.s) > 0)) {
      const rs = ser.find((x) => ringAt(x.s) > 0).s.shadow;
      const rc = color(rs.color) || { hex: '#000000', alpha: 1 };
      shapes.unshift({
        type: 'rect', name: 'Ring',
        size: this.fit(ser, (s) => [s.w + ringAt(s), s.h + ringAt(s)], 0.3),
        roundness: this.fit(ser, (s) => (s.radius || 0) + ringAt(s) / 2, 0.3),
        stroke: { color: rc.hex, width: this.fit(ser, (s) => ringAt(s), 0.05), opacity: r3(rc.alpha * 100) },
      });
    }
    L.transform = this.transformFor(ser);
    L.shapes = shapes;
    const fx = this.effectsFor(ser, s0);
    if (fx.length) L.effects = fx;
    if (!rect.fill && !rect.gradient && !rect.stroke && !fx.length && shapes.length === 1) return [];
    return [L];
  }

  rasterBox(u, ser, s0) {
    const ras = this.rasters[u.tr.id];
    const L = Object.assign(this.common(u.tr.id, s0, 'picture'), { type: 'footage', asset: this.asset(ras.file) }, this.timing(u.first, u.last));
    L.transform = this.transformFor(ser, { extraScale: (s) => [s.w / ras.w, s.h / ras.h] });
    const fx = this.effectsFor(ser, s0);
    if (fx.length) L.effects = fx;
    this.warn('backgrounds After Effects cannot draw natively (soft or multi-stop gradients, patterns, images) are imported as pictures that keep their animation');
    return [L];
  }

  text(u) {
    const tr = u.tr, ser = this.series(tr), s0 = ser.find((x) => x.present).s;
    const L = Object.assign(this.common(tr.id, s0, 'text'), { type: 'text' }, this.timing(u.first, u.last));
    const f = s0.font;
    const t = {
      content: this.textContent(ser),
      fontFamily: fontFamily(f.family),
      fontStyle: fontStyleName(f.weight, f.style === 'italic' || f.style === 'oblique'),
      fontSize: r3(f.size),
      justification: 'center',
      anchor: 'center',
    };
    if (f.letterSpacing) t.tracking = Math.round((f.letterSpacing / f.size) * 1000);
    const c = color(s0.color);
    t.color = c ? c.hex : '#000000';
    if (f.stroke) { const sc = color(f.strokeColor); if (sc) { t.stroke = { color: sc.hex, width: f.stroke }; t.strokeOverFill = true; } }
    L.text = t;
    // unrotated text is placed by its baseline (exact, independent of how each app measures glyph boxes)
    const useBaseline = ser.every((x) => x.s.by !== null && x.s.by !== undefined && Math.abs(x.s.rot || 0) < 0.01);
    if (useBaseline) { t.anchor = 'baseline'; L.transform = this.transformFor(ser, { cx: (s) => [s.cx, s.by] }); }
    else L.transform = this.transformFor(ser);
    const fx = this.effectsFor(ser, s0);
    if (ser.some((x) => x.s.color !== s0.color)) fx.push({ name: 'Fill', properties: { Color: this.colorTrack(ser, (s) => s.color) } });
    if (c && c.alpha < 1) L.transform.opacity = this.fit(ser, (s, present) => (present ? s.opacity * (color(s.color) || { alpha: 1 }).alpha * 100 : 0), 0.4, { jump: 20 });
    if (fx.length) L.effects = fx;
    if (s0.gradText && s0.gradText.colors && s0.gradText.colors.length) {
      // gradient-filled text: a gradient rectangle matted by the text
      const g = s0.gradText, c0 = color(g.colors[0]), c1 = color(g.colors[g.colors.length - 1]);
      const th = (g.angle * Math.PI) / 180, dx = Math.sin(th), dy = -Math.cos(th), half = Math.abs((s0.w / 2) * dx) + Math.abs((s0.h / 2) * dy);
      const G = Object.assign(this.common(tr.id + '_grad', s0, 'gradient text'), { type: 'shape', trackMatte: { layer: tr.id, type: 'alpha' } }, this.timing(u.first, u.last));
      G.transform = this.transformFor(ser, { opacity: false });
      G.shapes = [{ type: 'rect', size: [r3(s0.w + 4), r3(s0.h + 4)], gradient: { gradientType: g.type === 'radial' ? 'radial' : 'linear', start: [r3(-dx * half), r3(-dy * half)], end: [r3(dx * half), r3(dy * half)], colors: [c0 ? c0.hex : '#ffffff', c1 ? c1.hex : '#000000'] } }];
      L.text.color = '#ffffff';
      return [G, L];
    }
    return [L];
  }

  textContent(ser) {
    const vals = ser.map((x) => x.s.text);
    if (vals.every((v) => v === vals[0])) return vals[0];
    const keys = [];
    ser.forEach((x, i) => { if (i === 0 || x.s.text !== ser[i - 1].s.text) keys.push({ t: r3(x.f / this.fps), v: x.s.text }); });
    return keys;
  }

  image(u) {
    const tr = u.tr, ser = this.series(tr), s0 = ser.find((x) => x.present).s;
    const L = Object.assign(this.common(tr.id, s0, 'image'), { type: 'footage', asset: this.asset(s0.src) }, this.timing(u.first, u.last));
    if (s0.fit === 'cover' || s0.fit === 'contain') {
      const k = s0.fit === 'contain' ? Math.min(s0.w / s0.nw, s0.h / s0.nh) : Math.max(s0.w / s0.nw, s0.h / s0.nh);
      L.transform = this.transformFor(ser, { extraScale: () => [k, k] });
      if (s0.fit === 'cover') this.warn('object-fit: cover images are not cropped to their box');
    } else L.transform = this.transformFor(ser, { extraScale: (s) => [s.w / s.nw, s.h / s.nh] });
    const fx = this.effectsFor(ser, s0);
    if (fx.length) L.effects = fx;
    return [L];
  }

  video(u) {
    const tr = u.tr, ser = this.series(tr), s0 = ser.find((x) => x.present).s;
    if (/\.webm(\?|$)/i.test(s0.src)) this.warn('WebM video cannot be opened by After Effects — convert it to H.264 MP4');
    const L = Object.assign(this.common(tr.id, s0, 'video'), { type: 'footage', asset: this.asset(s0.src) }, this.timing(u.first, u.last));
    L.startTime = r3(tr.first / this.fps - (s0.t || 0));
    L.transform = this.transformFor(ser, { extraScale: (s) => [s.nw ? s.w / s.nw : 1, s.nh ? s.h / s.nh : 1] });
    return [L];
  }

  canvas(u) {
    const tr = u.tr, ser = this.series(tr), s0 = ser.find((x) => x.present).s;
    if (!s0.data) { this.warn('a <canvas> could not be read (cross-origin content) and was skipped'); return []; }
    const dir = path.join(this.outDir, 'canvas_' + tr.id.replace(/\W/g, '_'));
    fs.mkdirSync(dir, { recursive: true });
    let lastData = null, n = 0, first = null;
    for (const x of ser) {
      const data = (x.s && x.s.data) || lastData;
      if (!data) continue;
      lastData = data;
      const file = path.join(dir, 'frame_' + String(n++).padStart(5, '0') + '.png');
      fs.writeFileSync(file, Buffer.from(data.split(',')[1], 'base64'));
      if (!first) first = file;
    }
    this.warn('<canvas> drawing is imported as a PNG sequence');
    const id = 'a' + (this.assets.length + 1);
    this.assets.push({ id, path: first, sequence: true, fps: this.fps });
    const L = Object.assign(this.common(tr.id, s0, 'canvas'), { type: 'footage', asset: id }, this.timing(u.first, u.last));
    L.transform = this.transformFor(ser, { extraScale: (s) => [s.w / s.cw, s.h / s.ch] });
    return [L];
  }

  svgGeom(s) {
    const g = s.g;
    switch (s.tag) {
      case 'path': return g.d ? parsePathData(g.d) : [];
      case 'rect': return g.width > 0 && g.height > 0 ? [rectPath(g.x, g.y, g.width, g.height, g.rx, g.ry || g.rx)] : [];
      case 'circle': return g.r > 0 ? [ellipsePath(g.cx, g.cy, g.r, g.r)] : [];
      case 'ellipse': return g.rx > 0 && g.ry > 0 ? [ellipsePath(g.cx, g.cy, g.rx, g.ry)] : [];
      case 'line': return [polyPath([g.x1, g.y1, g.x2, g.y2].join(' '), false)];
      case 'polyline': return [polyPath(g.points, false)];
      case 'polygon': return [polyPath(g.points, true)];
      default: return [];
    }
  }

  /** One SVG element → a shape group (geometry + paint) in its root's user space; null if nothing paints. */
  svgItem(ser, s0) {
    let geo0;
    try { geo0 = this.svgGeom(s0); } catch (e) { this.warn('an SVG shape could not be parsed: ' + e.message); return null; }
    if (!geo0.length) return null;
    const item = { type: 'path', name: s0.label && s0.label !== s0.tag ? s0.label : s0.tag };
    const geoKey = (s) => JSON.stringify(s.g);
    const changes = ser.filter((x, i) => x.present && (i === 0 || geoKey(x.s) !== geoKey(ser[i - 1].s)));
    if (changes.length > 1 && geo0.length === 1) {
      const keys = [];
      for (const x of changes) { try { const gp = this.svgGeom(x.s); if (gp.length) keys.push({ t: r3(x.f / this.fps), v: gp[0] }); } catch (_) { } }
      const sameCount = keys.every((k) => k.v.vertices.length === keys[0].v.vertices.length);
      if (!sameCount) { keys.forEach((k, i) => { if (i < keys.length - 1) k.ease = 'hold'; }); this.warn('SVG path morphs with changing point counts are imported as hold keyframes'); }
      item.path = keys;
    } else {
      item.paths = geo0;
      if (changes.length > 1) this.warn('animated compound SVG paths keep their first shape');
    }
    const bb = s0.bbox || [0, 0, 1, 1];
    const gradFrom = (ref) => {
      const num = (v, rel) => (/%$/.test(String(v)) ? (parseFloat(v) / 100) * rel : parseFloat(v));
      const box = ref.units !== 'userSpaceOnUse';
      const mapX = (v) => (box ? bb[0] + num(v, 1) * bb[2] : num(v, bb[2]));
      const mapY = (v) => (box ? bb[1] + num(v, 1) * bb[3] : num(v, bb[3]));
      const cs = ref.colors.map(color).filter(Boolean);
      if (ref.colors.length > 2) this.warn('SVG gradients with more than 2 stops use the first and last stop');
      if (ref.type === 'radial') { const cx = mapX(ref.cx), cy = mapY(ref.cy); return { gradientType: 'radial', start: [r3(cx), r3(cy)], end: [r3(cx + num(ref.r, 1) * (box ? bb[2] : 1)), r3(cy)], colors: [cs[0].hex, cs[cs.length - 1].hex] }; }
      return { gradientType: 'linear', start: [r3(mapX(ref.x1)), r3(mapY(ref.y1))], end: [r3(mapX(ref.x2)), r3(mapY(ref.y2))], colors: [cs[0] ? cs[0].hex : '#000', cs[cs.length - 1] ? cs[cs.length - 1].hex : '#fff'] };
    };
    if (s0.fillRef && s0.fillRef.colors.length) item.gradient = gradFrom(s0.fillRef);
    else if (s0.fill && s0.fill !== 'none' && color(s0.fill)) {
      item.fill = { color: this.colorTrack(ser, (s) => s.fill), opacity: this.fit(ser, (s) => { const c = color(s.fill); return (c ? c.alpha : 1) * (isNaN(s.fillOpacity) ? 1 : s.fillOpacity) * 100; }, 0.4) };
      if (item.fill.opacity === 100) delete item.fill.opacity;
      if (s0.fillRule === 'evenodd') item.fill.rule = 'evenodd';
    }
    if (s0.strokeRef && s0.strokeRef.colors.length) {
      const c = color(s0.strokeRef.colors[0]);
      if (c) item.stroke = { color: c.hex, width: s0.strokeWidth };
      this.warn('SVG gradient strokes use their first colour');
    } else if (s0.stroke && s0.stroke !== 'none' && s0.strokeWidth > 0 && color(s0.stroke)) {
      item.stroke = { color: this.colorTrack(ser, (s) => s.stroke), width: this.fit(ser, (s) => s.strokeWidth, 0.05), opacity: this.fit(ser, (s) => { const c = color(s.stroke); return (c ? c.alpha : 1) * (isNaN(s.strokeOpacity) ? 1 : s.strokeOpacity) * 100; }, 0.4) };
      if (item.stroke.opacity === 100) delete item.stroke.opacity;
      if (s0.cap && s0.cap !== 'butt') item.stroke.lineCap = s0.cap === 'square' ? 'square' : 'round';
      if (s0.join && s0.join !== 'miter') item.stroke.lineJoin = s0.join === 'bevel' ? 'bevel' : 'round';
      // a single dash at least as long as the path is a draw-on → Trim Paths
      const dashOf = (s) => (String(s.dash || 'none') === 'none' ? [] : String(s.dash).split(/[\s,]+/).map(parseFloat).filter((n) => !isNaN(n)));
      const dashes = dashOf(s0);
      const len = s0.len || 0;
      if (dashes.length && len && dashes[0] >= len * 0.97 && (dashes.length === 1 || dashes[1] >= len * 0.97)) {
        item.trimPaths = {
          end: this.fit(ser, (s) => {
            const d = dashOf(s)[0] || dashes[0], L0 = s.len || len, o = s.dashOffset || 0;
            const v = Math.abs(d - L0) <= 0.03 * L0 ? (1 - o / d) * 100 : ((d - o) / L0) * 100;
            return Math.max(0, Math.min(100, v));
          }, 0.25),
        };
        if (item.trimPaths.end === 100) delete item.trimPaths;
      } else if (dashes.length) {
        item.stroke.dashes = dashes.length % 2 ? dashes.concat(dashes) : dashes;
        const off = this.fit(ser, (s) => s.dashOffset || 0, 0.1);
        if (off !== 0) item.stroke.dashOffset = off;
      }
    }
    if (!item.fill && !item.stroke && !item.gradient) return null;
    return item;
  }

  /** Every element of one inline <svg> → one shape layer (layer = the svg, groups = its elements). */
  svgRoot(u) {
    const kids = u.children.slice().sort((a, b) => a.o - b.o);
    // root samples: any element present in the frame carries the root's matrix and opacity
    const rootSer = [];
    let last = null;
    for (let f = u.first; f <= u.last; f++) {
      let s = null;
      for (const k of kids) { const x = k.tr.byFrame.get(f); if (x) { s = x; break; } }
      if (s) last = s;
      rootSer.push({ f, present: !!s, s: last });
    }
    const first = rootSer.find((x) => x.present);
    for (const x of rootSer) if (!x.s) x.s = first.s;
    const s0 = first.s;
    const dser = rootSer.map((x) => ({ f: x.f, present: x.present, s: Object.assign(decompose(x.s.rootCtm), { opacity: x.s.rootOpacity }) }));
    if (dser.some((x) => Math.abs(x.s.skew) > 0.5)) this.warn('skewed SVG transforms are approximated');
    const L = Object.assign({ id: 'svg_' + u.id, name: this.uniqueName((u.label || 'svg') + ' (svg)'), type: 'shape' }, this.timing(u.first, u.last));
    L.transform = Object.assign({ anchorPoint: [0, 0] }, this.transformFor(dser));
    const groups = [];
    for (const k of kids) {
      const ser = this.series(k.tr, u.first, u.last);
      const ks0 = ser.find((x) => x.present).s;
      const item = this.svgItem(ser, ks0);
      if (!item) continue;
      const tf = {};
      if (ser.some((x) => !isIdentity(x.s.lm))) {
        const lser = ser.map((x) => ({ f: x.f, present: x.present, s: decompose(x.s.lm) }));
        Object.assign(tf, { anchorPoint: [0, 0] }, this.transformFor(lser, { opacity: false }));
      }
      const op = this.fit(ser, (s, present) => (present ? Math.max(0, Math.min(1, s.rootOpacity > 1e-4 ? s.opacity / s.rootOpacity : 1)) * 100 : 0), 0.4, { jump: 20 });
      if (op !== 100) tf.opacity = op;
      if (Object.keys(tf).length) item.transform = tf;
      groups.push(item);
    }
    if (!groups.length) return [];
    L.shapes = groups.reverse(); // first item draws on top
    if (s0.blend && s0.blend !== 'normal' && BLENDS[s0.blend]) L.blendMode = BLENDS[s0.blend];
    return [L];
  }

  // ---------------------------------------------------------------- clipping
  /** Shape layer drawing a clip container's visible area (used as an alpha matte). */
  clipLayer(ct, id, name) {
    const ser = this.series(ct), c0 = ser.find((x) => x.present).s;
    const L = Object.assign({ id, name, type: 'shape' }, this.timing(ct.first, ct.last));
    const same = ser.map((x) => (x.s.kind === c0.kind ? x : Object.assign({}, x, { s: c0 })));
    if (ser.some((x) => x.s.kind !== c0.kind)) this.warn('a clip that changes kind over time keeps its first kind');
    if (c0.kind === 'rect') {
      L.transform = this.transformFor(same, { opacity: false });
      L.shapes = [{ type: 'rect', name: 'Clip', size: this.fit(same, (s) => [s.w, s.h], 0.3), fill: '#ffffff' }];
      const rad = this.fit(same, (s) => s.radius || 0, 0.3);
      if (rad !== 0) L.shapes[0].roundness = rad;
    } else if (c0.kind === 'ellipse') {
      L.transform = this.transformFor(same.map((x) => ({ f: x.f, present: x.present, s: { cx: x.s.cx, cy: x.s.cy, rot: x.s.rot } })), { opacity: false });
      L.shapes = [{ type: 'ellipse', name: 'Clip', size: this.fit(same, (s) => [s.rx * 2, s.ry * 2], 0.3), fill: '#ffffff' }];
    } else {
      L.transform = Object.assign({ anchorPoint: [0, 0] }, this.transformFor(same.map((x) => ({ f: x.f, present: x.present, s: decompose(x.s.tf || [1, 0, 0, 1, 0, 0]) })), { opacity: false }));
      const changes = same.filter((x, i) => i === 0 || x.s.d !== same[i - 1].s.d);
      const item = { type: 'path', name: 'Clip', fill: '#ffffff' };
      if (changes.length > 1) {
        const keys = changes.map((x) => ({ t: r3(x.f / this.fps), v: parsePathData(x.s.d)[0] })).filter((k) => k.v);
        if (!keys.every((k) => k.v.vertices.length === keys[0].v.vertices.length)) keys.forEach((k) => { k.ease = 'hold'; });
        item.path = keys;
      } else item.paths = parsePathData(c0.d);
      L.shapes = [item];
    }
    return L;
  }

  // ------------------------------------------------------------------- build
  samplesAt(u, f) {
    if (u.kind !== 'svgroot') { const s = u.tr.byFrame.get(f); return s ? [s] : []; }
    const out = [];
    for (const k of u.children) { const s = k.tr.byFrame.get(f); if (s) out.push(s); }
    return out;
  }

  crosses(u, ct) {
    const c0 = ct.byFrame.get(ct.first);
    if (c0.kind !== 'rect' && c0.kind !== 'ellipse') return true;
    for (let f = Math.max(u.first, ct.first); f <= Math.min(u.last, ct.last); f++) {
      const c = ct.byFrame.get(f);
      if (!c) continue;
      for (const s of this.samplesAt(u, f)) {
        if (!(s.opacity > 0.001)) continue;
        const pts = cornersOf(s);
        if (!pts || !insideClip(c, pts)) return true;
      }
    }
    return false;
  }

  /** a scene-sized clip that never differs from the stage rectangle clips nothing the comp edge doesn't */
  isStageRect(ct) {
    const W = this.stage.width, H = this.stage.height;
    for (const c of ct.byFrame.values()) {
      if (c.kind !== 'rect' || c.radius > 0.5 || Math.abs(c.rot || 0) > 0.01 || Math.abs((c.sx || 1) - 1) > 1e-3 || Math.abs((c.sy || 1) - 1) > 1e-3) return false;
      if (Math.abs(c.cx - W / 2) > 0.5 || Math.abs(c.cy - H / 2) > 0.5 || c.w < W - 0.5 || c.h < H - 0.5) return false;
    }
    return true;
  }

  makeUnit(u) {
    switch (u.kind) {
      case 'box': return this.box(u);
      case 'text': return this.text(u);
      case 'image': return this.image(u);
      case 'video': return this.video(u);
      case 'canvas': return this.canvas(u);
      case 'svgroot': return this.svgRoot(u);
      default: return [];
    }
  }

  build({ name }) {
    const { tracks, clips } = this.collect();
    const duration = r3(this.frames.length / this.fps);
    const W = this.stage.width, H = this.stage.height;

    // ---- units: one per element (one per <svg> root for SVG content)
    const units = [];
    const roots = new Map();
    for (const tr of tracks.values()) {
      let visible = false;
      for (const s of tr.byFrame.values()) if (s.opacity > 0.001) { visible = true; break; }
      if (!visible) continue;
      const s0 = tr.byFrame.get(tr.first);
      if (tr.kind === 'svg') {
        let u = roots.get(s0.root);
        if (!u) {
          u = { kind: 'svgroot', id: s0.root, children: [], chain: s0.rootClips || [], z: s0.rootZ || 0, o: s0.rootO !== undefined ? s0.rootO : s0.o, first: tr.first, last: tr.last, label: s0.rootLabel };
          roots.set(s0.root, u);
          units.push(u);
        }
        u.children.push({ tr, o: s0.o });
        u.first = Math.min(u.first, tr.first);
        u.last = Math.max(u.last, tr.last);
      } else units.push({ kind: tr.kind, id: tr.id, tr, chain: s0.clips || [], z: s0.z || 0, o: s0.o || 0, first: tr.first, last: tr.last });
    }

    // ---- which clip containers matter, and how each is reproduced
    const c0 = (cid) => { const ct = clips.get(cid); return ct ? ct.byFrame.get(ct.first) : null; };
    const scene = new Set(), own = new Set();
    for (const [cid, ct] of clips) { const c = ct.byFrame.get(ct.first); if (c.scene) scene.add(cid); if (c.own) own.add(cid); }
    for (const u of units) {
      u.chain = u.chain.filter((cid) => clips.has(cid));
      u.crossed = new Set(u.chain.filter((cid) => own.has(cid) || this.crosses(u, clips.get(cid))));
    }
    const used = new Set(scene);
    for (const u of units) for (const cid of u.crossed) used.add(cid);
    for (const u of units) u.used = u.chain.filter((cid) => used.has(cid));
    const pre = new Set(scene);
    for (const u of units) u.used.slice(0, -1).forEach((cid) => pre.add(cid));
    const matted = new Map();
    for (const u of units) { const lastC = u.used[u.used.length - 1]; if (lastC && !pre.has(lastC) && u.crossed.has(lastC)) matted.set(lastC, (matted.get(lastC) || 0) + 1); }
    for (const [cid, n] of matted) if (n >= PRECOMP_MIN_LAYERS) pre.add(cid);
    const parentOf = new Map();
    for (const u of units) {
      const ps = u.used.filter((cid) => pre.has(cid));
      ps.forEach((cid, i) => { if (!parentOf.has(cid)) parentOf.set(cid, i ? ps[i - 1] : 'main'); });
      u.comp = ps.length ? ps[ps.length - 1] : 'main';
      const lastC = u.used[u.used.length - 1];
      u.matte = lastC && !pre.has(lastC) && u.crossed.has(lastC) ? lastC : null;
    }
    const crossedBy = new Set();
    for (const u of units) for (const cid of u.crossed) crossedBy.add(cid);

    // ---- entries per comp, painted bottom → top by (z-index, document order)
    const comps = new Map([['main', []]]);
    for (const cid of parentOf.keys()) comps.set(cid, []);
    for (const u of units) comps.get(u.comp).push({ z: u.z, o: u.o, unit: u });
    for (const [cid, parent] of parentOf) { const c = c0(cid); comps.get(parent).push({ z: c.z || 0, o: c.o || 0, pre: cid }); }

    const compId = (cid) => 'comp_' + cid;
    const compName = new Map();
    for (const cid of parentOf.keys()) { const c = c0(cid); compName.set(cid, this.uniqueName((c.scene ? 'Scene ' : '') + (c.label || cid))); }

    const out = [];
    for (const [cid, entries] of comps) {
      entries.sort((a, b) => a.z - b.z || a.o - b.o);
      const layers = []; // bottom first
      const matteDone = new Set();
      for (const e of entries) {
        let made = [];
        if (e.pre) {
          const ct = clips.get(e.pre);
          const P = { id: 'pc_' + e.pre, name: compName.get(e.pre), type: 'precomp', comp: compId(e.pre), startTime: 0 };
          Object.assign(P, this.timing(ct.first, ct.last));
          const needsMatte = own.has(e.pre) || (crossedBy.has(e.pre) && !this.isStageRect(ct));
          if (needsMatte) {
            P.trackMatte = { layer: 'matte_' + e.pre, type: 'alpha' };
            made.push(P, this.clipLayer(ct, 'matte_' + e.pre, compName.get(e.pre) + ' matte'));
          } else made.push(P);
        } else {
          const u = e.unit;
          try { made = this.makeUnit(u); } catch (err) { this.warn('an element (' + u.kind + ') could not be converted: ' + err.message); made = []; }
          if (u.matte && made.length) {
            const mid = 'clip_' + u.matte;
            for (const l of made) {
              if (l.trackMatte) { this.warn('gradient text inside a clipping container is not clipped'); continue; }
              l.trackMatte = { layer: mid, type: 'alpha' };
            }
            if (!matteDone.has(u.matte)) {
              matteDone.add(u.matte);
              const c = c0(u.matte);
              made.push(this.clipLayer(clips.get(u.matte), mid, this.uniqueName('Clip ' + (c.label || u.matte))));
            }
          }
        }
        layers.push(...made);
      }
      layers.reverse(); // top first
      if (cid === 'main') {
        const bgC = [this.frames[0].bg, this.stage.bg, this.stage.bodyBg].map(color).find((c) => c && c.alpha > 0) || null;
        const bgImage = this.frames[0].bgImage && this.frames[0].bgImage !== 'none' ? this.frames[0].bgImage : null;
        if (bgImage) {
          const g = parseGradient(bgImage);
          if (g && g.colors.length) {
            const fake = { id: 'stage_bg', kind: 'box', first: 0, last: this.frames.length - 1, byFrame: new Map(this.frames.map((fr, f) => [f, { kind: 'box', cx: W / 2, cy: H / 2, w: W, h: H, opacity: 1, rot: 0, sx: 1, sy: 1, grad: g, radius: 0, label: 'Background Gradient' }])) };
            const made = this.box({ kind: 'box', tr: fake, first: 0, last: this.frames.length - 1 });
            made.forEach((l) => { l.name = 'Background Gradient'; layers.push(l); });
            if (g.colors.length > 2 || g.repeating || g.type === 'conic') this.warn('the page background gradient is simplified to 2 colours');
          } else this.warn('the page background image is not converted');
        }
        if (bgC) layers.push({ type: 'solid', name: 'Background', color: bgC.hex, inPoint: 0, outPoint: duration });
        out.unshift({ id: 'main', name, width: W, height: H, fps: this.fps, duration, backgroundColor: bgC ? bgC.hex : '#000000', layers });
      } else {
        out.push({ id: compId(cid), name: compName.get(cid), width: W, height: H, fps: this.fps, duration, layers });
      }
    }
    return {
      spec: { format: 'claude-motion', version: 1, name, main: 'main', compositions: out, assets: this.assets },
      warnings: Array.from(this.warnings),
    };
  }
}

function parseGradient(bi) {
  const m = /^(repeating-)?(linear|radial|conic)-gradient\((.*)\)$/.exec(String(bi).trim());
  if (!m) return null;
  const parts = m[3].split(/,(?![^(]*\))/).map((s) => s.trim());
  let angle = 180;
  const a = /^(-?[\d.]+)deg$/.exec(parts[0]);
  if (a) { angle = +a[1]; parts.shift(); } else if (/^to |circle|ellipse|at /.test(parts[0])) parts.shift();
  const colors = parts.map((p) => (/(rgba?\([^)]*\)|#[0-9a-f]+|[a-z]+)/i.exec(p) || [])[1]).filter(Boolean);
  return { type: m[2], repeating: !!m[1], angle, colors };
}

module.exports = { Builder, fontFamily, fontStyleName, roundRectPath, insideClip, cornersOf };
