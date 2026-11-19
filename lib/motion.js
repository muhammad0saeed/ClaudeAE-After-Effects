'use strict';
/*
 * Claude Motion spec helpers (Node side).
 *
 * normalizeSpec() prepares a spec for the After Effects engine:
 *   - single-comp shorthand  → { compositions: [...] }
 *   - SVG path strings ("d")  → AE vertex/tangent paths (shapes, masks, path keyframes)
 *   - "svg" layers / items    → native shape layers (+ text layers for <text>)
 *   - url / data / inline-svg assets and footage layers → local files
 * and returns { spec, warnings }. Structural problems throw a SpecError listing every issue.
 */
const fs = require('fs');
const path = require('path');
const { parsePathData, svgToShapes } = require('./svg');
const { resolveAssetFile } = require('./assets');

class SpecError extends Error {
  constructor(problems) {
    super('Invalid Claude Motion spec:\n- ' + problems.join('\n- '));
    this.name = 'SpecError';
    this.problems = problems;
  }
}

const LAYER_TYPES = new Set(['solid', 'adjustment', 'shape', 'shapes', 'vector', 'text', 'null', 'camera', 'light', 'footage', 'image', 'video', 'audio', 'file', 'svg', 'sequence', 'precomp', 'comp', 'composition', 'colorsolid']);
const SHAPE_TYPES = new Set(['group', 'rect', 'rectangle', 'ellipse', 'circle', 'star', 'polygon', 'polystar', 'path', 'fill', 'stroke', 'gradientfill', 'gradientstroke', 'trimpaths', 'trim', 'repeater', 'roundcorners', 'offsetpaths', 'offset', 'zigzag', 'wigglepaths', 'roughen', 'twist', 'puckerbloat', 'pucker', 'mergepaths', 'merge', 'wiggletransform', 'svg']);
const norm = (s) => String(s).toLowerCase().replace(/[\s_\-.]/g, '');

function isKeyframes(v) {
  return Array.isArray(v) && v.length > 0 && v[0] && typeof v[0] === 'object' && ('t' in v[0] || 'time' in v[0] || 'frame' in v[0]);
}

function pathValue(v, where, warnings) {
  if (typeof v === 'string') {
    const p = parsePathData(v);
    if (!p.length) throw new Error(where + ': empty path data');
    if (p.length > 1) warnings.push(where + ': path data has ' + p.length + ' sub-paths; only the first is used here (use "paths" on a shape item for compound shapes)');
    return p[0];
  }
  if (v && typeof v === 'object' && (v.d || v.svgPath)) return pathValue(v.d || v.svgPath, where, warnings);
  return v;
}

function convertAnimatedPath(v, where, warnings) {
  if (isKeyframes(v)) return v.map((k) => Object.assign({}, k, { v: pathValue(k.v !== undefined ? k.v : k.value, where, warnings), value: undefined }));
  if (v && typeof v === 'object' && Array.isArray(v.keyframes)) return Object.assign({}, v, { keyframes: convertAnimatedPath(v.keyframes, where, warnings) });
  return pathValue(v, where, warnings);
}

function svgSource(obj, baseDir) {
  if (obj.svg && /<svg[\s>]/i.test(obj.svg)) return obj.svg;
  const file = obj.file || obj.path || obj.src;
  if (file && /\.svg$/i.test(file)) {
    const p = path.isAbsolute(file) ? file : path.resolve(baseDir || process.cwd(), file);
    return fs.readFileSync(p, 'utf8');
  }
  return null;
}

