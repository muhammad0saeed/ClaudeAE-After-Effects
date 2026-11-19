'use strict';
/*
 * Web fonts for HTML motion pages.
 *  - resolveWebFonts(): finds files for families the page uses but the browser could not load
 *    (e.g. "@fontsource/..." paths that only exist in the original project), via the Fontsource API
 *    (the open mirror of Google Fonts).
 *  - installFonts(): downloads the TTFs and installs them for the current user so After Effects can use
 *    the real typefaces (Windows: per-user font folder + HKCU registry; macOS: ~/Library/Fonts).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');
const { download } = require('./assets');
const { tempDir } = require('./paths');

const API = 'https://api.fontsource.org/v1/fonts/';
const WEIGHT_NAMES = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' };

function getJson(url) {
  return new Promise((resolve) => {
    https.get(url, { headers: { 'User-Agent': 'ClaudeAE' }, timeout: 20000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(c).toString('utf8'))); } catch (_) { resolve(null); } });
    }).on('error', () => resolve(null)).on('timeout', function () { this.destroy(); resolve(null); });
  });
}

const slug = (family) => String(family).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const styleName = (weight, style) => {
  const base = WEIGHT_NAMES[Math.min(900, Math.max(100, Math.round(Number(weight) / 100) * 100))] || 'Regular';
  if (style !== 'italic') return base;
  return base === 'Regular' ? 'Italic' : base + ' Italic';
};

/** @param {{family, weight, style}[]} wanted  @returns {Promise<{faces, notFound}>} */
async function resolveWebFonts(wanted) {
  const byFamily = new Map();
  for (const w of wanted) {
    if (!byFamily.has(w.family)) byFamily.set(w.family, []);
    byFamily.get(w.family).push(w);
  }
  const faces = [], notFound = [];
  for (const [family, list] of byFamily) {
    const meta = await getJson(API + slug(family));
    if (!meta || !meta.variants) { notFound.push(family); continue; }
    const weights = (meta.weights || []).map(Number);
    const seen = new Set();
    for (const w of list) {
      const want = Number(w.weight) || 400;
      const weight = weights.length ? weights.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a)) : want;
      const style = w.style === 'italic' && (meta.styles || []).includes('italic') ? 'italic' : 'normal';
      const key = weight + style;
      if (seen.has(key)) continue;
      seen.add(key);
      const v = meta.variants[String(weight)] && meta.variants[String(weight)][style];
      const sub = v && (v.latin || v[meta.defSubset] || v[Object.keys(v)[0]]);
      if (!sub || !sub.url) continue;
      faces.push({ family: meta.family || family, weight, style, woff2: sub.url.woff2, ttf: sub.url.ttf, id: meta.id || slug(family) });
    }
  }
  return { faces, notFound };
}

