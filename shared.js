// ffmpeg argument building shared by the native server (server.js) and the in-browser engine (engine-browser.js).

export const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'avif', 'tif', 'tiff'];
export const VIDEO_EXT = ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'wmv', 'flv', '3gp', 'mpg', 'mpeg'];

export const ALLOWED = {
  image: ['image-compress'],
  video: ['video-compress', 'video-to-gif'],
  gif: ['gif-compress', 'gif-to-video'],
};

export function extOf(filename) {
  const i = filename.lastIndexOf('.');
  return i < 0 ? '' : filename.slice(i + 1).toLowerCase();
}

export function kindOf(filename) {
  const ext = extOf(filename);
  if (ext === 'gif') return 'gif';
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (VIDEO_EXT.includes(ext)) return 'video';
  return null;
}

export function outputName(inputName, op, outExt) {
  const i = inputName.lastIndexOf('.');
  const base = i < 0 ? inputName : inputName.slice(0, i);
  return `${base}${op.endsWith('compress') ? '-squished' : ''}${outExt}`;
}

export const num = (v, def, min, max) => {
  if (v === '' || v == null) return def;
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
};

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

// Fit within a box on the long edge, keeping even dimensions for video codecs.
export function fitDims(w, h, maxEdge) {
  if (!w || !h) return null;
  if (!maxEdge || Math.max(w, h) <= maxEdge) return { w: even(w), h: even(h) };
  const s = maxEdge / Math.max(w, h);
  return { w: even(w * s), h: even(h * s) };
}

// Parse the banner ffmpeg prints for `ffmpeg -i file`.
export function parseProbeLog(log) {
  const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(log);
  const v = /Stream #[^\n]*Video:[^\n]*?(\d{2,5})x(\d{2,5})/.exec(log);
  const fps = /Stream #[^\n]*Video:[^\n]*?([\d.]+) (?:fps|tbr)/.exec(log);
  const rot = /rotation of (-?[\d.]+)/.exec(log);
  let width = v ? Number(v[1]) : 0;
  let height = v ? Number(v[2]) : 0;
  if (rot && Math.abs(Math.round(Number(rot[1]))) % 180 === 90) [width, height] = [height, width];
  return {
    duration: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0,
    width,
    height,
    fps: fps ? Number(fps[1]) : 0,
    hasAudio: /Stream #[^\n]*Audio:/.test(log),
  };
}

function gifFilter({ fps, dims, colors, dither }) {
  const parts = [];
  if (fps) parts.push(`fps=${fps}`);
  if (dims) parts.push(`scale=${dims.w}:${dims.h}:flags=lanczos`);
  const pre = parts.length ? parts.join(',') + ',' : '';
  const ditherOpt = dither === 'none' ? 'dither=none' : dither === 'smooth' ? 'dither=sierra2_4a' : 'dither=bayer:bayer_scale=4';
  return `${pre}split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=diff[p];[b][p]paletteuse=${ditherOpt}:diff_mode=rectangle`;
}

const VIDEO_QUALITY = { high: 21, balanced: 26, small: 31, tiny: 36 };

// `fast` trades a little compression for speed — used by the single-threaded WebAssembly build.
function videoEncodeArgs(format, o, info, fast) {
  const crfBase = VIDEO_QUALITY[o.quality] ?? VIDEO_QUALITY.balanced;
  const audio = !o.removeAudio && info.hasAudio;
  const audioKbps = 96;
  let rate = [];
  const targetMB = num(o.targetMB, 0, 0, 1e6);
  if (targetMB > 0 && info.duration > 0) {
    const totalKbps = (targetMB * 8 * 1024 * 0.95) / info.duration;
    const videoKbps = Math.max(50, Math.floor(totalKbps - (audio ? audioKbps : 0)));
    rate = ['-b:v', `${videoKbps}k`, '-maxrate', `${Math.floor(videoKbps * 1.4)}k`, '-bufsize', `${videoKbps * 2}k`];
  }
  const webmAudio = audio ? ['-c:a', 'libopus', '-b:a', `${audioKbps}k`] : ['-an'];
  if (format === 'webm' && fast) {
    // VP9 stalls in the single-threaded wasm build; VP8 works.
    const crf = Math.round((crfBase - 21) * 1.8) + 6;
    return ['-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', ...(rate.length ? rate : ['-crf', String(crf), '-b:v', '10M']), ...webmAudio];
  }
  if (format === 'webm') {
    return [
      '-c:v', 'libvpx-vp9', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4',
      ...(rate.length ? rate : ['-crf', String(crfBase + 8), '-b:v', '0']),
      ...webmAudio,
    ];
  }
  return [
    '-c:v', 'libx264', '-preset', fast ? 'veryfast' : 'medium', '-pix_fmt', 'yuv420p',
    ...(rate.length ? rate : ['-crf', String(crfBase)]),
    ...(audio ? ['-c:a', 'aac', '-b:a', `${audioKbps}k`] : ['-an']),
    '-movflags', '+faststart',
  ];
}

