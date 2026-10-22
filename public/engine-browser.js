// Runs entirely in the browser: canvas for images, ffmpeg.wasm for video/GIF.
// This is what the GitHub Pages build uses.
import { FFmpeg } from './vendor/ffmpeg/index.js';
import { buildFfmpegJob, extOf, num, outputName, parseProbeLog } from './shared.js';

const CORE_BASE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/';

export const name = 'browser';
// WebAssembly memory tops out around 2 GB, and input + output both live in it.
export const capabilities = { avif: await canEncode('image/avif'), keepMetadata: false, maxBytes: 700 * 1024 ** 2 };
export const events = new EventTarget();

export const available = async () => true;

function canEncode(type) {
  return new Promise((resolve) => {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    c.toBlob((b) => resolve(b?.type === type), type);
  });
}

// ---------- ffmpeg.wasm (lazy, ~32 MB download, cached by the browser after the first time) ----------

let ffmpegPromise = null;
let lock = Promise.resolve();
let logSink = null;

function status(detail) {
  events.dispatchEvent(new CustomEvent('status', { detail }));
}

async function fetchBlobURL(url, type, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't download the video engine (${res.status}).`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total) onProgress?.(received / total);
  }
  return URL.createObjectURL(new Blob(chunks, { type }));
}

function getFFmpeg() {
  ffmpegPromise ??= (async () => {
    status({ text: 'Downloading video engine…', progress: 0 });
    const ff = new FFmpeg();
    ff.on('log', ({ message }) => logSink?.(message));
    const coreURL = await fetchBlobURL(CORE_BASE + 'ffmpeg-core.js', 'text/javascript');
    const wasmURL = await fetchBlobURL(CORE_BASE + 'ffmpeg-core.wasm', 'application/wasm', (p) =>
      status({ text: 'Downloading video engine…', progress: p })
    );
    status({ text: 'Starting video engine…', progress: 1 });
    await ff.load({ coreURL, wasmURL });
    status(null);
    return ff;
  })().catch((err) => {
    ffmpegPromise = null;
    status(null);
    throw err;
  });
  return ffmpegPromise;
}

// ffmpeg.wasm is single-threaded and holds one filesystem, so run one command at a time.
function exclusive(fn) {
  const next = lock.then(fn, fn);
  lock = next.catch(() => {});
  return next;
}

async function execCapture(ff, args, onLine) {
  let log = '';
  logSink = (line) => {
    log += line + '\n';
    onLine?.(line);
  };
  try {
    const code = await ff.exec(args);
    return { code, log };
  } finally {
    logSink = null;
  }
}

function lastError(log) {
  const lines = log.split('\n').filter((l) => l && !/^\s*(frame|size|Stream|Input|Output|Duration|Metadata|  )/.test(l));
  return lines.slice(-2).join(' ') || 'Processing failed.';
}

async function withFiles(ff, inputs, fn) {
  const written = [];
  try {
    for (const [name, data] of inputs) {
      await ff.writeFile(name, data);
      written.push(name);
    }
    return await fn(written);
  } finally {
    for (const name of await ff.listDir('/').then((l) => l.map((e) => e.name)).catch(() => [])) {
      if (/^(in|out)\./.test(name)) await ff.deleteFile(name).catch(() => {});
    }
  }
}

async function ffmpegConvert(inputBytes, inExt, args, outName) {
  const ff = await getFFmpeg();
  return exclusive(() =>
    withFiles(ff, [[`in.${inExt}`, inputBytes]], async () => {
      const { code, log } = await execCapture(ff, ['-hide_banner', '-y', '-i', `in.${inExt}`, ...args, outName]);
      if (code !== 0) throw new Error(lastError(log));
      return ff.readFile(outName);
    })
  );
}

// ---------- images ----------

const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif' };
const SRC_FORMAT = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', webp: 'webp', avif: 'avif' };

async function decodeImage(file) {
  try {
    return await createImageBitmap(file); // honours EXIF orientation
  } catch {
    // e.g. TIFF in Chrome — let ffmpeg decode it.
    const png = await ffmpegConvert(new Uint8Array(await file.arrayBuffer()), extOf(file.name), ['-frames:v', '1'], 'out.png');
    return createImageBitmap(new Blob([png], { type: 'image/png' }));
  }
}

