/* Hidden background extension: starts with After Effects and hosts the ClaudeAE HTTP bridge. */
(function () {
  'use strict';
  var path = require('path');
  var fs = require('fs');
  var extRoot = CEP.getSystemPath('extension');
  var CepEngine = require(path.join(extRoot, 'node', 'cep-engine.js')).CepEngine;
  var bridgeMod = require(path.join(extRoot, 'node', 'bridge-server.js'));
  var VERSION = '1.0.0';
  try { VERSION = JSON.parse(fs.readFileSync(path.join(fs.realpathSync(extRoot), '..', 'package.json'), 'utf8')).version || VERSION; } catch (e) { }

  var logFile = path.join(bridgeMod.CONFIG_DIR, 'bridge.log');
  function log(msg) {
    try {
      fs.mkdirSync(bridgeMod.CONFIG_DIR, { recursive: true });
      fs.appendFileSync(logFile, new Date().toISOString() + ' ' + msg + '\n');
    } catch (e) { }
  }

  var settings = {};
  try { settings = JSON.parse(fs.readFileSync(path.join(bridgeMod.CONFIG_DIR, 'settings.json'), 'utf8')); } catch (e) { }

  var engine = new CepEngine({ evalScript: CEP.evalScript, enginePath: path.join(extRoot, 'host', 'claudeae.jsx') });
  var server = new bridgeMod.BridgeServer({
    engine: engine,
    version: VERSION,
    host: 'cep',
    log: log,
    onActivity: function (entry) { CEP.dispatchEvent('com.claudeae.activity', entry); }
  });

  function start() {
    bridgeMod.checkBridge(bridgeMod.readBridgeFile()).then(function (alive) {
      if (alive && alive.port) { log('another bridge is already running on ' + alive.port + ' — not starting a second one'); return; }
      return server.start(Number(settings.bridgePort) || 48760).then(function (port) {
        log('bridge started on 127.0.0.1:' + port + ' (AE ' + (CEP.hostEnv() || {}).appVersion + ')');
        CEP.dispatchEvent('com.claudeae.bridge', { status: 'running', port: port });
      });
    }).catch(function (e) { log('bridge failed to start: ' + (e && e.stack || e)); });
  }

  // the panel asks the bridge to rotate its token or report status
  CEP.addEventListener('com.claudeae.bridge.command', function (ev) {
    var cmd = CEP.eventData(ev) || {};
    if (cmd.action === 'rotate' && server.server) { server.rotateToken(); log('token rotated'); }
    CEP.dispatchEvent('com.claudeae.bridge', { status: server.server ? 'running' : 'stopped', port: server.port, requests: server.requests });
  });

  // fonts ClaudeAE installed for HTML imports: Windows can drop them from the session, so re-load them
  // (and let After Effects refresh its font list) every time After Effects starts
  function reloadFonts() {
    try {
      var fonts = require(path.join(fs.realpathSync(extRoot), '..', 'lib', 'fonts.js'));
      fonts.ensureFontsLoaded(function (err, n) { if (n) log('re-loaded ' + n + ' ClaudeAE font file(s)' + (err ? ' (' + err.message + ')' : '')); });
    } catch (e) { log('font reload skipped: ' + e.message); }
  }

  window.addEventListener('beforeunload', function () { server.stop(); log('bridge stopped'); });
  start();
  setTimeout(reloadFonts, 3000);
})();
