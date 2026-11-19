'use strict';
/*
 * Talks to After Effects.
 *
 *  1. "bridge": the ClaudeAE CEP extension runs a tiny HTTP server inside After Effects
 *     (127.0.0.1, token protected). Fast, works while AE is open. Discovery file:
 *     ~/.claudeae/bridge.json  ->  { port, token, pid, version }
 *  2. "cli": fallback that needs no extension at all. Writes the request to a temp file and
 *     asks After Effects to run a tiny ExtendScript wrapper (AfterFX.exe -r on Windows,
 *     osascript DoScriptFile on macOS). If AE is closed this launches it.
 *
 * Both paths execute the same engine: extension/host/claudeae.jsx
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { BRIDGE_FILE, ENGINE_PATH, readJson, tempDir } = require('./paths');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

class AEError extends Error {
  constructor(message, extra) {
    super(message);
    this.name = 'AEError';
    Object.assign(this, extra || {});
  }
}

/* ------------------------------------------------------------ AE discovery */
function execText(file, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? '' : String(stdout || ''));
    });
  });
}

async function runningAfterEffects() {
  if (isWin) {
    const out = await execText('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-Process AfterFX -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path"]);
    const p = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    return p ? { exe: p } : null;
  }
  if (isMac) {
    const out = await execText('ps', ['-axo', 'comm']);
    const line = out.split('\n').find((l) => /Adobe After Effects 20\d\d\.app\/Contents\/MacOS\//.test(l));
    if (!line) return null;
    const m = line.match(/(Adobe After Effects 20\d\d)\.app/);
    return { app: m ? m[1] : 'Adobe After Effects' };
  }
  return null;
}

function installedAfterEffects() {
  const found = [];
  if (isWin) {
    const roots = [process.env['ProgramFiles'] || 'C:\\Program Files', process.env['ProgramW6432']].filter(Boolean);
    for (const r of new Set(roots)) {
      const adobe = path.join(r, 'Adobe');
      let dirs = [];
      try { dirs = fs.readdirSync(adobe); } catch (_) { continue; }
      for (const d of dirs) {
        const m = d.match(/^Adobe After Effects (?:CC )?(\d{4})/);
        if (!m) continue;
        const exe = path.join(adobe, d, 'Support Files', 'AfterFX.exe');
        if (fs.existsSync(exe)) found.push({ exe, year: Number(m[1]) });
      }
    }
  } else if (isMac) {
    let dirs = [];
    try { dirs = fs.readdirSync('/Applications'); } catch (_) { }
    for (const d of dirs) {
      const m = d.match(/^Adobe After Effects (?:CC )?(\d{4})$/);
      if (m) found.push({ app: d, year: Number(m[1]) });
    }
  }
  return found.sort((a, b) => b.year - a.year);
}

/** Fast "is AE running" check (no executable path). */
async function isAeRunning() {
  if (isWin) return /AfterFX\.exe/i.test(await execText('tasklist', ['/FI', 'IMAGENAME eq AfterFX.exe', '/NH', '/FO', 'CSV']));
  if (isMac) return /Adobe After Effects 20\d\d\.app\/Contents\/MacOS\//.test(await execText('ps', ['-axo', 'comm']));
  return false;
}

async function aeWindowReady() {
  if (!isWin) return isAeRunning();
  const out = await execText('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "@(Get-Process AfterFX -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like 'Adobe After Effects*' }).Count"]);
  return Number(String(out).trim()) > 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Starts After Effects normally and waits until it can take commands. (Running "AfterFX.exe -r"
 * against a closed AE starts it in run-script-then-quit mode, so it must never be used to launch AE.)
 * Resolves to "bridge" when the ClaudeAE bridge came up, otherwise "cli".
 */
async function launchAfterEffects(target, timeoutMs = 240000) {
  if (isWin) spawn(target.exe, [], { detached: true, stdio: 'ignore', windowsHide: false }).on('error', () => { }).unref();
  else if (isMac) spawn('open', ['-a', target.app || 'Adobe After Effects'], { detached: true, stdio: 'ignore' }).on('error', () => { }).unref();
  else throw new AEError('Cannot launch After Effects on this platform', { code: 'UNSUPPORTED' });
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(2000);
    const info = readBridgeInfo();
    if (info) {
      try { const h = await httpJson(info, '/health', undefined, 2000); if (h && h.ok) return 'bridge'; } catch (_) { }
    }
    if (await aeWindowReady()) {
      // the window exists; give scripting and extensions a moment, preferring the bridge if it appears
      for (let i = 0; i < 8; i++) {
        await sleep(1000);
        const b = readBridgeInfo();
        if (b) { try { const h = await httpJson(b, '/health', undefined, 2000); if (h && h.ok) return 'bridge'; } catch (_) { } }
      }
      return 'cli';
    }
  }
  throw new AEError('After Effects did not finish starting within ' + Math.round(timeoutMs / 1000) + 's', { code: 'TIMEOUT' });
}

let cachedTarget = null;
async function resolveAfterEffects(force) {
  if (cachedTarget && !force) return cachedTarget;
  const envPath = process.env.CLAUDEAE_AE_PATH;
  const running = await runningAfterEffects();
  if (running) cachedTarget = { ...running, running: true };
  else if (envPath) cachedTarget = isMac ? { app: envPath, running: false } : { exe: envPath, running: false };
  else {
    const inst = installedAfterEffects()[0];
    cachedTarget = inst ? { ...inst, running: false } : null;
  }
  return cachedTarget;
}

/* ------------------------------------------------------------------ bridge */
function readBridgeInfo() {
  const info = readJson(BRIDGE_FILE, null);
  if (!info || !info.port || !info.token) return null;
  return info;
}

function httpJson(info, pathname, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({
      host: '127.0.0.1', port: info.port, path: pathname, method: data ? 'POST' : 'GET',
      headers: Object.assign({ 'Authorization': 'Bearer ' + info.token, 'Host': '127.0.0.1:' + info.port },
        data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch (e) { return reject(new AEError('Bridge returned invalid JSON (HTTP ' + res.statusCode + '): ' + text.slice(0, 300))); }
        if (res.statusCode === 401) return reject(new AEError('Bridge rejected the token — restart After Effects or re-open the ClaudeAE panel', { code: 'AUTH' }));
        resolve(json);
      });
    });
    req.on('error', (e) => reject(new AEError('Bridge not reachable: ' + e.message, { code: e.code || 'BRIDGE_DOWN', transport: 'bridge' })));
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timed out after ' + Math.round(timeoutMs / 1000) + 's')); });
    if (data) req.write(data);
    req.end();
  });
}

