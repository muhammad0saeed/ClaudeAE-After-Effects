'use strict';
/*
 * In-page code (runs inside headless Chrome). Plain functions serialised into the page — no template
 * interpolation is used inside them.
 *
 *   DETECT_STAGE   → { width, height, selector, duration, fps, bg, … } — the video frame and its length
 *   DETECT_DRIVER  → which time-control hooks the page exposes (render(t), seek(t), GSAP timelines …)
 *   FONT_REPORT    → the font families/weights the page uses and whether the browser can render them
 *   SNAPSHOT       → one frame: every painted thing in stage coordinates with a stable id
 *   RASTER_PREPARE → draws one element's own paint alone on a transparent page (for picture capture)
 */

const DETECT_STAGE = String.raw`(() => {
  const SIZES = [[1920,1080],[1080,1920],[1080,1080],[1280,720],[720,1280],[3840,2160],[2160,3840],[1080,1350],[1200,630],[1600,900],[2560,1440],[1440,2560],[800,600],[1024,768],[1080,566],[1200,1200],[1280,1280],[1920,1920]];
  const pick = (el) => el && el.offsetWidth > 0 && el.offsetHeight > 0 ? el : null;
  let stage = pick(document.querySelector('[data-claudeae-stage],[data-stage],#stage,.stage,#scene,#video,.video,#composition,.composition,#frame,#artboard,.artboard'));
  if (!stage) {
    let best = null;
    for (const el of document.querySelectorAll('body *')) {
      const w = el.offsetWidth, h = el.offsetHeight;
      if (SIZES.some(([a, b]) => a === w && b === h)) { if (!best || w * h > best.offsetWidth * best.offsetHeight) best = el; }
    }
    stage = best;
  }
  const explicit = window.STAGE || window.__STAGE__;
  let width = stage ? stage.offsetWidth : (explicit && explicit.width) || document.documentElement.clientWidth;
  let height = stage ? stage.offsetHeight : (explicit && explicit.height) || document.documentElement.clientHeight;
  if (explicit && explicit.width && explicit.height) { width = explicit.width; height = explicit.height; }
  const read = (n) => { try { return (0, eval)('typeof ' + n + ' !== "undefined" ? ' + n + ' : undefined'); } catch (e) { return undefined; } };
  let duration = null, fps = null;
  for (const n of ['DURATION', 'TOTAL', 'TOTAL_DURATION', 'LENGTH', 'VIDEO_DURATION', 'DURATION_S', 'TOTAL_SECONDS', 'VIDEO_LENGTH', '__duration', 'durationSeconds']) { const v = read(n); if (typeof v === 'number' && v > 0) { duration = v; break; } }
  if (duration === null) for (const n of ['TOTAL_MS', 'DURATION_MS']) { const v = read(n); if (typeof v === 'number' && v > 0) { duration = v / 1000; break; } }
  for (const n of ['FPS', 'FRAME_RATE', 'fps', '__fps']) { const v = read(n); if (typeof v === 'number' && v > 0 && v <= 240) { fps = v; break; } }
  if (duration === null) for (const n of ['TOTAL_FRAMES', 'FRAMES', 'FRAME_COUNT', 'NUM_FRAMES']) { const v = read(n); if (typeof v === 'number' && v > 0) { duration = v / (fps || 30); break; } }
  if (duration === null) { const d = parseFloat((stage || document.body).getAttribute('data-duration') || document.body.getAttribute('data-duration')); if (d > 0) duration = d; }
  if (duration === null) { const meta = document.querySelector('meta[name="duration"],meta[name="video:duration"]'); if (meta && parseFloat(meta.content) > 0) duration = parseFloat(meta.content); }
  if (duration !== null && duration > 600) duration = duration / 1000; // given in ms
  let sel = null;
  if (stage) { if (!stage.id) stage.setAttribute('data-cae-stage', '1'); sel = stage.id ? '#' + CSS.escape(stage.id) : '[data-cae-stage]'; }
  const csBody = getComputedStyle(document.body), csStage = stage ? getComputedStyle(stage) : csBody;
  return { width, height, selector: sel, duration, fps, title: document.title || '', bg: csStage.backgroundColor, bodyBg: csBody.backgroundColor, scale: stage ? stage.getBoundingClientRect().width / stage.offsetWidth : 1 };
})()`;

