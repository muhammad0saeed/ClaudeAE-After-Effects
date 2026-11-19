'use strict';
/*
 * The After Effects tool set, shared by the MCP server (Claude Desktop / Claude Code / any MCP
 * client) and the in-panel chat agent. Each tool returns { text, image? }.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Transport } = require('./transport');
const { normalizeSpec, svgLayerSpecs } = require('./motion');
const { resolveAssetFile } = require('./assets');
const { decodePng, encodePng, downscale } = require('./png');
const { tempDir, ROOT } = require('./paths');

const COMP = { description: 'Composition name or numeric item id. Omit to use the active (open) composition.', anyOf: [{ type: 'string' }, { type: 'number' }] };
const LAYER = { description: 'Layer name, 1-based index, "#3" (index) or "id:42".', anyOf: [{ type: 'string' }, { type: 'number' }] };
const TIME = { description: 'Time in seconds (number) or a string like "24f", "1.5s", "500ms", "00:00:01:12".', anyOf: [{ type: 'number' }, { type: 'string' }] };
const ANY = {};
const obj = (properties, required, extra) => Object.assign({ type: 'object', properties, required: required || [] }, extra || {});

const LAYER_SPEC_HELP = `Layer spec (Claude Motion format — call ae_motion_format for the full reference):
{ "type": "shape|text|solid|adjustment|null|camera|light|footage|precomp|svg", "name": "...", "id": "ref used by parent/trackMatte",
  "inPoint": 0, "outPoint": 5 (or "duration"), "parent": "<id or layer name>", "blendMode": "screen", "threeD": true,
  "trackMatte": {"layer": "<id>", "type": "alpha|alphaInverted|luma|lumaInverted"},
  "transform": {"position": [x,y], "scale": 100 or [x,y], "rotation": 0, "opacity": 100, "anchorPoint": [x,y]},
  shape layers: "shapes": [{"type": "rect|ellipse|star|polygon|path|group", "size": [w,h], "roundness": 20, "radius": 50, "d": "M0 0 L100 0",
     "fill": "#hex", "stroke": {"color": "#hex", "width": 4, "lineCap": "round", "dashes": [10,5]}, "gradient": {"colors": ["#a","#b"], "start": [x,y], "end": [x,y]},
     "trimPaths": {"start": 0, "end": 100}, "repeater": {...}, "transform": {...}}]  (shape coords are relative to the layer position)
  text layers: "text": {"content": "Hello", "font": "Inter-Bold" | "fontFamily": "Inter", "fontStyle": "Bold", "fontSize": 80, "color": "#fff",
     "justification": "left|center|right", "tracking": 0, "leading": 90, "box": [w,h], "anchor": "center|baseline|top-left…",
     "animators": [{"properties": {"opacity": 0, "position": [0,40]}, "selector": {"start": 0, "end": 100, "offset": [keyframes], "basedOn": "characters|words|lines", "shape": "rampUp"}}]}
  solid/adjustment: "color": "#hex", "width", "height";  footage: "path" | "url";  precomp: "comp": "<comp name or id>";  svg: "svg": "<svg>…</svg>" (becomes editable shapes)
  "effects": [{"name": "Gaussian Blur", "properties": {"Blurriness": 10}}], "masks": [{"rect": [x,y,w,h], "feather": 10, "mode": "add"} | {"d": "M…"}],
  "expressions": {"Transform/Rotation": "time*90"}, "properties": {"Contents/Group 1/Transform/Position": [0,0]} }
Any value can be animated with keyframes: [{"t": 0, "v": 0, "ease": "easeOutCubic"}, {"t": 1, "v": 100}]. "ease" shapes the segment from that key to the next:
linear, hold, easeIn/Out/InOut (+Sine/Quad/Cubic/Quart/Quint/Expo/Circ/Back), easyEase, or [x1,y1,x2,y2] cubic-bezier. Times are composition times. Colours: "#rrggbb".`;

/* ------------------------------------------------------------- helpers */
async function waitForFile(file, ms) {
  const t0 = Date.now();
  let last = -1, stable = 0;
  while (Date.now() - t0 < ms) {
    let size = -1;
    try { size = fs.statSync(file).size; } catch (_) { }
    if (size > 0 && size === last) { if (++stable >= 2) return true; } else stable = 0;
    last = size;
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

function fmt(r, extra) {
  const out = Object.assign({}, extra || {}, { result: r.result });
  if (r.warnings && r.warnings.length) out.warnings = r.warnings;
  return JSON.stringify(out, null, 1);
}

function readSpecInput(args) {
  if (args.file) {
    const file = path.resolve(args.file);
    const text = fs.readFileSync(file, 'utf8');
    return { input: text, baseDir: path.dirname(file) };
  }
  if (args.spec === undefined) throw new Error('Pass "spec" (Claude Motion JSON) or "file" (path to a .json file)');
  return { input: args.spec, baseDir: args.baseDir || process.cwd() };
}

function flatten(img, hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex) || [0, '000000'];
  const bg = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    if (a >= 1) continue;
    d[i] = Math.round(d[i] * a + bg[0] * (1 - a));
    d[i + 1] = Math.round(d[i + 1] * a + bg[1] * (1 - a));
    d[i + 2] = Math.round(d[i + 2] * a + bg[2] * (1 - a));
    d[i + 3] = 255;
  }
  return img;
}

