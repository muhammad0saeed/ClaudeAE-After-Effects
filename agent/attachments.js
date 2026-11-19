'use strict';
/*
 * Files the user attaches in the panel chat → what Claude receives:
 *  - images, graphics, video, audio and folders of assets are imported into the After Effects project
 *    (Attachments/Images, Video, Music, Voice-over, SFX …) and described with their project item ids;
 *  - pictures are also attached as images so Claude can see them;
 *  - scripts / subtitles / notes are included as text, PDFs as documents;
 *  - HTML motion pages and Claude Motion JSON are pointed at the matching import tool.
 */
const fs = require('fs');
const path = require('path');

const MEDIA = new Set(['image', 'graphic', 'video', 'audio', 'folder']);
const TEXT_LIMIT = 100 * 1024;
const PDF_LIMIT = 25 * 1024 * 1024;

const norm = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase();
const secs = (d) => (d >= 60 ? Math.floor(d / 60) + ':' + String(Math.round(d % 60)).padStart(2, '0') + ' min' : (Math.round(d * 10) / 10) + ' s');

function describeItem(it) {
  const bits = [it.kind + (it.role ? ' (' + (it.role === 'voiceover' ? 'voice-over' : it.role) + '?)' : '')];
  if (it.width) bits.push(it.width + '×' + it.height);
  if (it.duration) bits.push(secs(it.duration));
  if (it.fps && it.kind !== 'image') bits.push(it.fps + ' fps');
  if (it.hasAudio && it.kind === 'video') bits.push('has sound');
  if (it.alpha) bits.push('transparent');
  return bits.join(', ') + ' — project item id ' + it.id + ' "' + it.name + '" in ' + (it.folder || 'the project root');
}

function hintFor(it) {
  if (it.kind === 'audio') return it.role === 'voiceover' ? 'ae_analyze_audio gives its phrases and pauses' : it.role === 'sfx' ? 'ae_analyze_audio gives its hit point' : 'ae_analyze_audio gives beats, bars and sections';
  if (it.kind === 'video' || it.kind === 'sequence') return 'ae_preview_item shows frames' + (it.hasAudio ? '; ae_analyze_audio reads its sound' : '');
  if (it.kind === 'graphic') return 'ae_preview_item shows it';
  return '';
}

/**
 * @param {{path,name,kind,size,preview?}[]} atts
 * @param {{callTool: Function}} toolset
 * @returns {Promise<{text: string, blocks: object[], items: {path, ok, note}[]}>}
 */