function convertShapes(items, where, warnings, baseDir) {
  if (!Array.isArray(items)) items = [items];
  const out = [];
  items.forEach((it, i) => {
    const w = where + '[' + i + ']';
    if (!it || typeof it !== 'object') { warnings.push(w + ': shape item is not an object — skipped'); return; }
    const t = norm(it.type || it.kind || 'group');
    if (!SHAPE_TYPES.has(t)) warnings.push(w + ': unknown shape type "' + it.type + '"');
    if (t === 'svg') {
      const src = svgSource(it, baseDir);
      if (!src) { warnings.push(w + ': svg item needs "svg" markup or an .svg "file"'); return; }
      const res = svgToShapes(src, { width: it.width, height: it.height, origin: it.origin || 'center' });
      res.warnings.forEach((m) => warnings.push(w + ': ' + m));
      if (res.texts.length) warnings.push(w + ': ' + res.texts.length + ' <text> element(s) inside a shape item were skipped (use an "svg" layer to keep text)');
      const g = { type: 'group', name: it.name || 'SVG', items: res.items };
      if (it.transform) g.transform = it.transform;
      out.push(g);
      return;
    }
    const c = Object.assign({}, it);
    if (t === 'path') {
      if (c.d || c.svgPath) {
        const ps = parsePathData(c.d || c.svgPath);
        if (!ps.length) { warnings.push(w + ': empty path data'); return; }
        c.paths = ps;
        delete c.d; delete c.svgPath;
      }
      if (c.path !== undefined) c.path = convertAnimatedPath(c.path, w + '.path', warnings);
      if (Array.isArray(c.paths)) c.paths = c.paths.map((p, k) => (typeof p === 'string' || (p && (p.d || p.svgPath)) ? pathValue(p, w + '.paths[' + k + ']', warnings) : (p && p.keyframes ? convertAnimatedPath(p, w + '.paths[' + k + ']', warnings) : p)));
    }
    if (Array.isArray(c.items || c.shapes || c.contents)) {
      const key = c.items ? 'items' : c.shapes ? 'shapes' : 'contents';
      c[key] = convertShapes(c[key], w + '.' + key, warnings, baseDir);
    }
    out.push(c);
  });
  return out;
}

function convertMasks(masks, where, warnings) {
  if (!Array.isArray(masks)) masks = [masks];
  return masks.map((m, i) => {
    const c = Object.assign({}, m);
    if (c.d || c.svgPath) { c.path = pathValue(c.d || c.svgPath, where + '[' + i + ']', warnings); delete c.d; delete c.svgPath; }
    else if (c.path !== undefined) c.path = convertAnimatedPath(c.path, where + '[' + i + ']', warnings);
    return c;
  });
}

/* ------------------------------------------------------------ gradients
 * After Effects scripting cannot set gradient colour stops, so the engine recreates a gradient with
 * a Tint effect on the layer — which recolours everything on that layer. Shape layers that mix a
 * gradient with other paint (or several different gradients) are therefore split into stacked layers
 * with identical timing/transform, one per paint "key". */
const PRIM = new Set(['rect', 'rectangle', 'ellipse', 'circle', 'star', 'polygon', 'polystar', 'path']);
const isNone = (v) => v === undefined || v === null || v === false || v === 'none';
const gradKey = (g) => 'g:' + JSON.stringify(((g && g.colors) || []).map((c) => (c && typeof c === 'object' ? c.color : c)));
const childKey = (it) => (Array.isArray(it.items) ? 'items' : Array.isArray(it.shapes) ? 'shapes' : Array.isArray(it.contents) ? 'contents' : null);

/** Paint keys of an item in drawing order (top first). null = plain colour. */
function paintKeys(it) {
  if (!it || typeof it !== 'object') return [];
  const t = norm(it.type || it.kind || 'group');
  if (t === 'group') { const k = childKey(it); return k ? [].concat(...it[k].map(paintKeys)) : []; }
  if (t === 'fill' || t === 'stroke') return [null];
  if (t === 'gradientfill' || t === 'gradientstroke') return [gradKey(it)];
  if (!PRIM.has(t)) return [];
  const stroke = isNone(it.stroke) ? [] : [it.stroke.gradient ? gradKey(it.stroke.gradient) : null];
  const fill = [];
  if (it.gradient) fill.push(gradKey(it.gradient));
  if (!isNone(it.fill)) fill.push(it.fill.gradient ? gradKey(it.fill.gradient) : null);
  return it.strokeBelowFill ? fill.concat(stroke) : stroke.concat(fill);
}

