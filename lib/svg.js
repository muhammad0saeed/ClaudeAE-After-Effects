'use strict';
/*
 * SVG → After Effects shape data.
 *
 *  parsePathData(d)        SVG path "d" → [{ vertices, inTangents, outTangents, closed }]
 *  svgToShapes(markup, o)  whole SVG document → { width, height, items, texts, warnings }
 *
 * Coordinates are baked (all transforms applied) so the result is exact; groups mirror the
 * SVG <g> structure so the AE layer stays organised. The output plugs straight into the
 * "shapes" array of a Claude Motion shape layer.
 */

/* ------------------------------------------------------------ path parsing */
function tokenize(d) {
  const out = [];
  let i = 0, cmd = null, argIdx = 0;
  const n = d.length;
  const isNumStart = (c) => (c >= '0' && c <= '9') || c === '-' || c === '+' || c === '.';
  while (i < n) {
    const c = d[i];
    if (/[MmLlHhVvCcSsQqTtAaZz]/.test(c)) { out.push(c); cmd = c; argIdx = 0; i++; continue; }
    // arc flags are single characters and may be packed together ("a10 10 0 0150 50")
    if ((cmd === 'a' || cmd === 'A') && (argIdx % 7 === 3 || argIdx % 7 === 4) && (c === '0' || c === '1')) {
      out.push(c === '1' ? 1 : 0); argIdx++; i++; continue;
    }
    if (isNumStart(c)) {
      argIdx++;
      let j = i;
      if (d[j] === '-' || d[j] === '+') j++;
      let sawDot = false, sawDigit = false;
      while (j < n) {
        const ch = d[j];
        if (ch >= '0' && ch <= '9') { sawDigit = true; j++; }
        else if (ch === '.' && !sawDot) { sawDot = true; j++; }
        else break;
      }
      if ((d[j] === 'e' || d[j] === 'E') && sawDigit) {
        let k = j + 1;
        if (d[k] === '-' || d[k] === '+') k++;
        if (d[k] >= '0' && d[k] <= '9') { j = k; while (d[j] >= '0' && d[j] <= '9') j++; }
      }
      if (j === i || (!sawDigit)) throw new Error('Bad number in path data near "' + d.slice(i, i + 12) + '"');
      out.push(parseFloat(d.slice(i, j)));
      i = j;
      continue;
    }
    i++; // whitespace / comma
  }
  return out;
}

function arcToCubics(x1, y1, rx, ry, phiDeg, fa, fs, x2, y2) {
  if (rx === 0 || ry === 0) return [[x1, y1, x2, y2, x2, y2]];
  const phi = (phiDeg * Math.PI) / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy, y1p = -sin * dx + cos * dy;
  rx = Math.abs(rx); ry = Math.abs(ry);
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }
  const sign = fa === fs ? -1 : 1;
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const co = sign * Math.sqrt(Math.max(0, num / (rx * rx * y1p * y1p + ry * ry * x1p * x1p)));
  const cxp = co * (rx * y1p) / ry, cyp = co * -(ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2, cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  let t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!fs && dt > 0) dt -= 2 * Math.PI;
  else if (fs && dt < 0) dt += 2 * Math.PI;
  const segs = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2)));
  const delta = dt / segs, k = (4 / 3) * Math.tan(delta / 4);
  const out = [];
  let px = x1, py = y1;
  for (let i = 0; i < segs; i++) {
    const a1 = t1 + i * delta, a2 = a1 + delta;
    const c1x = Math.cos(a1) - k * Math.sin(a1), c1y = Math.sin(a1) + k * Math.cos(a1);
    const c2x = Math.cos(a2) + k * Math.sin(a2), c2y = Math.sin(a2) - k * Math.cos(a2);
    const ex = Math.cos(a2), ey = Math.sin(a2);
    const map = (u, v) => [cx + rx * u * cos - ry * v * sin, cy + rx * u * sin + ry * v * cos];
    const C1 = map(c1x, c1y), C2 = map(c2x, c2y), E = i === segs - 1 ? [x2, y2] : map(ex, ey);
    out.push([C1[0], C1[1], C2[0], C2[1], E[0], E[1]]);
    px = E[0]; py = E[1];
  }
  return out;
}

