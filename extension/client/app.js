/* ClaudeAE panel — chat with Claude, import motion designs, connect Claude Desktop. */
(function () {
  'use strict';
  var path = require('path');
  var fs = require('fs');
  var os = require('os');
  var cp = require('child_process');
  var readline = require('readline');

  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };
  var esc = Markdown.escape;

  /* ------------------------------------------------------------------ roots */
  var EXT = CEP.getSystemPath('extension');
  var REAL_EXT = EXT;
  try { REAL_EXT = fs.realpathSync(EXT); } catch (e) { }
  var CONFIG_DIR = path.join(os.homedir(), '.claudeae');
  var SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');

  function readJson(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } }
  function writeJson(f, data) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    var tmp = f + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, f);
  }

  var ROOT = (function () {
    var cands = [path.join(REAL_EXT, '..'), (readJson(path.join(CONFIG_DIR, 'config.json'), {}) || {}).root];
    for (var i = 0; i < cands.length; i++) if (cands[i] && fs.existsSync(path.join(cands[i], 'lib', 'tools.js'))) return cands[i];
    return null;
  })();
  var VERSION = ROOT ? (readJson(path.join(ROOT, 'package.json'), {}).version || '1.0.0') : '1.0.0';

  var settings = Object.assign({ backend: 'claude-code', model: 'claude-opus-5-5', effort: 'high', bridgePort: 48760 }, readJson(SETTINGS_FILE, {}));
  function saveSettings(patch) {
    Object.assign(settings, patch);
    writeJson(SETTINGS_FILE, settings);
  }

  /* ------------------------------------------------------- engine / tools */
  var CepEngine = require(path.join(EXT, 'node', 'cep-engine.js')).CepEngine;
  var bridgeMod = require(path.join(EXT, 'node', 'bridge-server.js'));
  var engine = new CepEngine({ evalScript: CEP.evalScript, enginePath: path.join(EXT, 'host', 'claudeae.jsx') });

  var panelTransport = {
    mode: 'panel',
    call: function (method, params) {
      var t0 = Date.now();
      return engine.call(method, params).then(function (r) {
        if (method !== 'context') addActivity({ source: 'panel', method: method, ok: !!r.ok, ms: Date.now() - t0, error: r.ok ? undefined : r.error && r.error.message, warnings: r.warnings || [] });
        if (!r.ok) { var e = new Error((r.error && r.error.message) || 'After Effects error'); e.warnings = r.warnings || []; throw e; }
        return { result: r.result, warnings: r.warnings || [], transport: 'panel' };
      });
    },
    status: function () { return Promise.resolve({ bridge: state.bridge, afterEffects: { running: true }, mode: 'panel' }); }
  };

  var tools = null, motionLib = null, locate = null, htmlLib = null, libError = null;
  if (ROOT) {
    try {
      tools = require(path.join(ROOT, 'lib', 'tools.js')).createTools({ transport: panelTransport });
      motionLib = require(path.join(ROOT, 'lib', 'motion.js'));
      locate = require(path.join(ROOT, 'lib', 'locate.js'));
      htmlLib = fs.existsSync(path.join(ROOT, 'lib', 'html', 'cli.js'));
    } catch (e) { libError = e; }
  }

  var state = { bridge: { running: false }, activity: [], unseen: 0 };

  /* ------------------------------------------------------------------ tabs */
  $$('.tab').forEach(function (t) {
    t.addEventListener('click', function () {
      $$('.tab').forEach(function (x) { x.classList.toggle('active', x === t); });
      $$('.pane').forEach(function (p) { p.classList.toggle('active', p.id === 'tab-' + t.dataset.tab); });
      if (t.dataset.tab === 'activity') { state.unseen = 0; renderBadge(); }
      if (t.dataset.tab === 'connect') refreshConnect();
    });
  });
  function showTab(name) { var t = $('.tab[data-tab="' + name + '"]'); if (t) t.click(); }

  /* --------------------------------------------------------------- theme */
  (function theme() {
    var skin = CEP.skin();
    if (skin && skin.panelBackgroundColor && skin.panelBackgroundColor.color) {
      var c = skin.panelBackgroundColor.color;
      document.documentElement.style.setProperty('--bg', 'rgb(' + Math.round(c.red) + ',' + Math.round(c.green) + ',' + Math.round(c.blue) + ')');
    }
  })();

  /* -------------------------------------------------------------- bridge */
  var ownBridge = null;
  function ensureBridge() {
    var info = bridgeMod.readBridgeFile();
    return bridgeMod.checkBridge(info).then(function (alive) {
      if (alive) { state.bridge = { running: true, port: info.port, host: alive.extension, requests: alive.requests }; return; }
      if (ownBridge && ownBridge.server) { state.bridge = { running: true, port: ownBridge.port, host: 'panel', requests: ownBridge.requests }; return; }
      ownBridge = new bridgeMod.BridgeServer({ engine: engine, version: VERSION, host: 'panel', onActivity: addActivity });
      return ownBridge.start(Number(settings.bridgePort) || 48760).then(function (port) {
        state.bridge = { running: true, port: port, host: 'panel', requests: 0 };
      });
    }).catch(function (e) {
      state.bridge = { running: false, error: e.message };
    }).then(renderStatus);
  }
  function renderStatus() {
    var b = state.bridge, el = $('#status');
    el.classList.toggle('ok', !!b.running);
    el.classList.toggle('err', !b.running);
    $('#statusText').textContent = b.running ? 'Connected · :' + b.port : 'Bridge offline';
    el.title = b.running ? 'MCP bridge on 127.0.0.1:' + b.port + ' (hosted by the ' + (b.host === 'panel' ? 'panel' : 'background extension') + ')' : (b.error || 'Bridge not running');
    $('#bridgeInfo').textContent = b.running ? '127.0.0.1:' + b.port + (b.host === 'panel' ? ' (panel)' : '') : 'offline';
  }
  $('#status').addEventListener('click', function () { showTab('connect'); });
  CEP.addEventListener('com.claudeae.activity', function (ev) { addActivity(CEP.eventData(ev)); });
  CEP.addEventListener('com.claudeae.bridge', function () { ensureBridge(); });
  window.addEventListener('beforeunload', function () { if (ownBridge) ownBridge.stop(); if (agent) { try { agent.kill(); } catch (e) { } } });

  /* ------------------------------------------------------------ activity */
  function addActivity(e) {
    if (!e || !e.method) return;
    state.activity.unshift(e);
    if (state.activity.length > 300) state.activity.pop();
    if (!$('#tab-activity').classList.contains('active')) { state.unseen++; renderBadge(); }
    renderActivity();
  }
  function renderBadge() {
    var b = $('#activityBadge');
    b.textContent = state.unseen > 99 ? '99+' : String(state.unseen);
    b.classList.toggle('hidden', !state.unseen);
  }
  function renderActivity() {
    var ul = $('#activity');
    ul.innerHTML = state.activity.slice(0, 150).map(function (a) {
      var t = new Date(a.time || Date.now());
      var w = a.warnings && a.warnings.length ? '<div class="w">' + esc(a.warnings.slice(0, 3).join(' · ')) + '</div>' : '';
      return '<li><span class="' + (a.ok ? 'i-ok' : 'i-err') + '">' + (a.ok ? '✓' : '✗') + '</span>' +
        '<span><span class="src">' + esc(a.source || '') + '</span> <span class="m">' + esc(a.method) + '</span></span>' +
        '<span class="t">' + (a.ms != null ? a.ms + ' ms · ' : '') + t.toLocaleTimeString() + '</span>' +
        (a.error ? '<div class="e">' + esc(a.error) + '</div>' : '') + w + '</li>';
    }).join('');
  }
  $('#undoLast').addEventListener('click', function () {
    panelTransport.call('undo', { steps: 1 }).catch(function (e) { alert(e.message); });
  });
  $('#clearActivity').addEventListener('click', function () { state.activity = []; renderActivity(); });

  /* ================================================================= CHAT */
  var agent = null, turn = null, seq = 0;

  function notice(html, kind) {
    var n = $('#chatNotice');
    if (!html) { n.classList.add('hidden'); return; }
    n.innerHTML = html;
    n.classList.remove('hidden');
  }

  function agentSettings() {
    return { backend: settings.backend, model: settings.model, effort: settings.effort, apiKey: settings.apiKey, claudePath: settings.claudePath };
  }

  function startAgent() {
    if (!ROOT || !locate) { notice('The ClaudeAE folder could not be found. Re-run the installer (scripts/install).'); return false; }
    var node = locate.findNode(settings.nodePath);
    if (!node) { notice('Chat needs <b>Node.js 18 or newer</b>. Install it from nodejs.org (or set its path in Connect), then click New.'); return false; }
    agent = cp.spawn(node.path, [path.join(ROOT, 'agent', 'agent.js')], { cwd: ROOT, env: Object.assign({}, process.env, { CLAUDEAE_TRANSPORT: 'auto' }), windowsHide: true });
    readline.createInterface({ input: agent.stdout }).on('line', function (l) {
      var ev;
      try { ev = JSON.parse(l); } catch (e) { return; }
      onAgentEvent(ev);
    });
    var errBuf = '';
    agent.stderr.on('data', function (d) { errBuf = (errBuf + d).slice(-2000); });
    agent.on('exit', function (code) {
      agent = null;
      if (turn) { turnError('The chat process stopped (exit code ' + code + '). ' + esc(errBuf.split('\n').slice(-3).join(' '))); endTurn(); }
    });
    agent.on('error', function (e) { agent = null; notice('Could not start Node.js: ' + esc(e.message)); });
    agent.stdin.write(JSON.stringify({ type: 'configure', settings: agentSettings() }) + '\n');
    return true;
  }
  function sendAgent(m) {
    if (!agent && !startAgent()) return false;
    agent.stdin.write(JSON.stringify(m) + '\n');
    return true;
  }
  function updateBackendLabel() {
    var m = $('#model').querySelector('option[value="' + settings.model + '"]');
    $('#backendLabel').textContent = (settings.backend === 'api' ? 'API' : 'Claude account') + ' · ' + (m ? m.textContent.replace('Claude ', '') : settings.model);
  }

  function scrollChat() { var m = $('#messages'); m.scrollTop = m.scrollHeight; }

  function addUserBubble(text, atts) {
    $('#emptyChat').classList.add('hidden');
    var d = document.createElement('div');
    d.className = 'msg user';
    d.textContent = text;
    if (atts && atts.length) {
      var t = document.createElement('div');
      t.className = 'tray';
      t.innerHTML = atts.map(function (a) { return chipHtml(a, false); }).join('');
      Array.prototype.forEach.call(t.querySelectorAll('.att'), function (c) { c.classList.add('busy'); });
      d.appendChild(t);
      lastUserTray = t;
    }
    $('#messages').appendChild(d);
    scrollChat();
  }
  var lastUserTray = null;
  // the agent reports what each attachment became (project item, text, document …)
  function markAttachments(list) {
    if (!lastUserTray) return;
    (list || []).forEach(function (r) {
      Array.prototype.forEach.call(lastUserTray.querySelectorAll('.att'), function (c) {
        if (c.dataset.path !== r.path) return;
        c.classList.remove('busy');
        c.classList.add(r.ok ? 'ok' : 'err');
        if (r.note) c.title = r.path + '\n' + r.note;
      });
    });
    Array.prototype.forEach.call(lastUserTray.querySelectorAll('.att.busy'), function (c) { c.classList.remove('busy'); });
  }

  function newTurn() {
    var d = document.createElement('div');
    d.className = 'msg assistant';
    d.innerHTML = '<div class="thinking"><span class="spinner"></span><span class="tlabel">Thinking…</span></div>';
    $('#messages').appendChild(d);
    turn = { el: d, current: null, text: '', tools: {}, id: ++seq, renderTimer: null };
    scrollChat();
    return turn;
  }
  function setThinking(label) {
    if (!turn) return;
    var t = turn.el.querySelector('.thinking');
    if (!t) { t = document.createElement('div'); t.className = 'thinking'; t.innerHTML = '<span class="spinner"></span><span class="tlabel"></span>'; turn.el.appendChild(t); }
    else turn.el.appendChild(t); // keep the indicator last
    t.querySelector('.tlabel').textContent = label;
  }
  function textBlock() {
    if (!turn.current) {
      turn.current = document.createElement('div');
      turn.current.className = 'text';
      turn.current._md = '';
      var th = turn.el.querySelector('.thinking');
      turn.el.insertBefore(turn.current, th);
    }
    return turn.current;
  }
  function appendText(delta) {
    var b = textBlock();
    b._md += delta;
    if (!turn.renderTimer) {
      turn.renderTimer = setTimeout(function () {
        if (!turn) return;
        turn.renderTimer = null;
        if (turn.current) turn.current.innerHTML = Markdown.render(turn.current._md);
        scrollChat();
      }, 60);
    }
  }
  function flushText() {
    if (turn && turn.current) turn.current.innerHTML = Markdown.render(turn.current._md);
  }

  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
  function summarizeInput(name, input) {
    input = input || {};
    try {
      switch (name) {
        case 'ae_create_comp': return (input.name || 'comp') + (input.layers ? ' · ' + plural(input.layers.length, 'layer') : '');
        case 'ae_add_layers': return plural(input.layers ? input.layers.length : 0, 'layer') + (input.comp ? ' → ' + input.comp : '');
        case 'ae_update_layer': return String(input.layer) + ' · ' + Object.keys(input.set || {}).join(', ');
        case 'ae_set_property': return String(input.layer) + ' · ' + input.path + (input.keyframes ? ' · ' + plural(input.keyframes.length, 'key') : '');
        case 'ae_render_frame': return 'frame' + (input.time !== undefined ? ' @ ' + input.time : '');
        case 'ae_import_motion': return input.file ? path.basename(input.file) : 'motion spec';
        case 'ae_import_file': return input.path ? path.basename(input.path) : (input.url || 'file');
        case 'ae_import_svg': return input.name || 'svg';
        case 'ae_run_script': return String(input.code || '').slice(0, 60);
        default: break;
      }
      var k = Object.keys(input).slice(0, 3).map(function (x) { var v = input[x]; return x + '=' + (typeof v === 'object' ? '…' : String(v)).slice(0, 24); });
      return k.join(' ');
    } catch (e) { return ''; }
  }
  function summarizeOutput(text) {
    try {
      var j = JSON.parse(text);
      var parts = [];
      if (j.result && j.result.layersCreated !== undefined) parts.push(plural(j.result.layersCreated, 'layer') + ' built');
      else if (j.result && j.result.layers && j.result.layers.length !== undefined) parts.push(plural(j.result.layers.length, 'layer') + ' built');
      if (j.warnings && j.warnings.length) parts.push(plural(j.warnings.length, 'warning'));
      return parts.join(' · ');
    } catch (e) { return String(text || '').split('\n')[0].slice(0, 80); }
  }

  function toolStart(ev) {
    turn.current = null;
    var d = document.createElement('details');
    d.className = 'tool running';
    d.innerHTML = '<summary><span class="ticon">◌</span><span class="tname">' + esc(ev.name.replace(/^ae_/, '')) + '</span><span class="tsum">' + esc(summarizeInput(ev.name, ev.input)) + '</span></summary><pre>' + esc(JSON.stringify(ev.input, null, 1).slice(0, 6000)) + '</pre>';
    turn.el.insertBefore(d, turn.el.querySelector('.thinking'));
    turn.tools[ev.toolId] = { el: d, name: ev.name };
    setThinking('Running ' + ev.name.replace(/^ae_/, '') + '…');
    scrollChat();
  }
  function toolEnd(ev) {
    var t = turn.tools[ev.toolId];
    if (!t) return;
    t.el.className = 'tool ' + (ev.ok ? 'ok' : 'err');
    t.el.querySelector('.ticon').textContent = ev.ok ? '✓' : '✗';
    var s = summarizeOutput(ev.text);
    if (s) t.el.querySelector('.tsum').textContent += '  →  ' + s;
    var pre = document.createElement('pre');
    pre.textContent = String(ev.text || '').slice(0, 8000);
    t.el.appendChild(pre);
    if (ev.image && ev.image.data) {
      var img = document.createElement('img');
      img.className = 'frame';
      img.src = 'data:' + ev.image.mimeType + ';base64,' + ev.image.data;
      img.addEventListener('click', function () { openLightbox(img.src); });
      turn.el.insertBefore(img, turn.el.querySelector('.thinking'));
    }
    setThinking('Thinking…');
    scrollChat();
  }
  function turnError(html) {
    if (!turn) return;
    var d = document.createElement('div');
    d.className = 'error';
    d.innerHTML = html;
    turn.el.insertBefore(d, turn.el.querySelector('.thinking'));
    scrollChat();
  }
  function endTurn(info) {
    if (!turn) return;
    flushText();
    var th = turn.el.querySelector('.thinking');
    if (th) th.remove();
    // No cost readout: with a Claude subscription, Claude Code only reports an API-equivalent estimate,
    // which reads like a charge. Token usage is shown for the API-key backend only.
    if (info && info.usage && info.usage.output && settings.backend === 'api') {
      var c = document.createElement('div');
      c.className = 'cost';
      c.textContent = (info.usage.input + info.usage.cacheRead) + ' in · ' + info.usage.output + ' out tokens';
      turn.el.appendChild(c);
    }
    if (!turn.el.querySelector('.text, .tool, .error, .frame')) turn.el.remove();
    turn = null;
    $('#send').textContent = 'Send';
    $('#send').classList.add('primary');
    $('#prompt').focus();
  }

  function onAgentEvent(ev) {
    switch (ev.type) {
      case 'ready': case 'configured': case 'pong': case 'reset_done': break;
      case 'status': break;
      case 'turn_start': break;
      case 'thinking': if (turn) setThinking('Thinking: …' + String(ev.delta).slice(-70)); break;
      case 'text': if (turn) { appendText(ev.delta); setThinking('Writing…'); } break;
      case 'tool_pending': if (turn) setThinking('Preparing ' + String(ev.name).replace(/^ae_/, '') + '…'); break;
      case 'tool_start': if (turn) toolStart(ev); break;
      case 'tool_end': if (turn) toolEnd(ev); break;
      case 'error':
        if (ev.code === 'auth' || ev.code === 'no_claude') {
          notice(esc(ev.message) + (settings.backend === 'api' ? ' <button class="secondary" data-go="connect">Settings</button>' : ' <button class="secondary" id="noticeLogin">Sign in…</button> <button class="ghost" data-go="connect">Settings</button>'));
          var b = $('#noticeLogin');
          if (b) b.addEventListener('click', function () { sendAgent({ type: 'login' }); });
          $$('#chatNotice [data-go]').forEach(function (x) { x.addEventListener('click', function () { showTab('connect'); }); });
        }
        if (turn) turnError('⚠ ' + esc(ev.message));
        else if (ev.message) notice(esc(ev.message));
        break;
      case 'attached': markAttachments(ev.items); if (turn) setThinking('Thinking…'); break;
      case 'turn_end': endTurn(ev); break;
      case 'auth': renderAuth(ev); break;
      case 'log': console.log('[agent]', ev.message); break;
      default: break;
    }
  }

  /* ------------------------------------------------------- attachments */
  // Files attached to the next message: imported into the project by the agent and shown to Claude
  // (pictures as images, scripts/subtitles as text, PDFs as documents, media with their details).
  var KINDS = [
    ['image', /\.(png|jpe?g|gif|webp|bmp|tiff?|tga|exr|hdr|heic|avif)$/i],
    ['graphic', /\.(psd|ai|eps|svg)$/i],
    ['video', /\.(mp4|m4v|mov|avi|mkv|mxf|wmv|mpe?g|mts|m2ts|3gp|webm)$/i],
    ['audio', /\.(wav|wave|mp3|aac|m4a|aiff?|aifc|flac|ogg|opus)$/i],
    ['text', /\.(txt|md|srt|vtt|csv|rtf)$/i],
    ['motion', /\.json$/i],
    ['html', /\.html?$/i],
    ['pdf', /\.pdf$/i]
  ];
  var BROWSER_IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
  var pending = [];

  function kindOf(p) {
    try { if (fs.statSync(p).isDirectory()) return 'folder'; } catch (e) { return null; }
    for (var i = 0; i < KINDS.length; i++) if (KINDS[i][1].test(p)) return KINDS[i][0];
    return 'file';
  }
  function fmtSize(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }

  // Downscaled copy of a picture for Claude to look at (≤ 1568 px, ≤ ~4 MB).
  function makePreview(file) {
    return new Promise(function (resolve) {
      var buf;
      try { if (fs.statSync(file).size > 60 * 1048576) return resolve(null); buf = fs.readFileSync(file); } catch (e) { return resolve(null); }
      var ext = path.extname(file).slice(1).toLowerCase();
      var mime = ext === 'jpg' ? 'image/jpeg' : ext === 'svg' ? 'image/svg+xml' : 'image/' + ext;
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth || 1024, h = img.naturalHeight || 1024, k = Math.min(1, 1568 / Math.max(w, h));
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
        var g = c.getContext('2d');
        var alpha = /png|gif|webp|svg/.test(ext);
        if (!alpha) { g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); }
        g.drawImage(img, 0, 0, c.width, c.height);
        var url = alpha ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.88);
        if (url.length > 5200000) { g.globalCompositeOperation = 'destination-over'; g.fillStyle = '#808080'; g.fillRect(0, 0, c.width, c.height); url = c.toDataURL('image/jpeg', 0.85); }
        var m = /^data:([^;]+);base64,(.*)$/.exec(url);
        resolve(m ? { mimeType: m[1], data: m[2], width: w, height: h, thumb: url } : null);
      };
      img.onerror = function () { resolve(null); };
      img.src = 'data:' + mime + ';base64,' + buf.toString('base64');
    });
  }

  function addAttachment(p) {
    if (!p || pending.some(function (a) { return a.path === p; })) return;
    var kind = kindOf(p);
    if (!kind) return;
    var size = 0;
    try { size = fs.statSync(p).size; } catch (e) { }
    var a = { path: p, name: path.basename(p), kind: kind, size: size, preview: null, ready: Promise.resolve() };
    if (BROWSER_IMAGE.test(p)) a.ready = makePreview(p).then(function (pr) { a.preview = pr; renderTray(); });
    pending.push(a);
    renderTray();
  }

  function chipHtml(a, removable) {
    var thumb = a.preview && a.preview.thumb ? '<img class="thumb" src="' + a.preview.thumb + '" alt="">' : '<span class="thumb">' + esc(a.kind === 'folder' ? 'dir' : (path.extname(a.name).slice(1, 5) || a.kind)) + '</span>';
    var meta = a.kind === 'folder' ? 'folder' : (a.preview && a.preview.width ? a.preview.width + '×' + a.preview.height + ' · ' : '') + fmtSize(a.size);
    return '<span class="att" data-path="' + esc(a.path) + '" title="' + esc(a.path) + '">' + thumb + '<span class="nm">' + esc(a.name) + '</span><span class="meta">' + esc(meta) + '</span>' + (removable ? '<button type="button" class="x" title="Remove">×</button>' : '') + '</span>';
  }
  function renderTray() {
    var tray = $('#tray');
    tray.innerHTML = pending.map(function (a) { return chipHtml(a, true); }).join('');
    tray.classList.toggle('hidden', !pending.length);
    $$('#tray .att .x').forEach(function (b) {
      b.addEventListener('click', function () {
        var p = b.parentNode.dataset.path;
        pending = pending.filter(function (a) { return a.path !== p; });
        renderTray();
      });
    });
  }

  $('#attachBtn').addEventListener('click', function (e) {
    // Shift+click picks a whole folder of assets
    var r = null;
    if (e.shiftKey && window.cep && cep.fs && cep.fs.showOpenDialogEx) {
      var d = cep.fs.showOpenDialogEx(false, true, 'Attach a folder of assets', '', []);
      r = d && !d.err && d.data && d.data.length ? d.data : null;
    } else r = CEP.openFileDialog('Attach files for Claude', [], true);
    if (r) r.forEach(addAttachment);
    $('#prompt').focus();
  });

  // pasted screenshots / images → temp PNG files
  $('#prompt').addEventListener('paste', function (e) {
    var items = (e.clipboardData && e.clipboardData.items) || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind !== 'file' || !/^image\//.test(items[i].type)) continue;
      var f = items[i].getAsFile();
      if (!f) continue;
      e.preventDefault();
      (function (blob) {
        var rd = new FileReader();
        rd.onload = function () {
          var dir = path.join(os.tmpdir(), 'claudeae-pasted');
          fs.mkdirSync(dir, { recursive: true });
          var out = path.join(dir, 'pasted-' + Date.now() + '.png');
          fs.writeFileSync(out, Buffer.from(String(rd.result).split(',')[1], 'base64'));
          addAttachment(out);
        };
        rd.readAsDataURL(blob);
      })(f);
    }
  });

  function submit() {
    var ta = $('#prompt');
    if (turn) { sendAgent({ type: 'stop' }); setThinking('Stopping…'); return; }
    var text = ta.value.trim();
    if (!text && !pending.length) return;
    var atts = pending;
    pending = [];
    renderTray();
    if (!text) text = atts.length === 1 ? 'Here is ' + atts[0].name + '.' : 'Here are ' + atts.length + ' files.';
    ta.value = '';
    notice(null);
    addUserBubble(text, atts);
    newTurn();
    $('#send').textContent = 'Stop';
    $('#send').classList.remove('primary');
    var withContext = $('#attachContext').checked;
    var ctxP = withContext ? panelTransport.call('context', {}).then(function (r) { return r.result; }, function () { return null; }) : Promise.resolve(null);
    Promise.all([ctxP].concat(atts.map(function (a) { return a.ready; }))).then(function (res) {
      var attachments = atts.map(function (a) {
        return { path: a.path, name: a.name, kind: a.kind, size: a.size, preview: a.preview ? { mimeType: a.preview.mimeType, data: a.preview.data, width: a.preview.width, height: a.preview.height } : undefined };
      });
      if (attachments.length) setThinking('Adding ' + plural(attachments.length, 'file') + ' to the project…');
      if (!sendAgent({ type: 'user', id: turn ? turn.id : seq, text: text, context: res[0], attachments: attachments })) endTurn();
    });
  }
  $('#composer').addEventListener('submit', function (e) { e.preventDefault(); submit(); });
  $('#prompt').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  });
  $('#newChat').addEventListener('click', function () {
    if (turn) sendAgent({ type: 'stop' });
    if (agent) agent.stdin.write(JSON.stringify({ type: 'reset' }) + '\n');
    $$('#messages .msg').forEach(function (m) { m.remove(); });
    $('#emptyChat').classList.remove('hidden');
    notice(null);
    turn = null;
    $('#send').textContent = 'Send';
    $('#send').classList.add('primary');
  });
  $$('.chip-suggest').forEach(function (b) {
    b.addEventListener('click', function () { $('#prompt').value = b.textContent; $('#prompt').focus(); });
  });
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[data-href]');
    if (a) { e.preventDefault(); CEP.openURL(a.dataset.href); }
  });
  function openLightbox(src) { var lb = $('#lightbox'); lb.querySelector('img').src = src; lb.classList.remove('hidden'); }
  $('#lightbox').addEventListener('click', function () { $('#lightbox').classList.add('hidden'); });

  /* =============================================================== IMPORT */
  function logEntry(html, kind) {
    var d = document.createElement('div');
    d.className = 'entry ' + (kind || '');
    d.innerHTML = html;
    var log = $('#importLog');
    log.insertBefore(d, log.firstChild);
    return d;
  }
  function target() { return ($('input[name=target]:checked') || {}).value || 'new'; }

  function activeContext() {
    return panelTransport.call('context', {}).then(function (r) { return r.result; });
  }
  function needComp(ctx) {
    if (!ctx || !ctx.activeComp) throw new Error('Open (or click into) a composition first — or choose "New compositions".');
    return ctx.activeComp;
  }

  function describeResult(out) {
    var j = null;
    try { j = JSON.parse(out.text); } catch (e) { return esc(String(out.text || '').slice(0, 300)); }
    var r = j.result || {}, parts = [];
    if (r.comps && r.comps.length) parts.push(r.comps.length + ' comp' + (r.comps.length > 1 ? 's' : '') + ' (' + esc(r.comps.map(function (c) { return c.name; }).join(', ')) + ')');
    if (r.layersCreated !== undefined) parts.push(plural(r.layersCreated, 'layer'));
    else if (r.layers) parts.push(plural(r.layers.length, 'layer'));
    if (r.item) parts.push(esc(r.item.name));
    if (r.layer) parts.push('layer #' + r.layer.index + ' at ' + r.layer.inPoint + ' s');
    if (r.comp && r.comp.name && !r.comps) parts.push('in ' + esc(r.comp.name));
    var html = parts.join(' · ') || 'Done';
    if (j.warnings && j.warnings.length) html += '<ul>' + j.warnings.slice(0, 12).map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul>';
    return html;
  }

  function runImport(label, fn) {
    if (!tools) { logEntry('ClaudeAE library not available: ' + esc(libError ? libError.message : 'folder not found'), 'err'); return Promise.resolve(); }
    var entry = logEntry('<b>' + esc(label) + '</b> — working…', 'run');
    return Promise.resolve().then(fn).then(function (out) {
      entry.className = 'entry ok';
      entry.innerHTML = '<b>' + esc(label) + '</b> — ' + describeResult(out);
    }).catch(function (e) {
      entry.className = 'entry err';
      entry.innerHTML = '<b>' + esc(label) + '</b> — ' + esc(e.message) + (e.warnings && e.warnings.length ? '<ul>' + e.warnings.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul>' : '');
    });
  }

  function motionArgs(base) {
    var t = target();
    if (t === 'new') return Promise.resolve(Object.assign({ mode: 'new' }, base));
    return activeContext().then(function (ctx) {
      var c = needComp(ctx);
      return Object.assign({ mode: t, comp: c.id, time: c.time }, base);
    });
  }

  function importSvgText(svg, name) {
    var t = target();
    if (t === 'new') {
      var size = { width: 1920, height: 1080 };
      try { var r = require(path.join(ROOT, 'lib', 'svg.js')).svgToShapes(svg); size = { width: Math.max(4, Math.round(r.width)), height: Math.max(4, Math.round(r.height)) }; } catch (e) { }
      return tools.callTool('ae_create_comp', { name: name, width: size.width, height: size.height, duration: 10, folder: 'ClaudeAE Imports' }).then(function (c) {
        var comp = JSON.parse(c.text).result.comp;
        return tools.callTool('ae_import_svg', { svg: svg, comp: comp.id, name: name, position: [size.width / 2, size.height / 2] });
      });
    }
    return activeContext().then(function (ctx) {
      var c = needComp(ctx);
      return tools.callTool('ae_import_svg', { svg: svg, comp: c.id, name: name, time: c.time, position: [c.width / 2, c.height / 2] });
    });
  }

  // HTML → layers runs in a separate Node.js process (headless Chrome + keyframe fitting can take a
  // while and must not freeze the panel); progress lines stream back as JSON.
  function importHtmlFile(file) {
    var dur = parseFloat($('#htmlDuration').value), fps = parseFloat($('#htmlFps').value) || 30;
    var node = locate && locate.findNode(settings.nodePath);
    if (!node) return Promise.reject(new Error('HTML import needs Node.js 18+ (set its path in Connect).'));
    var entry = $('#importLog .entry.run');
    var progress = function (msg) { if (entry) entry.innerHTML = '<b>' + esc(path.basename(file)) + '</b> — ' + esc(msg); };
    return new Promise(function (resolve, reject) {
      var args = [path.join(ROOT, 'lib', 'html', 'cli.js'), file, '--fps', String(fps)];
      if (isFinite(dur) && dur > 0) args.push('--duration', String(dur));
      var child = cp.spawn(node.path, args, { cwd: ROOT, windowsHide: true });
      var result = null, errText = '';
      readline.createInterface({ input: child.stdout }).on('line', function (l) {
        var m; try { m = JSON.parse(l); } catch (e) { return; }
        if (m.progress) progress(m.progress);
        if (m.done || m.error) result = m;
      });
      child.stderr.on('data', function (d) { errText = (errText + d).slice(-1500); });
      child.on('error', function (e) { reject(e); });
      child.on('exit', function () {
        if (!result) return reject(new Error('HTML conversion failed' + (errText ? ': ' + errText.split(/\r?\n/).slice(-3).join(' ') : '')));
        if (result.error) return reject(new Error(result.error));
        progress('Building ' + result.stats.layers + ' layers in After Effects…');
        motionArgs({ file: result.specFile }).then(function (a) { return tools.callTool('ae_import_motion', a); }).then(function (out) {
          if (result.warnings && result.warnings.length) {
            try { var j = JSON.parse(out.text); j.warnings = result.warnings.concat(j.warnings || []); out.text = JSON.stringify(j); } catch (e) { }
          }
          resolve(out);
        }, reject);
      });
    });
  }

  var FOOTAGE = /\.(png|jpe?g|gif|tiff?|bmp|psd|ai|eps|pdf|mp4|mov|m4v|avi|mxf|webm|mp3|wav|aif+|m4a|aac|exr|tga|dpx)$/i;
  function importPath(file) {
    var ext = path.extname(file).toLowerCase(), name = path.basename(file, ext);
    if (ext === '.json') return runImport(path.basename(file), function () { return motionArgs({ file: file }).then(function (a) { return tools.callTool('ae_import_motion', a); }); });
    if (ext === '.svg') return runImport(path.basename(file), function () { return importSvgText(fs.readFileSync(file, 'utf8'), name); });
    if (ext === '.html' || ext === '.htm') return runImport(path.basename(file), function () { return importHtmlFile(file); });
    if (FOOTAGE.test(file)) {
      return runImport(path.basename(file), function () {
        if (target() === 'new') return tools.callTool('ae_import_file', { path: file, folder: 'ClaudeAE Imports' });
        return activeContext().then(function (ctx) { var c = needComp(ctx); return tools.callTool('ae_import_file', { path: file, comp: c.id, time: c.time, fit: 'contain' }); });
      });
    }
    logEntry('Unsupported file type: ' + esc(path.basename(file)), 'err');
    return Promise.resolve();
  }

  function importText(text) {
    var s = String(text || '').trim();
    if (!s) return;
    if (s[0] === '{' || s[0] === '[') {
      runImport('Pasted motion spec', function () {
        JSON.parse(s); // early, readable error for invalid JSON
        return motionArgs({ spec: s }).then(function (a) { return tools.callTool('ae_import_motion', a); });
      });
    } else if (/<svg[\s>]/i.test(s) && !/<html[\s>]/i.test(s)) {
      runImport('Pasted SVG', function () { return importSvgText(s, 'Pasted SVG'); });
    } else if (/<html[\s>]|<!doctype html/i.test(s)) {
      var f = path.join(os.tmpdir(), 'claudeae-pasted-' + Date.now() + '.html');
      fs.writeFileSync(f, s, 'utf8');
      runImport('Pasted HTML', function () { return importHtmlFile(f); });
    } else logEntry('Paste a Claude Motion JSON, an SVG or an HTML document.', 'err');
  }

  $('#browse').addEventListener('click', function () {
    var files = CEP.openFileDialog('Import into After Effects', ['json', 'svg', 'html', 'htm', 'png', 'jpg', 'jpeg', 'mp4', 'mov', 'mp3', 'wav', 'psd', 'ai'], true);
    if (files) files.forEach(importPath);
  });
  $('#importPaste').addEventListener('click', function () { importText($('#pasteBox').value); });

  var drop = $('#drop');
  // files dropped while the Chat tab is open are attached to the next message; elsewhere they are imported
  var chatOpen = function () { return $('#tab-chat').classList.contains('active'); };
  ['dragenter', 'dragover'].forEach(function (t) { document.addEventListener(t, function (e) { e.preventDefault(); (chatOpen() ? $('#composer') : drop).classList.add('over'); }); });
  ['dragleave', 'drop'].forEach(function (t) { document.addEventListener(t, function (e) { e.preventDefault(); if (t === 'dragleave' && e.relatedTarget) return; drop.classList.remove('over'); $('#composer').classList.remove('over'); }); });
  document.addEventListener('drop', function (e) {
    var dt = e.dataTransfer;
    if (!dt) return;
    if (chatOpen()) {
      var dropped = Array.prototype.slice.call(dt.files || []).map(function (f) { return f.path; }).filter(Boolean);
      if (dropped.length) { dropped.forEach(addAttachment); $('#prompt').focus(); return; }
      var dtxt = dt.getData('text/plain');
      if (dtxt) { var ta = $('#prompt'); ta.value += (ta.value ? '\n' : '') + dtxt; ta.focus(); }
      return;
    }
    showTab('import');
    var files = Array.prototype.slice.call(dt.files || []);
    if (files.length) {
      files.forEach(function (f) {
        if (f.path) importPath(f.path);
        else { var r = new FileReader(); r.onload = function () { importText(r.result); }; r.readAsText(f); }
      });
      return;
    }
    var txt = dt.getData('text/plain');
    if (txt) importText(txt);
  });

  (function examples() {
    if (!ROOT) return;
    var dir = path.join(ROOT, 'examples'), box = $('#examples');
    var files = [];
    ['', 'html', 'svg'].forEach(function (sub) {
      try { fs.readdirSync(path.join(dir, sub)).forEach(function (f) { if (/\.(json|svg|html)$/i.test(f)) files.push(sub ? sub + '/' + f : f); }); } catch (e) { }
    });
    box.innerHTML = files.map(function (f) { return '<button class="secondary" data-file="' + esc(f) + '">' + esc(f) + '</button>'; }).join('') || '<span class="muted">No examples found.</span>';
    $$('#examples button').forEach(function (b) { b.addEventListener('click', function () { importPath(path.join(dir, b.dataset.file)); }); });
  })();

  /* ============================================================== CONNECT */
  function desktopConfigPath() {
    if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
    return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  function mcpEntry() {
    var node = locate && locate.findNode(settings.nodePath);
    return { command: node ? node.path : 'node', args: [path.join(ROOT || REAL_EXT, 'mcp-server', 'index.js')] };
  }
  function refreshConnect() {
    renderStatus();
    if (!ROOT) { $('#desktopInfo').textContent = 'ClaudeAE folder not found'; return; }
    var cfg = readJson(desktopConfigPath(), null);
    var has = cfg && cfg.mcpServers && cfg.mcpServers.claudeae;
    $('#desktopInfo').textContent = has ? 'connected' : (cfg ? 'not connected' : 'Claude Desktop config not found');
    $('#connectDesktop').textContent = has ? 'Update Claude Desktop' : 'Connect Claude Desktop';
    $('#mcpSnippet').textContent = JSON.stringify({ mcpServers: { claudeae: mcpEntry() } }, null, 2);
    var node = locate.findNode(settings.nodePath);
    $('#nodeInfo').textContent = node ? node.version + ' — ' + node.path : 'not found (install Node.js 18+)';
    $('#backend').value = settings.backend;
    $('#model').value = settings.model;
    $('#effort').value = settings.effort;
    $('#claudePath').value = settings.claudePath || '';
    $('#nodePath').value = settings.nodePath || '';
    $('#apiKey').value = settings.apiKey ? '••••••••' + String(settings.apiKey).slice(-4) : '';
    $('#version').textContent = 'v' + VERSION;
    toggleBackendFields();
    if (settings.backend !== 'api') sendAgent({ type: 'auth_status' });
  }
  function renderAuth(ev) {
    if (ev.code === 'no_claude' || (!ev.exe && ev.error)) { $('#ccInfo').textContent = 'not found — install Claude Code or the Claude app'; return; }
    $('#ccInfo').textContent = (ev.loggedIn ? 'signed in' + (ev.authMethod && ev.authMethod !== 'none' ? ' (' + ev.authMethod + ')' : '') : 'not signed in') ;
    $('#ccInfo').title = ev.exe || '';
    $('#ccLogin').textContent = ev.loggedIn ? 'Sign in again…' : 'Sign in…';
  }
  function toggleBackendFields() {
    var api = $('#backend').value === 'api';
    $('#apiSettings').classList.toggle('hidden', !api);
    $('#ccSettings').classList.toggle('hidden', api);
  }
  $('#backend').addEventListener('change', toggleBackendFields);
  $('#saveSettings').addEventListener('click', function () {
    var patch = {
      backend: $('#backend').value, model: $('#model').value, effort: $('#effort').value,
      claudePath: $('#claudePath').value.trim() || undefined, nodePath: $('#nodePath').value.trim() || undefined
    };
    var key = $('#apiKey').value.trim();
    if (key && key.indexOf('••') !== 0) patch.apiKey = key;
    if (!key) patch.apiKey = undefined;
    saveSettings(patch);
    // restart the chat process so a new Node path / backend / environment takes effect
    if (agent && !turn) { try { agent.kill(); } catch (e) { } agent = null; }
    else if (agent) agent.stdin.write(JSON.stringify({ type: 'configure', settings: agentSettings() }) + '\n');
    updateBackendLabel();
    refreshConnect();
    $('#saveSettings').textContent = 'Saved ✓';
    setTimeout(function () { $('#saveSettings').textContent = 'Save'; }, 1500);
  });
  $('#ccLogin').addEventListener('click', function () { sendAgent({ type: 'login' }); $('#ccInfo').textContent = 'complete the sign-in in the window that opened, then Re-check'; });
  $('#ccRecheck').addEventListener('click', function () { sendAgent({ type: 'auth_status' }); });

  $('#connectDesktop').addEventListener('click', function () {
    if (!ROOT) return;
    var file = desktopConfigPath();
    try {
      var cfg = readJson(file, null);
      if (cfg === null && fs.existsSync(file)) throw new Error('claude_desktop_config.json is not valid JSON — fix or remove it first');
      cfg = cfg || {};
      if (fs.existsSync(file)) fs.copyFileSync(file, file + '.claudeae-backup');
      cfg.mcpServers = cfg.mcpServers || {};
      cfg.mcpServers.claudeae = mcpEntry();
      writeJson(file, cfg);
      $('#desktopInfo').textContent = 'connected — quit and reopen Claude Desktop to load the tools';
    } catch (e) { $('#desktopInfo').textContent = 'failed: ' + e.message; }
  });
  $('#copyMcp').addEventListener('click', function () {
    var t = $('#mcpSnippet').textContent;
    var ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); $('#copyMcp').textContent = 'Copied ✓'; } catch (e) { }
    ta.remove();
    setTimeout(function () { $('#copyMcp').textContent = 'Copy MCP config'; }, 1500);
  });
  $('#connectCode').addEventListener('click', function () {
    var exe = locate && locate.findClaude(settings.claudePath);
    if (!exe) { alert('Claude Code was not found on this computer.'); return; }
    var e = mcpEntry();
    cp.execFile(exe, ['mcp', 'add', '--scope', 'user', 'claudeae', '--', e.command].concat(e.args), { windowsHide: true, timeout: 30000 }, function (err, stdout, stderr) {
      var out = String(stdout || '') + String(stderr || '');
      $('#connectCode').textContent = !err || /already exists/i.test(out) ? 'Added to Claude Code ✓' : 'Failed';
      if (err && !/already exists/i.test(out)) alert(out || err.message);
    });
  });
  $('#rotateToken').addEventListener('click', function () {
    if (ownBridge && ownBridge.server) ownBridge.rotateToken();
    else CEP.dispatchEvent('com.claudeae.bridge.command', { action: 'rotate' });
    $('#rotateToken').textContent = 'Token rotated ✓';
    setTimeout(function () { $('#rotateToken').textContent = 'New bridge token'; }, 1500);
  });
  function openPath(p) {
    if (process.platform === 'win32') cp.spawn('explorer.exe', [p], { detached: true, stdio: 'ignore' }).unref();
    else cp.spawn('open', [p], { detached: true, stdio: 'ignore' }).unref();
  }
  $('#openFolder').addEventListener('click', function () { openPath(ROOT || REAL_EXT); });
  $('#openDocs').addEventListener('click', function () { if (ROOT) openPath(path.join(ROOT, 'docs', 'CLAUDE_MOTION_FORMAT.md')); });

  /* ================================================================ start */
  if (!ROOT) notice('ClaudeAE files were not found next to the extension. Re-run <b>scripts/install</b> from the ClaudeAE folder.');
  else if (libError) notice('ClaudeAE library failed to load: ' + esc(libError.message));
  if (!htmlLib) { var ho = $('#htmlOptions'); if (ho) ho.classList.add('hidden'); }
  updateBackendLabel();
  renderStatus();
  ensureBridge();
  setInterval(ensureBridge, 8000);
  engine.ensureLoaded().catch(function (e) { notice('Engine failed to load: ' + esc(e.message)); });
})();
