'use strict';
/*
 * Chat backend that talks to the Claude API directly (Anthropic API key) and runs the
 * After Effects tools locally. Streaming manual tool loop, append-only history.
 */
const Anthropic = require('@anthropic-ai/sdk');
const { SYSTEM_PROMPT } = require('./prompt');

// Models that accept the server-side refusal fallback ("default" form, Claude API).
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);
const MAX_ITERATIONS = 80;

/** Minimal JSON-schema check for tool inputs (eager input streaming skips server-side validation). */
function validateInput(schema, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'tool input must be a JSON object';
  for (const k of schema.required || []) if (input[k] === undefined) return 'missing required field "' + k + '"';
  const props = schema.properties || {};
  for (const k of Object.keys(input)) {
    const p = props[k], v = input[k];
    if (!p || v === undefined || v === null) continue;
    const types = p.anyOf ? p.anyOf.map((x) => x.type).filter(Boolean) : (p.type ? [p.type] : []);
    if (!types.length) continue;
    const actual = Array.isArray(v) ? 'array' : typeof v;
    if (!types.some((t) => t === actual || (t === 'integer' && actual === 'number'))) return 'field "' + k + '" must be ' + types.join(' or ') + ' (got ' + actual + ')';
    if (p.enum && !p.enum.includes(v)) return 'field "' + k + '" must be one of ' + p.enum.join(', ');
  }
  return null;
}

function friendlyApiError(e) {
  if (e instanceof Anthropic.AuthenticationError) return { code: 'auth', message: 'The API key was rejected. Check it in Connect → Claude inside After Effects.' };
  if (e instanceof Anthropic.PermissionDeniedError) return { code: 'auth', message: 'This API key is not allowed to use the selected model: ' + e.message };
  if (e instanceof Anthropic.RateLimitError) return { code: 'rate', message: 'Rate limited by the API — wait a moment and try again.' };
  if (e instanceof Anthropic.BadRequestError) return { code: 'api', message: 'The API rejected the request: ' + e.message };
  if (e instanceof Anthropic.InternalServerError) return { code: 'api', message: 'The Claude API had a server error (' + e.status + '). Try again.' };
  if (e instanceof Anthropic.APIConnectionError) return { code: 'network', message: 'Could not reach the Claude API — check your internet connection.' };
  if (e instanceof Anthropic.APIError) return { code: 'api', message: 'API error ' + (e.status || '') + ': ' + e.message };
  return { code: 'error', message: e && e.message ? e.message : String(e) };
}