/** Parses SVG path data into absolute cubic subpaths: [{ start:[x,y], segs:[[c1x,c1y,c2x,c2y,x,y]], closed }] */
function parseToCubics(d) {
  const tokens = tokenize(String(d));
  const subs = [];
  let cur = null, x = 0, y = 0, sx = 0, sy = 0, lastC = null, lastQ = null, i = 0, cmd = null;
  const num = () => {
    if (i >= tokens.length || typeof tokens[i] !== 'number') throw new Error('Path data: expected a number after "' + cmd + '"');
    return tokens[i++];
  };
  const begin = (nx, ny) => { cur = { start: [nx, ny], segs: [], closed: false }; subs.push(cur); x = sx = nx; y = sy = ny; };
  const ensure = () => { if (!cur || cur.closed) begin(x, y); };
  const line = (nx, ny) => { ensure(); cur.segs.push([x, y, nx, ny, nx, ny]); x = nx; y = ny; };
  while (i < tokens.length) {
    if (typeof tokens[i] === 'string') cmd = tokens[i++];
    else if (cmd === null) throw new Error('Path data must start with a command (M)');
    else if (cmd === 'M') cmd = 'L';
    else if (cmd === 'm') cmd = 'l';
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    let resetC = true, resetQ = true;
    switch (C) {
      case 'M': { const nx = num() + (rel ? x : 0), ny = num() + (rel ? y : 0); begin(nx, ny); break; }
      case 'L': { const nx = num() + (rel ? x : 0), ny = num() + (rel ? y : 0); line(nx, ny); break; }
      case 'H': { const nx = num() + (rel ? x : 0); line(nx, y); break; }
      case 'V': { const ny = num() + (rel ? y : 0); line(x, ny); break; }
      case 'C': {
        ensure();
        const c1x = num() + (rel ? x : 0), c1y = num() + (rel ? y : 0), c2x = num() + (rel ? x : 0), c2y = num() + (rel ? y : 0), nx = num() + (rel ? x : 0), ny = num() + (rel ? y : 0);
        cur.segs.push([c1x, c1y, c2x, c2y, nx, ny]); lastC = [c2x, c2y]; resetC = false; x = nx; y = ny; break;
      }
      case 'S': {
        ensure();
        const c1x = lastC ? 2 * x - lastC[0] : x, c1y = lastC ? 2 * y - lastC[1] : y;
        const c2x = num() + (rel ? x : 0), c2y = num() + (rel ? y : 0), nx = num() + (rel ? x : 0), ny = num() + (rel ? y : 0);
        cur.segs.push([c1x, c1y, c2x, c2y, nx, ny]); lastC = [c2x, c2y]; resetC = false; x = nx; y = ny; break;
      }
      case 'Q': {
        ensure();
        const qx = num() + (rel ? x : 0), qy = num() + (rel ? y : 0), nx = num() + (rel ? x : 0), ny = num() + (rel ? y : 0);
        cur.segs.push([x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), nx + (2 / 3) * (qx - nx), ny + (2 / 3) * (qy - ny), nx, ny]);
        lastQ = [qx, qy]; resetQ = false; x = nx; y = ny; break;
      }
      case 'T': {
        ensure();
        const qx = lastQ ? 2 * x - lastQ[0] : x, qy = lastQ ? 2 * y - lastQ[1] : y;
        const nx = num() + (rel ? x : 0), ny = num() + (rel ? y : 0);
        cur.segs.push([x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), nx + (2 / 3) * (qx - nx), ny + (2 / 3) * (qy - ny), nx, ny]);
        lastQ = [qx, qy]; resetQ = false; x = nx; y = ny; break;
      }
      case 'A': {
        ensure();
        const rx = num(), ry = num(), rot = num(), fa = num(), fs = num(), nx = num() + (rel ? x : 0), ny = num() + (rel ? y : 0);
        for (const s of arcToCubics(x, y, rx, ry, rot, fa ? 1 : 0, fs ? 1 : 0, nx, ny)) cur.segs.push(s);
        x = nx; y = ny; break;
      }
      case 'Z': {
        if (cur) { cur.closed = true; x = sx; y = sy; }
        break;
      }
      default: throw new Error('Unsupported path command ' + cmd);
    }
    if (resetC) lastC = null;
    if (resetQ) lastQ = null;
  }
  return subs.filter((s) => s.segs.length > 0 || s.closed);
}

const EPS = 1e-6;
const r3 = (n) => Math.round(n * 1000) / 1000;

/** Converts absolute cubic subpaths to AE vertex/tangent form. */
function cubicsToAE(sub) {
  const pts = [sub.start], segs = sub.segs.slice();
  let closed = sub.closed;
  for (const s of segs) pts.push([s[4], s[5]]);
  // a closed path whose last point returns to the start: merge the duplicate vertex
  if (segs.length && Math.abs(pts[pts.length - 1][0] - pts[0][0]) < EPS && Math.abs(pts[pts.length - 1][1] - pts[0][1]) < EPS && (closed || segs.length > 1)) {
    pts.pop();
    if (!closed) closed = true;
  } else if (closed) {
    // implicit straight closing segment
    const last = pts[pts.length - 1];
    segs.push([last[0], last[1], pts[0][0], pts[0][1], pts[0][0], pts[0][1]]);
  }
  const n = pts.length;
  const vertices = pts.map((p) => [r3(p[0]), r3(p[1])]);
  const inT = pts.map(() => [0, 0]), outT = pts.map(() => [0, 0]);
  for (let k = 0; k < segs.length; k++) {
    const s = segs[k], a = k, b = (k + 1) % n;
    if (k + 1 >= n && !closed) break;
    outT[a] = [r3(s[0] - pts[a][0]), r3(s[1] - pts[a][1])];
    inT[b] = [r3(s[2] - pts[b][0]), r3(s[3] - pts[b][1])];
  }
  return { vertices, inTangents: inT, outTangents: outT, closed };
}

