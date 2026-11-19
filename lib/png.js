'use strict';
// Dependency-free PNG decode / encode / downscale (enough for frames rendered by After Effects).
const zlib = require('zlib');

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
}

/** Decodes a non-interlaced PNG (gray/RGB/RGBA/gray+alpha/palette, 8 or 16 bit) to RGBA8. */
function decodePng(buf) {
  if (!buf.slice(0, 8).equals(SIG)) throw new Error('Not a PNG file');
  let pos = 8, width, height, bitDepth, colorType, interlace, palette = null, trns = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('ascii', pos + 4, pos + 8), data = buf.slice(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  if (interlace) throw new Error('Interlaced PNG is not supported');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('Unsupported PNG colour type ' + colorType);
  if (bitDepth < 8 && colorType !== 3 && colorType !== 0) throw new Error('Unsupported bit depth');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bitsPP = channels * bitDepth, bpp = Math.max(1, bitsPP >> 3), stride = Math.ceil(width * bitsPP / 8);
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride), cur = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], line = raw.slice(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1; else if (f === 4) v += paeth(a, b, c);
      cur[x] = v & 255;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      let r, g, bl, al = 255;
      const sample = (i) => {
        if (bitDepth === 16) return cur[i * 2];
        if (bitDepth === 8) return cur[i];
        const per = 8 / bitDepth, byte = cur[Math.floor(i / per)], shift = (per - 1 - (i % per)) * bitDepth;
        return (byte >> shift) & ((1 << bitDepth) - 1);
      };
      if (colorType === 3) {
        const idx = sample(x);
        r = palette[idx * 3]; g = palette[idx * 3 + 1]; bl = palette[idx * 3 + 2];
        if (trns && idx < trns.length) al = trns[idx];
      } else if (colorType === 0) {
        const v = sample(x); r = g = bl = bitDepth < 8 ? Math.round(v * 255 / ((1 << bitDepth) - 1)) : v;
      } else if (colorType === 4) { r = g = bl = sample(x * 2); al = sample(x * 2 + 1); }
      else if (colorType === 2) { r = sample(x * 3); g = sample(x * 3 + 1); bl = sample(x * 3 + 2); }
      else { r = sample(x * 4); g = sample(x * 4 + 1); bl = sample(x * 4 + 2); al = sample(x * 4 + 3); }
      out[o] = r; out[o + 1] = g; out[o + 2] = bl; out[o + 3] = al;
    }
    const t = prev; prev = cur; cur = t;
  }
  return { width, height, data: out };
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Encodes RGBA8 pixels as PNG. */
function encodePng({ width, height, data }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const stride = width * 4, raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 1; // Sub filter compresses rendered frames well
    for (let x = 0; x < stride; x++) {
      const v = data[y * stride + x], a = x >= 4 ? data[y * stride + x - 4] : 0;
      raw[y * (stride + 1) + 1 + x] = (v - a) & 255;
    }
  }
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Box-filter downscale so the longest side is at most maxSize. */
function downscale(img, maxSize) {
  const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
  if (scale >= 1) return img;
  const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
  const out = Buffer.alloc(w * h * 4), fx = img.width / w, fy = img.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * fy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * fx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        const i = (yy * img.width + xx) * 4;
        r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; a += img.data[i + 3]; n++;
      }
      const o = (y * w + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  return { width: w, height: h, data: out };
}

module.exports = { decodePng, encodePng, downscale };