const DETECT_DRIVER = String.raw`(() => {
  const isFn = (n) => { try { return (0, eval)('typeof ' + n + ' === "function"'); } catch (e) { return false; } };
  const fns = ['render', 'renderFrame', 'renderAt', 'renderTime', '__render', 'seek', 'seekTo', 'setTime', 'setFrame', 'gotoTime', 'goToTime', 'drawFrame'].filter(isFn);
  const timelines = [];
  for (const n of ['tl', 'timeline', 'master', 'mainTimeline', 'masterTimeline', 'mainTl', 'anim', 'animation', 'movie']) {
    try { const v = (0, eval)('typeof ' + n + ' !== "undefined" ? ' + n + ' : undefined'); if (v && typeof v.seek === 'function' && typeof v.duration === 'function') timelines.push({ name: n, duration: v.duration(), paused: typeof v.paused === 'function' ? v.paused() : null }); } catch (e) { }
  }
  return { fns, timelines, gsap: !!window.gsap, anime: !!window.anime, lottie: !!(window.lottie || window.bodymovin) };
})()`;

// Families used by visible text + whether the browser actually renders each one (width test vs fallbacks)
const FONT_REPORT = String.raw`(() => {
  const ctx = document.createElement('canvas').getContext('2d');
  const sample = 'AaBbGgQqWw@#%&0123456789';
  const generic = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', '-apple-system', 'blinkmacsystemfont', 'emoji', 'math', 'fangsong', 'inherit', 'initial']);
  const used = new Map();
  const add = (cs) => {
    const fam = cs.fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, '');
    if (!fam || generic.has(fam.toLowerCase())) return;
    const key = fam + '|' + cs.fontWeight + '|' + cs.fontStyle;
    if (!used.has(key)) used.set(key, { family: fam, weight: cs.fontWeight, style: cs.fontStyle });
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) { if (n.data.trim() && n.parentElement) add(getComputedStyle(n.parentElement)); }
  const available = (f) => ['monospace', 'serif', 'sans-serif'].some((fb) => {
    ctx.font = f.style + ' ' + f.weight + ' 40px ' + fb; const a = ctx.measureText(sample).width;
    ctx.font = f.style + ' ' + f.weight + ' 40px "' + f.family + '", ' + fb; const b = ctx.measureText(sample).width;
    return Math.abs(a - b) > 0.5;
  });
  return Array.from(used.values()).map((f) => Object.assign(f, { available: available(f) }));
})()`;