async function prepareAttachments(atts, toolset) {
  const lines = [], blocks = [], items = [];
  const media = atts.filter((a) => MEDIA.has(a.kind));
  const imported = new Map();
  let importError = null, folderResults = [];
  if (media.length) {
    try {
      const r = await toolset.callTool('ae_import_files', { paths: media.map((a) => a.path), folder: 'Attachments' });
      const res = JSON.parse(r.text).result || {};
      for (const it of res.imported || []) if (it.file) imported.set(norm(it.file), it);
      for (const f of res.failed || []) imported.set(norm(f.file), { failed: f.error });
      folderResults = res.imported || [];
    } catch (e) {
      importError = e.message || String(e);
    }
  }

  for (const a of atts) {
    const p = a.path;
    if (!fs.existsSync(p)) { lines.push('- ' + a.name + ': file not found (' + p + ')'); items.push({ path: p, ok: false, note: 'not found' }); continue; }
    if (a.kind === 'folder') {
      const inside = folderResults.filter((it) => it.file && norm(it.file).startsWith(norm(p) + '/'));
      if (importError) { lines.push('- folder ' + p + ': not imported (' + importError + ')'); items.push({ path: p, ok: false, note: importError }); continue; }
      lines.push('- folder ' + p + ' — ' + inside.length + ' media file(s) imported into Attachments:');
      inside.slice(0, 60).forEach((it) => lines.push('    • ' + path.basename(it.file) + ': ' + describeItem(it)));
      if (inside.length > 60) lines.push('    • … and ' + (inside.length - 60) + ' more (ae_project_items lists them)');
      items.push({ path: p, ok: true, note: inside.length + ' files imported' });
      continue;
    }
    if (MEDIA.has(a.kind)) {
      const it = imported.get(norm(p));
      if (it && !it.failed) {
        const hint = hintFor(it);
        lines.push('- ' + a.name + ': ' + describeItem(it) + (hint ? ' (' + hint + ')' : '') + '. File: ' + p);
        items.push({ path: p, ok: true, note: 'project item ' + it.id });
      } else {
        const why = it && it.failed ? it.failed : importError || 'not imported';
        lines.push('- ' + a.name + ': ' + a.kind + ' at ' + p + ' — could not be imported into After Effects (' + why + ')');
        items.push({ path: p, ok: false, note: why });
      }
      if (a.preview && a.preview.data) {
        blocks.push({ type: 'text', text: 'Attached image: ' + a.name });
        blocks.push({ type: 'image', source: { type: 'base64', media_type: a.preview.mimeType, data: a.preview.data } });
      } else if (a.kind === 'image' || a.kind === 'graphic') lines.push('    (no preview attached — call ae_preview_item to see it)');
      continue;
    }
    if (a.kind === 'text' || a.kind === 'motion') {
      let txt = '';
      try { txt = fs.readFileSync(p, 'utf8'); } catch (e) { lines.push('- ' + a.name + ': unreadable (' + e.message + ')'); items.push({ path: p, ok: false, note: e.message }); continue; }
      if (a.kind === 'motion') {
        let isSpec = false;
        try { const j = JSON.parse(txt); isSpec = !!(j && (j.format === 'claude-motion' || j.compositions || j.layers)); } catch (_) { }
        if (isSpec) { lines.push('- ' + a.name + ': a Claude Motion design — build it with ae_import_motion {"file": ' + JSON.stringify(p) + '}'); items.push({ path: p, ok: true, note: 'Claude Motion spec' }); continue; }
      }
      const cut = txt.length > TEXT_LIMIT;
      lines.push('- ' + a.name + ' (' + (a.kind === 'motion' ? 'JSON' : path.extname(p).slice(1) || 'text') + ', ' + p + ')' + (cut ? ' — first ' + Math.round(TEXT_LIMIT / 1024) + ' KB:' : ':'));
      lines.push('<file name="' + a.name.replace(/"/g, "'") + '">\n' + (cut ? txt.slice(0, TEXT_LIMIT) : txt) + '\n</file>');
      items.push({ path: p, ok: true, note: 'read as text' });
      continue;
    }
    if (a.kind === 'html') {
      lines.push('- ' + a.name + ': an HTML motion page — rebuild it as layers with ae_import_html {"file": ' + JSON.stringify(p) + '}');
      items.push({ path: p, ok: true, note: 'HTML motion page' });
      continue;
    }
    if (a.kind === 'pdf') {
      if (a.size > PDF_LIMIT) { lines.push('- ' + a.name + ': PDF too large to attach (' + Math.round(a.size / 1048576) + ' MB) — ' + p); items.push({ path: p, ok: false, note: 'too large' }); continue; }
      blocks.push({ type: 'text', text: 'Attached PDF: ' + a.name });
      blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fs.readFileSync(p).toString('base64') }, title: a.name });
      lines.push('- ' + a.name + ': PDF document (attached) — ' + p);
      items.push({ path: p, ok: true, note: 'attached as document' });
      continue;
    }
    lines.push('- ' + a.name + ': ' + p + ' (' + Math.round((a.size || 0) / 1024) + ' KB)');
    items.push({ path: p, ok: true, note: 'path only' });
  }
  const text = '<attachments>\nThe user attached these files' + (media.length ? '; media files were imported into the After Effects project folder "Attachments"' : '') + ':\n' + lines.join('\n') + '\n</attachments>';
  return { text, blocks, items };
}

module.exports = { prepareAttachments, describeItem };
