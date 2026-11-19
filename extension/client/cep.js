/* Minimal CEP host interface (the parts of Adobe's CSInterface that ClaudeAE needs). */
(function (global) {
  'use strict';
  var native = global.__adobe_cep__;

  function hostEnv() {
    try { return JSON.parse(native.getHostEnvironment()); } catch (e) { return null; }
  }

  var CEP = {
    available: !!native,
    evalScript: function (script, cb) {
      if (!native) { if (cb) cb('EvalScript error.'); return; }
      native.evalScript(script, cb || function () { });
    },
    /** type: "extension" | "userData" | "commonFiles" | "myDocuments" | "hostApplication" */
    getSystemPath: function (type) {
      var p = decodeURI(native.getSystemPath(type));
      return navigator.platform.indexOf('Win') === 0 ? p.replace('file:///', '') : p.replace('file://', '');
    },
    hostEnv: hostEnv,
    extensionId: function () { return native ? native.getExtensionId() : ''; },
    addEventListener: function (type, fn) { if (native) native.addEventListener(type, fn); },
    /** CEP delivers event.data either as a JSON string or already parsed, depending on the version. */
    eventData: function (ev) {
      var d = ev ? ev.data : null;
      if (typeof d === 'string') { try { return JSON.parse(d); } catch (e) { return d; } }
      return d || {};
    },
    dispatchEvent: function (type, data) {
      if (!native) return;
      var env = hostEnv();
      native.dispatchEvent({ type: type, scope: 'APPLICATION', appId: env ? env.appId : 'AEFT', extensionId: native.getExtensionId(), data: typeof data === 'string' ? data : JSON.stringify(data) });
    },
    requestOpenExtension: function (id, params) { if (native) native.requestOpenExtension(id, params || ''); },
    openURL: function (url) {
      if (global.cep && global.cep.util && global.cep.util.openURLInDefaultBrowser) global.cep.util.openURLInDefaultBrowser(url);
      else global.open(url);
    },
    openFileDialog: function (title, types, multi) {
      if (!global.cep || !global.cep.fs || !global.cep.fs.showOpenDialogEx) return null;
      var r = global.cep.fs.showOpenDialogEx(!!multi, false, title || 'Open', '', types || []);
      return r && !r.err && r.data && r.data.length ? r.data : null;
    },
    /** Theme colours of the host app panel */
    skin: function () {
      var env = hostEnv();
      return env && env.appSkinInfo ? env.appSkinInfo : null;
    }
  };
  global.CEP = CEP;
})(window);