const SNAPSHOT = String.raw`((stageSel, opts) => {
  const stage = stageSel ? document.querySelector(stageSel) : document.documentElement;
  const sr = stage.getBoundingClientRect();
  const ss = stageSel && stage.offsetWidth ? sr.width / stage.offsetWidth : 1;
  const stageW = stageSel ? stage.offsetWidth : innerWidth, stageH = stageSel ? stage.offsetHeight : innerHeight;
  const SX = (x) => (x - sr.left) / ss, SY = (y) => (y - sr.top) / ss;
  let nextId = window.__caeNextId || 1;
  const idOf = (n) => { if (!n.__caeId) n.__caeId = 'e' + (nextId++); return n.__caeId; };
  const items = [], clips = {};
  const root = stageSel ? stage : document.body;
  // document order of every element → stable paint-order keys across frames (elements may be hidden in some)
  const domIdx = new Map();
  { const all = root.getElementsByTagName('*'); for (let i = 0; i < all.length; i++) domIdx.set(all[i], i + 1); }
  const ordOf = (n) => (domIdx.get(n) || 0) * 1000;
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'TITLE', 'AUDIO', 'defs', 'linearGradient', 'radialGradient', 'clipPath', 'mask', 'pattern', 'filter', 'marker', 'symbol', 'title', 'desc', 'metadata', 'style', 'script']);
  const SVG_SHAPES = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);
  const transparent = (c) => !c || c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c);
  const csCache = new Map();
  const CS = (n) => { let c = csCache.get(n); if (!c) { c = getComputedStyle(n); csCache.set(n, c); } return c; };

  function matrixUp(el) {
    let m = new DOMMatrix();
    let flat3d = false;
    for (let n = el; n && n !== stage && n.nodeType === 1; n = n.parentElement) {
      const t = CS(n).transform;
      if (t && t !== 'none') { const tm = new DOMMatrix(t); if (!tm.is2D) flat3d = true; m = tm.multiply(m); }
    }
    return { a: m.a, b: m.b, c: m.c, d: m.d, flat3d };
  }
  function decompose(m) {
    const sx = Math.hypot(m.a, m.b) || 0;
    const det = m.a * m.d - m.b * m.c;
    const sy = sx ? det / sx : 0;
    return { rot: Math.atan2(m.b, m.a) * 180 / Math.PI, sx, sy, skew: sx && sy ? Math.atan2(m.a * m.c + m.b * m.d, det) * 180 / Math.PI : 0 };
  }
  const opCache = new Map();
  function effOpacity(el) {
    if (opCache.has(el)) return opCache.get(el);
    let o = 1;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) { o *= parseFloat(CS(n).opacity); if (n === stage) break; }
    opCache.set(el, o);
    return o;
  }
  function zKey(el) {
    for (let n = el; n && n !== stage && n.nodeType === 1; n = n.parentElement) {
      const cs = CS(n);
      if (cs.zIndex !== 'auto' && (cs.position !== 'static' || cs.display === 'flex' || cs.display === 'grid')) return parseInt(cs.zIndex, 10) || 0;
    }
    return 0;
  }
  const len = (v, ref) => { v = String(v).trim(); if (/%$/.test(v)) return parseFloat(v) / 100 * ref; return parseFloat(v) || 0; };
  function radiiOf(cs, W, H) { return ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius'].map((k) => { const r = cs[k].split(' ')[0]; return /%$/.test(r) ? parseFloat(r) / 100 * Math.min(W, H) : parseFloat(r) || 0; }); }
  function radiusOf(cs, W, H) { const r = cs.borderTopLeftRadius.split(' ')[0]; return /%$/.test(r) ? parseFloat(r) / 100 * Math.min(W, H) : parseFloat(r) || 0; }

  // ---------------------------------------------------------------- clipping
  function parseClipPath(cp, W, H, toStage, m) {
    const sc = (Math.hypot(m.a, m.b) + Math.hypot(m.c, m.d)) / 2 || 1;
    let mm;
    const at = (s) => {
      const p = (s || '').trim().split(/\s+/).filter(Boolean);
      const pos = (v, ref) => v === undefined || v === 'center' ? ref / 2 : v === 'left' || v === 'top' ? 0 : v === 'right' || v === 'bottom' ? ref : len(v, ref);
      return [pos(p[0], W), pos(p[1], H)];
    };
    if ((mm = /^circle\(\s*([^)]*?)\s*(?:\bat\s+([^)]+))?\)/.exec(cp))) {
      const c = at(mm[2]);
      let r = mm[1] || 'closest-side';
      if (r === 'closest-side') r = Math.min(c[0], W - c[0], c[1], H - c[1]);
      else if (r === 'farthest-side') r = Math.max(c[0], W - c[0], c[1], H - c[1]);
      else r = /%$/.test(r) ? parseFloat(r) / 100 * Math.hypot(W, H) / Math.SQRT2 : parseFloat(r);
      const p = toStage(c[0], c[1]);
      return { kind: 'ellipse', cx: p[0], cy: p[1], rx: r * sc, ry: r * sc };
    }
    if ((mm = /^ellipse\(\s*([^)]*?)\s*(?:\bat\s+([^)]+))?\)/.exec(cp))) {
      const c = at(mm[2]);
      const rr = (mm[1] || 'closest-side closest-side').split(/\s+/);
      const ry0 = rr[1] || rr[0];
      const rx = rr[0] === 'closest-side' ? Math.min(c[0], W - c[0]) : rr[0] === 'farthest-side' ? Math.max(c[0], W - c[0]) : len(rr[0], W);
      const ry = ry0 === 'closest-side' ? Math.min(c[1], H - c[1]) : ry0 === 'farthest-side' ? Math.max(c[1], H - c[1]) : len(ry0, H);
      const p = toStage(c[0], c[1]);
      return { kind: 'ellipse', cx: p[0], cy: p[1], rx: rx * sc, ry: ry * sc };
    }
    if ((mm = /^inset\(([^)]*)\)/.exec(cp))) {
      const parts = mm[1].split(/\s+round\s+/);
      const v = parts[0].trim().split(/\s+/);
      const t = len(v[0], H), r = len(v[1] !== undefined ? v[1] : v[0], W), b = len(v[2] !== undefined ? v[2] : v[0], H), l = len(v[3] !== undefined ? v[3] : (v[1] !== undefined ? v[1] : v[0]), W);
      const w = Math.max(0, W - l - r), h = Math.max(0, H - t - b);
      const p = toStage(l + w / 2, t + h / 2);
      return { kind: 'rect', cx: p[0], cy: p[1], w, h, radius: parts[1] ? len(parts[1].split(/\s+/)[0], Math.min(w, h)) : 0 };
    }
    if ((mm = /^polygon\((.*)\)$/.exec(cp))) {
      const pts = mm[1].replace(/^(nonzero|evenodd)\s*,/, '').split(',').map((s) => { const q = s.trim().split(/\s+/); return [len(q[0], W), len(q[1], H)]; });
      return { kind: 'path', d: 'M' + pts.map((p) => p[0] + ' ' + p[1]).join(' L') + ' Z' };
    }
    if ((mm = /^path\(\s*(?:(?:nonzero|evenodd)\s*,\s*)?["']([^"']+)["']\s*\)/.exec(cp))) return { kind: 'path', d: mm[1] };
    return null;
  }
  function clipOf(n) {
    if (n instanceof SVGElement) return null;
    const cs = CS(n);
    const cp = cs.clipPath && cs.clipPath !== 'none' ? cs.clipPath : null;
    const overflow = cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
    if (!cp && !overflow) return null;
    const cid = idOf(n);
    if (clips[cid] !== undefined) return clips[cid] ? cid : null;
    const r = n.getBoundingClientRect();
    const m = matrixUp(n), dm = decompose(m);
    const W = n.offsetWidth || r.width / ss, H = n.offsetHeight || r.height / ss;
    const cx = SX(r.left + r.width / 2), cy = SY(r.top + r.height / 2);
    const toStage = (x, y) => { const lx = x - W / 2, ly = y - H / 2; return [cx + m.a * lx + m.c * ly, cy + m.b * lx + m.d * ly]; };
    let shape = cp ? parseClipPath(cp, W, H, toStage, m) : null;
    if (shape && shape.kind === 'path') shape.tf = [m.a, m.b, m.c, m.d, cx - (m.a * W / 2 + m.c * H / 2), cy - (m.b * W / 2 + m.d * H / 2)];
    if (!shape && overflow) {
      const bl = parseFloat(cs.borderLeftWidth) || 0, bt = parseFloat(cs.borderTopWidth) || 0, br = parseFloat(cs.borderRightWidth) || 0, bb = parseFloat(cs.borderBottomWidth) || 0;
      const pw = Math.max(0, W - bl - br), ph = Math.max(0, H - bt - bb), c = toStage(bl + pw / 2, bt + ph / 2);
      shape = { kind: 'rect', cx: c[0], cy: c[1], w: pw, h: ph, radius: Math.max(0, radiusOf(cs, W, H) - Math.max(bl, bt)) };
    }
    if (!shape) { clips[cid] = null; return null; }
    const label = (n.id || (typeof n.className === 'string' ? n.className.split(' ')[0] : '') || n.tagName.toLowerCase()).slice(0, 40);
    clips[cid] = Object.assign(shape, { rot: dm.rot, sx: dm.sx, sy: dm.sy, label, own: !!cp, scene: W >= stageW * 0.9 && H >= stageH * 0.9, opacity: effOpacity(n), z: zKey(n), o: ordOf(n) + 500 });
    return cid;
  }
  const chainCache = new Map();
  // clip containers that clip this element's painting, outermost first (its own clip-path included)
  function clipChain(el) {
    if (chainCache.has(el)) return chainCache.get(el);
    const chain = [];
    for (let n = el.parentElement; n && n !== stage && n.nodeType === 1; n = n.parentElement) { const c = clipOf(n); if (c) chain.unshift(c); }
    if (el.nodeType === 1 && !(el instanceof SVGElement) && CS(el).clipPath && CS(el).clipPath !== 'none') { const own = clipOf(el); if (own) chain.push(own); }
    chainCache.set(el, chain);
    return chain;
  }

  // ------------------------------------------------------------- paint helpers
  function filterInfo(cs) {
    const out = {};
    const f = cs.filter;
    if (f && f !== 'none') {
      const b = /blur\(([\d.]+)px\)/.exec(f); if (b) out.blur = parseFloat(b[1]);
      const ds = /drop-shadow\((rgba?\([^)]*\)|#[0-9a-f]+|\w+)\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px\)/i.exec(f);
      if (ds) out.shadow = { color: ds[1], x: +ds[2], y: +ds[3], blur: +ds[4] };
    }
    return out;
  }
  function shadowInfo(s) {
    if (!s || s === 'none') return null;
    const first = s.split(/,(?![^(]*\))/)[0];
    if (/inset/.test(first)) return null;
    const color = (/(rgba?\([^)]*\)|#[0-9a-f]+)/i.exec(first) || [])[1] || 'rgba(0,0,0,0.5)';
    const nums = first.replace(color, '').match(/-?[\d.]+px/g) || [];
    return { color, x: parseFloat(nums[0]) || 0, y: parseFloat(nums[1]) || 0, blur: parseFloat(nums[2]) || 0, spread: parseFloat(nums[3]) || 0 };
  }
  // splits on commas outside parentheses (any depth)
  const topSplit = (s) => { const out = []; let d = 0, st = 0; for (let i = 0; i < s.length; i++) { const c = s[i]; if (c === '(') d++; else if (c === ')') d--; else if (c === ',' && d === 0) { out.push(s.slice(st, i).trim()); st = i + 1; } } out.push(s.slice(st).trim()); return out; };
  function gradientInfo(bi) {
    if (!bi || bi === 'none') return null;
    const m = /^(repeating-)?(linear|radial|conic)-gradient\((.*)\)$/.exec(bi.trim());
    if (!m) return null;
    const parts = topSplit(m[3]);
    let angle = 180, shape = m[2];
    if (shape === 'linear') {
      const a = /^(-?[\d.]+)(deg|turn|rad)$/.exec(parts[0]);
      if (a) { angle = a[2] === 'turn' ? +a[1] * 360 : a[2] === 'rad' ? +a[1] * 180 / Math.PI : +a[1]; parts.shift(); }
      else if (/^to /.test(parts[0])) { const d = parts.shift(); angle = { 'to top': 0, 'to right': 90, 'to bottom': 180, 'to left': 270, 'to top right': 45, 'to right top': 45, 'to bottom right': 135, 'to right bottom': 135, 'to bottom left': 225, 'to left bottom': 225, 'to top left': 315, 'to left top': 315 }[d] || 180; }
    } else if (/circle|ellipse|closest|farthest|\bat\b|^\d/.test(parts[0]) && !/^(rgba?|#|hsl)/.test(parts[0])) parts.shift();
    const colors = parts.map((p) => (/(rgba?\([^)]*\)|#[0-9a-f]+|[a-z]+)/i.exec(p) || [])[1]).filter(Boolean);
    return { type: shape, repeating: !!m[1], angle, colors };
  }
  // backgrounds that After Effects shapes cannot reproduce exactly → captured as a picture
  function needsRaster(cs, grad) {
    const bi = cs.backgroundImage;
    if (!bi || bi === 'none') return false;
    if (topSplit(bi).length > 1 || /url\(/.test(bi)) return true;
    if (!grad || grad.repeating || grad.type === 'conic' || grad.colors.length > 2) return true;
    if (grad.colors.some((c) => c === 'transparent' || /rgba\([^)]*,\s*(0?\.\d+|0)\)$/.test(c))) return true;
    const bs = cs.backgroundSize;
    if (bs && bs !== 'auto' && bs !== 'auto auto' && bs !== '100% 100%' && bs !== 'cover') return true;
    return false;
  }
  function paintOf(cs) {
    const p = {};
    for (const k of ['backgroundColor', 'backgroundImage', 'backgroundSize', 'backgroundPosition', 'backgroundRepeat', 'backgroundOrigin', 'backgroundClip', 'color', 'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderTopStyle', 'borderRightStyle', 'borderBottomStyle', 'borderLeftStyle', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor']) p[k] = cs[k];
    return p;
  }
  function fontInfo(cs) {
    return { family: cs.fontFamily, weight: cs.fontWeight, style: cs.fontStyle, size: parseFloat(cs.fontSize), lineHeight: cs.lineHeight === 'normal' ? null : parseFloat(cs.lineHeight), letterSpacing: cs.letterSpacing === 'normal' ? 0 : parseFloat(cs.letterSpacing) || 0, align: cs.textAlign, transform: cs.textTransform, stroke: parseFloat(cs.webkitTextStrokeWidth) || 0, strokeColor: cs.webkitTextStrokeColor, clipText: cs.webkitBackgroundClip === 'text' || cs.backgroundClip === 'text' };
  }
  const mctx = window.__caeCtx || (window.__caeCtx = document.createElement('canvas').getContext('2d'));
  function descentOf(cs, txt) {
    try { mctx.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily; return mctx.measureText(txt || 'Hg').fontBoundingBoxDescent; } catch (e) { return null; }
  }
  // line breaks measured in the text's own (untransformed) coordinates, so rotated or scaled words stay whole
  function lineRanges(node, m, fontSize) {
    const text = node.data, key = text + '|' + node.parentElement.offsetWidth + '|' + CS(node.parentElement).font;
    if (node.__caeLines && node.__caeLines.key === key) return node.__caeLines.lines;
    const det = m.a * m.d - m.b * m.c || 1;
    const r = document.createRange(), lines = [];
    let start = 0, ly0 = null;
    for (let i = 0; i < text.length; i++) {
      r.setStart(node, i); r.setEnd(node, i + 1);
      const rect = r.getBoundingClientRect();
      if (!rect.width && !rect.height) continue;
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      const ly = (-m.b * cx + m.a * cy) / det;
      if (ly0 === null) ly0 = ly;
      else if (Math.abs(ly - ly0) > fontSize * 0.6 && !/\s/.test(text[i])) { lines.push([start, i]); start = i; ly0 = ly; }
    }
    lines.push([start, text.length]);
    node.__caeLines = { key, lines };
    return lines;
  }

  // ------------------------------------------------------------------ visit
  function visit(el, depth) {
    if (depth > 80) return;
    const tag = el.tagName;
    if (SKIP.has(tag)) return;
    const cs = CS(el);
    if (cs.display === 'none') return;
    const hidden = cs.visibility === 'hidden';
    const isSvgRoot = tag.toLowerCase() === 'svg';
    const id = idOf(el);
    const base = (forEl) => {
      const m = matrixUp(forEl), d = decompose(m), f = filterInfo(CS(forEl));
      return { id: idOf(forEl), z: zKey(forEl), o: ordOf(forEl), opacity: hidden ? 0 : effOpacity(forEl), rot: d.rot, sx: d.sx, sy: d.sy, skew: d.skew, flat3d: m.flat3d, blend: CS(forEl).mixBlendMode, blur: f.blur, fshadow: f.shadow, clips: clipChain(forEl), label: (forEl.id || (typeof forEl.className === 'string' ? forEl.className.split(' ')[0] : '') || forEl.tagName.toLowerCase()).slice(0, 40) };
    };
    if (el instanceof SVGElement && !isSvgRoot) {
      if (SVG_SHAPES.has(tag)) {
        const ctm = el.getScreenCTM();
        let root = el.ownerSVGElement;
        while (root && root.ownerSVGElement) root = root.ownerSVGElement;
        if (!ctm || !root) return;
        const rctm = root.getScreenCTM();
        if (!rctm) return;
        const toStageM = (q) => new DOMMatrix([q.a / ss, q.b / ss, q.c / ss, q.d / ss, SX(q.e), SY(q.f)]);
        const RS = toStageM(rctm), ES = toStageM(ctm), LM = RS.inverse().multiply(ES);
        const b = base(el);
        const g = {};
        const A = (k) => el.getAttribute(k);
        if (tag === 'path') { const cd = cs.d; g.d = cd && cd !== 'none' ? cd.replace(/^path\(["']?|["']?\)$/g, '') : A('d'); }
        else if (tag === 'rect') { g.x = el.x.animVal.value; g.y = el.y.animVal.value; g.width = el.width.animVal.value; g.height = el.height.animVal.value; g.rx = el.rx.animVal.value; g.ry = el.ry.animVal.value; }
        else if (tag === 'circle') { g.cx = el.cx.animVal.value; g.cy = el.cy.animVal.value; g.r = el.r.animVal.value; }
        else if (tag === 'ellipse') { g.cx = el.cx.animVal.value; g.cy = el.cy.animVal.value; g.rx = el.rx.animVal.value; g.ry = el.ry.animVal.value; }
        else if (tag === 'line') { g.x1 = el.x1.animVal.value; g.y1 = el.y1.animVal.value; g.x2 = el.x2.animVal.value; g.y2 = el.y2.animVal.value; }
        else { g.points = A('points'); }
        let plen = 0; try { plen = el.getTotalLength(); } catch (e) { }
        let bbox = null; try { const bb = el.getBBox(); bbox = [bb.x, bb.y, bb.width, bb.height]; } catch (e) { }
        const paintRef = (v) => { const mm = /url\(["']?#([^"')]+)["']?\)/.exec(v || ''); if (!mm) return null; const ge = document.getElementById(mm[1]); if (!ge) return null; const stops = Array.from(ge.querySelectorAll('stop')).map((s) => getComputedStyle(s).stopColor); const at = (k, d) => ge.getAttribute(k) !== null ? ge.getAttribute(k) : d; return { type: ge.tagName === 'radialGradient' ? 'radial' : 'linear', units: at('gradientUnits', 'objectBoundingBox'), x1: at('x1', '0'), y1: at('y1', '0'), x2: at('x2', '1'), y2: at('y2', '0'), cx: at('cx', '0.5'), cy: at('cy', '0.5'), r: at('r', '0.5'), colors: stops }; };
        const parentLabel = root.parentElement ? (root.parentElement.id || (typeof root.parentElement.className === 'string' ? root.parentElement.className.split(' ')[0] : '')) : '';
        items.push(Object.assign(b, {
          kind: 'svg', tag, g, root: idOf(root), rootLabel: (root.id || parentLabel || 'svg').slice(0, 40),
          rootCtm: [RS.a, RS.b, RS.c, RS.d, RS.e, RS.f], lm: [LM.a, LM.b, LM.c, LM.d, LM.e, LM.f], rootOpacity: effOpacity(root), rootClips: clipChain(root), rootZ: zKey(root), rootO: ordOf(root),
          fill: cs.fill, fillRef: paintRef(cs.fill), fillOpacity: parseFloat(cs.fillOpacity), fillRule: cs.fillRule, stroke: cs.stroke, strokeRef: paintRef(cs.stroke), strokeWidth: parseFloat(cs.strokeWidth), strokeOpacity: parseFloat(cs.strokeOpacity),
          dash: cs.strokeDasharray, dashOffset: parseFloat(cs.strokeDashoffset) || 0, cap: cs.strokeLinecap, join: cs.strokeLinejoin, len: plen, bbox
        }));
        return;
      }
      if (tag === 'text') {
        const r = el.getBoundingClientRect();
        if (r.width && r.height) {
          const b = base(el);
          items.push(Object.assign(b, { kind: 'text', text: el.textContent.replace(/\s+/g, ' ').trim(), cx: SX(r.left + r.width / 2), cy: SY(r.top + r.height / 2), w: r.width / ss, h: r.height / ss, font: fontInfo(cs), color: cs.fill, svgText: true }));
        }
        return;
      }
      for (const c of el.children) visit(c, depth + 1);
      return;
    }
    const rects = el.getClientRects();
    if (!rects.length && !isSvgRoot) { for (const c of el.children) visit(c, depth + 1); return; }
    const r = el.getBoundingClientRect();
    // ---- the element's own box (background / border / shadow)
    const bg = cs.backgroundColor, bi = cs.backgroundImage;
    const bw = parseFloat(cs.borderTopWidth) || 0, bc = cs.borderTopColor;
    const shadow = shadowInfo(cs.boxShadow);
    const grad = gradientInfo(bi);
    const hasBox = el !== stage && !isSvgRoot && (!transparent(bg) || (bi && bi !== 'none') || (bw > 0 && cs.borderTopStyle !== 'none' && !transparent(bc)) || shadow);
    if (hasBox && !(grad && /text/.test(cs.webkitBackgroundClip || cs.backgroundClip))) {
      const b = base(el);
      const W = el.offsetWidth || r.width / ss, H = el.offsetHeight || r.height / ss;
      const raster = needsRaster(cs, grad);
      const sides = ['Right', 'Bottom', 'Left'].map((s) => parseFloat(cs['border' + s + 'Width']) || 0);
      items.push(Object.assign(b, {
        kind: 'box', cx: SX(r.left + r.width / 2), cy: SY(r.top + r.height / 2), w: W, h: H,
        bg: transparent(bg) ? null : bg, grad: raster ? null : grad, raster: raster ? paintOf(cs) : null, radius: radiusOf(cs, W, H), radii: radiiOf(cs, W, H),
        border: bw > 0 && !transparent(bc) && cs.borderTopStyle !== 'none' ? { w: bw, color: bc, style: cs.borderTopStyle, uneven: sides.some((s) => s !== bw) } : null, shadow
      }));
    }
    // ---- replaced elements
    if (tag === 'IMG' && el.complete && el.naturalWidth) {
      const b = base(el);
      items.push(Object.assign(b, { kind: 'image', src: el.currentSrc || el.src, nw: el.naturalWidth, nh: el.naturalHeight, cx: SX(r.left + r.width / 2), cy: SY(r.top + r.height / 2), w: el.offsetWidth, h: el.offsetHeight, fit: cs.objectFit }));
      return;
    }
    if (tag === 'VIDEO') {
      const b = base(el);
      items.push(Object.assign(b, { kind: 'video', src: el.currentSrc || el.src, t: el.currentTime, nw: el.videoWidth, nh: el.videoHeight, cx: SX(r.left + r.width / 2), cy: SY(r.top + r.height / 2), w: el.offsetWidth, h: el.offsetHeight }));
      return;
    }
    if (tag === 'CANVAS') {
      const b = base(el);
      let data = null;
      if (opts.canvas) { try { data = el.toDataURL('image/png'); } catch (e) { data = null; } }
      items.push(Object.assign(b, { kind: 'canvas', data, cw: el.width, ch: el.height, cx: SX(r.left + r.width / 2), cy: SY(r.top + r.height / 2), w: el.offsetWidth, h: el.offsetHeight }));
      return;
    }
    if (isSvgRoot) { for (const c of el.children) visit(c, depth + 1); return; }
    // ---- text: one item per rendered line of every direct text node
    let ti = 0;
    const tm = matrixUp(el);
    for (const node of el.childNodes) {
      if (node.nodeType !== 3) continue;
      const raw = node.data;
      if (!raw.trim()) continue;
      const font = fontInfo(cs);
      const lines = lineRanges(node, tm, font.size || 16);
      const range = document.createRange();
      lines.forEach(([s, e], li) => {
        range.setStart(node, s); range.setEnd(node, e);
        const lr = range.getBoundingClientRect();
        if (!lr.width || !lr.height) return;
        let txt = raw.slice(s, e);
        if (cs.whiteSpace.indexOf('pre') !== 0) txt = txt.replace(/\s+/g, ' ').trim();
        if (!txt) return;
        if (font.transform === 'uppercase') txt = txt.toUpperCase(); else if (font.transform === 'lowercase') txt = txt.toLowerCase();
        else if (font.transform === 'capitalize') txt = txt.replace(/\b\w/g, (c) => c.toUpperCase());
        const b = base(el);
        b.id = id + ':t' + ti + ':l' + li;
        b.o += 1 + Math.min(498, ti * 20 + li);
        const desc = descentOf(cs, txt);
        const by = desc === null || desc === undefined || Math.abs(b.rot) > 0.01 ? null : SY(lr.bottom) - desc * Math.abs(b.sy || 1);
        items.push(Object.assign(b, { kind: 'text', text: txt, cx: SX(lr.left + lr.width / 2), cy: SY(lr.top + lr.height / 2), by, w: lr.width / ss, h: lr.height / ss, font, color: cs.color, gradText: font.clipText ? gradientInfo(bi) : null }));
      });
      ti++;
    }
    for (const c of el.children) visit(c, depth + 1);
  }

  const rootCs = getComputedStyle(root);
  for (const c of root.children) visit(c, 0);
  window.__caeNextId = nextId;
  const usedClips = {};
  for (const k of Object.keys(clips)) if (clips[k]) usedClips[k] = clips[k];
  return { items, clips: usedClips, bg: rootCs.backgroundColor, bgImage: rootCs.backgroundImage, stageW, stageH };
})`;

// Draws one element's own paint (background, border, radius) alone on a transparent page so it can be
// captured as a picture. Runs after sampling, with the computed style recorded in the snapshot.
const RASTER_PREPARE = String.raw`((paint, w, h) => {
  let host = document.getElementById('__cae_raster');
  if (!host) {
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    for (const n of Array.from(document.body.children)) n.style.setProperty('display', 'none', 'important');
    host = document.createElement('div');
    host.id = '__cae_raster';
    host.style.cssText = 'position:fixed;left:0;top:0;margin:0;padding:0;z-index:2147483647;';
    document.body.appendChild(host);
  }
  host.innerHTML = '';
  const d = document.createElement('div');
  d.style.cssText = 'position:absolute;left:0;top:0;box-sizing:border-box;width:' + w + 'px;height:' + h + 'px;';
  for (const k of Object.keys(paint)) d.style[k] = paint[k];
  host.appendChild(d);
  return true;
})`;

module.exports = { DETECT_STAGE, DETECT_DRIVER, FONT_REPORT, SNAPSHOT, RASTER_PREPARE };
