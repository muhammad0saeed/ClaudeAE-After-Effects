#!/usr/bin/env node
'use strict';
/*
 * Chat agent for the ClaudeAE panel. Runs under system Node (>= 18), spawned by the panel.
 * Protocol: newline-delimited JSON on stdin (commands) and stdout (events).
 *
 *  in:  {type:"configure", settings:{backend:"claude-code"|"api", model, effort, apiKey, claudePath}}
 *       {type:"user", id, text, context?, attachments?:[{path, name, kind, size, preview?}]}   {type:"stop"}   {type:"reset"}   {type:"auth_status"}   {type:"login"}
 *  out: {type:"ready"} {type:"turn_start"} {type:"text", delta} {type:"thinking", delta} {type:"tool_pending", name}
 *       {type:"tool_start", toolId, name, input} {type:"tool_end", toolId, ok, text, image?} {type:"turn_end", stopReason, ...}
 *       {type:"attached", items:[{path, ok, note}]} {type:"error", message, code} {type:"auth", ...} {type:"log", message}
 */
const readline = require('readline');
const { createTools } = require('../lib/tools');
const { Transport } = require('../lib/transport');
const { ApiBackend } = require('./api-backend');
const { ClaudeCodeBackend } = require('./claude-code-backend');
const { prepareAttachments } = require('./attachments');

function emit(ev) { process.stdout.write(JSON.stringify(ev) + '\n'); }

let settings = {};
let backend = null;
let busy = false;
let toolset = null;

const IDENTITY_KEYS = ['backend', 'model', 'effort', 'apiKey', 'claudePath', 'claudeCommand'];
const identity = (s) => JSON.stringify(IDENTITY_KEYS.map((k) => (s || {})[k]));

function getToolset() {
  if (!toolset) toolset = createTools({ transport: new Transport({ timeoutMs: 300000 }) });
  return toolset;
}

function makeBackend() {
  if (settings.backend === 'api') return new ApiBackend({ settings, toolset: getToolset(), emit });
  return new ClaudeCodeBackend({ settings, emit, nodePath: process.execPath });
}

function formatUser(text, context) {
  if (!context) return text;
  return '<ae_context>\n' + JSON.stringify(context) + '\n</ae_context>\n\n' + text;
}

async function onMessage(m) {
  switch (m.type) {
    case 'configure': {
      const next = m.settings || {};
      if (backend && identity(next) !== identity(settings)) { backend.stop(); backend = null; }
      settings = next;
      emit({ type: 'configured', backend: settings.backend || 'claude-code' });
      break;
    }
    case 'user': {
      if (busy) { emit({ type: 'error', id: m.id, message: 'Still working on the previous message.', code: 'busy' }); return; }
      busy = true;
      emit({ type: 'turn_start', id: m.id });
      try {
        if (!backend) backend = makeBackend();
        let content = formatUser(String(m.text || ''), m.context);
        if (Array.isArray(m.attachments) && m.attachments.length) {
          const att = await prepareAttachments(m.attachments, getToolset());
          emit({ type: 'attached', id: m.id, items: att.items });
          content = [{ type: 'text', text: att.text + '\n\n' + content }].concat(att.blocks);
        }
        const res = await backend.send(content);
        emit(Object.assign({ type: 'turn_end', id: m.id }, res || {}));
      } catch (e) {
        emit({ type: 'error', id: m.id, message: e && e.message ? e.message : String(e), code: e && e.code });
        emit({ type: 'turn_end', id: m.id, stopReason: 'error' });
      } finally {
        busy = false;
      }
      break;
    }
    case 'stop':
      if (backend) backend.stop();
      break;
    case 'reset':
      if (backend) backend.reset();
      backend = null;
      emit({ type: 'reset_done' });
      break;
    case 'auth_status': {
      try {
        const cc = new ClaudeCodeBackend({ settings, emit, nodePath: process.execPath });
        emit(Object.assign({ type: 'auth' }, await cc.authStatus()));
      } catch (e) {
        emit({ type: 'auth', loggedIn: false, error: e.message, code: e.code });
      }
      break;
    }
    case 'login': {
      try { new ClaudeCodeBackend({ settings, emit, nodePath: process.execPath }).login(); emit({ type: 'log', message: 'Opened the Claude sign-in window' }); }
      catch (e) { emit({ type: 'error', message: e.message, code: e.code }); }
      break;
    }
    case 'ping':
      emit({ type: 'pong' });
      break;
    default:
      emit({ type: 'error', message: 'Unknown command ' + m.type });
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let m;
  try { m = JSON.parse(line); } catch (_) { emit({ type: 'error', message: 'Invalid command JSON' }); return; }
  onMessage(m).catch((e) => emit({ type: 'error', message: e.message }));
});
process.stdin.on('end', () => { if (backend) backend.stop(); process.exit(0); });
process.on('uncaughtException', (e) => emit({ type: 'error', message: 'Agent crashed: ' + (e && e.stack || e) }));
emit({ type: 'ready', node: process.version });
