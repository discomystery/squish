import { kindOf } from './shared.js';
import * as nativeEngine from './engine-native.js';
import * as browserEngine from './engine-browser.js';

// Use native ffmpeg when served by server.js; otherwise (e.g. GitHub Pages) do everything in the browser.
// Add ?engine=browser to force the in-browser engine locally.
const forceBrowser = new URLSearchParams(location.search).get('engine') === 'browser';
const engine = !forceBrowser && (await nativeEngine.available()) ? nativeEngine : browserEngine;

// ---------- option schemas ----------

const sel = (key, label, options, def) => ({ type: 'select', key, label, options, def });
const opts = (...pairs) => pairs.map(([value, text]) => ({ value: String(value), text }));

const TRIM = [
  { type: 'number', key: 'start', label: 'Start (sec)', def: '', placeholder: '0', step: 0.1 },
  { type: 'number', key: 'duration', label: 'Length (sec)', def: '', placeholder: 'all', step: 0.1 },
];
const DITHER = sel('dither', 'Dithering', opts(['bayer', 'Crisp'], ['smooth', 'Smooth'], ['none', 'None (smallest)']), 'bayer');
const VIDEO_QUALITY = sel('quality', 'Quality', opts(['high', 'High'], ['balanced', 'Balanced'], ['small', 'Small'], ['tiny', 'Tiny']), 'balanced');

const OPS = {
  'image-compress': {
    kind: 'image', label: 'Compress',
    fields: [
      sel('format', 'Format', opts(['keep', 'Same as original'], ['jpeg', 'JPEG'], ['png', 'PNG'], ['webp', 'WebP'], ['avif', 'AVIF']), 'keep'),
      { type: 'range', key: 'quality', label: 'Quality', min: 10, max: 100, def: 75 },
      sel('maxEdge', 'Max size', opts([0, 'Original'], [3840, '3840 px'], [2560, '2560 px'], [1920, '1920 px'], [1280, '1280 px'], [800, '800 px']), '0'),
      { type: 'check', key: 'keepMetadata', label: 'Keep EXIF / location', def: false },
    ],
  },
  'video-compress': {
    kind: 'video', label: 'Compress',
    fields: [
      VIDEO_QUALITY,
      { type: 'number', key: 'targetMB', label: 'Or target MB', def: '', placeholder: 'auto', step: 1 },
      sel('maxEdge', 'Resolution', opts([0, 'Original'], [1920, '1080p'], [1280, '720p'], [854, '480p']), '0'),
      sel('fps', 'Frame rate', opts([0, 'Original'], [30, '30 fps'], [24, '24 fps']), '0'),
      sel('format', 'Format', opts(['mp4', 'MP4'], ['webm', 'WebM']), 'mp4'),
      ...TRIM,
      { type: 'check', key: 'removeAudio', label: 'Remove audio', def: false },
    ],
  },
  'video-to-gif': {
    kind: 'video', label: 'Make GIF',
    fields: [
      sel('maxEdge', 'Size', opts([320, '320 px'], [480, '480 px'], [640, '640 px'], [800, '800 px'], [0, 'Original']), '480'),
      sel('fps', 'Frame rate', opts([8, '8 fps'], [10, '10 fps'], [12, '12 fps'], [15, '15 fps'], [20, '20 fps'], [25, '25 fps']), '12'),
      sel('colors', 'Colors', opts([256, '256'], [128, '128'], [64, '64'], [32, '32']), '256'),
      DITHER,
      ...TRIM,
    ],
  },
  'gif-compress': {
    kind: 'gif', label: 'Compress',
    fields: [
      sel('colors', 'Colors', opts([256, '256'], [128, '128'], [64, '64'], [32, '32'], [16, '16']), '128'),
      sel('maxEdge', 'Max size', opts([0, 'Original'], [800, '800 px'], [640, '640 px'], [480, '480 px'], [320, '320 px']), '0'),
      sel('fps', 'Frame rate', opts([0, 'Original'], [20, '20 fps'], [15, '15 fps'], [12, '12 fps'], [10, '10 fps']), '0'),
      DITHER,
    ],
  },
  'gif-to-video': {
    kind: 'gif', label: 'Make video',
    fields: [
      sel('format', 'Format', opts(['mp4', 'MP4'], ['webm', 'WebM']), 'mp4'),
      VIDEO_QUALITY,
      sel('loops', 'Play', opts([1, 'Once'], [2, '2×'], [3, '3×'], [5, '5×'], [10, '10×']), '1'),
    ],
  },
};

