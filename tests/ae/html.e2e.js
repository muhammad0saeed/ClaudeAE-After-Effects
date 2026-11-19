'use strict';
/*
 * HTML motion → After Effects fidelity test.
 * Converts an HTML page, imports it into AE, renders frames, captures the same instants in headless
 * Chrome, and compares the pictures.
 *   node tests/ae/html.e2e.js [page.html] [--out dir] [--keep] [--times 0.5,1,2] [--max 12]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { createTools } = require('../../lib/tools');
const { launch } = require('../../lib/html/browser');
const { openStage } = require('../../lib/html');
const { decodePng, encodePng, downscale } = require('../../lib/png');
const { test, run, assert } = require('./harness');

const args = process.argv.slice(2);
const page = path.resolve(args.find((a) => /\.html?$/i.test(a)) || path.join(__dirname, '..', '..', 'examples', 'html', 'launch.html'));
const outIdx = args.indexOf('--out');
const OUT = outIdx >= 0 ? path.resolve(args[outIdx + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'claudeae-html-'));
fs.mkdirSync(OUT, { recursive: true });
const opt = (n) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : undefined; };
const TIMES = (opt('times') || '0.5,1,2,3.5').split(',').map(Number);
const MAX_DIFF = Number(opt('max')) || 12;
const { callTool } = createTools();
let imported = null;

function flatten(img, bg) {
  for (let i = 0; i < img.data.length; i += 4) {
    const a = img.data[i + 3] / 255;
    for (let k = 0; k < 3; k++) img.data[i + k] = Math.round(img.data[i + k] * a + bg[k] * (1 - a));
    img.data[i + 3] = 255;
  }
  return img;
}
function diff(a, b) {
  const w = Math.min(a.width, b.width), h = Math.min(a.height, b.height);
  let sum = 0;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const ia = (y * a.width + x) * 4, ib = (y * b.width + x) * 4, io = (y * w + x) * 4;
    let d = 0;
    for (let k = 0; k < 3; k++) d += Math.abs(a.data[ia + k] - b.data[ib + k]);
    sum += d / 3;
    const v = Math.min(255, d);
    out[io] = v; out[io + 1] = v; out[io + 2] = v; out[io + 3] = 255;
  }
  return { mean: sum / (w * h), image: { width: w, height: h, data: out } };
}
function sideBySide(a, b, d) {
  const w = a.width, h = a.height, out = Buffer.alloc(w * 3 * h * 4);
  [a, b, d].forEach((img, k) => { for (let y = 0; y < h; y++) img.data.copy(out, (y * w * 3 + k * w) * 4, y * w * 4, (y + 1) * w * 4); });
  return encodePng({ width: w * 3, height: h, data: out });
}

test('convert + import into After Effects', async () => {
  const r = await callTool('ae_import_html', { file: page, open: false });
  const j = JSON.parse(r.text);
  imported = j;
  console.log('      ' + j.converted.layers + ' layers from ' + j.converted.frames + ' frames · ' + (j.warnings || []).length + ' warnings');
  (j.warnings || []).forEach((w) => console.log('        ! ' + w));
  assert.ok(j.result.layersCreated > 3);
});

test('After Effects frames match the browser', async () => {
  const comp = imported.result.main.itemId;
  const browser = await launch();
  const scores = [];
  try {
    const spec = JSON.parse(fs.readFileSync(imported.specFile, 'utf8')).compositions[0];
    // same page set-up as the converter: web fonts, stage size, time driver (render(t) / timeline / clock)
    const { page: p, stepJs } = await openStage(browser, pathToFileURL(page).href, { fps: spec.fps });
    let frame = 0;
    for (const t of TIMES) {
      // step frame by frame like the converter (GSAP's lag smoothing ignores big jumps)
      const target = Math.round(t * spec.fps);
      while (frame < target) { frame++; await p.evaluate(stepJs(frame)); }
      if (target === 0) await p.evaluate(stepJs(0));
      const shot = await p.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: spec.width, height: spec.height, scale: 1 } });
      const ref = downscale(decodePng(Buffer.from(shot.data, 'base64')), 640);
      const aeFile = path.join(OUT, 'ae-' + t + 's.png');
      await callTool('ae_render_frame', { comp, time: t, savePath: aeFile });
      const bgHex = spec.backgroundColor.slice(1);
      const ae = flatten(downscale(decodePng(fs.readFileSync(aeFile)), 640), [0, 2, 4].map((i) => parseInt(bgHex.slice(i, i + 2), 16)));
      const d = diff(ref, ae);
      scores.push({ t, mean: d.mean });
      fs.writeFileSync(path.join(OUT, 'compare-' + t + 's.png'), sideBySide(ref, ae, d.image));
      console.log('      t=' + t + 's  mean pixel difference ' + d.mean.toFixed(2) + '/255');
    }
  } finally { await browser.close(); }
  // text rasterisation differs between Chrome and After Effects, so allow a small average difference
  for (const s of scores) assert.ok(s.mean < MAX_DIFF, 'frame at ' + s.t + 's differs too much (' + s.mean.toFixed(2) + ')');
});

(async () => {
  const res = await run();
  if (imported && !args.includes('--keep')) {
    try { await callTool('ae_run_script', { code: `(function(){ for (var i = app.project.numItems; i >= 1; i--) { var it = app.project.item(i); if (it instanceof FolderItem && it.name === ${JSON.stringify(imported.result.folder)}) it.remove(); } for (var j = app.project.numItems; j >= 1; j--) { var s = app.project.item(j); if (s instanceof FootageItem && s.mainSource instanceof SolidSource && s.usedIn.length === 0) s.remove(); } for (var m = app.project.numItems; m >= 1; m--) { var f = app.project.item(m); if (f instanceof FolderItem && f.numItems === 0 && f.name === "Solids") f.remove(); } return 1; })()` }); } catch (e) { console.log('cleanup: ' + e.message); }
  }
  console.log('comparisons in ' + OUT);
  process.exit(res.fail ? 1 : 0);
})();
