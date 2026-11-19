#!/usr/bin/env node
'use strict';
/*
 * ClaudeAE MCP server — lets Claude Desktop, Claude Code or any MCP client drive Adobe After Effects.
 * Transport: stdio (newline-delimited JSON-RPC 2.0). No dependencies.
 *
 *   node mcp-server/index.js
 *
 * Environment:
 *   CLAUDEAE_TRANSPORT = auto | bridge | cli   (default auto: CEP bridge if running, else AfterFX -r)
 *   CLAUDEAE_AE_PATH   = path to AfterFX.exe when several versions are installed
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { createTools } = require('../lib/tools');
const { Transport } = require('../lib/transport');
const { ROOT } = require('../lib/paths');

const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = `ClaudeAE connects you to Adobe After Effects running on this computer.
Workflow: ae_status → ae_get_project / ae_get_comp to see the timeline → build or edit → ae_render_frame to look at the result → refine.
- Build whole designs with ae_create_comp (layers inline) or ae_import_motion (multi-comp Claude Motion JSON; read ae_motion_format first for large designs).
- Edit precisely with ae_add_layers, ae_update_layer, ae_set_property (keyframes with eases at exact times: seconds, "12f", or timecode).
- Generate graphics by writing SVG and calling ae_import_svg (becomes editable shape layers), or import files/URLs with ae_import_file at an exact time.
- Every tool call is a single undo step (ae_undo). Use ae_run_script (ExtendScript) for anything not covered.
Coordinates are in pixels from the comp's top-left; shape contents are relative to their layer's position. Layers listed first are on top.`;

const PROMPTS = [
  {
    name: 'motion_design',
    description: 'Design and build an animated composition in After Effects from a short brief.',
    arguments: [{ name: 'brief', description: 'What to make (style, length, format, text, colours…)', required: true }],
    build: (a) => `Design and build this motion piece in After Effects using the ClaudeAE tools: ${a.brief || ''}\n\n` +
      'Plan the composition (size, fps, duration, layers, timing beats) first, read ae_motion_format, build it with ae_import_motion or ae_create_comp, then render 2-3 frames with ae_render_frame to check spacing, legibility and timing, and fix anything that looks off.',
  },
  {
    name: 'edit_timeline',
    description: 'Inspect the active composition and apply an edit.',
    arguments: [{ name: 'change', description: 'What to change on the timeline', required: true }],
    build: (a) => `In the active After Effects composition: ${a.change || ''}\n\nStart with ae_get_comp to understand the layers and timing, make the change with the smallest set of tool calls, then confirm with ae_render_frame.`,
  },
];

const transport = new Transport({ timeoutMs: 300000 });
const { tools, callTool } = createTools({ transport });

function log(...a) { process.stderr.write('[claudeae-mcp] ' + a.join(' ') + '\n'); }
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyError(id, code, message, data) { send({ jsonrpc: '2.0', id, error: Object.assign({ code, message }, data !== undefined ? { data } : {}) }); }

const handlers = {
  initialize(params) {
    const requested = params && params.protocolVersion;
    const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0];
    return {
      protocolVersion,
      capabilities: { tools: { listChanged: false }, prompts: { listChanged: false }, resources: { listChanged: false } },
      serverInfo: { name: 'claudeae', title: 'ClaudeAE — After Effects', version: PKG.version },
      instructions: INSTRUCTIONS,
    };
  },
  ping() { return {}; },
  'tools/list'() {
    return { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) };
  },
  async 'tools/call'(params) {
    const name = params && params.name;
    if (!tools.some((t) => t.name === name)) throw Object.assign(new Error('Unknown tool: ' + name), { rpcCode: -32602 });
    try {
      const out = await callTool(name, (params && params.arguments) || {});
      const content = [];
      if (out.text) content.push({ type: 'text', text: out.text });
      if (out.image) content.push({ type: 'image', data: out.image.data, mimeType: out.image.mimeType });
      return { content };
    } catch (e) {
      const parts = ['Error: ' + (e && e.message ? e.message : String(e))];
      if (e && e.warnings && e.warnings.length) parts.push('Warnings: ' + e.warnings.join(' | '));
      if (e && (e.code === 'BRIDGE_DOWN' || e.code === 'NO_AE' || e.code === 'TIMEOUT')) parts.push('Hint: make sure Adobe After Effects is open. Call ae_status for details.');
      return { content: [{ type: 'text', text: parts.join('\n') }], isError: true };
    }
  },
  'prompts/list'() {
    return { prompts: PROMPTS.map(({ name, description, arguments: args }) => ({ name, description, arguments: args })) };
  },
  'prompts/get'(params) {
    const p = PROMPTS.find((x) => x.name === (params && params.name));
    if (!p) throw Object.assign(new Error('Unknown prompt'), { rpcCode: -32602 });
    return { description: p.description, messages: [{ role: 'user', content: { type: 'text', text: p.build((params && params.arguments) || {}) } }] };
  },
  'resources/list'() {
    return { resources: [{ uri: 'claudeae://docs/claude-motion-format', name: 'Claude Motion format', description: 'Reference for the Claude Motion JSON format', mimeType: 'text/markdown' }] };
  },
  'resources/read'(params) {
    if (!params || params.uri !== 'claudeae://docs/claude-motion-format') throw Object.assign(new Error('Unknown resource'), { rpcCode: -32602 });
    return { contents: [{ uri: params.uri, mimeType: 'text/markdown', text: fs.readFileSync(path.join(ROOT, 'docs', 'CLAUDE_MOTION_FORMAT.md'), 'utf8') }] };
  },
  'resources/templates/list'() { return { resourceTemplates: [] }; },
};

async function handle(msg) {
  if (!msg || msg.jsonrpc !== '2.0') { if (msg && msg.id !== undefined) replyError(msg.id, -32600, 'Invalid request'); return; }
  const isNotification = msg.id === undefined || msg.id === null;
  if (!msg.method) return; // a response to something we never send
  if (msg.method.startsWith('notifications/')) return;
  const h = handlers[msg.method];
  if (!h) { if (!isNotification) replyError(msg.id, -32601, 'Method not found: ' + msg.method); return; }
  try {
    const result = await h(msg.params);
    if (!isNotification) reply(msg.id, result);
  } catch (e) {
    if (!isNotification) replyError(msg.id, e.rpcCode || -32603, e.message || String(e));
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch (e) { replyError(null, -32700, 'Parse error'); return; }
  if (Array.isArray(msg)) { msg.forEach((m) => handle(m)); return; }
  handle(msg);
});
rl.on('close', () => process.exit(0));
process.on('uncaughtException', (e) => log('uncaught:', e && e.stack || e));
process.on('unhandledRejection', (e) => log('unhandled:', e && e.stack || e));
log('ready (v' + PKG.version + ', transport ' + transport.mode + ')');
