'use strict';
// Turns asset references (local path, http(s) URL, data: URI, base64, inline SVG) into local files
// that After Effects can import.
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { tempDir } = require('./paths');

const MIME_EXT = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
  'image/svg+xml': '.svg', 'image/tiff': '.tif', 'image/bmp': '.bmp', 'video/mp4': '.mp4', 'video/quicktime': '.mov',
  'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/aac': '.aac',
  'application/pdf': '.pdf', 'image/vnd.adobe.photoshop': '.psd', 'application/postscript': '.ai',
};
const MAX_DOWNLOAD = 1024 * 1024 * 1024; // 1 GB

function hash(s) { return crypto.createHash('sha1').update(s).digest('hex').slice(0, 16); }

function extFromUrl(u) {
  try {
    const e = path.extname(new URL(u).pathname).toLowerCase();
    return /^\.[a-z0-9]{1,5}$/.test(e) ? e : '';
  } catch (_) { return ''; }
}

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects for ' + url));
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'ClaudeAE/1.0' }, timeout: 60000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).toString(), dest, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('Download failed (HTTP ' + res.statusCode + '): ' + url)); }
      let size = 0;
      const tmp = dest + '.part';
      const out = fs.createWriteStream(tmp);
      res.on('data', (c) => { size += c.length; if (size > MAX_DOWNLOAD) { req.destroy(new Error('Download larger than 1 GB: ' + url)); } });
      res.pipe(out);
      out.on('finish', () => {
        let final = dest;
        if (!path.extname(dest)) {
          const ct = String(res.headers['content-type'] || '').split(';')[0].trim();
          final = dest + (MIME_EXT[ct] || '');
        }
        fs.renameSync(tmp, final);
        resolve(final);
      });
      out.on('error', reject);
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Download timed out: ' + url)));
    req.on('error', reject);
  });
}

function writeData(data, ext, nameHint) {
  let buf, mimeExt = '';
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(data);
  if (m) {
    mimeExt = MIME_EXT[(m[1] || '').toLowerCase()] || '';
    buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
  } else {
    buf = Buffer.from(String(data).replace(/\s/g, ''), 'base64');
  }
  const e = ext ? (ext.startsWith('.') ? ext : '.' + ext) : mimeExt || '.bin';
  const file = path.join(tempDir('assets'), (nameHint ? safe(nameHint) + '-' : '') + hash(buf.toString('base64').slice(0, 4096) + buf.length) + e);
  if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
  return file;
}

function safe(s) { return String(s).replace(/[^a-z0-9_-]+/gi, '_').slice(0, 40); }

/**
 * Resolves one asset description to a local file path.
 * Accepts { path } | { url } | { data, ext? } | { svg } (inline markup).
 */
async function resolveAssetFile(a, baseDir) {
  if (!a || typeof a !== 'object') throw new Error('Asset must be an object');
  if (a.path) {
    const p = path.isAbsolute(a.path) ? a.path : path.resolve(baseDir || process.cwd(), a.path);
    if (!fs.existsSync(p)) throw new Error('Asset file not found: ' + p);
    return p;
  }
  if (a.svg) {
    const file = path.join(tempDir('assets'), (a.id ? safe(a.id) + '-' : '') + hash(a.svg) + '.svg');
    if (!fs.existsSync(file)) fs.writeFileSync(file, a.svg, 'utf8');
    return file;
  }
  if (a.data) return writeData(a.data, a.ext, a.id);
  if (a.url) {
    if (a.url.startsWith('data:')) return writeData(a.url, a.ext, a.id);
    if (a.url.startsWith('file://')) return resolveAssetFile({ path: decodeURIComponent(new URL(a.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')) }, baseDir);
    if (!/^https?:\/\//i.test(a.url)) return resolveAssetFile({ path: a.url }, baseDir);
    const ext = a.ext ? (a.ext.startsWith('.') ? a.ext : '.' + a.ext) : extFromUrl(a.url);
    const dest = path.join(tempDir('assets'), (a.id ? safe(a.id) + '-' : '') + hash(a.url) + ext);
    const existing = [dest, ...Object.values(MIME_EXT).map((e) => dest + e)].find((f) => fs.existsSync(f));
    if (existing) return existing;
    return download(a.url, dest);
  }
  throw new Error('Asset "' + (a.id || '?') + '" needs one of: path, url, data, svg');
}

module.exports = { resolveAssetFile, download };
