'use strict';
/*
 * HTML motion video → Claude Motion spec.
 *
 *   const { htmlToMotion } = require('./lib/html');
 *   const { spec, warnings, stats } = await htmlToMotion('promo.html', { fps: 30 });
 *
 * The page is opened in headless Chrome/Edge with a virtual clock (shim.js). Time is driven by
 *   1. a frame function the page exposes — render(t), renderFrame(n), seek(t), setTime(t) … (the way
 *      Claude Code builds videos it later exports to MP4),
 *   2. an exposed GSAP timeline (tl.seek(t)), or
 *   3. the clock itself (CSS / Web Animations / GSAP / requestAnimationFrame / timers).
 * Every frame, every painted element is recorded (extract.js) and rebuilt as native layers (build.js).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { launch, newPage } = require('./browser');
const { SHIM } = require('./shim');
const { DETECT_STAGE, DETECT_DRIVER, FONT_REPORT, SNAPSHOT, RASTER_PREPARE } = require('./extract');
const { Builder } = require('./build');
const { resolveWebFonts, installFonts } = require('../fonts');

const FN_PRIORITY = ['render', 'renderFrame', 'renderAt', 'renderTime', '__render', 'seek', 'seekTo', 'setTime', 'setFrame', 'gotoTime', 'goToTime', 'drawFrame'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Opens a motion page in a headless browser ready to be stepped frame by frame: web fonts loaded, the
 * viewport sized to the stage, and the page's time driver detected.
 * Returns { page, stage, fps, driver, stepJs(frame), webFaces, viewport: [w, h] }.
 */
async function openStage(browser, url, opts = {}, onProgress = () => { }, warnings = []) {
  let webFaces = [];
  let vw = Number(opts.width) || 1920, vh = Number(opts.height) || 1080;
  const page = await newPage(browser.cdp, { width: vw, height: vh });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: SHIM });

  const loadFonts = async () => {
    let report = [];
    try { report = await page.evaluate(FONT_REPORT); } catch (_) { }
    const missing = report.filter((f) => !f.available);
    if (!missing.length || opts.webFonts === false) return;
    if (!webFaces.length) {
      onProgress('Fetching web fonts: ' + Array.from(new Set(missing.map((m) => m.family))).join(', ') + '…');
      const r = await resolveWebFonts(missing);
      webFaces = r.faces;
      if (r.notFound.length) warnings.push('Fonts not found online (install them, then import again): ' + r.notFound.join(', '));
    }
    if (webFaces.length) {
      await page.evaluate('(async (faces) => { for (const f of faces) { try { const ff = new FontFace(f.family, "url(" + f.woff2 + ")", { weight: String(f.weight), style: f.style }); await ff.load(); document.fonts.add(ff); } catch (e) { } } await document.fonts.ready; return true; })(' + JSON.stringify(webFaces) + ')');
    }
  };
  const load = async () => {
    await page.navigate(url);
    try { await page.evaluate('document.fonts && document.fonts.ready.then(() => true)'); } catch (_) { }
    await loadFonts();
    await page.evaluate('window.__cae ? (window.__cae.advance(0), true) : false');
  };
  onProgress('Loading page…');
  await load();
  if (!(await page.evaluate('!!window.__cae'))) throw new Error('The page could not be instrumented (is it an HTML document?)');
  let stage = await page.evaluate(DETECT_STAGE);
  if (!opts.width && (stage.width !== vw || stage.height !== vh || Math.abs(stage.scale - 1) > 0.001)) {
    // render at the stage's real size so "fit to window" scaling resolves to 1
    vw = Math.round(stage.width); vh = Math.round(stage.height);
    await page.send('Emulation.setDeviceMetricsOverride', { width: vw, height: vh, deviceScaleFactor: 1, mobile: false });
    await load();
    stage = await page.evaluate(DETECT_STAGE);
  }
  if (opts.width && opts.height) { stage.width = Number(opts.width); stage.height = Number(opts.height); }
  stage.width = Math.max(4, Math.round(stage.width));
  stage.height = Math.max(4, Math.round(stage.height));
  if (Math.abs(stage.scale - 1) > 0.01) warnings.push('The stage is scaled on the page (' + stage.scale.toFixed(2) + '×); coordinates were normalised to its real size');
  const fps = Number(opts.fps) || stage.fps || 30;

  // ---- how is time driven?
  const drv = await page.evaluate(DETECT_DRIVER);
  let driver = { kind: 'clock' };
  const fnName = opts.driverFunction || FN_PRIORITY.find((n) => drv.fns.includes(n));
  if (fnName) driver = { kind: 'function', name: fnName, unit: /frame/i.test(fnName) ? 'frame' : 'seconds' };
  else if (drv.timelines.length) driver = { kind: 'timeline', name: drv.timelines[0].name, duration: drv.timelines[0].duration };
  const stepJs = (f) => {
    const t = f / fps;
    let js = 'window.__cae.advance(' + (t * 1000) + ');';
    if (driver.kind === 'function') js += driver.name + '(' + (driver.unit === 'frame' ? f : t) + ');';
    else if (driver.kind === 'timeline') js += driver.name + '.seek(' + t + ', false);';
    return js + 'true';
  };
  return { page, stage, fps, driver, stepJs, webFaces, viewport: [vw, vh] };
}