class ApiBackend {
  constructor({ settings, toolset, emit }) {
    this.settings = settings || {};
    this.toolset = toolset;
    this.emit = emit;
    const apiKey = this.settings.apiKey || process.env.ANTHROPIC_API_KEY;
    const opts = { maxRetries: 2 };
    if (apiKey) opts.apiKey = apiKey;
    if (process.env.CLAUDEAE_API_BASE_URL) opts.baseURL = process.env.CLAUDEAE_API_BASE_URL;
    this.client = new Anthropic(opts);
    this.messages = [];
    this.tools = toolset.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema, eager_input_streaming: true }));
    this.schemas = new Map(toolset.tools.map((t) => [t.name, t.inputSchema]));
    this.abortCtl = null;
    this.stopped = false;
  }

  reset() { this.messages = []; }

  stop() {
    this.stopped = true;
    if (this.abortCtl) this.abortCtl.abort();
  }

  /** @param {string|object[]} content  text, or content blocks (text / image / document) */
  async send(content) {
    this.stopped = false;
    this.messages.push({ role: 'user', content: Array.isArray(content) ? content : [{ type: 'text', text: content }] });
    const model = this.settings.model || 'claude-opus-5-5';
    const usage = { input: 0, output: 0, cacheRead: 0 };
    let jsonRetries = 0;

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      if (this.stopped) return { stopReason: 'stopped', usage };
      this.abortCtl = new AbortController();
      const params = {
        model,
        max_tokens: 64000,
        system: SYSTEM_PROMPT,
        tools: this.tools,
        messages: this.messages,
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: this.settings.effort || 'high' },
        cache_control: { type: 'ephemeral' },
      };
      const stream = FALLBACK_MODELS.has(model)
        ? this.client.beta.messages.stream(Object.assign({}, params, { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }), { signal: this.abortCtl.signal })
        : this.client.messages.stream(params, { signal: this.abortCtl.signal });
      stream.on('text', (delta) => this.emit({ type: 'text', delta }));
      stream.on('thinking', (delta) => { if (delta) this.emit({ type: 'thinking', delta }); });
      stream.on('streamEvent', (ev) => {
        if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'tool_use') this.emit({ type: 'tool_pending', name: ev.content_block.name });
      });

      let msg;
      try {
        msg = await stream.finalMessage();
        jsonRetries = 0;
      } catch (e) {
        if (this.stopped || e instanceof Anthropic.APIUserAbortError) return { stopReason: 'stopped', usage };
        if (e instanceof Anthropic.APIError) throw Object.assign(new Error(friendlyApiError(e).message), friendlyApiError(e));
        // eager input streaming: the tool input could not be parsed at all — re-issue the turn
        if (jsonRetries++ < 2) { this.emit({ type: 'log', message: 'Tool input was not valid JSON, retrying (' + e.message + ')' }); continue; }
        throw e;
      }
      if (msg.usage) { usage.input += msg.usage.input_tokens || 0; usage.output += msg.usage.output_tokens || 0; usage.cacheRead += msg.usage.cache_read_input_tokens || 0; }
      if (msg.content && msg.content.some((b) => b.type === 'fallback')) this.emit({ type: 'log', message: 'Served by fallback model ' + msg.model });

      if (msg.stop_reason === 'refusal') {
        // a refusal can cut a tool_use off mid-input: never run that turn's tools
        const cat = msg.stop_details && msg.stop_details.category ? ' (' + msg.stop_details.category + ')' : '';
        throw Object.assign(new Error('Claude declined this request' + cat + '. Try rephrasing it.'), { code: 'refusal' });
      }
      const toolUses = msg.content.filter((b) => b.type === 'tool_use');
      if (msg.stop_reason === 'max_tokens' && toolUses.length) {
        throw Object.assign(new Error('The response was cut off while Claude was writing a tool call. Ask for a smaller step.'), { code: 'max_tokens' });
      }
      this.messages.push({ role: 'assistant', content: msg.content });
      if (msg.stop_reason === 'pause_turn') continue;
      if (!toolUses.length) return { stopReason: msg.stop_reason, usage };

      const results = [];
      for (const tu of toolUses) {
        if (this.stopped) {
          results.push({ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: 'Cancelled by the user.' });
          this.emit({ type: 'tool_end', toolId: tu.id, ok: false, text: 'Cancelled' });
          continue;
        }
        this.emit({ type: 'tool_start', toolId: tu.id, name: tu.name, input: tu.input });
        const schema = this.schemas.get(tu.name);
        const problem = schema ? validateInput(schema, tu.input) : 'unknown tool ' + tu.name;
        if (problem) {
          results.push({ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: JSON.stringify({ INVALID_JSON: JSON.stringify(tu.input), problem }) });
          this.emit({ type: 'tool_end', toolId: tu.id, ok: false, text: 'Invalid input: ' + problem });
          continue;
        }
        const t0 = Date.now();
        try {
          const out = await this.toolset.callTool(tu.name, tu.input);
          const content = [{ type: 'text', text: out.text || '(no output)' }];
          if (out.image) content.push({ type: 'image', source: { type: 'base64', media_type: out.image.mimeType, data: out.image.data } });
          results.push({ type: 'tool_result', tool_use_id: tu.id, content });
          this.emit({ type: 'tool_end', toolId: tu.id, ok: true, text: out.text, image: out.image, ms: Date.now() - t0 });
        } catch (e) {
          const m = 'Error: ' + (e.message || String(e)) + (e.warnings && e.warnings.length ? '\nWarnings: ' + e.warnings.join(' | ') : '');
          results.push({ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: m });
          this.emit({ type: 'tool_end', toolId: tu.id, ok: false, text: m, ms: Date.now() - t0 });
        }
      }
      this.messages.push({ role: 'user', content: results });
      if (this.stopped) return { stopReason: 'stopped', usage };
    }
    throw Object.assign(new Error('Stopped after ' + MAX_ITERATIONS + ' tool rounds.'), { code: 'limit' });
  }
}

module.exports = { ApiBackend, validateInput };
