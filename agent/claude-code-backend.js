'use strict';
/*
 * Chat backend that runs Claude Code headless (uses the user's Claude account / subscription).
 * One long-lived `claude -p --input-format stream-json` process per conversation; the only tools
 * it gets are the ClaudeAE MCP tools (built-in file/shell tools are disabled).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn, execFile } = require('child_process');
const { findClaude } = require('../lib/locate');
const { SYSTEM_PROMPT } = require('./prompt');

const ROOT = path.resolve(__dirname, '..');
const WORK_DIR = path.join(process.env.CLAUDEAE_HOME || path.join(os.homedir(), '.claudeae'), 'chat');
const PREFIX = 'mcp__claudeae__';

function claudeAuthStatus(exe, prefix) {
  return new Promise((resolve) => {
    execFile(exe, (prefix || []).concat(['auth', 'status', '--json']), { timeout: 20000, windowsHide: true }, (err, stdout) => {
      try { resolve(JSON.parse(String(stdout))); } catch (_) { resolve({ loggedIn: false, error: err ? err.message : 'unreadable status' }); }
    });
  });
}

/** Opens a visible terminal window running `claude auth login` so the user can sign in. */
function openLoginWindow(exe) {
  if (process.platform === 'win32') {
    const child = spawn('cmd.exe', ['/d', '/c', 'start', '"Claude sign-in"', 'cmd.exe', '/k', '"' + exe + '" auth login'], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true });
    child.unref();
  } else if (process.platform === 'darwin') {
    const script = 'tell application "Terminal" to do script "' + exe.replace(/"/g, '\\"') + ' auth login"\ntell application "Terminal" to activate';
    spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('x-terminal-emulator', ['-e', exe + ' auth login'], { detached: true, stdio: 'ignore' }).unref();
  }
}

class ClaudeCodeBackend {
  constructor({ settings, emit, nodePath }) {
    this.settings = settings || {};
    this.emit = emit;
    this.nodePath = nodePath || process.execPath;
    this.proc = null;
    this.sessionId = null;
    this.pending = null; // { resolve, reject }
    this.streamedText = false;
    this.exe = null;
  }

  locate() {
    // settings.claudeCommand = ["node", "fake-claude.js"] lets tests substitute the CLI
    if (Array.isArray(this.settings.claudeCommand) && this.settings.claudeCommand.length) {
      this.exe = this.settings.claudeCommand[0];
      this.exePrefix = this.settings.claudeCommand.slice(1);
      return this.exe;
    }
    this.exePrefix = [];
    this.exe = findClaude(this.settings.claudePath);
    if (!this.exe) throw Object.assign(new Error('Claude Code was not found. Install it (or the Claude desktop app) or set its path in Connect → Claude inside After Effects.'), { code: 'no_claude' });
    return this.exe;
  }