async function htmlToMotion(input, opts = {}) {
  const maxDuration = Number(opts.maxDuration) || 60;
  const onProgress = opts.onProgress || (() => { });
  const isUrl = /^https?:\/\//i.test(String(input));
  const file = isUrl ? null : path.resolve(input);
  if (file && !fs.existsSync(file)) throw new Error('HTML file not found: ' + file);
  const url = isUrl ? input : pathToFileURL(file).href;
  const outDir = opts.outDir || path.join(file ? path.dirname(file) : os.tmpdir(), (file ? path.basename(file, path.extname(file)) : 'html') + ' (ClaudeAE)');
  fs.mkdirSync(outDir, { recursive: true });

  onProgress('Starting headless browser…');
  const browser = await launch({ executable: opts.browser });
  const warnings = [];
  try {
    const { page, stage, fps, driver, stepJs, webFaces, viewport } = await openStage(browser, url, opts, onProgress, warnings);
    const [vw, vh] = viewport;

    let duration = Number(opts.duration) || stage.duration || (driver.kind === 'timeline' && driver.duration > 0 ? driver.duration : null);
    const auto = !duration;
    const limit = auto ? (driver.kind === 'clock' ? Math.min(maxDuration, 30) : maxDuration) : duration;
    const total = Math.max(1, Math.round(limit * fps));
    const frames = [];
    const snap = '(' + SNAPSHOT + ')(' + JSON.stringify(stage.selector) + ', { canvas: ' + (opts.canvas === false ? 'false' : 'true') + ' })';

    // "significant" change = something appears/disappears, fades, changes text, or travels far — idle
    // floating/looping motion at the end of a piece does not count when measuring its length.
    const win = Math.max(2, Math.round(fps / 2));
    const history = [];
    let lastSig = 0, prevPresent = null;
    onProgress(driver.kind === 'function' ? 'Driving the page with ' + driver.name + '(t)…' : driver.kind === 'timeline' ? 'Driving the GSAP timeline "' + driver.name + '"…' : 'Playing the page…');
    for (let f = 0; f < total; f++) {
      await page.evaluate(stepJs(f));
      const s = await page.evaluate(snap);
      frames.push(s);
      const now = new Map();
      for (const it of s.items) now.set(it.id, { x: it.cx !== undefined ? it.cx : (it.rootCtm ? it.rootCtm[4] + it.lm[4] : 0), y: it.cy !== undefined ? it.cy : (it.rootCtm ? it.rootCtm[5] + it.lm[5] : 0), s: it.sx || 1, r: it.rot || 0, o: Math.round((it.opacity || 0) * 20), t: it.text, d: it.dashOffset });
      let sig = false;
      if (prevPresent) {
        if (prevPresent.size !== now.size) sig = true;
        else for (const [id, v] of now) { const p = prevPresent.get(id); if (!p || p.o !== v.o || p.t !== v.t || Math.abs((p.d || 0) - (v.d || 0)) > 0.5) { sig = true; break; } }
      }
      const old = history.length >= win ? history[history.length - win] : null;
      if (!sig && old) {
        for (const [id, v] of now) { const p = old.get(id); if (p && (Math.hypot(v.x - p.x, v.y - p.y) > 40 || Math.abs(v.s - p.s) > 0.15 || Math.abs(v.r - p.r) > 25)) { sig = true; break; } }
      }
      if (sig || f === 0) lastSig = f;
      history.push(now);
      if (history.length > win + 1) history.shift();
      prevPresent = now;
      if (f % Math.max(1, Math.round(fps / 2)) === 0) onProgress('Reading frame ' + (f + 1) + (auto ? '' : ' / ' + total));
      if (auto && f > fps * 2 && f - lastSig > fps * 3) break;
    }
    if (auto) {
      duration = Math.min(limit, Math.ceil(((lastSig + 1) / fps + 1) * 2) / 2);
      if (lastSig >= total - fps) warnings.push('The animation was still changing after ' + limit + ' s — set the length with const DURATION = <seconds>; or the Duration field');
      else warnings.push('No DURATION was declared; measured ' + duration.toFixed(1) + ' s (set const DURATION = <seconds>; to override)');
    }
    const keep = Math.max(1, Math.round(duration * fps));
    if (frames.length > keep) frames.length = keep;
    while (frames.length < keep) {
      // declared length longer than what was sampled (only when the loop stopped early) — sample on
      const f = frames.length;
      await page.evaluate(stepJs(f));
      frames.push(await page.evaluate(snap));
    }
    const pageErrors = page.consoleErrors.concat(await page.evaluate('window.__cae.errors'));
    if (pageErrors.length) warnings.push('The page reported errors: ' + pageErrors.slice(0, 3).join(' | ').slice(0, 400));

    // ---- pictures for paint After Effects cannot rebuild natively (soft gradients, patterns, images)
    const rasters = {};
    const wanted = new Map();
    frames.forEach((fr) => fr.items.forEach((it) => { if (it.kind === 'box' && it.raster && !wanted.has(it.id)) wanted.set(it.id, it); }));
    if (wanted.size) {
      onProgress('Capturing ' + wanted.size + ' background' + (wanted.size > 1 ? 's' : '') + ' as pictures…');
      await page.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
      let maxW = vw, maxH = vh;
      for (const it of wanted.values()) { maxW = Math.max(maxW, Math.ceil(it.w)); maxH = Math.max(maxH, Math.ceil(it.h)); }
      if (maxW !== vw || maxH !== vh) await page.send('Emulation.setDeviceMetricsOverride', { width: maxW, height: maxH, deviceScaleFactor: 1, mobile: false });
      for (const it of wanted.values()) {
        const w = Math.max(1, Math.ceil(it.w)), h = Math.max(1, Math.ceil(it.h));
        await page.evaluate('(' + RASTER_PREPARE + ')(' + JSON.stringify(it.raster) + ', ' + w + ', ' + h + ')');
        const urls = (String(it.raster.backgroundImage).match(/url\(["']?([^"')]+)["']?\)/g) || []).map((u) => u.replace(/^url\(["']?|["']?\)$/g, ''));
        if (urls.length) await page.evaluate('Promise.all(' + JSON.stringify(urls) + '.map((u) => new Promise((r) => { const i = new Image(); i.onload = i.onerror = r; i.src = u; }))).then(() => true)');
        await sleep(60);
        const shot = await page.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: w, height: h, scale: 1 }, captureBeyondViewport: true });
        const fileOut = path.join(outDir, 'raster_' + it.id.replace(/\W/g, '_') + '.png');
        fs.writeFileSync(fileOut, Buffer.from(shot.data, 'base64'));
        rasters[it.id] = { file: fileOut, w, h };
      }
    }

    onProgress('Building layers…');
    const builder = new Builder({ frames, fps, stage, htmlFile: file || path.join(os.tmpdir(), 'page.html'), outDir, rasters });
    const name = (opts.name || stage.title || (file ? path.basename(file, path.extname(file)) : 'HTML Motion')).slice(0, 60);
    const res = builder.build({ name });
    const specFile = path.join(outDir, 'motion.json');
    fs.writeFileSync(specFile, JSON.stringify(res.spec, null, 1));
    const comps = res.spec.compositions;
    // the page's web fonts are installed for this user so After Effects shows the real typefaces
    let fontsInstalled = null;
    if (webFaces.length && opts.installFonts !== false) {
      onProgress('Installing fonts…');
      fontsInstalled = await installFonts(webFaces);
      if (fontsInstalled.failed.length) warnings.push('Some fonts could not be installed: ' + fontsInstalled.failed.join('; '));
    }
    return {
      spec: res.spec,
      specFile,
      fonts: webFaces,
      fontsInstalled,
      warnings: warnings.concat(res.warnings),
      stats: { frames: frames.length, fps, duration: frames.length / fps, width: stage.width, height: stage.height, driver: driver.kind === 'clock' ? 'clock' : driver.name, comps: comps.length, layers: comps.reduce((n, c) => n + c.layers.length, 0) },
    };
  } finally {
    await browser.close();
  }
}

module.exports = { htmlToMotion, openStage };
