'use strict';
// Chat agent tests: API backend against a mock Messages API (SSE), Claude Code backend against a fake CLI.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');

const AGENT = path.join(__dirname, '..', '..', 'agent', 'agent.js');
const FAKE_CLAUDE = path.join(__dirname, 'fixtures', 'fake-claude.js');

function sse(events) {
  return events.map((e) => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n').join('');
}
function message(blocks, stopReason, extra) {
  const ev = [{ type: 'message_start', message: { id: 'msg_' + Math.random().toString(36).slice(2), type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }];
  blocks.forEach((b, i) => {
    if (b.type === 'text') {
      ev.push({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } });
      ev.push({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: b.text } });
    } else if (b.type === 'tool_use') {
      ev.push({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      ev.push({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    }
    ev.push({ type: 'content_block_stop', index: i });
  });
  ev.push(Object.assign({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 20 } }, extra || {}));
  ev.push({ type: 'message_stop' });
  return sse(ev);
}

function mockApi(script) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push({ url: req.url, headers: req.headers, body });
      const step = script[requests.length - 1];
      if (!step) { res.writeHead(500); res.end('{}'); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(step(body));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: 'http://127.0.0.1:' + server.address().port })));
}

function startAgent(env) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeae-agent-'));
  const proc = spawn(process.execPath, [AGENT], { env: Object.assign({}, process.env, { CLAUDEAE_HOME: home, CLAUDEAE_TRANSPORT: 'bridge', ANTHROPIC_API_KEY: '' }, env), stdio: ['pipe', 'pipe', 'pipe'] });
  const events = [];
  const waiters = [];
  readline.createInterface({ input: proc.stdout }).on('line', (l) => {
    const ev = JSON.parse(l);
    events.push(ev);
    waiters.slice().forEach((w) => { if (w.pred(ev)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(ev); } });
  });
  const send = (m) => proc.stdin.write(JSON.stringify(m) + '\n');
  const waitFor = (pred, ms = 15000) => new Promise((resolve, reject) => {
    const found = events.find(pred);
    if (found) return resolve(found);
    const t = setTimeout(() => reject(new Error('timeout; events: ' + JSON.stringify(events.map((e) => e.type)))), ms);
    waiters.push({ pred, resolve: (e) => { clearTimeout(t); resolve(e); } });
  });
  return { proc, events, send, waitFor, close: () => { proc.stdin.end(); proc.kill(); } };
}

test('API backend: streams text, runs tools, sends results back, uses fallbacks + eager streaming', async () => {
  const api = await mockApi([
    () => message([{ type: 'text', text: 'Reading the format.' }, { type: 'tool_use', id: 'toolu_1', name: 'ae_motion_format', input: {} }], 'tool_use'),
    (body) => {
      const last = body.messages[body.messages.length - 1];
      const tr = last.content.find((c) => c.type === 'tool_result');
      return message([{ type: 'text', text: tr && /Claude Motion format/.test(JSON.stringify(tr.content)) ? 'Got it.' : 'MISSING RESULT' }], 'end_turn');
    },
  ]);
  const a = startAgent({ CLAUDEAE_API_BASE_URL: api.url });
  try {
    await a.waitFor((e) => e.type === 'ready');
    a.send({ type: 'configure', settings: { backend: 'api', apiKey: 'sk-test', model: 'claude-opus-5-5', effort: 'high' } });
    a.send({ type: 'user', id: 1, text: 'hello', context: { activeComp: { name: 'Main' } } });
    const end = await a.waitFor((e) => e.type === 'turn_end');
    assert.strictEqual(end.stopReason, 'end_turn');
    const text = a.events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
    assert.strictEqual(text, 'Reading the format.Got it.');
    const ts = a.events.find((e) => e.type === 'tool_start');
    assert.strictEqual(ts.name, 'ae_motion_format');
    assert.ok(a.events.find((e) => e.type === 'tool_end' && e.ok));
    const r0 = api.requests[0];
    assert.match(r0.url, /\/v1\/messages/);
    assert.match(String(r0.headers['anthropic-beta']), /server-side-fallback-2026-07-01/);
    assert.strictEqual(r0.body.fallbacks, 'default');
    assert.strictEqual(r0.body.model, 'claude-opus-5-5');
    assert.deepStrictEqual(r0.body.thinking, { type: 'adaptive', display: 'summarized' });
    assert.strictEqual(r0.body.output_config.effort, 'high');
    assert.ok(r0.body.tools.every((t) => t.eager_input_streaming === true));
    assert.match(r0.body.messages[0].content[0].text, /<ae_context>[\s\S]*"Main"[\s\S]*<\/ae_context>\s+hello/);
    // history is append-only: request 2 starts with request 1's messages
    assert.deepStrictEqual(api.requests[1].body.messages[0], r0.body.messages[0]);
  } finally { a.close(); api.server.close(); }
});

