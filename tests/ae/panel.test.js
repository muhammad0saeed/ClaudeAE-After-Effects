'use strict';
/*
 * Drives the real Claude AE panel inside After Effects through Chrome DevTools (CEP remote debugging,
 * port 8197 from extension/.debug). After Effects must be running with the panel open.
 *   node tests/ae/panel.test.js [--shots <dir>]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { connect } = require('./cdp');
const { test, run, assert } = require('./harness');

const shotIdx = process.argv.indexOf('--shots');
const SHOTS = shotIdx > 0 ? path.resolve(process.argv[shotIdx + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'claudeae-panel-'));
fs.mkdirSync(SHOTS, { recursive: true });
const SETTINGS = path.join(os.homedir(), '.claudeae', 'settings.json');
const savedSettings = fs.existsSync(SETTINGS) ? fs.readFileSync(SETTINGS, 'utf8') : null;
let p;
const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const click = (sel) => p.evaluate(`${q(sel)}.click(), true`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('panel loads without errors and connects to the bridge', async () => {
  p = await connect(8197, /Claude AE/);
  await p.send('Page.reload', { ignoreCache: true });
  await sleep(3000);
  await p.waitFor(`document.readyState === 'complete' && ${q('#statusText')}`);
  await p.waitFor(`/Connected/.test(${q('#statusText')}.textContent)`, 20000);
  await sleep(1500);
  const errors = p.log.filter((l) => l.type === 'exception' || l.type === 'error');
  assert.deepStrictEqual(errors, [], 'console errors: ' + JSON.stringify(errors));
  assert.ok(await p.evaluate(`${q('#chatNotice')}.classList.contains('hidden')`), 'no warning notice: ' + await p.evaluate(`${q('#chatNotice')}.textContent`));
  await p.screenshot(path.join(SHOTS, '1-chat.png'));
});

test('Connect tab shows bridge, Node.js, Claude Code and Desktop status', async () => {
  await click('.tab[data-tab="connect"]');
  await p.waitFor(`!/checking/.test(${q('#nodeInfo')}.textContent)`, 15000);
  const node = await p.evaluate(`${q('#nodeInfo')}.textContent`);
  assert.match(node, /^v\d+/);
  assert.match(await p.evaluate(`${q('#bridgeInfo')}.textContent`), /127\.0\.0\.1:\d+/);
  await p.waitFor(`!/checking/.test(${q('#ccInfo')}.textContent)`, 30000);
  const cc = await p.evaluate(`${q('#ccInfo')}.textContent`);
  assert.match(cc, /signed in|not signed in|not found/);
  const snippet = JSON.parse(await p.evaluate(`${q('#mcpSnippet')}.textContent`));
  assert.ok(fs.existsSync(snippet.mcpServers.claudeae.args[0]), 'snippet points at mcp-server/index.js');
  console.log('      node ' + node + ' · claude code: ' + cc + ' · desktop: ' + await p.evaluate(`${q('#desktopInfo')}.textContent`));
  await p.screenshot(path.join(SHOTS, '2-connect.png'));
});

test('Import tab: examples list and pasted spec import', async () => {
  await click('.tab[data-tab="import"]');
  const n = await p.evaluate(`document.querySelectorAll('#examples button').length`);
  assert.ok(n >= 3, 'examples listed');
  const spec = { name: 'Panel Paste Test', width: 640, height: 360, fps: 24, duration: 2, backgroundColor: '#112233', layers: [{ type: 'text', name: 'Hi', text: { content: 'Pasted!', fontSize: 60, color: '#ffffff' }, transform: { position: [320, 180] } }] };
  await p.evaluate(`${q('input[name=target][value=new]')}.checked = true; ${q('#pasteBox')}.value = ${JSON.stringify(JSON.stringify(spec))}; true`);
  await click('#importPaste');
  await p.waitFor(`${q('#importLog .entry')} && !${q('#importLog .entry')}.classList.contains('run')`, 30000);
  const cls = await p.evaluate(`${q('#importLog .entry')}.className`);
  const txt = await p.evaluate(`${q('#importLog .entry')}.textContent`);
  assert.match(cls, /ok/, txt);
  assert.match(txt, /1 comp .*Panel Paste Test.*1 layer/);
  await p.screenshot(path.join(SHOTS, '3-import.png'));
});

test('Import tab: pasted SVG becomes a comp with shape layers', async () => {
  await p.evaluate(`${q('#pasteBox')}.value = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" rx="24" fill="#0ea5e9"/><circle cx="150" cy="100" r="50" fill="#fff"/></svg>'; true`);
  await click('#importPaste');
  await sleep(300);
  await p.waitFor(`!${q('#importLog .entry')}.classList.contains('run')`, 30000);
  const txt = await p.evaluate(`${q('#importLog .entry')}.textContent`);
  assert.match(txt, /Pasted SVG — .*layer/, txt);
});

test('Import tab: HTML motion example converts through the panel', async () => {
  await p.evaluate(`${q('input[name=target][value=new]')}.checked = true; true`);
  const has = await p.evaluate(`Array.from(document.querySelectorAll('#examples button')).some((b) => b.dataset.file === 'html/launch.html')`);
  assert.ok(has, 'html example listed');
  await p.evaluate(`Array.from(document.querySelectorAll('#examples button')).find((b) => b.dataset.file === 'html/launch.html').click(), true`);
  await sleep(500);
  await p.waitFor(`!${q('#importLog .entry')}.classList.contains('run')`, 180000, 500);
  const txt = await p.evaluate(`${q('#importLog .entry')}.textContent`);
  assert.match(txt, /launch\.html — 1 comp .*\d+ layers/, txt);
  await p.screenshot(path.join(SHOTS, '3b-import-html.png'));
});

// ---- chat against a mock Claude API, executing real After Effects tools through the bridge
function sse(events) { return events.map((e) => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n').join(''); }
function msg(blocks, stop) {
  const ev = [{ type: 'message_start', message: { id: 'msg_x', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } }];
  blocks.forEach((b, i) => {
    if (b.type === 'text') { ev.push({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } }); ev.push({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: b.text } }); }
    else { ev.push({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } }); ev.push({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } }); }
    ev.push({ type: 'content_block_stop', index: i });
  });
  ev.push({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 9 } });
  ev.push({ type: 'message_stop' });
  return sse(ev);
}
let mock, mockRequests = [];

test('Chat (API backend, mocked model): Claude builds a comp in AE and looks at a frame', async () => {
  const script = [
    () => msg([{ type: 'text', text: 'Creating the comp.' }, { type: 'tool_use', id: 'tu1', name: 'ae_create_comp', input: { name: 'Chat Built Comp', width: 800, height: 450, duration: 3, backgroundColor: '#1e1b4b', folder: 'ClaudeAE Panel Test', layers: [{ type: 'text', name: 'Headline', text: { content: 'Made from chat', fontSize: 64, color: '#ffffff' }, transform: { position: [400, 225], opacity: [{ t: 0, v: 0, ease: 'easeOutCubic' }, { t: 0.6, v: 100 }] } }] } }], 'tool_use'),
    () => msg([{ type: 'tool_use', id: 'tu2', name: 'ae_render_frame', input: { comp: 'Chat Built Comp', time: 1, maxSize: 400 } }], 'tool_use'),
    (body) => {
      const last = body.messages[body.messages.length - 1].content[0];
      const sawImage = Array.isArray(last.content) && last.content.some((c) => c.type === 'image');
      return msg([{ type: 'text', text: sawImage ? 'Done — **Chat Built Comp** with a fading headline.' : 'NO IMAGE' }], 'end_turn');
    },
  ];
  mock = http.createServer((req, res) => {
    const c = [];
    req.on('data', (d) => c.push(d));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(c).toString('utf8'));
      mockRequests.push(body);
      const step = script[mockRequests.length - 1];
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(step ? step(body) : msg([{ type: 'text', text: 'extra call' }], 'end_turn'));
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  await click('.tab[data-tab="connect"]');
  await p.evaluate(`process.env.CLAUDEAE_API_BASE_URL = 'http://127.0.0.1:${mock.address().port}'; true`);
  await p.evaluate(`${q('#backend')}.value = 'api'; ${q('#backend')}.dispatchEvent(new Event('change')); ${q('#apiKey')}.value = 'sk-ant-test-panel'; ${q('#model')}.value = 'claude-opus-5-5'; true`);
  await click('#saveSettings');
  await click('#newChat');
  await sleep(500);
  await click('.tab[data-tab="chat"]');
  // the agent may already be running from the Connect tab; restart it so it inherits the mock URL
  await p.evaluate(`${q('#prompt')}.value = 'Make a title card'; true`);
  await click('#send');
  await p.waitFor(`document.querySelectorAll('.msg.assistant .tool.ok').length >= 2 && !document.querySelector('.msg.assistant .thinking')`, 90000, 500);
  const text = await p.evaluate(`Array.from(document.querySelectorAll('.msg.assistant .text')).map(e => e.textContent).join(' ')`);
  assert.match(text, /Done — Chat Built Comp/);
  assert.ok(await p.evaluate(`!!document.querySelector('.msg.assistant img.frame')`), 'rendered frame shown in chat');
  assert.ok(mockRequests[0].messages[0].content[0].text.includes('<ae_context>'), 'timeline context attached');
  await p.screenshot(path.join(SHOTS, '4-chat-api.png'));
});

test('Activity tab lists bridge/panel commands with undo', async () => {
  await click('.tab[data-tab="activity"]');
  const n = await p.evaluate(`document.querySelectorAll('#activity li').length`);
  assert.ok(n > 3, 'activity entries: ' + n);
  await p.screenshot(path.join(SHOTS, '5-activity.png'));
});

test('Chat (Claude Code backend) without sign-in shows a sign-in prompt', async () => {
  await click('.tab[data-tab="connect"]');
  await p.evaluate(`${q('#backend')}.value = 'claude-code'; ${q('#backend')}.dispatchEvent(new Event('change')); ${q('#apiKey')}.value = ''; true`);
  await click('#saveSettings');
  await click('.tab[data-tab="chat"]');
  await click('#newChat');
  await p.evaluate(`${q('#prompt')}.value = 'hello'; true`);
  await click('#send');
  await p.waitFor(`!${q('#chatNotice')}.classList.contains('hidden') || /signed in/.test(document.querySelector('.msg.assistant') ? document.querySelector('.msg.assistant').textContent : '')`, 90000, 500);
  const notice = await p.evaluate(`${q('#chatNotice')}.textContent`);
  const reply = await p.evaluate(`(document.querySelector('.msg.assistant') || {}).textContent || ''`);
  console.log('      notice: ' + notice.slice(0, 120));
  assert.ok(/sign/i.test(notice) || reply.length > 0, 'shows sign-in guidance or a reply');
  await p.screenshot(path.join(SHOTS, '6-chat-claude-code.png'));
});

(async () => {
  const res = await run(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : undefined);
  // restore the user's panel settings and remove test content
  try { if (savedSettings === null) fs.rmSync(SETTINGS, { force: true }); else fs.writeFileSync(SETTINGS, savedSettings); } catch (_) { }
  try {
    const { Transport } = require('../../lib/transport');
    await new Transport().call('run_script', { code: '(function(){ var names = ["ClaudeAE Panel Test", "Panel Paste Test", "ClaudeAE Imports", "ClaudeAE Launch"]; for (var i = app.project.numItems; i >= 1; i--) { var it = app.project.item(i); if (it instanceof FolderItem) for (var k = 0; k < names.length; k++) if (it.name === names[k]) { it.remove(); break; } } for (var j = app.project.numItems; j >= 1; j--) { var s = app.project.item(j); if (s instanceof FootageItem && s.mainSource instanceof SolidSource && s.usedIn.length === 0) s.remove(); } for (var m = app.project.numItems; m >= 1; m--) { var f = app.project.item(m); if (f instanceof FolderItem && f.numItems === 0 && f.name === "Solids") f.remove(); } return app.project.numItems; })()' });
  } catch (e) { console.log('cleanup: ' + e.message); }
  if (p) { try { await p.evaluate(`location.reload(), true`); } catch (_) { } p.close(); }
  if (mock) mock.close();
  console.log('screenshots in ' + SHOTS);
  process.exit(res.fail ? 1 : 0);
})();