/**
 * Build the ffmpeg command for a video/GIF operation.
 * Returns { args, outExt, duration (seconds of output, for progress), sameFormat }.
 * `output` is a function from extension to output path.
 */
export function buildFfmpegJob(op, o, info, { input, output, inputName, fast = false }) {
  const start = num(o.start, 0, 0, 1e6);
  const length = num(o.duration, 0, 0, 1e6);
  const trim = [...(start > 0 ? ['-ss', String(start)] : []), ...(length > 0 ? ['-t', String(length)] : [])];
  const clipDuration = Math.max(0, length > 0 ? Math.min(length, info.duration - start) : info.duration - start);
  const srcExt = '.' + extOf(inputName);

  if (op === 'video-compress') {
    const format = o.format === 'webm' ? 'webm' : 'mp4';
    const dims = fitDims(info.width, info.height, num(o.maxEdge, 0, 0, 8000));
    const vf = [];
    if (dims) vf.push(`scale=${dims.w}:${dims.h}`);
    const fps = num(o.fps, 0, 0, 120);
    if (fps && (!info.fps || fps < info.fps)) vf.push(`fps=${fps}`);
    const outExt = `.${format}`;
    return {
      args: [...trim, '-i', input, ...(vf.length ? ['-vf', vf.join(',')] : []), ...videoEncodeArgs(format, o, { ...info, duration: clipDuration }, fast), '-map_metadata', '-1', output(outExt)],
      outExt,
      duration: clipDuration,
      sameFormat: srcExt === outExt,
    };
  }

  if (op === 'video-to-gif') {
    const fps = num(o.fps, 12, 1, 50);
    const dims = fitDims(info.width, info.height, num(o.maxEdge, 480, 0, 4000));
    const colors = num(o.colors, 256, 2, 256);
    return {
      args: [...trim, '-i', input, '-filter_complex', gifFilter({ fps, dims, colors, dither: o.dither }), '-loop', '0', output('.gif')],
      outExt: '.gif',
      duration: clipDuration,
    };
  }

  if (op === 'gif-compress') {
    const fpsCap = num(o.fps, 0, 0, 50);
    const fps = fpsCap && (!info.fps || fpsCap < info.fps) ? fpsCap : 0;
    const maxEdge = num(o.maxEdge, 0, 0, 4000);
    const dims = maxEdge && Math.max(info.width, info.height) > maxEdge ? fitDims(info.width, info.height, maxEdge) : null;
    const colors = num(o.colors, 128, 2, 256);
    return {
      args: ['-i', input, '-filter_complex', gifFilter({ fps, dims, colors, dither: o.dither }), '-loop', '0', output('.gif')],
      outExt: '.gif',
      duration: info.duration,
      sameFormat: true,
    };
  }

  if (op === 'gif-to-video') {
    const format = o.format === 'webm' ? 'webm' : 'mp4';
    const loops = num(o.loops, 1, 1, 50);
    const dims = fitDims(info.width, info.height, num(o.maxEdge, 0, 0, 4000));
    const vf = dims ? `scale=${dims.w}:${dims.h}:flags=lanczos` : 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
    const outExt = `.${format}`;
    return {
      args: [...(loops > 1 ? ['-stream_loop', String(loops - 1)] : []), '-i', input, '-vf', vf, ...videoEncodeArgs(format, { ...o, removeAudio: true }, info, fast), output(outExt)],
      outExt,
      duration: info.duration * loops,
    };
  }

  throw new Error(`Unknown operation: ${op}`);
}
