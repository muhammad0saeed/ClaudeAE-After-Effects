const { Transport } = require('../../lib/transport');
(async () => {
  const t = new Transport({ mode: 'cli' });
  const t0 = Date.now();
  try {
    const r = await t.call('ping', {});
    console.log(JSON.stringify(r, null, 2), (Date.now() - t0) + 'ms');
    const d = await t.call('describe', {});
    console.log(d.result.methods.join(', '));
  } catch (e) { console.error('ERR', e.message, e); process.exit(1); }
})();