/* ---------------------------------------------------------------- tools */
function createTools(opts = {}) {
  const transport = opts.transport || new Transport();
  const ae = (method, params, o) => transport.call(method, params, o);
  const passthrough = (method, mapArgs) => async (args) => fmt(await ae(method, mapArgs ? mapArgs(args) : args));

  const tools = [
    {
      name: 'ae_status',
      description: 'Check the connection to Adobe After Effects: which transport is used (CEP bridge or command line), AE version, open project and active composition. Call this first if anything fails.',
      inputSchema: obj({}),
      handler: async () => {
        const st = await transport.status();
        let ping = null, error = null;
        try { ping = (await ae('ping', {}, { launch: false })).result; } catch (e) { error = e.message; }
        return JSON.stringify({ connection: st, afterEffects: ping, error }, null, 1);
      },
    },
    {
      name: 'ae_get_project',
      description: 'List project items (compositions, footage, folders, solids) with ids, sizes and durations. Optional filters.',
      inputSchema: obj({ type: { type: 'string', enum: ['comp', 'folder', 'image', 'video', 'audio', 'solid', 'footage'] }, query: { type: 'string', description: 'Substring of the item name' }, limit: { type: 'number' } }),
      handler: passthrough('get_project'),
    },
    {
      name: 'ae_get_comp',
      description: 'Describe a composition: settings (size, fps, duration, background, work area, current time), markers, and every layer (index, name, type, in/out points, parent, switches, track matte, effects, which properties are animated). Use this to understand the timeline before editing.',
      inputSchema: obj({ comp: COMP, detail: { type: 'boolean', description: 'Include animated-property summaries per layer (default true).' } }),
      handler: passthrough('get_comp'),
    },
    {
      name: 'ae_get_layer',
      description: 'Inspect one layer in depth: every modified/animated/expression-driven property with its path, value, keyframes (time, value, interpolation, ease) and expression. Property paths returned here can be passed to ae_set_property.',
      inputSchema: obj({ comp: COMP, layer: LAYER, all: { type: 'boolean', description: 'List every property, not only modified ones (large).' }, keyframes: { type: 'boolean' }, depth: { type: 'number' } }, ['layer']),
      handler: passthrough('get_layer'),
    },
    {
      name: 'ae_get_property',
      description: 'Read one property (value, keyframes, expression) or a property group. "path" is like "Transform/Position", "Effects/Gaussian Blur/Blurriness", "Contents/Group 1/Contents/Fill 1/Color" or a shortcut: position, scale, rotation, opacity, anchorPoint, sourceText. Pass "time" to also get the evaluated value at that time.',
      inputSchema: obj({ comp: COMP, layer: LAYER, path: { type: 'string' }, time: TIME }, ['layer', 'path']),
      handler: passthrough('get_property'),
    },
    {
      name: 'ae_create_comp',
      description: 'Create a new composition (and optionally fill it with layers in one call). Defaults: 1920x1080, 30 fps, 10 s. ' + LAYER_SPEC_HELP,
      inputSchema: obj({
        name: { type: 'string' }, width: { type: 'number' }, height: { type: 'number' }, fps: { type: 'number' }, duration: TIME,
        backgroundColor: { type: 'string', description: '#rrggbb' }, folder: { type: 'string', description: 'Project folder to put the comp in' },
        layers: { type: 'array', items: { type: 'object' }, description: 'Layer specs, first = top of the timeline' },
        markers: { type: 'array', items: { type: 'object' } }, defaultEase: { type: 'string' }, open: { type: 'boolean' },
        motionBlur: { type: 'boolean' }, workAreaStart: TIME, workAreaDuration: TIME,
      }, ['name']),
      handler: passthrough('create_comp'),
      timeoutMs: 300000,
    },
    {
      name: 'ae_update_comp',
      description: 'Change composition settings: name, width, height, fps, duration, backgroundColor, workAreaStart/Duration, motionBlur, shutterAngle, renderer, or move the playhead ("time"). "open": true shows it in the viewer.',
      inputSchema: obj({ comp: COMP, name: { type: 'string' }, width: { type: 'number' }, height: { type: 'number' }, fps: { type: 'number' }, duration: TIME, backgroundColor: { type: 'string' }, workAreaStart: TIME, workAreaDuration: TIME, motionBlur: { type: 'boolean' }, shutterAngle: { type: 'number' }, time: TIME, open: { type: 'boolean' }, markers: { type: 'array', items: { type: 'object' } } }),
      handler: passthrough('update_comp'),
    },
    {
      name: 'ae_add_layers',
      description: 'Add one or more layers to a composition at exact times. Layers listed first end up on top. Layers in the same call can reference each other by "id" for parent and trackMatte; existing layers can be referenced by name. Placement: "index", "above" or "below" an existing layer (default: top). "timeOffset" shifts every time in the specs. ' + LAYER_SPEC_HELP,
      inputSchema: obj({ comp: COMP, layers: { type: 'array', items: { type: 'object' } }, index: { type: 'number' }, above: LAYER, below: LAYER, timeOffset: TIME, defaultEase: { type: 'string' } }, ['layers']),
      handler: async (args) => {
        const { spec, warnings } = await normalizeSpec({ compositions: [{ id: '__add', layers: args.layers }] }, { baseDir: args.baseDir });
        const assets = {};
        for (const a of spec.assets || []) assets[a.id] = a.path;
        const layers = spec.compositions[0].layers.map((l) => (l.asset && assets[l.asset] ? Object.assign({}, l, { path: assets[l.asset], asset: undefined }) : l));
        const r = await ae('add_layers', Object.assign({}, args, { layers }), { timeoutMs: 300000 });
        r.warnings = warnings.concat(r.warnings);
        return fmt(r);
      },
    },
    {
      name: 'ae_update_layer',
      description: 'Edit an existing layer. "set" accepts any layer-spec field: name, inPoint/outPoint/duration/startTime, parent (keeps the visual position; "parentJump": true keeps values instead), blendMode, threeD, enabled, solo, locked, label, transform (keyframes replace existing ones), text (new content/style), color (solids), shapes (+ "replaceShapes": true), masks (+ "replaceMasks"), effects (an effect whose name already exists is updated, {"name": X, "remove": true} deletes, otherwise added), properties, expressions, markers, trackMatte.',
      inputSchema: obj({ comp: COMP, layer: LAYER, set: { type: 'object', description: 'Fields to change (layer-spec format)' } }, ['layer', 'set']),
      handler: async (args) => {
        const set = Object.assign({}, args.set || {});
        if (set.shapes || set.masks) {
          const { spec, warnings } = await normalizeSpec({ compositions: [{ id: '__u', layers: [{ type: set.shapes ? 'shape' : 'null', shapes: set.shapes, masks: set.masks }] }] }, { resolveAssets: false });
          const L = spec.compositions[0].layers[0];
          if (set.shapes) set.shapes = L.shapes;
          if (set.masks) set.masks = L.masks;
          const r = await ae('update_layer', { comp: args.comp, layer: args.layer, set });
          r.warnings = warnings.concat(r.warnings);
          return fmt(r);
        }
        return fmt(await ae('update_layer', { comp: args.comp, layer: args.layer, set }));
      },
    },
    {
      name: 'ae_set_property',
      description: 'Set a property to a static value, keyframes and/or an expression. Keyframes replace existing ones unless "replace": false. Example keyframes: [{"t": 0, "v": [960,1200], "ease": "easeOutExpo"}, {"t": "20f", "v": [960,540]}]. Use "expression": "" to remove an expression. Paths as in ae_get_property.',
      inputSchema: obj({ comp: COMP, layer: LAYER, path: { type: 'string' }, value: ANY, keyframes: { type: 'array', items: { type: 'object' } }, expression: { type: 'string' }, replace: { type: 'boolean' }, separate: { type: 'boolean', description: 'For position: split into X/Y/Z dimensions' } }, ['layer', 'path']),
      handler: passthrough('set_property'),
    },
    {
      name: 'ae_add_effect',
      description: 'Add effects to a layer. Each effect: {"name": "Gaussian Blur" (display name) or "matchName": "ADBE Gaussian Blur 2", "label": "custom name", "properties": {"Blurriness": 20 or keyframes}}. Shortcuts: blur, glow, dropShadow, fill, tint, gradientRamp, fractalNoise, turbulentDisplace, curves, levels, hueSaturation, linearWipe, radialWipe, motionTile, echo, slider, checkbox, colorControl, pointControl. Use ae_list_effects to discover names.',
      inputSchema: obj({ comp: COMP, layer: LAYER, effects: { type: 'array', items: { type: 'object' } } }, ['layer', 'effects']),
      handler: passthrough('add_effect'),
    },
    {
      name: 'ae_delete_layers',
      description: 'Delete layers (by name, index or id).',
      inputSchema: obj({ comp: COMP, layers: { type: 'array', items: LAYER } }, ['layers']),
      handler: passthrough('delete_layers'),
    },
    {
      name: 'ae_duplicate_layer',
      description: 'Duplicate a layer "count" times; "offset" staggers each copy in time (e.g. "5f").',
      inputSchema: obj({ comp: COMP, layer: LAYER, count: { type: 'number' }, name: { type: 'string' }, offset: TIME }, ['layer']),
      handler: passthrough('duplicate_layer'),
    },
    {
      name: 'ae_move_layer',
      description: 'Reorder a layer: "index", "above"/"below" another layer, or "to": "top"/"bottom".',
      inputSchema: obj({ comp: COMP, layer: LAYER, index: { type: 'number' }, above: LAYER, below: LAYER, to: { type: 'string', enum: ['top', 'bottom'] } }, ['layer']),
      handler: passthrough('move_layer'),
    },
    {
      name: 'ae_precompose',
      description: 'Pre-compose layers into a new composition (moves all attributes by default).',
      inputSchema: obj({ comp: COMP, layers: { type: 'array', items: LAYER }, name: { type: 'string' }, moveAllAttributes: { type: 'boolean' }, open: { type: 'boolean' } }, ['layers']),
      handler: passthrough('precompose'),
    },
    {
      name: 'ae_add_markers',
      description: 'Add markers to a composition (or to a layer if "layer" is given). Each marker: {"time": 2, "comment": "Beat", "duration": 0.5, "label": 3}.',
      inputSchema: obj({ comp: COMP, layer: LAYER, markers: { type: 'array', items: { type: 'object' } } }, ['markers']),
      handler: passthrough('add_markers'),
    },
    {
      name: 'ae_import_file',
      description: 'Import an image, video, audio, PSD/AI or SVG file into the project and (if "comp" or "time" is given) place it in the composition at an exact time. Source: "path" (local file), "url" (downloaded) or "data" (base64 / data: URI with "ext"). Placement options: time (= inPoint), outPoint or duration, startTime, sourceIn (trim the clip start), fit ("contain"|"cover"|"width"|"height"|"stretch"), transform, effects, blendMode, parent, index/above/below. "sequence": true imports an image sequence; "as": "comp" imports layered PSD/AI files as compositions.',
      inputSchema: obj({ path: { type: 'string' }, url: { type: 'string' }, data: { type: 'string' }, ext: { type: 'string' }, name: { type: 'string' }, comp: COMP, time: TIME, outPoint: TIME, duration: TIME, startTime: TIME, sourceIn: TIME, fit: { type: 'string' }, transform: { type: 'object' }, effects: { type: 'array', items: { type: 'object' } }, blendMode: { type: 'string' }, parent: LAYER, index: { type: 'number' }, above: LAYER, below: LAYER, layerName: { type: 'string' }, folder: { type: 'string' }, sequence: { type: 'boolean' }, as: { type: 'string', enum: ['footage', 'comp', 'compCroppedLayers'] }, fps: { type: 'number' } }),
      handler: async (args) => {
        const a = Object.assign({}, args);
        if (!a.path && (a.url || a.data)) a.path = await resolveAssetFile({ url: a.url, data: a.data, ext: a.ext, id: a.name });
        delete a.url; delete a.data; delete a.ext;
        return fmt(await ae('import_file', a, { timeoutMs: 600000 }));
      },
    },
    {
      name: 'ae_import_motion',
      description: 'Build a complete Claude Motion design (JSON: compositions → layers → keyframes) as native, editable After Effects compositions. Pass "spec" (object or JSON text) or "file" (path to a .json). Modes: "new" (default without comp: new comps in their own project folder), "precomp" (also drop the main comp into "comp" at "time"), "flatten" (put the main comp\'s layers straight into "comp", shifted to "time"). Call ae_motion_format for the format reference.',
      inputSchema: obj({ spec: ANY, file: { type: 'string' }, mode: { type: 'string', enum: ['new', 'precomp', 'flatten'] }, comp: COMP, time: TIME, open: { type: 'boolean' }, defaultEase: { type: 'string' }, index: { type: 'number' }, above: LAYER, below: LAYER }),
      handler: async (args) => {
        const { input, baseDir } = readSpecInput(args);
        const { spec, warnings } = await normalizeSpec(input, { baseDir });
        const p = { spec, mode: args.mode, comp: args.comp, time: args.time, open: args.open, defaultEase: args.defaultEase, index: args.index, above: args.above, below: args.below };
        if (!args.mode && args.comp === undefined) p.mode = 'new';
        const r = await ae('import_motion', p, { timeoutMs: 600000 });
        r.warnings = warnings.concat(r.warnings);
        return fmt(r);
      },
      timeoutMs: 600000,
    },
    {
      name: 'ae_import_html',
      description: 'Convert an HTML motion video (HTML/CSS/SVG with CSS animations, Web Animations, GSAP, requestAnimationFrame or timers — e.g. a Claude-made animation) into native, editable After Effects layers: text → text layers, boxes → shape layers, SVG → shapes (stroke draw-ons → Trim Paths), images/video → footage, overflow clips → track mattes, motion → eased keyframes. Needs Chrome or Edge installed. Pass "file" (path to the .html) or "html" (markup). The page should have a fixed-size stage (e.g. 1920×1080) and declare `const DURATION = <seconds>;` (otherwise the length is measured). Modes as in ae_import_motion.',
      inputSchema: obj({ file: { type: 'string' }, html: { type: 'string' }, fps: { type: 'number' }, duration: { type: 'number' }, mode: { type: 'string', enum: ['new', 'precomp', 'flatten'] }, comp: COMP, time: TIME, open: { type: 'boolean' } }),
      handler: async (args) => {
        const { htmlToMotion } = require('./html');
        let file = args.file ? path.resolve(args.file) : null;
        if (!file) {
          if (!args.html) throw new Error('Pass "file" (an .html path) or "html" (markup)');
          file = path.join(tempDir('html'), 'motion-' + crypto.randomBytes(5).toString('hex') + '.html');
          fs.writeFileSync(file, args.html, 'utf8');
        }
        const conv = await htmlToMotion(file, { fps: args.fps, duration: args.duration });
        const { spec, warnings } = await normalizeSpec(conv.spec, { baseDir: path.dirname(file) });
        const p = { spec, mode: args.mode || (args.comp === undefined ? 'new' : 'precomp'), comp: args.comp, time: args.time, open: args.open };
        const r = await ae('import_motion', p, { timeoutMs: 600000 });
        r.warnings = conv.warnings.concat(warnings, r.warnings);
        return fmt(r, { converted: conv.stats, specFile: conv.specFile });
      },
      timeoutMs: 900000,
    },
    {
      name: 'ae_import_svg',
      description: 'Turn SVG markup (or an .svg file) into an editable shape layer — every path, rect, circle, gradient and stroke becomes native shape contents; <text> becomes text layers parented to it. Use this to generate graphics: write the SVG yourself and import it. Options: name, width/height (output size in px), position (layer position, default comp centre), time/outPoint/duration, "as": "footage" to import it as a flat SVG footage item instead.',
      inputSchema: obj({ svg: { type: 'string' }, file: { type: 'string' }, comp: COMP, name: { type: 'string' }, width: { type: 'number' }, height: { type: 'number' }, position: { type: 'array', items: { type: 'number' } }, time: TIME, outPoint: TIME, duration: TIME, index: { type: 'number' }, above: LAYER, below: LAYER, as: { type: 'string', enum: ['shapes', 'footage'] } }),
      handler: async (args) => {
        let svg = args.svg;
        if (!svg && args.file) svg = fs.readFileSync(path.resolve(args.file), 'utf8');
        if (!svg) throw new Error('Pass "svg" markup or "file"');
        if (args.as === 'footage') {
          const file = args.file ? path.resolve(args.file) : await resolveAssetFile({ svg, id: args.name || 'svg' });
          return fmt(await ae('import_file', { path: file, comp: args.comp, time: args.time, outPoint: args.outPoint, duration: args.duration, layerName: args.name, index: args.index, above: args.above, below: args.below, transform: args.position ? { position: args.position } : undefined }));
        }
        const built = svgLayerSpecs(svg, { name: args.name, width: args.width, height: args.height, position: args.position, inPoint: args.time, outPoint: args.outPoint, duration: args.duration });
        const r = await ae('add_layers', { comp: args.comp, layers: built.layers, index: args.index, above: args.above, below: args.below });
        r.warnings = built.warnings.concat(r.warnings);
        return fmt(r, { size: [built.width, built.height] });
      },
    },
    {
      name: 'ae_render_frame',
      description: 'Render one frame of a composition and return it as an image so you can SEE the result. Use it to check your work after building or editing. "maxSize" limits the longest side of the returned image (default 1024).',
      inputSchema: obj({ comp: COMP, time: TIME, maxSize: { type: 'number' }, transparent: { type: 'boolean', description: 'Keep transparency instead of compositing onto the comp background colour' }, savePath: { type: 'string', description: 'Also keep the full-size PNG at this path' } }),
      handler: async (args) => {
        const file = args.savePath ? path.resolve(args.savePath) : path.join(tempDir('frames'), 'frame-' + crypto.randomBytes(6).toString('hex') + '.png');
        const r = await ae('render_frame', { comp: args.comp, time: args.time, path: file }, { timeoutMs: 180000 });
        if (!(await waitForFile(file, 60000))) throw new Error('After Effects did not write the frame (' + file + ')');
        let buf = fs.readFileSync(file);
        let size = [r.result.width, r.result.height];
        try {
          const img = downscale(decodePng(buf), Math.max(64, Number(args.maxSize) || 1024));
          // AE writes transparent pixels where the comp background shows in the viewer; composite
          // onto the background colour so the picture matches what the user sees.
          if (args.transparent !== true) flatten(img, r.result.bgColor || '#000000');
          buf = encodePng(img);
          size = [img.width, img.height];
        } catch (_) { /* send the original */ }
        if (!args.savePath) { try { fs.unlinkSync(file); } catch (_) { } }
        return { text: JSON.stringify({ comp: r.result.comp, time: r.result.time, compSize: [r.result.width, r.result.height], imageSize: size, savedTo: args.savePath ? file : undefined }), image: { data: buf.toString('base64'), mimeType: 'image/png' } };
      },
      timeoutMs: 180000,
    },
    {
      name: 'ae_render',
      description: 'Add a composition to the Render Queue with an output file (and an output-module template such as "H.264 - Match Render Settings - 15 Mbps" or "Lossless"). "start": true renders immediately (After Effects is busy until it finishes).',
      inputSchema: obj({ comp: COMP, output: { type: 'string' }, template: { type: 'string' }, renderTemplate: { type: 'string' }, start: { type: 'boolean' } }, ['output']),
      handler: async (args) => fmt(await ae('render', args, { timeoutMs: args.start ? 4 * 3600 * 1000 : 60000 })),
    },
    {
      name: 'ae_save_project',
      description: 'Save the project (to "path" if given — required for a never-saved project).',
      inputSchema: obj({ path: { type: 'string' } }),
      handler: passthrough('save_project'),
    },
    {
      name: 'ae_list_effects',
      description: 'Search installed effects (display name, match name, category).',
      inputSchema: obj({ query: { type: 'string' }, category: { type: 'string' }, limit: { type: 'number' } }),
      handler: passthrough('list_effects'),
    },
    {
      name: 'ae_list_fonts',
      description: 'Search installed fonts: family, styles and PostScript names (use the PostScript name as "font" in text layers).',
      inputSchema: obj({ query: { type: 'string' }, limit: { type: 'number' } }),
      handler: passthrough('list_fonts'),
    },
    {
      name: 'ae_select_layers',
      description: 'Select layers in a composition (deselects others unless "only": false).',
      inputSchema: obj({ comp: COMP, layers: { type: 'array', items: LAYER }, only: { type: 'boolean' } }, ['layers']),
      handler: passthrough('select_layers'),
    },
    {
      name: 'ae_apply_preset',
      description: 'Apply an animation preset (.ffx file) to a layer.',
      inputSchema: obj({ comp: COMP, layer: LAYER, path: { type: 'string' } }, ['layer', 'path']),
      handler: passthrough('apply_preset'),
    },
    {
      name: 'ae_run_script',
      description: 'Run arbitrary ExtendScript (ES3 JavaScript) inside After Effects and return the value of the last expression. Use it for anything the other tools do not cover. The whole script is one undo step. Helpers: ClaudeAE.util.findComp(nameOrId), ClaudeAE.util.findLayer(comp, ref), ClaudeAE.util.resolveProp(layer, "Transform/Position"). ExtendScript quirks: no Array.indexOf/forEach/map, no let/const/arrow functions, and "a || b && c" is mis-parsed — always parenthesise mixed && / ||.',
      inputSchema: obj({ code: { type: 'string' } }, ['code']),
      handler: passthrough('run_script'),
      timeoutMs: 600000,
    },
    {
      name: 'ae_undo',
      description: 'Undo the last After Effects action(s). Every Claude tool call is one undo step.',
      inputSchema: obj({ steps: { type: 'number' } }),
      handler: passthrough('undo'),
    },
    {
      name: 'ae_batch',
      description: 'Run several engine commands in one round-trip and one undo step. commands: [{"method": "add_layers"|"update_layer"|"set_property"|"add_effect"|"delete_layers"|"move_layer"|"add_markers"|"update_comp"|"get_comp"|..., "params": {...}}]. Method names are the tool names without the "ae_" prefix. Shapes must not use SVG "d" strings here (use ae_add_layers for those).',
      inputSchema: obj({ commands: { type: 'array', items: { type: 'object' } }, stopOnError: { type: 'boolean' } }, ['commands']),
      handler: passthrough('batch'),
      timeoutMs: 600000,
    },
    /* ------------------------------------------ the user's own assets */
    {
      name: 'ae_project_items',
      description: 'Inventory of the open project — use it first whenever the user refers to their own footage, photos, music, voice-over or comps, or asks for a video made from what is in the project. Lists every item with id, kind (comp, precomp, image, video, sequence, graphic, audio, solid, folder), audio role guess (music / voiceover / sfx), folder path, size, duration, fps, audio/video flags, file path, missing files and how many comps use it, plus totals. Filters: "kind" (one or a list, roles allowed), "query" (text in the name or file path), "folder", "unused": true.',
      inputSchema: obj({ kind: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] }, query: { type: 'string' }, folder: { type: 'string' }, unused: { type: 'boolean' }, limit: { type: 'number' } }),
      handler: passthrough('project_items'),
    },
    {
      name: 'ae_import_files',
      description: 'Import many files and/or whole folders (searched recursively for images, video, audio, PSD/AI/PDF/SVG) into the project, filed by kind under "folder" (default "Footage"): Images, Video, Sequences, Graphics, Music, Voice-over, SFX. Already-imported files are re-used. Returns the details of every item (ids for placing them).',
      inputSchema: obj({ paths: { type: 'array', items: { type: 'string' }, description: 'Files or folders' }, folder: { type: 'string' }, byKind: { type: 'boolean' }, recursive: { type: 'boolean' } }, ['paths']),
      handler: async (args) => fmt(await ae('import_files', args, { timeoutMs: 600000 })),
      timeoutMs: 600000,
    },
    {
      name: 'ae_organize_project',
      description: 'Tidy the Project panel into folders: Comps (Comps/Precomps), Footage/Video, Footage/Images, Footage/Sequences, Footage/Graphics, Audio/Music, Audio/Voice-over, Audio/SFX, Solids; empty folders are removed. scope "root" (default) files only loose items, "all" re-files everything. "folders" maps a kind/role to your own folder path, "rules" [{match: regex on the name, folder: "Path/Sub"}] win over both. "dryRun": true returns the plan without moving anything. "removeUnused" (delete unused footage) and "consolidate" (merge duplicate footage) change the project — use them only when the user asks.',
      inputSchema: obj({ scope: { type: 'string', enum: ['root', 'all'] }, folders: { type: 'object' }, rules: { type: 'array', items: { type: 'object' } }, dryRun: { type: 'boolean' }, removeUnused: { type: 'boolean' }, consolidate: { type: 'boolean' }, removeEmptyFolders: { type: 'boolean' } }),
      handler: passthrough('organize_project'),
    },
    {
      name: 'ae_update_item',
      description: 'Change a project item: rename ("newName"), move to a folder ("Folder/Sub", "" = root), set label colour (0–16) or comment, relink footage to another file ("replace"), and for footage conform the frame rate ("fps"), loop count ("loop") or alpha interpretation ("straight"|"premultiplied"|"ignore").',
      inputSchema: obj({ item: { anyOf: [{ type: 'string' }, { type: 'number' }], description: 'Item id or name' }, newName: { type: 'string' }, folder: { type: 'string' }, label: { type: 'number' }, comment: { type: 'string' }, replace: { type: 'string' }, fps: { type: 'number' }, loop: { type: 'number' }, alpha: { type: 'string' } }, ['item']),
      handler: passthrough('update_item'),
    },
    {
      name: 'ae_analyze_audio',
      description: 'Listen to music, a voice-over, a sound effect or a video\'s sound (a project item or a file path) and get timing to edit to. Music → bpm, beats, downbeats (bar starts), sections where it gets louder/quieter (drops, breakdowns), strong accents (onsets), where the music starts/ends. Voice-over → phrases (start/end) and the pauses between them — match them, in order, to the script lines. Sound effect → its hit point. Also a loudness curve. Times are seconds of the audio itself: add the time the audio layer starts in the comp. "markers": {"comp", "layer"?, "at"?: comp time where the audio starts (default: the layer\'s start, or 0), "what": "beats"|"downbeats"|"phrases"|"onsets"|"sections"} drops them on the timeline as markers.',
      inputSchema: obj({ item: { anyOf: [{ type: 'string' }, { type: 'number' }], description: 'Project item id or name' }, path: { type: 'string', description: 'Audio/video file (imported if needed; WAV files are read directly)' }, kind: { type: 'string', enum: ['auto', 'music', 'voiceover', 'sfx'] }, start: { type: 'number' }, duration: { type: 'number' }, markers: { type: 'object' } }),
      handler: async (args) => {
        const { readWavEnvelope, analyzeEnvelope } = require('./audio');
        let env = null, source = {}, nameRole = null;
        const isWav = (f) => /\.(wav|wave)$/i.test(f || '');
        if (args.path && isWav(args.path) && fs.existsSync(args.path)) {
          env = readWavEnvelope(path.resolve(args.path), 50);
          source = { file: path.resolve(args.path) };
        } else {
          const r = await ae('analyze_audio', { item: args.item, path: args.path, start: args.start, duration: args.duration, folder: 'Footage/Audio' }, { timeoutMs: 300000 });
          env = r.result;
          source = { id: env.id, name: env.name, file: env.file };
          nameRole = env.role;
          // After Effects returns silence for files it cannot decode (e.g. a WAV with a damaged header)
          if (Math.max(0, ...(env.both || [])) <= 0 && isWav(env.file) && fs.existsSync(env.file)) env = readWavEnvelope(env.file, 50);
        }
        if (source.file && !nameRole) nameRole = /(^|[^a-z])(vo|v\.o)([^a-z]|$)|voice|narrat|speech|dialog|interview/i.test(path.basename(source.file)) ? 'voiceover' : null;
        if (env.declaredDuration && env.declaredDuration > env.duration + 0.5) source.warning = 'The file header claims ' + env.declaredDuration.toFixed(1) + ' s but only ' + env.duration.toFixed(1) + ' s of audio is present (truncated file)';
        // a WAV read directly covers the whole file: honour start/duration here
        if (args.path && isWav(args.path) && (args.start || args.duration)) {
          const i0 = Math.round((args.start || 0) * env.fps), i1 = args.duration ? i0 + Math.round(args.duration * env.fps) : env.both.length;
          env = Object.assign({}, env, { both: env.both.slice(i0, i1), duration: (Math.min(i1, env.both.length) - i0) / env.fps });
        }
        const kind = args.kind && args.kind !== 'auto' ? args.kind : (nameRole === 'voiceover' ? 'voiceover' : 'auto');
        const res = analyzeEnvelope(env, { kind, start: args.start || 0 });
        const out = Object.assign({ source }, res);
        if (args.markers) {
          const m = args.markers, what = m.what || (res.kind === 'voiceover' ? 'phrases' : 'beats');
          let at = m.at;
          if (at === undefined && m.layer !== undefined) {
            try { at = JSON.parse((await callTool('ae_get_layer', { comp: m.comp, layer: m.layer, depth: 0 })).text).result.startTime || 0; } catch (_) { at = 0; }
          }
          at = Number(at) || 0;
          let list = [];
          if (what === 'phrases') list = (res.phrases || []).map((p) => ({ time: at + p.start, duration: p.length, comment: 'Phrase ' + p.n }));
          else if (what === 'downbeats') list = (res.downbeats || []).map((t, i) => ({ time: at + t, comment: 'Bar ' + (i + 1) }));
          else if (what === 'onsets') list = (res.onsets || []).map((o) => ({ time: at + o.t, comment: 'Accent' }));
          else if (what === 'sections') list = (res.sections || []).map((s) => ({ time: at + s.t, comment: s.change === 'louder' ? 'Drop / build' : 'Breakdown' }));
          else list = (res.beats || []).map((t, i) => ({ time: at + t, comment: (i % 4) + 1 + '' }));
          list = list.slice(0, 500);
          if (list.length) {
            const mr = await ae('add_markers', { comp: m.comp, layer: m.layer, markers: list });
            out.markersAdded = { what, count: list.length, target: mr.result.target };
          } else out.markersAdded = { what, count: 0 };
        }
        return JSON.stringify(out);
      },
      timeoutMs: 300000,
    },
    {
      name: 'ae_preview_item',
      description: 'Look at a footage item (photo, video, image sequence, PSD/AI graphic) or a composition from the project, or an image/video file: returns up to 9 frames as one contact-sheet image plus the item\'s details. Default times: 1 frame for stills, 4 spread over a clip. Use it to see the user\'s photos and clips before choosing and placing them.',
      inputSchema: obj({ item: { anyOf: [{ type: 'string' }, { type: 'number' }] }, path: { type: 'string' }, times: { type: 'array', items: { type: 'number' } }, maxSize: { type: 'number' } }),
      handler: async (args) => {
        const dir = tempDir('frames');
        const shot = async (t) => {
          const file = path.join(dir, 'item-' + crypto.randomBytes(6).toString('hex') + '.png');
          const r = await ae('footage_frame', { item: args.item, path: args.path, folder: 'Footage', time: t, maxSize: 1280, output: file }, { timeoutMs: 120000 });
          if (!(await waitForFile(file, 30000))) throw new Error('After Effects did not write the preview');
          const img = decodePng(fs.readFileSync(file));
          try { fs.unlinkSync(file); } catch (_) { }
          return { img, info: r.result };
        };
        const first = await shot(args.times && args.times.length ? args.times[0] : 0);
        const src = first.info.source;
        let times = (args.times || []).slice(0, 9);
        if (!times.length) times = src.duration > 0.5 && (src.kind === 'video' || src.kind === 'sequence' || src.kind === 'comp' || src.kind === 'precomp') ? [0.08, 0.36, 0.64, 0.92].map((k) => Math.round(src.duration * k * 100) / 100) : [0];
        const shots = [first];
        for (const t of times.slice(1)) shots.push(await shot(t));
        if (times.length > 1 && !(args.times && args.times.length)) shots[0] = await shot(times[0]);
        const cols = shots.length === 1 ? 1 : shots.length <= 4 ? 2 : 3;
        const cellW = Math.round((Math.max(256, Number(args.maxSize) || 1024)) / cols);
        const cells = shots.map((s) => flatten(downscale(s.img, cellW), '#202020'));
        const cellH = Math.max(...cells.map((c) => c.height));
        const rows = Math.ceil(cells.length / cols), gap = 4;
        const W = cols * cellW + (cols - 1) * gap, H = rows * cellH + (rows - 1) * gap;
        const data = Buffer.alloc(W * H * 4);
        for (let i = 0; i < data.length; i += 4) { data[i] = data[i + 1] = data[i + 2] = 12; data[i + 3] = 255; }
        cells.forEach((c, k) => {
          const ox = (k % cols) * (cellW + gap) + Math.floor((cellW - c.width) / 2), oy = Math.floor(k / cols) * (cellH + gap) + Math.floor((cellH - c.height) / 2);
          for (let y = 0; y < c.height; y++) c.data.copy(data, ((oy + y) * W + ox) * 4, y * c.width * 4, (y + 1) * c.width * 4);
        });
        const png = encodePng({ width: W, height: H, data });
        return { text: JSON.stringify({ item: src, times: shots.map((s) => s.info.time), layout: cols + ' columns, left→right, top→bottom' }), image: { data: png.toString('base64'), mimeType: 'image/png' } };
      },
      timeoutMs: 300000,
    },
    {
      name: 'ae_motion_format',
      description: 'Return the full reference for the Claude Motion JSON format (layer specs, shapes, text, animators, effects, easing, timing). Read it before writing large motion designs.',
      inputSchema: obj({}),
      handler: async () => fs.readFileSync(path.join(ROOT, 'docs', 'CLAUDE_MOTION_FORMAT.md'), 'utf8'),
    },
  ];

  if (opts.extraTools) tools.push(...opts.extraTools(transport));

  const byName = new Map(tools.map((t) => [t.name, t]));
  async function callTool(name, args) {
    const t = byName.get(name);
    if (!t) throw new Error('Unknown tool ' + name);
    const out = await t.handler(args || {});
    return typeof out === 'string' ? { text: out } : out;
  }
  return { tools, callTool, transport };
}

module.exports = { createTools, LAYER_SPEC_HELP };