test('API backend: invalid tool input becomes an error tool_result; haiku gets no fallbacks', async () => {
  const api = await mockApi([
    () => message([{ type: 'tool_use', id: 'toolu_x', name: 'ae_get_layer', input: { comp: 'Main' } }], 'tool_use'),
    (body) => {
      const tr = body.messages[body.messages.length - 1].content[0];
      return message([{ type: 'text', text: tr.is_error && /INVALID_JSON/.test(tr.content) ? 'ok-invalid' : 'bad' }], 'end_turn');
    },
  ]);
  const a = startAgent({ CLAUDEAE_API_BASE_URL: api.url });
  try {
    a.send({ type: 'configure', settings: { backend: 'api', apiKey: 'sk-test', model: 'claude-haiku-5-5' } });
    a.send({ type: 'user', id: 2, text: 'inspect' });
    await a.waitFor((e) => e.type === 'turn_end');
    assert.strictEqual(a.events.filter((e) => e.type === 'text').map((e) => e.delta).join(''), 'ok-invalid');
    assert.ok(a.events.find((e) => e.type === 'tool_end' && !e.ok && /missing required field "layer"/.test(e.text)));
    assert.strictEqual(api.requests[0].body.fallbacks, undefined);
    assert.ok(!/server-side-fallback/.test(String(api.requests[0].headers['anthropic-beta'] || '')));
  } finally { a.close(); api.server.close(); }
});

test('API backend: refusal and auth errors are reported cleanly', async () => {
  const api = await mockApi([() => message([], 'refusal', { delta: { stop_reason: 'refusal', stop_sequence: null, stop_details: { type: 'refusal', category: 'cyber' } } })]);
  const a = startAgent({ CLAUDEAE_API_BASE_URL: api.url });
  try {
    a.send({ type: 'configure', settings: { backend: 'api', apiKey: 'sk-test' } });
    a.send({ type: 'user', id: 3, text: 'x' });
    const err = await a.waitFor((e) => e.type === 'error');
    assert.strictEqual(err.code, 'refusal');
    await a.waitFor((e) => e.type === 'turn_end');
  } finally { a.close(); api.server.close(); }

  const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const b = startAgent({ CLAUDEAE_API_BASE_URL: 'http://127.0.0.1:' + srv.address().port });
  try {
    b.send({ type: 'configure', settings: { backend: 'api', apiKey: 'sk-bad' } });
    b.send({ type: 'user', id: 4, text: 'x' });
    const err = await b.waitFor((e) => e.type === 'error');
    assert.strictEqual(err.code, 'auth');
    assert.match(err.message, /API key was rejected/);
  } finally { b.close(); srv.close(); }
});