/** Copy of an item keeping only the paint with the given key (neutral items are kept). */
function filterPaint(it, key) {
  const t = norm(it.type || it.kind || 'group');
  const keys = paintKeys(it);
  if (!keys.length) return it;
  if (!keys.includes(key)) return null;
  if (t === 'group') {
    const k = childKey(it);
    const kids = it[k].map((c) => filterPaint(c, key)).filter(Boolean);
    return Object.assign({}, it, { [k]: kids });
  }
  if (!PRIM.has(t)) return it;
  const c = Object.assign({}, it);
  const sk = isNone(it.stroke) ? undefined : (it.stroke.gradient ? gradKey(it.stroke.gradient) : null);
  if (sk === undefined || sk !== key) delete c.stroke;
  if (!(it.gradient && gradKey(it.gradient) === key)) delete c.gradient;
  const fk = isNone(it.fill) ? undefined : (it.fill.gradient ? gradKey(it.fill.gradient) : null);
  if (fk === undefined || fk !== key) delete c.fill;
  return c;
}

function splitGradientLayers(layer, autoIdFn) {
  const t = norm(layer.type || '');
  const key = layer.shapes ? 'shapes' : layer.contents ? 'contents' : null;
  if (!key || !['shape', 'shapes', 'vector'].includes(t)) return [layer];
  const items = layer[key];
  const all = [...new Set([].concat(...items.map(paintKeys)))];
  if (all.length <= 1 || !all.some((k) => k !== null)) return [layer];
  // runs of consecutive top-level items sharing one paint key; mixed items are split by key
  const runs = [];
  const push = (k, item) => { const last = runs[runs.length - 1]; if (last && last.key === k) last.items.push(item); else runs.push({ key: k, items: [item] }); };
  let pendingNeutral = [];
  for (const it of items) {
    const ks = [...new Set(paintKeys(it))];
    if (!ks.length) { pendingNeutral.push(it); continue; }
    for (const k of ks) {
      const part = ks.length === 1 ? it : filterPaint(it, k);
      if (pendingNeutral.length) { pendingNeutral.forEach((n) => push(k, n)); pendingNeutral = []; }
      push(k, part);
    }
  }
  if (pendingNeutral.length && runs.length) pendingNeutral.forEach((n) => runs[runs.length - 1].items.push(n));
  if (runs.length <= 1) return [layer];
  const baseId = layer.id !== undefined ? String(layer.id) : (layer.name ? String(layer.name) : (autoIdFn ? autoIdFn() : '__split'));
  // Parts are parented to the first layer with an identity transform, so moving/scaling/rotating the
  // main layer (now or later) moves every part. Opacity is not inherited by parenting, so it is copied.
  const isTransformKey = (k) => /^(transform\/|position|anchor|scale|rotation|orientation|[xyz]$|point)/i.test(k) && !/opacity/i.test(k);
  const keepNonTransform = (map) => {
    if (!map) return undefined;
    const o = {};
    for (const k of Object.keys(map)) if (!isTransformKey(k)) o[k] = map[k];
    return Object.keys(o).length ? o : undefined;
  };
  return runs.map((r, i) => {
    const L = Object.assign({}, layer, { [key]: r.items });
    if (i === 0) { L.id = baseId; return L; }
    L.id = baseId + '__part' + (i + 1);
    L.name = (layer.name || 'Shape') + (r.key ? ' (gradient)' : '') + ' ' + (i + 1);
    L.parent = baseId;
    delete L.parentJump;
    // explicit identity: new AE layers default to the comp centre, which would offset the part
    L.transform = Object.assign({ anchorPoint: [0, 0], position: [0, 0] }, layer.transform && layer.transform.opacity !== undefined ? { opacity: layer.transform.opacity } : {});
    L.properties = keepNonTransform(layer.properties);
    L.expressions = keepNonTransform(layer.expressions);
    return L;
  });
}