function parsePathData(d) {
  return parseToCubics(d).map(cubicsToAE).filter((p) => p.vertices.length > 0);
}

/* --------------------------------------------------------------- matrices */
const I = [1, 0, 0, 1, 0, 0];
function mul(m, n) { // m * n (apply n first, then m)
  return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
}
function apply(m, p) { return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]]; }
function parseTransform(s) {
  let m = I;
  if (!s) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let r;
  while ((r = re.exec(s))) {
    const a = r[2].trim().split(/[\s,]+/).filter(Boolean).map(Number);
    let t = I;
    switch (r[1]) {
      case 'matrix': t = a.slice(0, 6); break;
      case 'translate': t = [1, 0, 0, 1, a[0] || 0, a[1] || 0]; break;
      case 'scale': t = [a[0], 0, 0, a.length > 1 ? a[1] : a[0], 0, 0]; break;
      case 'rotate': {
        const ang = (a[0] * Math.PI) / 180, c = Math.cos(ang), sn = Math.sin(ang);
        t = [c, sn, -sn, c, 0, 0];
        if (a.length >= 3) t = mul(mul([1, 0, 0, 1, a[1], a[2]], t), [1, 0, 0, 1, -a[1], -a[2]]);
        break;
      }
      case 'skewX': t = [1, 0, Math.tan((a[0] * Math.PI) / 180), 1, 0, 0]; break;
      case 'skewY': t = [1, Math.tan((a[0] * Math.PI) / 180), 0, 1, 0, 0]; break;
    }
    m = mul(m, t);
  }
  return m;
}
function transformPath(p, m) {
  const vertices = [], inTangents = [], outTangents = [];
  for (let i = 0; i < p.vertices.length; i++) {
    const v = p.vertices[i], tv = apply(m, v);
    const ti = apply(m, [v[0] + p.inTangents[i][0], v[1] + p.inTangents[i][1]]);
    const to = apply(m, [v[0] + p.outTangents[i][0], v[1] + p.outTangents[i][1]]);
    vertices.push([r3(tv[0]), r3(tv[1])]);
    inTangents.push([r3(ti[0] - tv[0]), r3(ti[1] - tv[1])]);
    outTangents.push([r3(to[0] - tv[0]), r3(to[1] - tv[1])]);
  }
  return { vertices, inTangents, outTangents, closed: p.closed };
}
const matScale = (m) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;

