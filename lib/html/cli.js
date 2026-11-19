#!/usr/bin/env node
'use strict';
// node lib/html/cli.js page.html [--fps 30] [--duration 6] [--out dir]
// Prints JSON lines: {"progress": "..."} then {"done": true, "specFile": ..., "warnings": [...], "stats": {...}} or {"error": "..."}
const { htmlToMotion } = require('./index');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : undefined; };
const file = args.find((a, i) => !a.startsWith('--') && (i === 0 || !args[i - 1].startsWith('--')));
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

if (!file) { out({ error: 'usage: cli.js <page.html> [--fps 30] [--duration 6] [--out dir]' }); process.exit(2); }
htmlToMotion(file, { fps: opt('fps'), duration: opt('duration'), outDir: opt('out'), width: opt('width'), height: opt('height'), installFonts: !args.includes('--no-install-fonts'), onProgress: (m) => out({ progress: m }) })
  .then((r) => { out({ done: true, specFile: r.specFile, warnings: r.warnings, stats: r.stats, fontsInstalled: r.fontsInstalled }); process.exit(0); })
  .catch((e) => { out({ error: e.message || String(e) }); process.exit(1); });