let autoId = 0;
function expandLayer(layer, where, warnings, ctx) {
  const L = Object.assign({}, layer);
  const type = norm(L.type || '');
  if (L.type && !LAYER_TYPES.has(type)) warnings.push(where + ': unknown layer type "' + L.type + '"');
  const extra = [];

  if (type === 'svg' && norm(L.as || 'shapes') !== 'footage') {
    const src = svgSource(L, ctx.baseDir);
    if (!src) throw new Error(where + ': svg layer needs "svg" markup or an .svg "file"');
    const res = svgToShapes(src, { width: L.width, height: L.height, origin: 'center' });
    res.warnings.forEach((m) => warnings.push(where + ': ' + m));
    L.type = 'shape';
    L.shapes = res.items.concat(L.shapes ? convertShapes(L.shapes, where + '.shapes', warnings, ctx.baseDir) : []);
    delete L.svg; delete L.file; delete L.width; delete L.height; delete L.as;
    if (res.texts.length) {
      if (!L.id) L.id = '__svg' + (++autoId);
      res.texts.forEach((t, k) => {
        extra.push({
          type: 'text', name: (L.name || 'SVG') + ' Text ' + (k + 1), parent: L.id,
          inPoint: L.inPoint, outPoint: L.outPoint, duration: L.duration, startTime: L.startTime,
          text: { content: t.content, fontFamily: t.fontFamily, fontWeight: t.fontWeight, fontStyle: t.fontStyle, fontSize: t.fontSize, color: t.color, anchor: 'baseline', justification: t.anchor },
          transform: Object.assign({ position: t.position }, t.rotation ? { rotation: t.rotation } : {}, t.opacity < 100 ? { opacity: t.opacity } : {}),
        });
      });
    }
  } else if (type === 'svg') {
    const src = svgSource(L, ctx.baseDir);
    L.type = 'footage';
    if (src && L.svg) { L.asset = ctx.addAsset({ svg: src, id: L.name }); delete L.svg; }
    delete L.as;
  }

  if (L.shapes || L.contents) {
    const key = L.shapes ? 'shapes' : 'contents';
    L[key] = convertShapes(L[key], where + '.' + key, warnings, ctx.baseDir);
  }
  if (L.masks) L.masks = convertMasks(L.masks, where + '.masks', warnings);

  const ftype = norm(L.type || '');
  if (['footage', 'image', 'video', 'audio', 'file', 'sequence'].includes(ftype) || (!L.type && (L.url || L.data))) {
    if (L.url || L.data || (L.svg && /<svg/i.test(L.svg))) {
      L.asset = ctx.addAsset({ url: L.url, data: L.data, svg: L.svg, ext: L.ext, id: L.name });
      delete L.url; delete L.data; delete L.svg;
      if (!L.type) L.type = 'footage';
    } else if (L.path || L.file) {
      const p = L.path || L.file;
      L.path = path.isAbsolute(p) ? p : path.resolve(ctx.baseDir || process.cwd(), p);
      delete L.file;
    }
  }
  if (L.properties) {
    for (const k of Object.keys(L.properties)) {
      if (/(^|\/)(path|mask path|mask shape)$/i.test(k)) L.properties[k] = convertAnimatedPath(L.properties[k], where + '.properties.' + k, warnings);
    }
  }
  return [L, extra];
}

function checkNumber(v, where, problems, { min, max } = {}) {
  if (v === undefined) return;
  if (typeof v !== 'number' || !Number.isFinite(v)) { problems.push(where + ' must be a number'); return; }
  if (min !== undefined && v < min) problems.push(where + ' must be ≥ ' + min);
  if (max !== undefined && v > max) problems.push(where + ' must be ≤ ' + max);
}

/**
 * @param {object|string} input  spec object or JSON text
 * @param {{baseDir?: string, resolveAssets?: boolean}} opts
 */
