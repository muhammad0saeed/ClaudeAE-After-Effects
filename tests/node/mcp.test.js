'use strict';
// Protocol test: drives the ClaudeAE MCP server with the official MCP SDK client.
// Uses CLAUDEAE_TRANSPORT=bridge with no bridge file so no After Effects is needed.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

const SERVER = path.join(__dirname, '..', '..', 'mcp-server', 'index.js');

async function connect(env) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env: Object.assign({}, process.env, env), stderr: 'pipe' });
  const client = new Client({ name: 'claudeae-test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

test('MCP handshake, tools, prompts, resources', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeae-home-'));
  const client = await connect({ CLAUDEAE_TRANSPORT: 'bridge', CLAUDEAE_HOME: home });
  try {
    const info = client.getServerVersion();
    assert.strictEqual(info.name, 'claudeae');
    assert.ok(client.getInstructions().includes('After Effects'));

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ['ae_status', 'ae_get_comp', 'ae_create_comp', 'ae_add_layers', 'ae_set_property', 'ae_import_motion', 'ae_import_svg', 'ae_import_file', 'ae_render_frame', 'ae_run_script', 'ae_motion_format']) {
      assert.ok(names.includes(n), 'missing tool ' + n);
    }
    for (const t of tools) {
      assert.strictEqual(t.inputSchema.type, 'object', t.name);
      assert.ok(t.description.length > 20, t.name + ' description');
      assert.ok(/^[a-z_]+$/.test(t.name) && t.name.length <= 64, t.name);
    }

    const fmt = await client.callTool({ name: 'ae_motion_format', arguments: {} });
    assert.ok(fmt.content[0].text.includes('# Claude Motion format'));

    // no bridge + bridge-only transport → clean tool error, not a protocol error
    const st = await client.callTool({ name: 'ae_get_comp', arguments: {} });
    assert.strictEqual(st.isError, true);
    assert.match(st.content[0].text, /bridge is not running/i);

    const bad = await client.callTool({ name: 'ae_import_motion', arguments: { spec: { compositions: [{ width: 1 }] } } });
    assert.strictEqual(bad.isError, true);
    assert.match(bad.content[0].text, /width must be ≥ 4/);

    const { prompts } = await client.listPrompts();
    assert.ok(prompts.some((p) => p.name === 'motion_design'));
    const p = await client.getPrompt({ name: 'motion_design', arguments: { brief: 'a 5s logo sting' } });
    assert.match(p.messages[0].content.text, /logo sting/);

    const { resources } = await client.listResources();
    const r = await client.readResource({ uri: resources[0].uri });
    assert.match(r.contents[0].text, /Claude Motion/);

    await assert.rejects(() => client.callTool({ name: 'nope', arguments: {} }));
  } finally {
    await client.close();
  }
});
