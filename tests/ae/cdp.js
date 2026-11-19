'use strict';
// Tiny Chrome DevTools Protocol client for driving the CEP panel in tests (Node >= 22: global WebSocket).
const http = require('http');
const fs = require('fs');

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(c).toString('utf8'))); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function connect(port, titleMatch) {
  const targets = await getJson('http://localhost:' + port + '/json/list');
  const t = targets.find((x) => x.type === 'page' && (!titleMatch || titleMatch.test(x.title)));
  if (!t) throw new Error('No debug target on port ' + port);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  const log = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      const p = pending.get(d.id);
      pending.delete(d.id);
      if (d.error) p.reject(new Error(d.error.message)); else p.resolve(d.result);
      return;
    }
    if (d.method === 'Runtime.consoleAPICalled') log.push({ type: d.params.type, text: d.params.args.map((a) => a.value !== undefined ? String(a.value) : a.description || '').join(' ') });
    if (d.method === 'Runtime.exceptionThrown') log.push({ type: 'exception', text: (d.params.exceptionDetails.exception && d.params.exceptionDetails.exception.description) || d.params.exceptionDetails.text });
    listeners.forEach((l) => l(d));
  };
  const send = (method, params) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
  async function evaluate(expression) {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('Evaluation failed: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result.value;
  }
  async function screenshot(file) {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }
  async function waitFor(expression, ms = 30000, interval = 250) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try { const v = await evaluate(expression); if (v) return v; } catch (_) { }
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error('Timed out waiting for: ' + expression);
  }
  await send('Runtime.enable');
  await send('Page.enable');
  return { send, evaluate, screenshot, waitFor, log, close: () => ws.close(), on: (fn) => listeners.push(fn) };
}

module.exports = { connect, getJson };
