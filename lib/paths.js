'use strict';
// Shared filesystem locations for ClaudeAE (bridge discovery file, temp dirs, engine path).
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_DIR = process.env.CLAUDEAE_HOME || path.join(os.homedir(), '.claudeae');
const BRIDGE_FILE = path.join(CONFIG_DIR, 'bridge.json');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
const TEMP_DIR = path.join(os.tmpdir(), 'claudeae');
const ENGINE_PATH = path.join(ROOT, 'extension', 'host', 'claudeae.jsx');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function tempDir(sub) {
  return ensureDir(sub ? path.join(TEMP_DIR, sub) : TEMP_DIR);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, data, mode) {
  ensureDir(path.dirname(file));
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

module.exports = { ROOT, CONFIG_DIR, BRIDGE_FILE, SETTINGS_FILE, TEMP_DIR, ENGINE_PATH, ensureDir, tempDir, readJson, writeJson };
