'use strict';
// Security checks against the live ClaudeAE bridge (After Effects must be running with the extension).
const http = require('http');
const { readBridgeInfo } = require('../../lib/transport');
const { test, run, assert } = require('./harness');

const info = readBridgeInfo();
function req({ method = 'GET', path = '/health', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: info.port, path, method, headers: Object.assign({ Host: '127.0.0.1:' + info.port }, headers) }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}
const auth = () => ({ Authorization: 'Bearer ' + info.token });

test('bridge file exists and only binds to loopback', async () => {
  assert.ok(info && info.port && info.token && info.token.length >= 32, 'bridge.json with a long token');
});
test('missing or wrong token → 401', async () => {
  assert.strictEqual((await req()).status, 401);
  assert.strictEqual((await req({ headers: { Authorization: 'Bearer nope' } })).status, 401);
  assert.strictEqual((await req({ method: 'POST', path: '/rpc', headers: { Authorization: 'Bearer ' + info.token.slice(0, -1) + 'x' }, body: '{"method":"ping"}' })).status, 401);
});
test('browser requests (Origin header) are refused even with the token', async () => {
  const r = await req({ method: 'POST', path: '/rpc', headers: Object.assign({ Origin: 'https://evil.example', 'Content-Type': 'application/json' }, auth()), body: '{"method":"ping"}' });
  assert.strictEqual(r.status, 403);
});
test('DNS-rebinding Host headers are refused', async () => {
  const r = await req({ headers: Object.assign({}, auth(), { Host: 'evil.example:' + info.port }) });
  assert.strictEqual(r.status, 403);
});
test('authorised health + rpc work; bad bodies are 400', async () => {
  const h = await req({ headers: auth() });
  assert.strictEqual(h.status, 200);
  assert.strictEqual(JSON.parse(h.body).ok, true);
  const p = await req({ method: 'POST', path: '/rpc', headers: Object.assign({ 'Content-Type': 'application/json' }, auth()), body: '{"method":"ping","params":{}}' });
  assert.strictEqual(p.status, 200);
  assert.ok(/^\d+\./.test(JSON.parse(p.body).result.version));
  assert.strictEqual((await req({ method: 'POST', path: '/rpc', headers: auth(), body: 'not json' })).status, 400);
  assert.strictEqual((await req({ method: 'POST', path: '/rpc', headers: auth(), body: '{"params":{}}' })).status, 400);
  assert.strictEqual((await req({ path: '/nope', headers: auth() })).status, 404);
});
test('engine survives hostile params (no code injection through JSON)', async () => {
  const body = JSON.stringify({ method: 'get_comp', params: { comp: '"); app.quit(); ("' } });
  const r = JSON.parse((await req({ method: 'POST', path: '/rpc', headers: auth(), body })).body);
  assert.strictEqual(r.ok, false);
  assert.match(r.error.message, /Composition not found/);
  const u = JSON.parse((await req({ method: 'POST', path: '/rpc', headers: auth(), body: JSON.stringify({ method: 'get_comp', params: { comp: 'line sep x "q" \\ ünï 😀' } }) })).body);
  assert.match(u.error.message, /Composition not found: line/);
});

(async () => {
  if (!info) { console.log('No bridge running (start After Effects with the ClaudeAE extension).'); process.exit(1); }
  const res = await run();
  process.exit(res.fail ? 1 : 0);
})();