async function normalizeSpec(input, opts = {}) {
  let spec = typeof input === 'string' ? JSON.parse(input) : JSON.parse(JSON.stringify(input));
  const warnings = [];
  const problems = [];
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new SpecError(['The spec must be a JSON object']);
  if (!spec.compositions && !spec.comps && Array.isArray(spec.layers)) {
    spec = {
      format: spec.format || 'claude-motion', version: spec.version || 1, name: spec.name, defaultEase: spec.defaultEase, assets: spec.assets,
      compositions: [{ id: 'main', name: spec.name || 'Claude Motion', width: spec.width, height: spec.height, fps: spec.fps || spec.frameRate, duration: spec.duration, backgroundColor: spec.backgroundColor || spec.bgColor, layers: spec.layers, markers: spec.markers }],
    };
  }
  if (spec.comps && !spec.compositions) { spec.compositions = spec.comps; delete spec.comps; }
  if (!Array.isArray(spec.compositions) || !spec.compositions.length) throw new SpecError(['"compositions" must be a non-empty array (or give a top-level "layers" array)']);

  const assets = Array.isArray(spec.assets) ? spec.assets.slice() : [];
  let nAuto = 0;
  const ctx = {
    baseDir: opts.baseDir,
    addAsset(a) { const id = '__asset' + (++nAuto) + (a.id ? '_' + String(a.id).replace(/\W+/g, '_') : ''); assets.push(Object.assign({}, a, { id })); return id; },
  };

  const compIds = new Set();
  spec.compositions.forEach((c, ci) => {
    const w = 'compositions[' + ci + ']';
    if (!c || typeof c !== 'object') { problems.push(w + ' must be an object'); return; }
    const id = String(c.id !== undefined ? c.id : c.name || 'comp' + ci);
    if (compIds.has(id)) problems.push(w + ': duplicate composition id "' + id + '"');
    compIds.add(id);
    checkNumber(c.width, w + '.width', problems, { min: 4, max: 30000 });
    checkNumber(c.height, w + '.height', problems, { min: 4, max: 30000 });
    checkNumber(c.fps !== undefined ? c.fps : c.frameRate, w + '.fps', problems, { min: 1, max: 999 });
    if (typeof c.duration === 'number' && c.duration <= 0) problems.push(w + '.duration must be > 0');
    if (c.layers !== undefined && !Array.isArray(c.layers)) problems.push(w + '.layers must be an array');
  });
  spec.compositions.forEach((c, ci) => {
    if (!c || !Array.isArray(c.layers)) return;
    const out = [];
    const layerIds = new Set();
    c.layers.forEach((l, li) => {
      const w = 'compositions[' + ci + '].layers[' + li + ']' + (l && l.name ? ' "' + l.name + '"' : '');
      if (!l || typeof l !== 'object') { problems.push(w + ' must be an object'); return; }
      if (l.id !== undefined) { if (layerIds.has(String(l.id))) problems.push(w + ': duplicate layer id "' + l.id + '"'); layerIds.add(String(l.id)); }
      if (norm(l.type || '') === 'precomp' || norm(l.type || '') === 'comp') {
        if (l.comp === undefined) problems.push(w + ': precomp layer needs "comp"');
        else if (typeof l.comp === 'string' && !compIds.has(l.comp)) warnings.push(w + ': comp "' + l.comp + '" is not in this spec — it must already exist in the project');
      }
      try {
        const [L, extra] = expandLayer(l, w, warnings, ctx);
        // extra (text from svg) goes above the svg layer; mixed gradient layers are split
        out.push(...extra, ...splitGradientLayers(L, () => '__layer' + (++autoId)));
      } catch (e) { problems.push(e.message); }
    });
    c.layers = out;
  });
  if (problems.length) throw new SpecError(problems);

  if (opts.resolveAssets !== false) {
    for (const a of assets) {
      if (!a.id) { warnings.push('An asset without "id" was ignored'); continue; }
      try {
        const local = await resolveAssetFile(a, opts.baseDir);
        a.path = local;
        delete a.url; delete a.data; delete a.svg;
      } catch (e) { warnings.push('Asset "' + a.id + '": ' + e.message); }
    }
  }
  spec.assets = assets.filter((a) => a.path || opts.resolveAssets === false);
  return { spec, warnings };
}

/** Builds a shape layer spec (+ text layers) from SVG markup — used by the import_svg tool. */
function svgLayerSpecs(svg, { name, width, height, position, inPoint, outPoint, duration, parent } = {}) {
  const res = svgToShapes(svg, { width, height, origin: 'center' });
  const id = '__svg_import';
  const layers = splitGradientLayers({ id, type: 'shape', name: name || 'SVG', shapes: res.items, inPoint, outPoint, duration, parent, transform: position ? { position } : undefined });
  res.texts.forEach((t, k) => layers.unshift({
    type: 'text', name: (name || 'SVG') + ' Text ' + (k + 1), parent: id, inPoint, outPoint, duration,
    text: { content: t.content, fontFamily: t.fontFamily, fontWeight: t.fontWeight, fontStyle: t.fontStyle, fontSize: t.fontSize, color: t.color, anchor: 'baseline', justification: t.anchor },
    transform: Object.assign({ position: t.position }, t.rotation ? { rotation: t.rotation } : {}, t.opacity < 100 ? { opacity: t.opacity } : {}),
  }));
  return { layers, width: res.width, height: res.height, warnings: res.warnings };
}

module.exports = { normalizeSpec, svgLayerSpecs, splitGradientLayers, SpecError };
