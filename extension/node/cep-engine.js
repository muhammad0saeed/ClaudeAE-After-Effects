'use strict';
// Runs ClaudeAE engine commands through CEP's evalScript (used by the bridge and the panel).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function jsLiteral(s) {
  // JSON string literal that is also valid ES3 (no raw U+2028/2029 or non-ASCII characters)
  return JSON.stringify(String(s)).replace(/[\u007f-￿]/g, (c) => '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4));
}

const FILE_THRESHOLD = 256 * 1024;

class CepEngine {
  /**
   * @param {{evalScript: (script: string, cb: (result: string) => void) => void, enginePath: string}} opts
   */
  constructor(opts) {
    this.evalScriptFn = opts.evalScript;
    this.enginePath = opts.enginePath;
    this.loadedMtime = 0;
    this.queue = Promise.resolve();
  }

  _eval(script) {
    return new Promise((resolve) => this.evalScriptFn(script, (r) => resolve(r)));
  }

  async ensureLoaded(force) {
    const mtime = Math.round(fs.statSync(this.enginePath).mtimeMs);
    if (!force && this.loadedMtime === mtime) {
      const t = await this._eval('typeof ClaudeAE === "object" && ClaudeAE.__cepMtime === ' + mtime);
      if (t === 'true') return;
    }
    const r = await this._eval('$.evalFile(new File(' + jsLiteral(this.enginePath.replace(/\\/g, '/')) + ')); ClaudeAE.__cepMtime = ' + mtime + '; "loaded " + ClaudeAE.version;');
    if (!/^loaded /.test(String(r))) throw new Error('Could not load the ClaudeAE engine (' + this.enginePath + '): ' + r);
    this.loadedMtime = mtime;
  }

  /** Runs one engine method and resolves to the raw engine reply {ok, result, warnings, error}. */
  call(method, params) {
    const run = () => this._call(method, params);
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => { });
    return p;
  }

  async _call(method, params) {
    await this.ensureLoaded();
    const req = JSON.stringify({ method, params: params || {} });
    let out, tmp = null;
    if (req.length > FILE_THRESHOLD) {
      tmp = path.join(os.tmpdir(), 'claudeae-req-' + crypto.randomBytes(6).toString('hex') + '.json');
      fs.writeFileSync(tmp, req, 'utf8');
      out = await this._eval('ClaudeAE.runFile(' + jsLiteral(tmp.replace(/\\/g, '/')) + ')');
    } else {
      out = await this._eval('ClaudeAE.run(' + jsLiteral(req) + ')');
    }
    if (tmp) { try { fs.unlinkSync(tmp); } catch (_) { } }
    if (out === 'EvalScript error.' || out === undefined || out === null || out === '') {
      // engine was unloaded (e.g. another script redefined globals) — reload once and retry
      await this.ensureLoaded(true);
      out = await this._eval('ClaudeAE.run(' + jsLiteral(req) + ')');
    }
    try {
      return JSON.parse(out);
    } catch (e) {
      return { ok: false, error: { message: 'After Effects returned an unexpected reply: ' + String(out).slice(0, 300) }, warnings: [] };
    }
  }
}

module.exports = { CepEngine, jsLiteral };
