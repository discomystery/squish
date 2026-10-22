// Optional native backend. The app in public/ works on its own (in-browser WebAssembly);
// when served by this server it uses native ffmpeg + sharp instead, which is much faster.
import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOWED, buildFfmpegJob, kindOf, num, outputName } from './public/shared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4321;
const WORK_DIR = path.join(os.tmpdir(), 'squish');
const JOB_TTL_MS = 60 * 60 * 1000;
const MAX_CONCURRENT = 2;

fs.rmSync(WORK_DIR, { recursive: true, force: true });
fs.mkdirSync(WORK_DIR, { recursive: true });

// ---------- helpers ----------

function probe(file) {
  return new Promise((resolve) => {
    execFile(
      ffprobeStatic.path,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      (err, stdout) => {
        if (err) return resolve({ duration: 0, width: 0, height: 0, fps: 0, hasAudio: false });
        const data = JSON.parse(stdout);
        const v = data.streams.find((s) => s.codec_type === 'video') || {};
        const [fn, fd] = (v.avg_frame_rate || '0/1').split('/').map(Number);
        let { width = 0, height = 0 } = v;
        const rotation = Number(v.tags?.rotate ?? v.side_data_list?.find((d) => d.rotation != null)?.rotation ?? 0);
        if (Math.abs(rotation) === 90 || Math.abs(rotation) === 270) [width, height] = [height, width];
        resolve({
          duration: Number(data.format?.duration) || Number(v.duration) || 0,
          width,
          height,
          fps: fd ? fn / fd : 0,
          hasAudio: data.streams.some((s) => s.codec_type === 'audio'),
        });
      }
    );
  });
}

function runFfmpeg(args, duration, onProgress) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-y', '-progress', 'pipe:1', '-nostats', ...args]);
    let stderr = '';
    proc.stdout.on('data', (chunk) => {
      const m = /out_time_us=(\d+)/.exec(chunk.toString());
      if (m && duration > 0) onProgress(Math.min(0.99, Number(m[1]) / 1e6 / duration));
    });
    proc.stderr.on('data', (d) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.split('\n').filter(Boolean).slice(-3).join(' ') || `ffmpeg exited with ${code}`));
    });
  });
}

async function compressImage(job, o) {
  const ext = path.extname(job.inputName).toLowerCase();
  const srcFormat = { '.jpg': 'jpeg', '.jpeg': 'jpeg', '.png': 'png', '.webp': 'webp', '.avif': 'avif' }[ext] || 'jpeg';
  const format = o.format && o.format !== 'keep' ? o.format : srcFormat;
  const quality = num(o.quality, 75, 1, 100);
  const maxEdge = num(o.maxEdge, 0, 0, 20000);

  let img = sharp(job.inputPath).rotate();
  if (maxEdge) img = img.resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true });
  if (o.keepMetadata) img = img.keepMetadata();

  if (format === 'jpeg') img = img.flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true });
  else if (format === 'png') img = img.png({ compressionLevel: 9, palette: quality < 100, quality, effort: 10 });
  else if (format === 'webp') img = img.webp({ quality, effort: 6 });
  else if (format === 'avif') img = img.avif({ quality: Math.max(1, quality - 15), effort: 5 });

  job.progress = 0.5;
  const outExt = format === 'jpeg' ? '.jpg' : `.${format}`;
  await img.toFile(job.outputPath(outExt));
  return { outExt, sameFormat: format === srcFormat };
}

// ---------- job queue ----------

const jobs = new Map();
const queue = [];
let running = 0;

function pump() {
  while (running < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    running++;
    runJob(job).finally(() => {
      running--;
      pump();
    });
  }
}

async function runJob(job) {
  job.status = 'working';
  try {
    let result;
    if (job.kind === 'image') {
      result = await compressImage(job, job.options);
    } else {
      const info = await probe(job.inputPath);
      if (!info.width) throw new Error("Couldn't read this file — it may be corrupt or an unsupported codec.");
      const spec = buildFfmpegJob(job.op, job.options, info, { input: job.inputPath, output: job.outputPath, inputName: job.inputName });
      await runFfmpeg(spec.args, spec.duration, (p) => (job.progress = p));
      result = spec;
    }
    let outPath = job.outputPath(result.outExt);
    let outSize = fs.statSync(outPath).size;

    // A "compress" that grew the file is pointless — hand back the original instead.
    if (result.sameFormat && outSize >= job.inputSize) {
      fs.rmSync(outPath, { force: true });
      outPath = job.inputPath;
      outSize = job.inputSize;
      job.note = 'Already well optimized — kept the original.';
    }

    job.outputFile = outPath;
    job.outputName = outputName(job.inputName, job.op, result.outExt);
    job.outputSize = outSize;
    job.progress = 1;
    job.status = 'done';
  } catch (err) {
    console.error(`[${job.id}] ${job.op} failed:`, err.message);
    job.status = 'error';
    job.error = err.message;
  }
}

setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.created < cutoff && job.status !== 'working' && job.status !== 'queued') {
      fs.rmSync(job.dir, { recursive: true, force: true });
      jobs.delete(id);
    }
  }
}, 5 * 60 * 1000).unref();

// ---------- http ----------

const app = express();
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(WORK_DIR, randomUUID());
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, 'input' + path.extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: 4 * 1024 ** 3 },
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => res.json({ engine: 'native' }));

app.post('/api/jobs', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  // multer decodes filenames as latin1
  const inputName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  const kind = kindOf(inputName);
  const op = req.body.op;
  if (!kind || !ALLOWED[kind].includes(op)) {
    fs.rmSync(path.dirname(req.file.path), { recursive: true, force: true });
    return res.status(400).json({ error: `Can't run ${op} on this file type.` });
  }
  let options = {};
  try {
    options = JSON.parse(req.body.options || '{}');
  } catch {}

  const dir = path.dirname(req.file.path);
  const job = {
    id: randomUUID(),
    created: Date.now(),
    dir,
    kind,
    op,
    options,
    inputName,
    inputPath: req.file.path,
    inputSize: req.file.size,
    outputPath: (ext) => path.join(dir, 'output' + ext),
    status: 'queued',
    progress: 0,
  };
  jobs.set(job.id, job);
  queue.push(job);
  pump();
  res.json({ id: job.id });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found (it may have expired).' });
  const { id, status, progress, inputSize, outputSize, outputName, error, note } = job;
  res.json({ id, status, progress, inputSize, outputSize, outputName, error, note });
});

app.get('/api/jobs/:id/file', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'done') return res.status(404).end();
  if (req.query.download) res.attachment(job.outputName);
  res.type(path.extname(job.outputName));
  res.sendFile(job.outputFile);
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Squish is running → http://localhost:${PORT}\n`);
});
