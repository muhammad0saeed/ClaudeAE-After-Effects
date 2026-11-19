'use strict';
/*
 * Local HTTP bridge between MCP servers / agents and After Effects.
 * - listens on 127.0.0.1 only, random bearer token per session
 * - rejects browser requests (Origin header) and foreign Host headers (DNS rebinding)
 * - publishes { port, token } in ~/.claudeae/bridge.json (readable only by the user)
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const CONFIG_DIR = process.env.CLAUDEAE_HOME || path.join(os.homedir(), '.claudeae');
const BRIDGE_FILE = path.join(CONFIG_DIR, 'bridge.json');
const MAX_BODY = 256 * 1024 * 1024;

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

class BridgeServer {
  constructor({ engine, version, host = 'cep', onActivity, log }) {
    this.engine = engine;
    this.version = version;
    this.hostKind = host;
    this.onActivity = onActivity || (() => { });
    this.log = log || (() => { });
    this.server = null;
    this.port = 0;
    this.token = crypto.randomBytes(24).toString('hex');
    this.startedAt = new Date().toISOString();
    this.requests = 0;
  }

  start(preferredPort = 48760, attempts = 20) {
    return new Promise((resolve, reject) => {
      let port = preferredPort, tries = 0;
      const tryListen = () => {
        const srv = http.createServer((req, res) => this.handle(req, res));
        srv.on('error', (e) => {
          if ((e.code === 'EADDRINUSE' || e.code === 'EACCES') && ++tries < attempts) { port++; tryListen(); }
          else reject(e);
        });
        srv.listen(port, '127.0.0.1', () => {
          this.server = srv;
          this.port = port;
          this.publish();
          this.log('listening on 127.0.0.1:' + port);
          resolve(port);
        });
      };
      tryListen();
    });
  }

  publish() {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const info = { port: this.port, token: this.token, pid: process.pid, version: this.version, host: this.hostKind, startedAt: this.startedAt };
    const tmp = BRIDGE_FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(info, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, BRIDGE_FILE);
  }

  stop() {
    try { if (this.server) this.server.close(); } catch (_) { }
    try {
      const cur = JSON.parse(fs.readFileSync(BRIDGE_FILE, 'utf8'));
      if (cur.token === this.token) fs.unlinkSync(BRIDGE_FILE);
    } catch (_) { }
    this.server = null;
  }

  rotateToken() {
    this.token = crypto.randomBytes(24).toString('hex');
    this.publish();
    return this.token;
  }

  send(res, code, obj) {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
    res.end(body);
  }

  handle(req, res) {
    const host = String(req.headers.host || '');
    if (host !== '127.0.0.1:' + this.port && host !== 'localhost:' + this.port) return this.send(res, 403, { ok: false, error: { message: 'Forbidden host' } });
    if (req.headers.origin) return this.send(res, 403, { ok: false, error: { message: 'Browser requests are not allowed' } });
    const auth = String(req.headers.authorization || '');
    if (!auth.startsWith('Bearer ') || !safeEqual(auth.slice(7), this.token)) return this.send(res, 401, { ok: false, error: { message: 'Unauthorized' } });

    if (req.method === 'GET' && req.url === '/health') {
      return this.send(res, 200, { ok: true, version: this.version, extension: this.hostKind, port: this.port, requests: this.requests, startedAt: this.startedAt });
    }
    if (req.method === 'POST' && req.url === '/rpc') {
      const chunks = [];
      let size = 0, aborted = false;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { aborted = true; this.send(res, 413, { ok: false, error: { message: 'Request too large' } }); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', async () => {
        if (aborted) return;
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return this.send(res, 400, { ok: false, error: { message: 'Invalid JSON body' } }); }
        if (!body || typeof body.method !== 'string') return this.send(res, 400, { ok: false, error: { message: 'Missing "method"' } });
        this.requests++;
        const t0 = Date.now();
        let reply;
        try { reply = await this.engine.call(body.method, body.params || {}); }
        catch (e) { reply = { ok: false, error: { message: e.message || String(e) }, warnings: [] }; }
        const ms = Date.now() - t0;
        try { this.onActivity({ source: body.source || 'mcp', method: body.method, ok: !!reply.ok, ms, error: reply.ok ? undefined : reply.error && reply.error.message, warnings: reply.warnings || [], time: Date.now() }); } catch (_) { }
        this.send(res, 200, reply);
      });
      return;
    }
    this.send(res, 404, { ok: false, error: { message: 'Not found' } });
  }
}

function readBridgeFile() {
  try { return JSON.parse(fs.readFileSync(BRIDGE_FILE, 'utf8')); } catch (_) { return null; }
}

function checkBridge(info, timeoutMs = 1500) {
  return new Promise((resolve) => {
    if (!info || !info.port) return resolve(null);
    const req = http.request({ host: '127.0.0.1', port: info.port, path: '/health', method: 'GET', headers: { Authorization: 'Bearer ' + info.token, Host: '127.0.0.1:' + info.port } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { try { const j = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(j.ok ? j : null); } catch (_) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

module.exports = { BridgeServer, readBridgeFile, checkBridge, BRIDGE_FILE, CONFIG_DIR };
