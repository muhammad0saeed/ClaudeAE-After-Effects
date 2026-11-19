'use strict';
// Finds the Claude Code executable and a Node.js (>= 18) binary on this machine.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const isWin = process.platform === 'win32';
const home = os.homedir();

function exists(p) { try { return !!p && fs.statSync(p).isFile(); } catch (_) { return false; } }

function onPath(names) {
  const dirs = String(process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) for (const n of names) { const p = path.join(d.replace(/^"|"$/g, ''), n); if (exists(p)) return p; }
  return null;
}

function semverDirs(root) {
  let dirs = [];
  try { dirs = fs.readdirSync(root).filter((d) => /^\d+\.\d+\.\d+/.test(d)); } catch (_) { return []; }
  const key = (v) => v.split(/[.-]/).slice(0, 3).map((n) => String(Number(n) || 0).padStart(6, '0')).join('.');
  return dirs.sort((a, b) => (key(a) < key(b) ? 1 : -1)).map((d) => path.join(root, d));
}

/** Claude Code CLI: custom path, PATH, native installer, Claude Desktop's bundled copy, npm global. */
function findClaude(custom) {
  if (custom && exists(custom)) return custom;
  const exe = isWin ? 'claude.exe' : 'claude';
  const candidates = [
    onPath(isWin ? ['claude.exe'] : ['claude']),
    path.join(home, '.local', 'bin', exe),
    path.join(home, '.claude', 'local', exe),
  ];
  // the Claude desktop app ships a copy of Claude Code: <AppData>/Claude/claude-code/<version>/<build>/claude(.exe)
  const bundleRoots = isWin
    ? [path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude-code')]
    : [path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code'), path.join(home, '.config', 'Claude', 'claude-code')];
  for (const root of bundleRoots) {
    for (const v of semverDirs(root)) {
      let builds = [];
      try { builds = fs.readdirSync(v).map((b) => path.join(v, b)); } catch (_) { }
      for (const b of builds) candidates.push(path.join(b, exe));
      candidates.push(path.join(v, exe));
    }
  }
  if (!isWin) candidates.push('/usr/local/bin/claude', '/opt/homebrew/bin/claude');
  if (isWin) candidates.push(onPath(['claude.cmd']), path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'));
  return candidates.find(exists) || null;
}

function nodeVersion(p) {
  try {
    const v = execFileSync(p, ['-v'], { timeout: 8000, windowsHide: true, encoding: 'utf8' }).trim();
    const m = /^v(\d+)\./.exec(v);
    return m ? { version: v, major: Number(m[1]) } : null;
  } catch (_) { return null; }
}

/** A Node.js >= 18 binary (the CEP panel's own Node is too old for the Anthropic SDK). */
function findNode(custom) {
  const exe = isWin ? 'node.exe' : 'node';
  const candidates = [custom];
  if (/^node(\.exe)?$/i.test(path.basename(process.execPath))) candidates.push(process.execPath);
  candidates.push(onPath([exe]));
  if (isWin) {
    candidates.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', exe));
    candidates.push(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs', exe));
    for (const v of semverDirs(path.join(process.env.APPDATA || '', 'nvm')).map((d) => path.join(d, exe))) candidates.push(v);
    candidates.push(path.join(process.env.NVM_SYMLINK || '', exe));
  } else {
    candidates.push('/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node');
    for (const v of semverDirs(path.join(home, '.nvm', 'versions', 'node'))) candidates.push(path.join(v, 'bin', 'node'));
    for (const v of semverDirs(path.join(home, '.volta', 'tools', 'image', 'node'))) candidates.push(path.join(v, 'bin', 'node'));
  }
  for (const c of candidates) {
    if (!exists(c)) continue;
    const v = nodeVersion(c);
    if (v && v.major >= 18) return { path: c, version: v.version };
  }
  return null;
}

module.exports = { findClaude, findNode };
