'use strict';
// Minimal async test runner used by the After Effects integration tests (no dependencies).
const assert = require('assert');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function near(a, b, eps = 0.01, msg) {
  if (Array.isArray(a) || Array.isArray(b)) {
    assert.ok(Array.isArray(a) && Array.isArray(b), (msg || '') + ` expected arrays, got ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) near(a[i], b[i], eps, (msg || '') + `[${i}]`);
    return;
  }
  assert.ok(Math.abs(a - b) <= eps, `${msg || 'value'}: expected ${b}, got ${a}`);
}

async function run(filter) {
  let pass = 0, fail = 0;
  const failures = [];
  for (const t of tests) {
    if (filter && !t.name.includes(filter)) continue;
    const t0 = Date.now();
    try {
      await t.fn();
      pass++;
      console.log(`  ✓ ${t.name} (${Date.now() - t0}ms)`);
    } catch (e) {
      fail++;
      failures.push({ name: t.name, error: e });
      console.log(`  ✗ ${t.name}\n      ${String(e && e.stack || e).split('\n').slice(0, 4).join('\n      ')}`);
      if (e && e.warnings && e.warnings.length) console.log('      warnings: ' + JSON.stringify(e.warnings));
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  return { pass, fail, failures };
}

module.exports = { test, run, near, assert };
