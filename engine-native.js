// Talks to server.js (native ffmpeg + sharp). Only available when running locally.

export const name = 'native';
export const capabilities = { avif: true, keepMetadata: true, maxBytes: 4 * 1024 ** 3 };

export async function available() {
  try {
    const res = await fetch('api/health', { cache: 'no-store' });
    return res.ok && (await res.json()).engine === 'native';
  } catch {
    return false;
  }
}

export async function run({ file, op, options }, onProgress) {
  const form = new FormData();
  form.append('op', op);
  form.append('options', JSON.stringify(options));
  form.append('file', file);

  const res = await fetch('api/jobs', { method: 'POST', body: form });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Upload failed');

  while (true) {
    await new Promise((r) => setTimeout(r, 400));
    const job = await (await fetch(`api/jobs/${data.id}`)).json();
    if (job.status === 'error' || (job.error && !job.status)) throw new Error(job.error);
    if (job.status === 'working' && job.progress > 0) onProgress(job.progress);
    if (job.status === 'done') {
      return {
        url: `api/jobs/${job.id}/file`,
        downloadUrl: `api/jobs/${job.id}/file?download=1`,
        outputName: job.outputName,
        inputSize: job.inputSize,
        outputSize: job.outputSize,
        note: job.note,
      };
    }
  }
}
