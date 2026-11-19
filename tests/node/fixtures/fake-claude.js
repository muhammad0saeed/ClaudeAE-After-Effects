'use strict';
// Stand-in for the Claude Code CLI used by the agent tests (speaks the stream-json protocol).
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const args = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

if (args[0] === 'auth' && args[1] === 'status') {
  out({ loggedIn: !process.env.FAKE_CLAUDE_LOGGED_OUT, authMethod: 'claude.ai' });
  process.exit(0);
}
fs.writeFileSync(process.env.CLAUDEAE_FAKE_LOG || path.join(os.tmpdir(), 'fake-claude-args.json'), JSON.stringify(args));

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
let n = 0;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'user') return;
  n++;
  if (process.env.CLAUDEAE_FAKE_MSGS) fs.appendFileSync(process.env.CLAUDEAE_FAKE_MSGS, JSON.stringify(msg) + '\n');
  if (process.env.FAKE_CLAUDE_LOGGED_OUT) {
    out({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' });
    return;
  }
  if (n === 1) out({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-opus-5-5', mcp_servers: [{ name: 'claudeae', status: 'connected' }] });
  out({ type: 'stream_event', event: { type: 'message_start' } });
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Building now.' } } });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Building now.' }, { type: 'tool_use', id: 'tu_' + n, name: 'mcp__claudeae__ae_get_comp', input: { comp: 'Main' } }] } });
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_' + n, content: [{ type: 'text', text: '{"result":{}}' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }] }] } });
  out({ type: 'stream_event', event: { type: 'message_start' } });
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done!' } } });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done!' }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'Done!', total_cost_usd: 0.01, num_turns: 2 });
});