function drawResized(bitmap, maxEdge) {
  let w = bitmap.width, h = bitmap.height;
  if (maxEdge && Math.max(w, h) > maxEdge) {
    const s = maxEdge / Math.max(w, h);
    w = Math.round(w * s);
    h = Math.round(h * s);
  }
  // Halve in steps for big downscales; one-shot canvas downscaling looks jagged.
  let src = bitmap, sw = bitmap.width, sh = bitmap.height;
  while (sw / 2 > w && sh / 2 > h) {
    const step = document.createElement('canvas');
    step.width = (sw = Math.round(sw / 2));
    step.height = (sh = Math.round(sh / 2));
    const sctx = step.getContext('2d');
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(src, 0, 0, sw, sh);
    src = step;
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  return { canvas, ctx, src };
}

const toBlob = (canvas, type, quality) => new Promise((r) => canvas.toBlob(r, type, quality));

async function compressImage(file, o) {
  const srcFormat = SRC_FORMAT[extOf(file.name)] || 'jpeg';
  const format = o.format && o.format !== 'keep' ? o.format : srcFormat;
  const quality = num(o.quality, 75, 1, 100);
  if (format === 'avif' && !capabilities.avif) throw new Error("This browser can't create AVIF files — pick another format.");

  const bitmap = await decodeImage(file);
  const { canvas, ctx, src } = drawResized(bitmap, num(o.maxEdge, 0, 0, 20000));
  if (format === 'jpeg') {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();

  let blob;
  if (format === 'png') {
    blob = await toBlob(canvas, 'image/png');
    if (quality < 100) {
      // Lossy PNG: quantize to a palette, like pngquant.
      const colors = quality >= 80 ? 256 : quality >= 60 ? 128 : quality >= 40 ? 64 : 32;
      const bytes = await ffmpegConvert(
        new Uint8Array(await blob.arrayBuffer()),
        'png',
        ['-filter_complex', `split[a][b];[a]palettegen=max_colors=${colors}:reserve_transparent=1[p];[b][p]paletteuse=dither=sierra2_4a:alpha_threshold=128`, '-compression_level', '100'],
        'out.png'
      );
      blob = new Blob([bytes], { type: 'image/png' });
    }
  } else {
    blob = await toBlob(canvas, MIME[format], quality / 100);
    if (blob.type !== MIME[format] && format === 'webp') {
      // Safari can't encode WebP from a canvas; fall back to ffmpeg's libwebp.
      const png = await toBlob(canvas, 'image/png');
      const bytes = await ffmpegConvert(new Uint8Array(await png.arrayBuffer()), 'png', ['-c:v', 'libwebp', '-quality', String(quality)], 'out.webp');
      blob = new Blob([bytes], { type: 'image/webp' });
    }
  }
  return { blob, outExt: format === 'jpeg' ? '.jpg' : `.${format}`, sameFormat: format === srcFormat };
}

// ---------- video / GIF ----------

async function runFfmpegOp(file, op, options, onProgress) {
  const ff = await getFFmpeg();
  const inExt = extOf(file.name);
  const input = `in.${inExt}`;
  const data = new Uint8Array(await file.arrayBuffer());

  return exclusive(() =>
    withFiles(ff, [[input, data]], async () => {
      const { log: probeLog } = await execCapture(ff, ['-hide_banner', '-i', input]);
      const info = parseProbeLog(probeLog);
      if (!info.width) throw new Error("Couldn't read this file — it may be corrupt or use a codec the browser engine lacks.");

      const spec = buildFfmpegJob(op, options, info, { input, output: (ext) => `out${ext}`, inputName: file.name, fast: true });
      const { code, log } = await execCapture(ff, ['-hide_banner', '-y', ...spec.args], (line) => {
        const m = /time=(\d+):(\d+):([\d.]+)/.exec(line);
        if (m && spec.duration > 0) onProgress(Math.min(0.99, (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) / spec.duration));
      });
      if (code !== 0) throw new Error(lastError(log));
      const bytes = await ff.readFile(`out${spec.outExt}`);
      const type = { '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm' }[spec.outExt];
      return { blob: new Blob([bytes], { type }), outExt: spec.outExt, sameFormat: spec.sameFormat };
    })
  );
}

// ---------- entry point ----------

export async function run({ file, kind, op, options }, onProgress) {
  if (file.size > capabilities.maxBytes) {
    throw new Error('Too big to process in the browser (limit ~700 MB). Run Squish locally for large files.');
  }
  const result = kind === 'image' ? await compressImage(file, options) : await runFfmpegOp(file, op, options, onProgress);

  let blob = result.blob;
  let note;
  if (result.sameFormat && blob.size >= file.size) {
    blob = file;
    note = 'Already well optimized — kept the original.';
  }
  const url = URL.createObjectURL(blob);
  return { url, downloadUrl: url, outputName: outputName(file.name, op, result.outExt), inputSize: file.size, outputSize: blob.size, note };
}