/* --------------------------------------------------------------------- cli */
function jsxString(s) {
  return JSON.stringify(String(s).replace(/\\/g, '/')).replace(/[\u007f-\uffff]/g, (c) => '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4));
}

async function waitForFile(file, timeoutMs, isAlive) {
  const start = Date.now();
  let delay = 40;
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(file)) return true;
    if (isAlive && !(await isAlive())) return false;
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 400);
  }
  return false;
}

async function callCli(method, params, timeoutMs) {
  const target = await resolveAfterEffects();
  if (!target) throw new AEError('After Effects was not found. Set CLAUDEAE_AE_PATH to AfterFX.exe (Windows) or the app name (macOS).', { code: 'NO_AE' });
  const dir = tempDir('cli');
  const id = crypto.randomBytes(8).toString('hex');
  const reqFile = path.join(dir, id + '.req.json');
  const resFile = path.join(dir, id + '.res.json');
  const jsxFile = path.join(dir, id + '.jsx');
  fs.writeFileSync(reqFile, JSON.stringify({ method, params: params || {} }), 'utf8');
  const jsx = [
    '(function () {',
    '  var out;',
    '  try {',
    '    if (typeof ClaudeAE === "undefined" || ClaudeAE.__file !== ' + jsxString(ENGINE_PATH) + ' || ClaudeAE.__mtime !== ' + fs.statSync(ENGINE_PATH).mtimeMs + ') {',
    '      $.evalFile(new File(' + jsxString(ENGINE_PATH) + '));',
    '      ClaudeAE.__file = ' + jsxString(ENGINE_PATH) + '; ClaudeAE.__mtime = ' + fs.statSync(ENGINE_PATH).mtimeMs + ';',
    '    }',
    '    var rf = new File(' + jsxString(reqFile) + '); rf.encoding = "UTF-8"; rf.open("r"); var req = rf.read(); rf.close();',
    '    out = ClaudeAE.run(req);',
    // no global JSON here: other extensions in the shared ExtendScript engine may have broken it
    '  } catch (e) { out = \'{"ok":false,"warnings":[],"error":{"message":"ClaudeAE engine failed: \' + String(e).replace(/[^ -~]/g, " ").replace(/["\\\\]/g, "\'") + \' (line \' + e.line + \')"}}\'; }',
    '  var tf = new File(' + jsxString(resFile + '.tmp') + '); tf.encoding = "UTF-8"; tf.open("w"); tf.write(out); tf.close();',
    '  tf.rename(' + jsxString(path.basename(resFile)) + ');',
    '})();',
  ].join('\n');
  fs.writeFileSync(jsxFile, jsx, 'utf8');

  if (isWin) {
    const child = spawn(target.exe, ['-r', jsxFile], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => { });
    child.unref();
  } else if (isMac) {
    const app = target.app || 'Adobe After Effects';
    const child = spawn('osascript', ['-e', `tell application "${app}" to DoScriptFile "${jsxFile.replace(/"/g, '\\"')}"`], { detached: true, stdio: 'ignore' });
    child.on('error', () => { });
    child.unref();
  } else {
    throw new AEError('Command-line transport is only available on Windows and macOS', { code: 'UNSUPPORTED' });
  }
  const wait = timeoutMs;
  const ok = await waitForFile(resFile, wait);
  try { fs.unlinkSync(jsxFile); } catch (_) { }
  try { fs.unlinkSync(reqFile); } catch (_) { }
  if (!ok) {
    cachedTarget = null;
    throw new AEError('After Effects did not answer within ' + Math.round(wait / 1000) + 's (is a modal dialog open, or is AE busy rendering?)', { code: 'TIMEOUT', transport: 'cli' });
  }
  const text = fs.readFileSync(resFile, 'utf8');
  try { fs.unlinkSync(resFile); } catch (_) { }
  try { return JSON.parse(text); } catch (e) { throw new AEError('Engine returned invalid JSON: ' + text.slice(0, 300)); }
}

