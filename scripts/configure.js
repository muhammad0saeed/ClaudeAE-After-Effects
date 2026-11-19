#!/usr/bin/env node
'use strict';
/*
 * ClaudeAE configuration helper (used by the installers; safe to run repeatedly).
 *
 *   node scripts/configure.js --root              remember where ClaudeAE lives (~/.claudeae/config.json)
 *   node scripts/configure.js --desktop           add the MCP server to Claude Desktop (backs up the config)
 *   node scripts/configure.js --code              add the MCP server to Claude Code (user scope)
 *   node scripts/configure.js --skill             install the claude-motion skill for Claude Code + build dist/claude-motion-skill.zip
 *   node scripts/configure.js --uninstall         remove the Claude Desktop / Claude Code entries
 *   node scripts/configure.js --status            print what is configured
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { findClaude, findNode } = require('../lib/locate');

const ROOT = path.resolve(__dirname, '..');
const HOME = os.homedir();
const CONFIG_DIR = process.env.CLAUDEAE_HOME || path.join(HOME, '.claudeae');
const MCP_ENTRY = path.join(ROOT, 'mcp-server', 'index.js');
const args = new Set(process.argv.slice(2));
const log = (...a) => console.log(...a);

function desktopConfigPath() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'darwin') return path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  return path.join(HOME, '.config', 'Claude', 'claude_desktop_config.json');
}
function readJson(f) { return JSON.parse(fs.readFileSync(f, 'utf8')); }
function writeJson(f, data) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, f);
}
function nodePath() {
  const n = findNode(process.execPath);
  return n ? n.path : process.execPath;
}

function setRoot() {
  writeJson(path.join(CONFIG_DIR, 'config.json'), { root: ROOT, installedAt: new Date().toISOString() });
  log('✓ ClaudeAE folder registered: ' + ROOT);
}

function desktop(remove) {
  const file = desktopConfigPath();
  let cfg = {};
  if (fs.existsSync(file)) {
    try { cfg = readJson(file); } catch (e) { throw new Error(file + ' is not valid JSON — fix it first (' + e.message + ')'); }
    const backup = file + '.claudeae-backup';
    if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  } else if (remove) { log('- Claude Desktop config not found, nothing to remove'); return; }
  cfg.mcpServers = cfg.mcpServers || {};
  if (remove) {
    if (!cfg.mcpServers.claudeae) { log('- Claude Desktop: claudeae not configured'); return; }
    delete cfg.mcpServers.claudeae;
    writeJson(file, cfg);
    log('✓ Removed claudeae from Claude Desktop (' + file + ')');
    return;
  }
  cfg.mcpServers.claudeae = { command: nodePath(), args: [MCP_ENTRY] };
  writeJson(file, cfg);
  log('✓ Claude Desktop: added the "claudeae" MCP server (' + file + ')');
  log('  Quit Claude Desktop completely (tray icon → Quit) and reopen it to load the After Effects tools.');
}

function code(remove) {
  const exe = findClaude();
  if (!exe) { log('- Claude Code not found — skipped. Later: claude mcp add --scope user claudeae -- node "' + MCP_ENTRY + '"'); return; }
  try {
    if (remove) {
      execFileSync(exe, ['mcp', 'remove', '--scope', 'user', 'claudeae'], { stdio: 'pipe', timeout: 60000, windowsHide: true });
      log('✓ Removed claudeae from Claude Code');
      return;
    }
    try { execFileSync(exe, ['mcp', 'remove', '--scope', 'user', 'claudeae'], { stdio: 'pipe', timeout: 60000, windowsHide: true }); } catch (_) { }
    execFileSync(exe, ['mcp', 'add', '--scope', 'user', 'claudeae', '--', nodePath(), MCP_ENTRY], { stdio: 'pipe', timeout: 60000, windowsHide: true });
    log('✓ Claude Code: added the "claudeae" MCP server (user scope) via ' + exe);
  } catch (e) {
    log('! Claude Code: ' + String(e.stderr || e.message).trim());
  }
}

/* minimal ZIP writer (deflate) for the skill upload package */
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
function zipFiles(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8'), comp = zlib.deflateRawSync(data), crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(0, 10); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(0, 12); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
function walk(dir, base = '') {
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f), rel = base ? base + '/' + f : f;
    if (fs.statSync(p).isDirectory()) out.push(...walk(p, rel)); else out.push({ name: rel, file: p });
  }
  return out;
}
/** Keeps the skill's reference docs and examples identical to the project's (single source of truth). */
function syncSkill(src) {
  const copies = [
    ['docs/CLAUDE_MOTION_FORMAT.md', 'reference/format.md'],
    ['docs/HTML_MOTION.md', 'reference/html-motion.md'],
    ['examples/logo-reveal.json', 'examples/logo-reveal.json'],
    ['examples/lower-third.json', 'examples/lower-third.json'],
    ['examples/social-promo-vertical.json', 'examples/social-promo-vertical.json'],
    ['examples/html/launch.html', 'examples/launch.html'],
    ['examples/html/gsap-title.html', 'examples/gsap-title.html'],
  ];
  for (const [from, to] of copies) {
    const a = path.join(ROOT, from), b = path.join(src, to);
    if (!fs.existsSync(a)) continue;
    fs.mkdirSync(path.dirname(b), { recursive: true });
    fs.copyFileSync(a, b);
  }
}

function skill(remove) {
  const src = path.join(ROOT, 'skill', 'claude-motion');
  const dest = path.join(HOME, '.claude', 'skills', 'claude-motion');
  if (remove) { if (fs.existsSync(dest)) { fs.rmSync(dest, { recursive: true, force: true }); log('✓ Removed the claude-motion skill from Claude Code'); } return; }
  if (!fs.existsSync(path.join(src, 'SKILL.md'))) { log('- skill/claude-motion not found, skipped'); return; }
  syncSkill(src);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  log('✓ Claude Code skill installed: ' + dest);
  const files = walk(src).map((f) => ({ name: 'claude-motion/' + f.name, data: fs.readFileSync(f.file) }));
  fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
  const zip = path.join(ROOT, 'dist', 'claude-motion-skill.zip');
  fs.writeFileSync(zip, zipFiles(files));
  log('✓ Skill package for the Claude app: ' + zip);
  log('  Claude app → Settings → Capabilities → Skills → Upload skill → choose that zip.');
}

function status() {
  const file = desktopConfigPath();
  let desk = 'not configured';
  try { if (readJson(file).mcpServers.claudeae) desk = 'configured'; } catch (_) { }
  const exe = findClaude();
  log('ClaudeAE root      ' + ROOT);
  log('Node.js            ' + nodePath());
  log('Claude Desktop     ' + desk + ' (' + file + ')');
  log('Claude Code        ' + (exe || 'not found'));
  log('Bridge file        ' + path.join(CONFIG_DIR, 'bridge.json') + (fs.existsSync(path.join(CONFIG_DIR, 'bridge.json')) ? ' (present)' : ' (After Effects not running with the extension)'));
}

try {
  const remove = args.has('--uninstall');
  if (args.has('--root') && !remove) setRoot();
  if (args.has('--desktop') || remove) desktop(remove);
  if (args.has('--code') || remove) code(remove);
  if (args.has('--skill') || remove) skill(remove);
  if (args.has('--status') || args.size === 0) status();
} catch (e) {
  console.error('✗ ' + e.message);
  process.exit(1);
}