// Drop options the active engine can't do.
{
  const img = OPS['image-compress'];
  if (!engine.capabilities.avif) {
    const format = img.fields.find((f) => f.key === 'format');
    format.options = format.options.filter((o) => o.value !== 'avif');
  }
  if (!engine.capabilities.keepMetadata) img.fields = img.fields.filter((f) => f.key !== 'keepMetadata');
}

// ---------- remembered settings ----------

const PREFS_KEY = 'squish-prefs-v1';
let prefs = {};
try { prefs = JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch {}
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {} };

function defaultsFor(op) {
  const fields = OPS[op].fields;
  const base = Object.fromEntries(fields.map((f) => [f.key, f.def]));
  // Trim is per-file; don't carry it over.
  const { start, duration, ...saved } = prefs[op] || {};
  const merged = { ...base, ...saved };
  // A saved choice may not exist under this engine (e.g. AVIF in Safari).
  for (const f of fields) if (f.type === 'select' && !f.options.some((o) => o.value === String(merged[f.key]))) merged[f.key] = f.def;
  return merged;
}

// ---------- utils ----------

const $ = (s, el = document) => el.querySelector(s);

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let n = bytes / 1024, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

function fmtTime(sec) {
  if (!isFinite(sec)) return '';
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function mediaEl(kind, src) {
  if (kind === 'video') {
    const v = document.createElement('video');
    Object.assign(v, { src, muted: true, playsInline: true, loop: true, preload: 'metadata' });
    return v;
  }
  const img = document.createElement('img');
  img.src = src;
  img.alt = '';
  return img;
}

// ---------- items ----------

const items = [];
const list = $('#files');
const tpl = $('#cardTpl');

function addFiles(fileList) {
  let skipped = 0;
  for (const file of fileList) {
    const kind = kindOf(file.name);
    if (!kind) { skipped++; continue; }
    const op = Object.keys(OPS).find((k) => OPS[k].kind === kind);
    const item = { id: crypto.randomUUID(), file, kind, op, options: defaultsFor(op), state: 'ready', url: URL.createObjectURL(file) };
    items.push(item);
    renderCard(item);
  }
  if (skipped) flash(`Skipped ${skipped} file${skipped > 1 ? 's' : ''} with an unsupported type.`);
  updateToolbar();
}

function renderCard(item) {
  const el = tpl.content.firstElementChild.cloneNode(true);
  item.el = el;
  el.dataset.id = item.id;

  const thumb = $('.thumb', el);
  const media = mediaEl(item.kind, item.url);
  thumb.append(media);
  if (item.kind === 'video') {
    media.addEventListener('loadedmetadata', () => {
      item.duration = media.duration;
      media.currentTime = Math.min(1, media.duration / 3);
      updateMeta(item);
    });
    thumb.addEventListener('mouseenter', () => media.play().catch(() => {}));
    thumb.addEventListener('mouseleave', () => media.pause());
  } else {
    media.addEventListener('load', () => {
      item.dims = `${media.naturalWidth}×${media.naturalHeight}`;
      updateMeta(item);
    });
  }

  $('.name', el).textContent = item.file.name;
  $('.name', el).title = item.file.name;
  $('.badge', el).textContent = item.kind;
  updateMeta(item);

  $('.remove', el).addEventListener('click', () => removeItem(item));
  $('.go', el).addEventListener('click', () => process(item));

  renderOps(item);
  renderSettings(item);
  list.append(el);
}

function updateMeta(item) {
  const bits = [fmtSize(item.file.size)];
  if (item.duration) bits.push(fmtTime(item.duration));
  if (item.dims) bits.push(item.dims);
  $('.meta', item.el).textContent = bits.join(' · ');
}

function renderOps(item) {
  const wrap = $('.ops', item.el);
  wrap.replaceChildren();
  for (const [key, op] of Object.entries(OPS)) {
    if (op.kind !== item.kind) continue;
    const b = document.createElement('button');
    b.type = 'button';
    b.role = 'tab';
    b.textContent = op.label;
    b.setAttribute('aria-selected', String(key === item.op));
    b.addEventListener('click', () => {
      if (item.op === key || item.state === 'working') return;
      item.op = key;
      item.options = defaultsFor(key);
      renderOps(item);
      renderSettings(item);
      resetResult(item);
    });
    wrap.append(b);
  }
}

function renderSettings(item) {
  const wrap = $('.settings', item.el);
  wrap.replaceChildren();
  for (const f of OPS[item.op].fields) {
    const label = document.createElement('label');
    label.className = `field ${f.type}`;
    let input;

    if (f.type === 'select') {
      input = document.createElement('select');
      for (const o of f.options) input.add(new Option(o.text, o.value));
      input.value = String(item.options[f.key]);
      label.append(f.label, input);
    } else if (f.type === 'range') {
      input = Object.assign(document.createElement('input'), { type: 'range', min: f.min, max: f.max, value: item.options[f.key] });
      const out = document.createElement('output');
      out.textContent = input.value;
      input.addEventListener('input', () => (out.textContent = input.value));
      const row = document.createElement('div');
      row.className = 'range-row';
      row.append(input, out);
      label.append(f.label, row);
    } else if (f.type === 'number') {
      input = Object.assign(document.createElement('input'), { type: 'number', min: 0, step: f.step, placeholder: f.placeholder, value: item.options[f.key] ?? '' });
      label.append(f.label, input);
    } else if (f.type === 'check') {
      input = Object.assign(document.createElement('input'), { type: 'checkbox', checked: !!item.options[f.key] });
      label.append(input, f.label);
    }

    input.addEventListener('change', () => {
      const value = f.type === 'check' ? input.checked : input.value;
      item.options[f.key] = value;
      prefs[item.op] = { ...(prefs[item.op] || {}), [f.key]: value };
      savePrefs();
      if (item.state === 'done' || item.state === 'error') resetResult(item);
    });
    wrap.append(label);
  }
}

function dropResult(item) {
  if (item.result?.url.startsWith('blob:') && item.result.url !== item.url) URL.revokeObjectURL(item.result.url);
  item.result = null;
}

function resetResult(item) {
  item.state = 'ready';
  dropResult(item);
  const el = item.el;
  $('.go', el).hidden = false;
  $('.go', el).textContent = 'Squish';
  $('.progress', el).hidden = true;
  $('.result', el).hidden = true;
  updateToolbar();
}

function removeItem(item) {
  item.removed = true;
  dropResult(item);
  URL.revokeObjectURL(item.url);
  item.el.remove();
  items.splice(items.indexOf(item), 1);
  updateToolbar();
}

// ---------- processing ----------

async function process(item) {
  if (item.state === 'working') return;
  item.state = 'working';
  const el = item.el;
  $('.go', el).hidden = true;
  $('.result', el).hidden = true;
  const progress = $('.progress', el);
  progress.hidden = false;
  progress.classList.add('indeterminate');
  $('.bar', progress).style.width = '';
  updateToolbar();

  const options = Object.fromEntries(Object.entries(item.options).filter(([, v]) => v !== ''));
  dropResult(item);

  try {
    const result = await engine.run({ file: item.file, kind: item.kind, op: item.op, options }, (p) => {
      progress.classList.remove('indeterminate');
      $('.bar', progress).style.width = `${Math.round(p * 100)}%`;
    });
    if (item.removed) {
      if (result.url.startsWith('blob:') && result.url !== item.url) URL.revokeObjectURL(result.url);
      return;
    }
    item.result = result;
    item.state = 'done';
    showResult(item);
  } catch (err) {
    if (item.removed) return;
    console.error(err);
    item.state = 'error';
    progress.hidden = true;
    const result = $('.result', el);
    result.hidden = false;
    result.replaceChildren();
    const msg = Object.assign(document.createElement('span'), { className: 'error', textContent: err.message });
    const retry = Object.assign(document.createElement('button'), { className: 'btn ghost small', textContent: 'Try again' });
    retry.addEventListener('click', () => process(item));
    result.append(msg, retry);
  }
  updateToolbar();
}

function showResult(item) {
  const { result: job, el } = item;
  $('.progress', el).hidden = true;
  const result = $('.result', el);
  result.hidden = false;
  result.replaceChildren();

  const sizes = document.createElement('span');
  sizes.className = 'sizes';
  sizes.textContent = `${fmtSize(job.inputSize)} → ${fmtSize(job.outputSize)}`;

  const pct = Math.round((1 - job.outputSize / job.inputSize) * 100);
  const delta = document.createElement('span');
  delta.className = `delta ${pct >= 0 ? 'down' : 'up'}`;
  delta.textContent = pct >= 0 ? `−${pct}%` : `+${-pct}%`;

  const dl = Object.assign(document.createElement('a'), {
    className: 'btn primary small',
    href: job.downloadUrl,
    textContent: `Download ${job.outputName.split('.').pop().toUpperCase()}`,
    download: job.outputName,
  });
  const cmp = Object.assign(document.createElement('button'), { className: 'btn ghost small', textContent: 'Compare' });
  cmp.addEventListener('click', () => openCompare(item));
  const again = Object.assign(document.createElement('button'), { className: 'btn ghost small', textContent: 'Redo' });
  again.addEventListener('click', () => process(item));

  result.append(sizes, delta, dl, cmp, again);
  if (job.note) result.append(Object.assign(document.createElement('span'), { className: 'note', textContent: job.note }));
  else if (pct < 0) result.append(Object.assign(document.createElement('span'), { className: 'note', textContent: 'Bigger than the original — try fewer colors, a smaller size, or a shorter clip.' }));
}

// ---------- compare ----------

const dialog = $('#compare');
$('#compareClose').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
dialog.addEventListener('close', () => {
  $('#compareBefore').replaceChildren();
  $('#compareAfter').replaceChildren();
});

function openCompare(item) {
  const { result: job } = item;
  const outKind = /\.(mp4|webm)$/i.test(job.outputName) ? 'video' : 'image';
  $('#compareTitle').textContent = item.file.name;
  const before = mediaEl(item.kind, item.url);
  const after = mediaEl(outKind, job.url);
  for (const m of [before, after]) if (m.tagName === 'VIDEO') { m.controls = true; m.autoplay = true; }
  $('#compareBefore').replaceChildren(before);
  $('#compareAfter').replaceChildren(after);
  $('#compareBeforeCap').textContent = `Original · ${fmtSize(job.inputSize)}`;
  $('#compareAfterCap').textContent = `${job.outputName} · ${fmtSize(job.outputSize)}`;
  dialog.showModal();
}

// ---------- toolbar ----------

function updateToolbar() {
  $('#toolbar').hidden = items.length === 0;
  const done = items.filter((i) => i.state === 'done');
  const pending = items.filter((i) => i.state === 'ready' || i.state === 'error');
  $('#runAll').disabled = pending.length === 0;
  $('#downloadAll').disabled = done.length === 0;

  let text = `${items.length} file${items.length === 1 ? '' : 's'}`;
  if (done.length) {
    const before = done.reduce((s, i) => s + i.result.inputSize, 0);
    const after = done.reduce((s, i) => s + i.result.outputSize, 0);
    const saved = before - after;
    text += ` · ${done.length} done` + (saved > 0 ? ` · saved ${fmtSize(saved)}` : '');
  }
  $('#summary').textContent = text;
}

$('#runAll').addEventListener('click', () => {
  // Both engines queue work, so firing them all at once is fine.
  for (const item of items) if (item.state === 'ready' || item.state === 'error') process(item);
});

$('#downloadAll').addEventListener('click', async () => {
  for (const item of items.filter((i) => i.state === 'done')) {
    const a = Object.assign(document.createElement('a'), { href: item.result.downloadUrl, download: item.result.outputName });
    document.body.append(a);
    a.click();
    a.remove();
    await new Promise((r) => setTimeout(r, 350));
  }
});

$('#clear').addEventListener('click', () => {
  for (const item of [...items]) removeItem(item);
});

// ---------- engine status ----------

$('#engineMode').textContent =
  engine.name === 'native'
    ? 'Running locally with native ffmpeg.'
    : 'Runs entirely in your browser — files never get uploaded.';

browserEngine.events.addEventListener('status', (e) => {
  const banner = $('#engineStatus');
  banner.hidden = !e.detail;
  if (!e.detail) return;
  $('.engine-text', banner).textContent = e.detail.text;
  $('.bar', banner).style.width = `${Math.round((e.detail.progress ?? 0) * 100)}%`;
});

function flash(msg) {
  $('#summary').textContent = msg;
  setTimeout(updateToolbar, 3000);
}

// ---------- drop / pick / paste ----------

const drop = $('#drop');
const picker = $('#picker');
picker.addEventListener('change', () => { addFiles(picker.files); picker.value = ''; });

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; drop.classList.add('over'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; drop.classList.remove('over'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  drop.classList.remove('over');
  if (e.dataTransfer?.files.length) addFiles(e.dataTransfer.files);
});
window.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) addFiles(files);
});