function installedFontNames() {
  if (process.platform !== 'win32') return '';
  let out = '';
  for (const key of ['HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts', 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts']) {
    try { out += execFileSync('reg', ['query', key], { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 }); } catch (_) { }
  }
  return out.toLowerCase();
}

function isInstalled(names, family, weight, style) {
  const norm = (s) => s.toLowerCase().replace(/\s*\((truetype|opentype|all res)\)\s*$/, '').replace(/[\s_-]+/g, '');
  // `reg query` lines look like "    Karla Bold (TrueType)    REG_SZ    C:\...\file.ttf"
  const entries = names.split(/\r?\n/).map((l) => l.trim().split(/\s{2,}reg_sz/)[0]).filter(Boolean).map(norm);
  const fam = norm(family), sn = norm(styleName(weight, style));
  const wanted = sn === 'regular' ? [fam, fam + 'regular'] : [fam + sn];
  return entries.some((e) => wanted.includes(e) || (e.startsWith(fam) && e.includes('variable')));
}

/**
 * Windows: loads font files into the current session and broadcasts WM_FONTCHANGE, so running apps
 * (After Effects included) see them without a restart. The registry entry keeps them after a reboot.
 */
function announceArgs(files) {
  const list = files.map((f) => "'" + f.replace(/'/g, "''") + "'").join(',');
  const ps = [
    "$sig = '[DllImport(\"gdi32.dll\", CharSet=CharSet.Unicode)] public static extern int AddFontResourceW(string f); [DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeoutW(IntPtr h, uint m, UIntPtr w, IntPtr l, uint f, uint t, out UIntPtr r);';",
    '$t = Add-Type -MemberDefinition $sig -Name FontApi -Namespace ClaudeAEFonts -PassThru;',
    'foreach ($f in @(' + list + ')) { [void]$t::AddFontResourceW($f) };',
    '$r = [UIntPtr]::Zero; [void]$t::SendMessageTimeoutW([IntPtr]0xffff, 0x001D, [UIntPtr]::Zero, [IntPtr]::Zero, 2, 5000, [ref]$r)',
  ].join(' ');
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps];
}
function announceFonts(files) {
  if (process.platform !== 'win32' || !files.length) return;
  try { execFileSync('powershell.exe', announceArgs(files), { windowsHide: true, stdio: 'ignore', timeout: 30000 }); } catch (_) { }
}
const userFontDir = () => path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Microsoft', 'Windows', 'Fonts');

/**
 * Windows can drop session-loaded per-user fonts (they normally return only at the next sign-in), so
 * the bridge calls this whenever After Effects starts: it re-loads the fonts ClaudeAE installed and tells
 * running apps. Asynchronous; done(err, count) is optional.
 */
function ensureFontsLoaded(done) {
  const cb = done || (() => { });
  if (process.platform !== 'win32') return cb(null, 0);
  let files = [];
  try { files = fs.readdirSync(userFontDir()).filter((f) => /^ClaudeAE-.*\.(ttf|otf)$/i.test(f)).map((f) => path.join(userFontDir(), f)); } catch (_) { }
  if (!files.length) return cb(null, 0);
  require('child_process').execFile('powershell.exe', announceArgs(files), { windowsHide: true, timeout: 30000 }, (err) => cb(err || null, files.length));
}

/** Downloads and installs fonts for the current user. Returns { installed, already, failed }. */
async function installFonts(faces) {
  const res = { installed: [], already: [], failed: [] };
  if (!faces.length) return res;
  const added = [];
  const names = installedFontNames();
  const dir = tempDir('fonts');
  for (const f of faces) {
    const label = f.family + ' ' + styleName(f.weight, f.style);
    if (process.platform === 'win32' && isInstalled(names, f.family, f.weight, f.style)) { res.already.push(label); continue; }
    try {
      const file = path.join(dir, f.id + '-' + f.weight + '-' + f.style + '.ttf');
      if (!fs.existsSync(file)) await download(f.ttf, file);
      if (process.platform === 'win32') {
        const fontDir = userFontDir();
        fs.mkdirSync(fontDir, { recursive: true });
        const dest = path.join(fontDir, 'ClaudeAE-' + path.basename(file));
        fs.copyFileSync(file, dest);
        execFileSync('reg', ['add', 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts', '/v', label + ' (TrueType)', '/t', 'REG_SZ', '/d', dest, '/f'], { windowsHide: true, stdio: 'ignore' });
        added.push(dest);
      } else if (process.platform === 'darwin') {
        const fontDir = path.join(os.homedir(), 'Library', 'Fonts');
        fs.copyFileSync(file, path.join(fontDir, 'ClaudeAE-' + path.basename(file)));
      } else {
        const fontDir = path.join(os.homedir(), '.local', 'share', 'fonts');
        fs.mkdirSync(fontDir, { recursive: true });
        fs.copyFileSync(file, path.join(fontDir, 'ClaudeAE-' + path.basename(file)));
      }
      res.installed.push(label);
    } catch (e) {
      res.failed.push(label + ': ' + e.message);
    }
  }
  announceFonts(added);
  return res;
}

module.exports = { resolveWebFonts, installFonts, announceFonts, ensureFontsLoaded, styleName };