test('Claude Code backend: stream-json events become panel events; tools are stripped of the MCP prefix', async () => {
  const a = startAgent({});
  try {
    a.send({ type: 'configure', settings: { backend: 'claude-code', claudeCommand: [process.execPath, FAKE_CLAUDE], model: 'claude-opus-5-5' } });
    a.send({ type: 'user', id: 5, text: 'build it' });
    const end = await a.waitFor((e) => e.type === 'turn_end');
    assert.strictEqual(end.stopReason, 'success');
    assert.strictEqual(a.events.filter((e) => e.type === 'text').map((e) => e.delta).join(''), 'Building now.Done!');
    const ts = a.events.find((e) => e.type === 'tool_start');
    assert.strictEqual(ts.name, 'ae_get_comp');
    const te = a.events.find((e) => e.type === 'tool_end');
    assert.strictEqual(te.ok, true);
    assert.ok(te.image && te.image.mimeType === 'image/png');
    // second turn reuses the same long-lived process
    a.send({ type: 'user', id: 6, text: 'again' });
    await a.waitFor((e) => e.type === 'turn_end' && e.id === 6);
    const argsSeen = fs.readFileSync(path.join(process.env.CLAUDEAE_FAKE_LOG || path.join(os.tmpdir(), 'fake-claude-args.json')), 'utf8');
    const args = JSON.parse(argsSeen);
    assert.ok(args.includes('--strict-mcp-config') && args.includes('mcp__claudeae') && args.includes('stream-json'));
    const authEv = new Promise((r) => { a.send({ type: 'auth_status' }); r(); });
    await authEv;
    const auth = await a.waitFor((e) => e.type === 'auth');
    assert.strictEqual(auth.loggedIn, true);
  } finally { a.close(); }
});

test('attachments: pictures, scripts and PDFs reach Claude; media import failures are reported', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeae-att-'));
  const script = path.join(dir, 'script.srt');
  fs.writeFileSync(script, '1\n00:00:00,000 --> 00:00:02,000\nCraving something delicious?\n');
  const pdf = path.join(dir, 'brief.pdf');
  fs.writeFileSync(pdf, '%PDF-1.4\n%fake\n');
  const photo = path.join(dir, 'photo.png');
  fs.writeFileSync(photo, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  const msgs = path.join(dir, 'msgs.jsonl');
  // no bridge in this CLAUDEAE_HOME → After Effects is unreachable and media cannot be imported
  const a = startAgent({ CLAUDEAE_FAKE_MSGS: msgs });
  try {
    a.send({ type: 'configure', settings: { backend: 'claude-code', claudeCommand: [process.execPath, FAKE_CLAUDE] } });
    a.send({
      type: 'user', id: 9, text: 'make a promo',
      attachments: [
        { path: photo, name: 'photo.png', kind: 'image', size: 70, preview: { mimeType: 'image/png', data: 'AAAA', width: 1, height: 1 } },
        { path: script, name: 'script.srt', kind: 'text', size: 60 },
        { path: pdf, name: 'brief.pdf', kind: 'pdf', size: 16 },
      ],
    });
    const att = await a.waitFor((e) => e.type === 'attached', 60000);
    const byName = (n) => att.items.find((i) => path.basename(i.path) === n);
    assert.strictEqual(byName('script.srt').ok, true);
    assert.strictEqual(byName('brief.pdf').ok, true);
    assert.strictEqual(byName('photo.png').ok, false); // not imported (no After Effects in this test)
    await a.waitFor((e) => e.type === 'turn_end' && e.id === 9, 30000);
    const sent = JSON.parse(fs.readFileSync(msgs, 'utf8').trim().split('\n')[0]).message.content;
    assert.strictEqual(sent[0].type, 'text');
    assert.match(sent[0].text, /<attachments>/);
    assert.match(sent[0].text, /Craving something delicious\?/);
    assert.match(sent[0].text, /could not be imported/);
    assert.match(sent[0].text, /make a promo$/);
    assert.ok(sent.some((b) => b.type === 'image' && b.source.data === 'AAAA'));
    assert.ok(sent.some((b) => b.type === 'document' && b.source.media_type === 'application/pdf'));
  } finally { a.close(); }
});

test('Claude Code backend: "not logged in" surfaces as an auth error', async () => {
  const a = startAgent({ FAKE_CLAUDE_LOGGED_OUT: '1' });
  try {
    a.send({ type: 'configure', settings: { backend: 'claude-code', claudeCommand: [process.execPath, FAKE_CLAUDE] } });
    a.send({ type: 'user', id: 7, text: 'hi' });
    const err = await a.waitFor((e) => e.type === 'error');
    assert.strictEqual(err.code, 'auth');
    assert.match(err.message, /not signed in/);
  } finally { a.close(); }
});