/* ---------------------------------------------------------------- XML */
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e) => {
    const l = e.toLowerCase();
    if (l === 'amp') return '&'; if (l === 'lt') return '<'; if (l === 'gt') return '>';
    if (l === 'quot') return '"'; if (l === 'apos') return "'"; if (l === 'nbsp') return ' ';
    if (l[1] === 'x') return String.fromCodePoint(parseInt(l.slice(2), 16));
    return String.fromCodePoint(parseInt(l.slice(1), 10));
  });
}
function parseXml(src) {
  const root = { name: '#root', attrs: {}, children: [] };
  const stack = [root];
  let i = 0;
  const n = src.length;
  while (i < n) {
    if (src.startsWith('<!--', i)) { const e = src.indexOf('-->', i); i = e < 0 ? n : e + 3; continue; }
    if (src.startsWith('<![CDATA[', i)) {
      const e = src.indexOf(']]>', i);
      stack[stack.length - 1].children.push({ name: '#text', text: src.slice(i + 9, e < 0 ? n : e) });
      i = e < 0 ? n : e + 3; continue;
    }
    if (src.startsWith('<?', i) || src.startsWith('<!', i)) { const e = src.indexOf('>', i); i = e < 0 ? n : e + 1; continue; }
    if (src[i] === '<') {
      if (src[i + 1] === '/') {
        const e = src.indexOf('>', i);
        const name = src.slice(i + 2, e).trim();
        for (let k = stack.length - 1; k > 0; k--) if (stack[k].name === name) { stack.length = k; break; }
        i = e + 1; continue;
      }
      const m = /^<([A-Za-z_][\w:.-]*)/.exec(src.slice(i, i + 200));
      if (!m) { i++; continue; }
      const el = { name: m[1], attrs: {}, children: [] };
      i += m[0].length;
      const attrRe = /\s*([A-Za-z_:][\w:.-]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'>/]+)))?/y;
      while (i < n) {
        while (i < n && /\s/.test(src[i])) i++;
        if (src[i] === '>' || src.startsWith('/>', i)) break;
        attrRe.lastIndex = i;
        const a = attrRe.exec(src);
        if (!a || a[0].length === 0) { i++; continue; }
        el.attrs[a[1]] = decodeEntities(a[3] !== undefined ? a[3] : a[4] !== undefined ? a[4] : a[5] !== undefined ? a[5] : '');
        i = attrRe.lastIndex;
      }
      const selfClose = src.startsWith('/>', i);
      i += selfClose ? 2 : 1;
      stack[stack.length - 1].children.push(el);
      if (!selfClose) stack.push(el);
      continue;
    }
    const e = src.indexOf('<', i);
    const text = src.slice(i, e < 0 ? n : e);
    if (text.trim()) stack[stack.length - 1].children.push({ name: '#text', text: decodeEntities(text) });
    i = e < 0 ? n : e;
  }
  return root;
}

/* ---------------------------------------------------------------- styles */
const INHERITED = ['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'visibility', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'letter-spacing', 'color'];
const NON_INHERITED = ['opacity', 'display', 'mix-blend-mode'];
const ALL_STYLE = new Set([...INHERITED, ...NON_INHERITED]);

function parseStyleAttr(s) {
  const o = {};
  if (!s) return o;
  for (const part of s.split(';')) {
    const k = part.indexOf(':');
    if (k < 0) continue;
    o[part.slice(0, k).trim().toLowerCase()] = part.slice(k + 1).trim().replace(/\s*!important$/, '');
  }
  return o;
}
function parseCss(text) {
  const rules = [];
  text = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(text))) {
    const decl = parseStyleAttr(m[2]);
    for (const sel of m[1].split(',')) rules.push({ sel: sel.trim(), decl });
  }
  return rules;
}
function matchesSel(el, sel) {
  if (sel === '*') return true;
  const classes = (el.attrs.class || '').split(/\s+/).filter(Boolean);
  const m = /^([a-zA-Z][\w-]*)?((?:[.#][\w-]+)*)$/.exec(sel);
  if (!m) return false;
  if (m[1] && m[1] !== el.name) return false;
  const parts = (m[2] || '').match(/[.#][\w-]+/g) || [];
  for (const p of parts) {
    if (p[0] === '.' && !classes.includes(p.slice(1))) return false;
    if (p[0] === '#' && el.attrs.id !== p.slice(1)) return false;
  }
  return !!(m[1] || parts.length);
}

/* ---------------------------------------------------------------- colours */
const NAMED = { black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00', cyan: '#00ffff', aqua: '#00ffff', magenta: '#ff00ff', fuchsia: '#ff00ff', gray: '#808080', grey: '#808080', silver: '#c0c0c0', maroon: '#800000', olive: '#808000', lime: '#00ff00', teal: '#008080', navy: '#000080', purple: '#800080', orange: '#ffa500', pink: '#ffc0cb', gold: '#ffd700', indigo: '#4b0082', violet: '#ee82ee', brown: '#a52a2a', coral: '#ff7f50', crimson: '#dc143c', salmon: '#fa8072', tomato: '#ff6347', turquoise: '#40e0d0', skyblue: '#87ceeb', slategray: '#708090', darkgray: '#a9a9a9', lightgray: '#d3d3d3', whitesmoke: '#f5f5f5', transparent: 'transparent' };
function parseCssColor(v, current) {
  if (!v) return null;
  let s = String(v).trim().toLowerCase();
  if (s === 'none' || s === 'transparent') return { none: true };
  if (s === 'currentcolor') return current ? parseCssColor(current) : { hex: '#000000', alpha: 1 };
  if (NAMED[s]) s = NAMED[s];
  let m;
  if ((m = /^#([0-9a-f]{3,8})$/.exec(s))) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    const alpha = h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1;
    return { hex: '#' + h.slice(0, 6), alpha };
  }
  if ((m = /^rgba?\(([^)]+)\)$/.exec(s))) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean);
    const ch = (x) => (x.endsWith('%') ? (parseFloat(x) * 2.55) : parseFloat(x));
    const hex = '#' + [0, 1, 2].map((i) => Math.max(0, Math.min(255, Math.round(ch(p[i])))).toString(16).padStart(2, '0')).join('');
    const a = p[3] !== undefined ? (p[3].endsWith('%') ? parseFloat(p[3]) / 100 : parseFloat(p[3])) : 1;
    return { hex, alpha: a };
  }
  if ((m = /^hsla?\(([^)]+)\)$/.exec(s))) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean);
    const h = ((parseFloat(p[0]) % 360) + 360) % 360 / 360, sat = parseFloat(p[1]) / 100, l = parseFloat(p[2]) / 100;
    const q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat, pp = 2 * l - q;
    const f = (t) => { t = (t + 1) % 1; if (t < 1 / 6) return pp + (q - pp) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return pp + (q - pp) * (2 / 3 - t) * 6; return pp; };
    const hex = '#' + [f(h + 1 / 3), f(h), f(h - 1 / 3)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
    const a = p[3] !== undefined ? (p[3].endsWith('%') ? parseFloat(p[3]) / 100 : parseFloat(p[3])) : 1;
    return { hex, alpha: a };
  }
  return null;
}

/* ------------------------------------------------------------- converter */
function num(v, d = 0) { const n = parseFloat(v); return Number.isFinite(n) ? n : d; }
function lenVal(v, ref, d = 0) { if (v === undefined || v === null || v === '') return d; const s = String(v).trim(); if (s.endsWith('%')) return (parseFloat(s) / 100) * ref; return num(s, d); }

function rectPath(x, y, w, h, rx, ry) {
  rx = Math.min(Math.max(0, rx || 0), w / 2); ry = Math.min(Math.max(0, ry === undefined ? rx : ry), h / 2);
  if (!rx || !ry) return { vertices: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], inTangents: [[0, 0], [0, 0], [0, 0], [0, 0]], outTangents: [[0, 0], [0, 0], [0, 0], [0, 0]], closed: true };
  const kx = rx * 0.5523, ky = ry * 0.5523;
  return {
    vertices: [[x + rx, y], [x + w - rx, y], [x + w, y + ry], [x + w, y + h - ry], [x + w - rx, y + h], [x + rx, y + h], [x, y + h - ry], [x, y + ry]],
    inTangents: [[-kx, 0], [0, 0], [0, -ky], [0, 0], [kx, 0], [0, 0], [0, ky], [0, 0]],
    outTangents: [[0, 0], [kx, 0], [0, 0], [0, ky], [0, 0], [-kx, 0], [0, 0], [0, -ky]],
    closed: true,
  };
}
// Starts at (cx + rx, cy) and runs clockwise (on screen), like the SVG spec's circle/ellipse path —
// this matters for stroke-dash draw-ons, which become Trim Paths.
function ellipsePath(cx, cy, rx, ry) {
  const kx = rx * 0.5523, ky = ry * 0.5523;
  return {
    vertices: [[cx + rx, cy], [cx, cy + ry], [cx - rx, cy], [cx, cy - ry]],
    inTangents: [[0, -ky], [kx, 0], [0, ky], [-kx, 0]],
    outTangents: [[0, ky], [-kx, 0], [0, -ky], [kx, 0]],
    closed: true,
  };
}
function polyPath(points, closed) {
  const nums = String(points || '').trim().split(/[\s,]+/).filter(Boolean).map(Number);
  const v = [];
  for (let i = 0; i + 1 < nums.length; i += 2) v.push([nums[i], nums[i + 1]]);
  return { vertices: v, inTangents: v.map(() => [0, 0]), outTangents: v.map(() => [0, 0]), closed };
}
function bbox(paths) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of paths) for (const v of p.vertices) { x0 = Math.min(x0, v[0]); y0 = Math.min(y0, v[1]); x1 = Math.max(x1, v[0]); y1 = Math.max(y1, v[1]); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function svgToShapes(markup, opts = {}) {
  const warnings = [];
  const warnOnce = new Set();
  const warn = (m) => { if (!warnOnce.has(m)) { warnOnce.add(m); warnings.push(m); } };
  const doc = parseXml(String(markup));
  const svg = findFirst(doc, 'svg');
  if (!svg) throw new Error('No <svg> element found');

  const ids = {};
  const css = [];
  (function index(el) {
    if (el.attrs && el.attrs.id) ids[el.attrs.id] = el;
    if (el.name === 'style') css.push(...parseCss(el.children.filter((c) => c.name === '#text').map((c) => c.text).join('\n')));
    for (const c of el.children || []) if (c.name !== '#text') index(c);
  })(svg);

  const vb = (svg.attrs.viewBox || svg.attrs.viewbox || '').trim().split(/[\s,]+/).map(Number);
  const hasVB = vb.length === 4 && vb.every(Number.isFinite);
  let width = num(svg.attrs.width, hasVB ? vb[2] : 0), height = num(svg.attrs.height, hasVB ? vb[3] : 0);
  if (String(svg.attrs.width || '').endsWith('%') || !width) width = hasVB ? vb[2] : 300;
  if (String(svg.attrs.height || '').endsWith('%') || !height) height = hasVB ? vb[3] : 150;
  let root = I;
  if (hasVB) {
    const sx = width / vb[2], sy = height / vb[3];
    const par = String(svg.attrs.preserveAspectRatio || 'xMidYMid meet');
    if (par.startsWith('none')) root = [sx, 0, 0, sy, -vb[0] * sx, -vb[1] * sy];
    else {
      const s = /slice/.test(par) ? Math.max(sx, sy) : Math.min(sx, sy);
      const ax = /xMin/.test(par) ? 0 : /xMax/.test(par) ? 1 : 0.5, ay = /YMin/.test(par) ? 0 : /YMax/.test(par) ? 1 : 0.5;
      root = [s, 0, 0, s, -vb[0] * s + (width - vb[2] * s) * ax, -vb[1] * s + (height - vb[3] * s) * ay];
    }
  }
  // optional output size
  let outW = width, outH = height;
  if (opts.width || opts.height) {
    const s = opts.width && opts.height ? Math.min(opts.width / width, opts.height / height) : (opts.width ? opts.width / width : opts.height / height);
    root = mul([s, 0, 0, s, 0, 0], root);
    outW = width * s; outH = height * s;
  }
  const origin = opts.origin || 'center';
  if (origin === 'center') root = mul([1, 0, 0, 1, -outW / 2, -outH / 2], root);

  const texts = [];

  function styleOf(el, parent) {
    const st = {};
    for (const k of INHERITED) if (parent[k] !== undefined) st[k] = parent[k];
    for (const r of css) if (matchesSel(el, r.sel)) Object.assign(st, filterStyle(r.decl));
    for (const k of Object.keys(el.attrs)) if (ALL_STYLE.has(k)) st[k] = el.attrs[k];
    Object.assign(st, filterStyle(parseStyleAttr(el.attrs.style)));
    return st;
  }
  function filterStyle(d) { const o = {}; for (const k of Object.keys(d)) if (ALL_STYLE.has(k)) o[k] = d[k]; return o; }

  function paint(st, paths, m, opacityMul) {
    const out = {};
    const fillV = st.fill === undefined ? 'black' : st.fill;
    const fo = num(st['fill-opacity'], 1) * opacityMul;
    const urlF = /^url\(\s*#([^)]+)\)/.exec(fillV || '');
    if (urlF) {
      const g = gradientFor(urlF[1], paths, m);
      if (g) out.gradient = g; else warn('Unsupported paint server url(#' + urlF[1] + ') — using its first colour');
      if (!g) { const c = firstStop(urlF[1]); if (c) out.fill = { color: c.hex, opacity: round(fo * c.alpha * 100) }; }
      if (g && fo < 1) out.gradient.opacity = round(fo * 100);
    } else {
      const c = parseCssColor(fillV, st.color);
      if (c && !c.none) out.fill = { color: c.hex, opacity: round(fo * c.alpha * 100) };
    }
    if (out.fill && out.fill.opacity === 100) delete out.fill.opacity;
    if ((st['fill-rule'] || '') === 'evenodd') { if (out.fill) out.fill.rule = 'evenodd'; if (out.gradient) out.gradient.rule = 'evenodd'; }
    const strokeV = st.stroke;
    if (strokeV && strokeV !== 'none') {
      const urlS = /^url\(\s*#([^)]+)\)/.exec(strokeV);
      const c = urlS ? firstStop(urlS[1]) : parseCssColor(strokeV, st.color);
      if (urlS) warn('Gradient strokes are converted to a solid colour (first stop)');
      if (c && !c.none) {
        const so = num(st['stroke-opacity'], 1) * opacityMul * c.alpha;
        const s = { color: c.hex, width: round(num(st['stroke-width'], 1) * matScale(m)) };
        if (so < 1) s.opacity = round(so * 100);
        if (st['stroke-linecap']) s.lineCap = st['stroke-linecap'] === 'square' ? 'square' : st['stroke-linecap'];
        if (st['stroke-linejoin']) s.lineJoin = st['stroke-linejoin'] === 'miter-clip' || st['stroke-linejoin'] === 'arcs' ? 'miter' : st['stroke-linejoin'];
        if (st['stroke-miterlimit']) s.miterLimit = num(st['stroke-miterlimit'], 4);
        if (st['stroke-dasharray'] && st['stroke-dasharray'] !== 'none') {
          const d = st['stroke-dasharray'].split(/[\s,]+/).filter(Boolean).map((x) => round(num(x) * matScale(m)));
          if (d.length) s.dashes = d.length % 2 ? d.concat(d) : d;
          if (st['stroke-dashoffset']) s.dashOffset = round(num(st['stroke-dashoffset']) * matScale(m));
        }
        out.stroke = s;
      }
    }
    return out;
  }
  function round(n) { return Math.round(n * 1000) / 1000; }
  function stops(id, depth = 0) {
    const g = ids[id];
    if (!g || depth > 5) return [];
    const own = g.children.filter((c) => c.name === 'stop');
    if (own.length) return own.map((s) => {
      const st = Object.assign({}, s.attrs, parseStyleAttr(s.attrs.style));
      const c = parseCssColor(st['stop-color'] || 'black') || { hex: '#000000', alpha: 1 };
      return { hex: c.hex, alpha: (c.alpha === undefined ? 1 : c.alpha) * num(st['stop-opacity'], 1), offset: lenVal(st.offset, 1, 0) };
    });
    const href = g.attrs.href || g.attrs['xlink:href'];
    return href ? stops(href.replace(/^#/, ''), depth + 1) : [];
  }
  function firstStop(id) { const s = stops(id); return s[0] || null; }
  function gradAttr(g, name, depth = 0) {
    if (!g || depth > 5) return undefined;
    if (g.attrs[name] !== undefined) return g.attrs[name];
    const href = g.attrs.href || g.attrs['xlink:href'];
    return href ? gradAttr(ids[href.replace(/^#/, '')], name, depth + 1) : undefined;
  }
  function gradientFor(id, paths, m) {
    const g = ids[id];
    if (!g || (g.name !== 'linearGradient' && g.name !== 'radialGradient')) return null;
    const st = stops(id);
    if (!st.length) return null;
    if (st.length > 2) warn('Gradients with more than 2 colour stops use the first and last stop in After Effects');
    if (st.some((s) => s.alpha < 1)) warn('Gradient stop opacity is not supported by After Effects scripting — stops are opaque');
    const units = gradAttr(g, 'gradientUnits') || 'objectBoundingBox';
    const gt = parseTransform(gradAttr(g, 'gradientTransform'));
    // paths are already in final coordinates; compute bbox in final space for bbox units
    let toFinal;
    if (units === 'userSpaceOnUse') toFinal = mul(m, gt);
    else {
      const raw = paths.raw; // untransformed geometry bbox
      const b = bbox(raw);
      toFinal = mul(m, mul([b.w || 1, 0, 0, b.h || 1, b.x, b.y], gt));
    }
    const isBox = units !== 'userSpaceOnUse';
    let start, end, type;
    if (g.name === 'linearGradient') {
      type = 'linear';
      start = apply(toFinal, [lenVal(gradAttr(g, 'x1'), 1, 0), lenVal(gradAttr(g, 'y1'), 1, 0)].map((v, i) => (isBox ? v : v)));
      end = apply(toFinal, [lenVal(gradAttr(g, 'x2'), isBox ? 1 : width, isBox ? 1 : width), lenVal(gradAttr(g, 'y2'), 1, 0)]);
    } else {
      type = 'radial';
      const cx = lenVal(gradAttr(g, 'cx'), isBox ? 1 : width, isBox ? 0.5 : width / 2), cy = lenVal(gradAttr(g, 'cy'), isBox ? 1 : height, isBox ? 0.5 : height / 2);
      const r = lenVal(gradAttr(g, 'r'), isBox ? 1 : Math.hypot(width, height) / Math.SQRT2, isBox ? 0.5 : 50);
      start = apply(toFinal, [cx, cy]);
      end = apply(toFinal, [cx + r, cy]);
    }
    return { gradientType: type, start: start.map(round), end: end.map(round), colors: [st[0].hex, st[st.length - 1].hex] };
  }

  function geom(el, st) {
    const a = el.attrs;
    switch (el.name) {
      case 'path': return a.d ? parsePathData(a.d) : [];
      case 'rect': {
        const w = lenVal(a.width, width), h = lenVal(a.height, height);
        if (w <= 0 || h <= 0) return [];
        const rx = a.rx !== undefined ? lenVal(a.rx, width) : (a.ry !== undefined ? lenVal(a.ry, height) : 0);
        const ry = a.ry !== undefined ? lenVal(a.ry, height) : rx;
        return [rectPath(lenVal(a.x, width), lenVal(a.y, height), w, h, rx, ry)];
      }
      case 'circle': { const r = lenVal(a.r, Math.hypot(width, height) / Math.SQRT2); return r > 0 ? [ellipsePath(lenVal(a.cx, width), lenVal(a.cy, height), r, r)] : []; }
      case 'ellipse': { const rx = lenVal(a.rx, width), ry = lenVal(a.ry, height); return rx > 0 && ry > 0 ? [ellipsePath(lenVal(a.cx, width), lenVal(a.cy, height), rx, ry)] : []; }
      case 'line': return [polyPath([lenVal(a.x1, width), lenVal(a.y1, height), lenVal(a.x2, width), lenVal(a.y2, height)].join(' '), false)];
      case 'polyline': return [polyPath(a.points, false)];
      case 'polygon': return [polyPath(a.points, true)];
      default: return [];
    }
  }

  function walk(el, parentStyle, m, depth) {
    const items = [];
    for (const child of el.children || []) {
      if (child.name === '#text') continue;
      const res = convert(child, parentStyle, m, depth);
      if (res) items.push(res);
    }
    return items.reverse(); // SVG paints later siblings on top; AE draws earlier items on top
  }

  function convert(el, parentStyle, parentM, depth) {
    if (depth > 64) return null;
    const name = el.name;
    if (['defs', 'style', 'title', 'desc', 'metadata', 'linearGradient', 'radialGradient', 'symbol', 'clipPath', 'mask', 'pattern', 'filter', 'marker', 'script'].includes(name)) {
      if (name === 'script') warn('SVG <script> ignored');
      return null;
    }
    const st = styleOf(el, parentStyle);
    if (st.display === 'none' || st.visibility === 'hidden') return null;
    let m = mul(parentM, parseTransform(el.attrs.transform));
    if (el.attrs['clip-path'] || el.attrs.mask || st['clip-path']) warn('clip-path / mask in SVG are not converted (use a track matte layer instead)');
    if (el.attrs.filter) warn('SVG filters are not converted (add After Effects effects instead)');
    const opacity = num(st.opacity, 1);
    const label = el.attrs.id || el.attrs['data-name'] || el.attrs['inkscape:label'] || null;

    if (name === 'g' || name === 'svg' || name === 'a' || name === 'switch') {
      if (name === 'svg' && depth > 0) {
        const x = lenVal(el.attrs.x, width), y = lenVal(el.attrs.y, height);
        m = mul(m, [1, 0, 0, 1, x, y]);
        const vb2 = (el.attrs.viewBox || '').split(/[\s,]+/).map(Number);
        if (vb2.length === 4 && vb2.every(Number.isFinite)) {
          const w2 = lenVal(el.attrs.width, width, vb2[2]), h2 = lenVal(el.attrs.height, height, vb2[3]);
          const s2 = Math.min(w2 / vb2[2], h2 / vb2[3]);
          m = mul(m, [s2, 0, 0, s2, -vb2[0] * s2, -vb2[1] * s2]);
        }
      }
      const children = walk(el, st, m, depth + 1);
      if (!children.length) return null;
      const g = { type: 'group', name: label || (name === 'svg' ? 'SVG' : 'Group'), items: children };
      if (opacity < 1) g.transform = { opacity: round(opacity * 100) };
      return g;
    }
    if (name === 'use') {
      const href = el.attrs.href || el.attrs['xlink:href'];
      const target = href && ids[href.replace(/^#/, '')];
      if (!target) { warn('<use> target not found: ' + href); return null; }
      const um = mul(m, [1, 0, 0, 1, lenVal(el.attrs.x, width), lenVal(el.attrs.y, height)]);
      const inner = target.name === 'symbol' ? { name: 'g', attrs: { id: target.attrs.id }, children: target.children } : target;
      const res = convert(inner, st, um, depth + 1);
      if (res && opacity < 1) res.transform = Object.assign(res.transform || {}, { opacity: round(opacity * 100 * ((res.transform && res.transform.opacity) || 100) / 100) });
      return res;
    }
    if (name === 'text') {
      const content = collectText(el).replace(/\s+/g, ' ').trim();
      if (!content) return null;
      const tspan = (el.children || []).find((c) => c.name === 'tspan' && (c.attrs.x !== undefined || c.attrs.y !== undefined));
      const x = lenVal(el.attrs.x !== undefined ? el.attrs.x : tspan && tspan.attrs.x, width), y = lenVal(el.attrs.y !== undefined ? el.attrs.y : tspan && tspan.attrs.y, height);
      const p = apply(m, [x, y]);
      const fill = parseCssColor(st.fill === undefined ? 'black' : st.fill, st.color);
      texts.push({
        content, position: [round(p[0]), round(p[1])], fontSize: round(num(st['font-size'], 16) * matScale(m)),
        fontFamily: (st['font-family'] || 'Arial').split(',')[0].replace(/["']/g, '').trim(),
        fontWeight: st['font-weight'], fontStyle: st['font-style'] === 'italic' ? 'Italic' : undefined,
        color: fill && !fill.none ? fill.hex : '#000000', opacity: round(opacity * 100),
        anchor: st['text-anchor'] === 'middle' ? 'center' : st['text-anchor'] === 'end' ? 'right' : 'left',
        rotation: round((Math.atan2(m[1], m[0]) * 180) / Math.PI),
      });
      return null;
    }
    if (name === 'image') { warn('<image> inside SVG is not converted — import the picture as its own footage layer'); return null; }
    if (!['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon'].includes(name)) {
      if (name !== 'tspan' && name !== 'foreignObject') warn('Unsupported SVG element <' + name + '> skipped');
      return null;
    }
    let raw;
    try { raw = geom(el, st); } catch (e) { warn('Could not parse <' + name + '>: ' + e.message); return null; }
    if (!raw.length) return null;
    const paths = raw.map((p) => transformPath(p, m));
    paths.raw = raw;
    const p = paint(st, paths, m, 1);
    if ((name === 'line' || name === 'polyline') && !p.stroke) return null;
    if (!p.fill && !p.stroke && !p.gradient) return null;
    const item = { type: 'path', name: label || name.charAt(0).toUpperCase() + name.slice(1), paths: paths.map((q) => ({ vertices: q.vertices, inTangents: q.inTangents, outTangents: q.outTangents, closed: q.closed })) };
    if (name === 'line' || name === 'polyline') delete p.fill;
    Object.assign(item, p);
    if (!item.fill && !item.gradient && !item.stroke) return null;
    if (opacity < 1) item.transform = { opacity: round(opacity * 100) };
    return item;
  }

  const items = walk(svg, { fill: 'black' }, root, 0);
  return { width: round(outW), height: round(outH), origin, items, texts, warnings };
}

function collectText(el) {
  let s = '';
  for (const c of el.children || []) s += c.name === '#text' ? c.text : collectText(c) + (c.name === 'tspan' ? ' ' : '');
  return s;
}
function findFirst(el, name) {
  if (el.name === name) return el;
  for (const c of el.children || []) { if (c.name === '#text') continue; const r = findFirst(c, name); if (r) return r; }
  return null;
}

module.exports = { parsePathData, svgToShapes, parseXml, parseTransform, parseCssColor, rectPath, ellipsePath, polyPath };