  writeConfig() {
    fs.mkdirSync(WORK_DIR, { recursive: true });
    const mcpFile = path.join(WORK_DIR, 'mcp.json');
    fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { claudeae: { command: this.nodePath, args: [path.join(ROOT, 'mcp-server', 'index.js')], env: { CLAUDEAE_TRANSPORT: process.env.CLAUDEAE_TRANSPORT || 'auto' } } } }, null, 2));
    const promptFile = path.join(WORK_DIR, 'system-prompt.md');
    fs.writeFileSync(promptFile, SYSTEM_PROMPT);
    return { mcpFile, promptFile };
  }

  ensureProcess() {
    if (this.proc && this.proc.exitCode === null && !this.proc.killed) return;
    const exe = this.locate();
    const { mcpFile, promptFile } = this.writeConfig();
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--mcp-config', mcpFile, '--strict-mcp-config', '--tools', '', '--allowedTools', 'mcp__claudeae',
      '--append-system-prompt-file', promptFile];
    if (this.settings.model) args.push('--model', this.settings.model);
    if (this.settings.effort) args.push('--effort', this.settings.effort);
    if (this.sessionId) args.push('--resume', this.sessionId);
    const proc = spawn(exe, (this.exePrefix || []).concat(args), { cwd: WORK_DIR, env: Object.assign({}, process.env, { CLAUDEAE_TRANSPORT: process.env.CLAUDEAE_TRANSPORT || 'auto' }), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    const stderr = [];
    proc.stderr.on('data', (d) => { stderr.push(String(d)); if (stderr.length > 50) stderr.shift(); });
    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      if (!line.trim()) return;
      let ev;
      try { ev = JSON.parse(line); } catch (_) { this.emit({ type: 'log', message: line.slice(0, 500) }); return; }
      try { this.onEvent(ev); } catch (e) { this.emit({ type: 'log', message: 'event error: ' + e.message }); }
    });
    proc.on('error', (e) => this.finish(Object.assign(new Error('Could not start Claude Code: ' + e.message), { code: 'no_claude' })));
    proc.on('exit', (code) => {
      if (this.proc === proc) this.proc = null;
      if (this.pending) {
        const tail = stderr.join('').trim().split('\n').slice(-4).join('\n');
        if (this.stopping) this.finish(null, { stopReason: 'stopped' });
        else this.finish(Object.assign(new Error('Claude Code exited (code ' + code + ')' + (tail ? ': ' + tail : '')), { code: /log ?in|auth/i.test(tail) ? 'auth' : 'exit' }));
      }
    });
  }

  finish(err, res) {
    const p = this.pending;
    this.pending = null;
    this.stopping = false;
    if (!p) return;
    if (err) p.reject(err); else p.resolve(res);
  }

  onEvent(ev) {
    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init') {
          this.sessionId = ev.session_id || this.sessionId;
          const srv = (ev.mcp_servers || []).find((s) => s.name === 'claudeae');
          if (srv && srv.status !== 'connected') this.emit({ type: 'log', message: 'ClaudeAE MCP server status: ' + srv.status });
          this.emit({ type: 'status', model: ev.model, session: this.sessionId });
        }
        break;
      case 'stream_event': {
        const e = ev.event || {};
        if (e.type === 'message_start') this.streamedText = false;
        if (e.type === 'content_block_delta' && e.delta) {
          if (e.delta.type === 'text_delta') { this.streamedText = true; this.emit({ type: 'text', delta: e.delta.text }); }
          else if (e.delta.type === 'thinking_delta' && e.delta.thinking) this.emit({ type: 'thinking', delta: e.delta.thinking });
        }
        if (e.type === 'content_block_start' && e.content_block && e.content_block.type === 'tool_use') this.emit({ type: 'tool_pending', name: String(e.content_block.name).replace(PREFIX, '') });
        break;
      }
      case 'assistant': {
        // CLI-generated notices (e.g. "Not logged in") arrive as <synthetic> messages and are
        // reported once through the result event instead
        if (ev.message && ev.message.model === '<synthetic>') break;
        const content = (ev.message && ev.message.content) || [];
        for (const b of content) {
          if (b.type === 'tool_use') this.emit({ type: 'tool_start', toolId: b.id, name: String(b.name).replace(PREFIX, ''), input: b.input });
          else if (b.type === 'text' && !this.streamedText && b.text) this.emit({ type: 'text', delta: b.text });
        }
        break;
      }
      case 'user': {
        const content = (ev.message && ev.message.content) || [];
        if (!Array.isArray(content)) break;
        for (const b of content) {
          if (b.type !== 'tool_result') continue;
          const parts = Array.isArray(b.content) ? b.content : [{ type: 'text', text: String(b.content || '') }];
          const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
          const img = parts.find((p) => p.type === 'image');
          const image = img ? (img.source ? { data: img.source.data, mimeType: img.source.media_type } : { data: img.data, mimeType: img.mimeType }) : undefined;
          this.emit({ type: 'tool_end', toolId: b.tool_use_id, ok: !b.is_error, text, image });
        }
        break;
      }
      case 'result': {
        const err = ev.is_error ? String(ev.result || ev.subtype || 'error') : null;
        if (err) {
          const auth = /not logged in|\/login|log ?in|authenticat|oauth/i.test(err);
          this.finish(Object.assign(new Error(auth ? 'Claude Code is not signed in. Click "Sign in…" in Connect → Claude inside After Effects.' : err), { code: auth ? 'auth' : 'claude_code' }));
        } else {
          this.finish(null, { stopReason: ev.subtype, costUsd: ev.total_cost_usd, turns: ev.num_turns });
        }
        break;
      }
      default:
        break;
    }
  }

  /** @param {string|object[]} content  text, or content blocks (text / image / document) */
  send(content) {
    return new Promise((resolve, reject) => {
      try { this.ensureProcess(); } catch (e) { reject(e); return; }
      this.pending = { resolve, reject };
      this.streamedText = false;
      const msg = { type: 'user', message: { role: 'user', content: Array.isArray(content) ? content : [{ type: 'text', text: content }] } };
      this.proc.stdin.write(JSON.stringify(msg) + '\n');
    });
  }

  stop() {
    if (!this.proc) return;
    this.stopping = true;
    try { this.proc.kill(); } catch (_) { }
  }

  reset() {
    this.stop();
    this.sessionId = null;
  }

  async authStatus() {
    const exe = this.locate();
    const st = await claudeAuthStatus(exe, this.exePrefix);
    return Object.assign({ exe }, st);
  }

  login() {
    openLoginWindow(this.locate());
  }
}

module.exports = { ClaudeCodeBackend, claudeAuthStatus, openLoginWindow };
