'use strict';
/*
 * Headless Chrome / Edge launcher + a small Chrome DevTools Protocol client.
 * Works on Node 18+ (falls back to a built-in WebSocket client when globalThis.WebSocket is missing).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');

function findBrowser(custom) {
  const c = [custom, process.env.CLAUDEAE_BROWSER];
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files', pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', la = process.env.LOCALAPPDATA || '';
    c.push(path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(la, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  } else if (process.platform === 'darwin') {
    c.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else {
    c.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge');
  }
  return c.find((p) => p && fs.existsSync(p)) || null;
}

/* ------------------------------------------------ minimal WebSocket client */
class MiniWebSocket {
  constructor(url) {
    const u = new URL(url);
    this.onmessage = null; this.onopen = null; this.onerror = null; this.onclose = null;
    this.buf = Buffer.alloc(0); this.frags = [];
    const key = crypto.randomBytes(16).toString('base64');
    this.sock = net.connect(Number(u.port), u.hostname, () => {
      this.sock.write('GET ' + u.pathname + u.search + ' HTTP/1.1\r\nHost: ' + u.host + '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    let handshake = true;
    this.sock.on('data', (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      if (handshake) {
        const i = this.buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        const head = this.buf.slice(0, i).toString();
        if (!/ 101 /.test(head.split('\r\n')[0])) { this.onerror && this.onerror(new Error('WebSocket handshake failed: ' + head.split('\r\n')[0])); return; }
        this.buf = this.buf.slice(i + 4);
        handshake = false;
        this.onopen && this.onopen();
      }
      this._parse();
    });
    this.sock.on('error', (e) => this.onerror && this.onerror(e));
    this.sock.on('close', () => this.onclose && this.onclose());
  }
  _parse() {
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      let len = b1 & 127, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (this.buf.length < off + len) return;
      const payload = this.buf.slice(off, off + len);
      this.buf = this.buf.slice(off + len);
      const op = b0 & 15, fin = b0 & 128;
      if (op === 8) { this.sock.end(); return; }
      if (op === 9) { this._send(10, payload); continue; }
      if (op === 1 || op === 2 || op === 0) {
        this.frags.push(payload);
        if (fin) { const msg = Buffer.concat(this.frags).toString('utf8'); this.frags = []; this.onmessage && this.onmessage({ data: msg }); }
      }
    }
  }
  _send(op, data) {
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const mask = crypto.randomBytes(4);
    let head;
    if (payload.length < 126) { head = Buffer.alloc(2); head[1] = 0x80 | payload.length; }
    else if (payload.length < 65536) { head = Buffer.alloc(4); head[1] = 0x80 | 126; head.writeUInt16BE(payload.length, 2); }
    else { head = Buffer.alloc(10); head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(payload.length), 2); }
    head[0] = 0x80 | op;
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
    this.sock.write(Buffer.concat([head, mask, masked]));
  }
  send(text) { this._send(1, text); }
  close() { try { this._send(8, Buffer.alloc(0)); this.sock.end(); } catch (_) { } }
}

/* ----------------------------------------------------------------- CDP */
class CDPSession {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.onmessage = (m) => {
      const d = JSON.parse(typeof m.data === 'string' ? m.data : m.data.toString());
      if (d.id !== undefined && this.pending.has(d.id)) {
        const p = this.pending.get(d.id); this.pending.delete(d.id);
        if (d.error) p.reject(new Error(d.error.message + (d.error.data ? ' (' + d.error.data + ')' : ''))); else p.resolve(d.result);
      } else if (d.method) {
        const key = (d.sessionId || '') + '|' + d.method;
        (this.handlers.get(key) || []).concat(this.handlers.get('|' + d.method) || []).forEach((h) => h(d.params, d.sessionId));
      }
    };
  }
  send(method, params, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      const msg = { id, method, params: params || {} };
      if (sessionId) msg.sessionId = sessionId;
      this.ws.send(JSON.stringify(msg));
    });
  }
  on(method, fn, sessionId) {
    const key = (sessionId || '') + '|' + method;
    if (!this.handlers.has(key)) this.handlers.set(key, []);
    this.handlers.get(key).push(fn);
  }
  close() { try { this.ws.close(); } catch (_) { } }
}

function openWebSocket(url) {
  return new Promise((resolve, reject) => {
    const WS = typeof globalThis.WebSocket === 'function' ? globalThis.WebSocket : MiniWebSocket;
    const ws = new WS(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(e instanceof Error ? e : new Error('WebSocket error'));
  });
}

/** Launches headless Chrome/Edge and returns { cdp, browserProcess, close() }. */
async function launch({ executable, width = 1920, height = 1080, timeoutMs = 30000 } = {}) {
  const exe = findBrowser(executable);
  if (!exe) throw new Error('Google Chrome or Microsoft Edge is needed to read HTML motion (none found). Install Chrome or set CLAUDEAE_BROWSER.');
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeae-chrome-'));
  const args = ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + userDir, '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--allow-file-access-from-files', '--disable-extensions', '--force-color-profile=srgb', '--window-size=' + width + ',' + height, 'about:blank'];
  const proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  const wsUrl = await new Promise((resolve, reject) => {
    let err = '';
    const t = setTimeout(() => reject(new Error('Headless browser did not start: ' + err.slice(-300))), timeoutMs);
    proc.stderr.on('data', (d) => {
      err += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
      if (m) { clearTimeout(t); resolve(m[1]); }
    });
    proc.on('exit', (c) => { clearTimeout(t); reject(new Error('Headless browser exited (' + c + '): ' + err.slice(-300))); });
  });
  const ws = await openWebSocket(wsUrl);
  const cdp = new CDPSession(ws);
  const close = async () => {
    try { await cdp.send('Browser.close'); } catch (_) { }
    cdp.close();
    try { proc.kill(); } catch (_) { }
    setTimeout(() => { try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (_) { } }, 1500);
  };
  return { cdp, proc, exe, close };
}

/** Creates a page target and returns helpers bound to its session. */
async function newPage(cdp, { width, height }) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (m, p) => cdp.send(m, p, sessionId);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  const consoleErrors = [];
  cdp.on('Runtime.exceptionThrown', (p) => consoleErrors.push((p.exceptionDetails.exception && p.exceptionDetails.exception.description) || p.exceptionDetails.text), sessionId);
  cdp.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error') consoleErrors.push(p.args.map((a) => a.value || a.description || '').join(' ')); }, sessionId);
  async function evaluate(expression, { awaitPromise = true } = {}) {
    const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error('Page script error: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    return r.result.value;
  }
  async function navigate(url, loadTimeout = 30000) {
    const loaded = new Promise((resolve) => {
      const t = setTimeout(resolve, loadTimeout);
      cdp.on('Page.loadEventFired', () => { clearTimeout(t); resolve(); }, sessionId);
    });
    const r = await send('Page.navigate', { url });
    if (r.errorText) throw new Error('Could not open ' + url + ': ' + r.errorText);
    await loaded;
  }
  return { send, evaluate, navigate, consoleErrors, sessionId, targetId };
}

module.exports = { findBrowser, launch, newPage, MiniWebSocket };