/* --------------------------------------------------------------- transport */
class Transport {
  constructor(opts = {}) {
    this.mode = opts.mode || process.env.CLAUDEAE_TRANSPORT || 'auto';
    this.timeoutMs = opts.timeoutMs || Number(process.env.CLAUDEAE_TIMEOUT_MS) || 120000;
    this.queue = Promise.resolve();
    this.lastTransport = null;
  }

  /** Runs one engine method. Resolves to { result, warnings, transport }; throws AEError on failure. */
  call(method, params, opts = {}) {
    const run = () => this._call(method, params, opts);
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => { });
    return p;
  }

  async _call(method, params, opts) {
    const timeoutMs = opts.timeoutMs || this.timeoutMs;
    let res, transport;
    const info = this.mode !== 'cli' ? readBridgeInfo() : null;
    if (info) {
      try {
        res = await httpJson(info, '/rpc', { method, params: params || {} }, timeoutMs);
        transport = 'bridge';
      } catch (e) {
        const down = e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET' || e.code === 'BRIDGE_DOWN';
        if (this.mode === 'bridge' || !down) throw e;
      }
    } else if (this.mode === 'bridge') {
      throw new AEError('ClaudeAE bridge is not running. Open After Effects (the bridge starts automatically) or Window > Extensions > Claude AE.', { code: 'BRIDGE_DOWN' });
    }
    if (!res && !(await isAeRunning())) {
      if (opts.launch === false || process.env.CLAUDEAE_AUTOLAUNCH === '0') {
        throw new AEError('After Effects is not running. Open it (the ClaudeAE bridge starts with it) and try again.', { code: 'NOT_RUNNING' });
      }
      const target = await resolveAfterEffects(true);
      if (!target) throw new AEError('After Effects was not found. Set CLAUDEAE_AE_PATH to AfterFX.exe (Windows) or the app name (macOS).', { code: 'NO_AE' });
      const via = await launchAfterEffects(target);
      cachedTarget = null;
      if (via === 'bridge' && this.mode !== 'cli') {
        res = await httpJson(readBridgeInfo(), '/rpc', { method, params: params || {} }, timeoutMs);
        transport = 'bridge';
      }
    }
    if (!res) {
      res = await callCli(method, params, timeoutMs);
      transport = 'cli';
    }
    this.lastTransport = transport;
    if (!res.ok) {
      const err = res.error || {};
      throw new AEError(err.message || 'Unknown After Effects error', { line: err.line, warnings: res.warnings || [], transport, code: 'ENGINE' });
    }
    return { result: res.result, warnings: res.warnings || [], transport };
  }

  async status() {
    const info = readBridgeInfo();
    let bridge = { running: false };
    if (info) {
      try {
        const health = await httpJson(info, '/health', undefined, 3000);
        bridge = { running: true, port: info.port, version: health.version, extension: health.extension };
      } catch (e) {
        bridge = { running: false, port: info.port, error: e.message };
      }
    }
    const target = await resolveAfterEffects(true);
    return { bridge, afterEffects: target, mode: this.mode };
  }
}

module.exports = { Transport, AEError, resolveAfterEffects, installedAfterEffects, runningAfterEffects, isAeRunning, launchAfterEffects, readBridgeInfo, httpJson };
