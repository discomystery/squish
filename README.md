# Squish

Compress images, videos and GIFs, and convert videos ↔ GIFs. Files never leave your device.

## Two ways to run it

**On the web (GitHub Pages)**: everything runs in your browser. Images use the browser's own encoders; video and GIF work uses [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm), a one-time ~32 MB download that the browser caches. It's slower than native and limited to files under ~700 MB.

**Locally (faster)**: double-click **Open Squish.command**, or run:

```
npm install
npm start
```

then open http://localhost:4321. The page detects the local server and switches to native ffmpeg and sharp, which are many times faster, handle files up to 4 GB, and add AVIF output and the option to keep EXIF data. Add `?engine=browser` to the URL to force the in-browser engine for testing.

## What it does

| Drop in | Options |
| --- | --- |
| **Image** (JPG, PNG, WebP, AVIF, TIFF) | Compress, change format, resize |
| **Video** (MP4, MOV, WebM, MKV…) | Compress (quality preset *or* target size in MB), resize, frame rate, MP4/WebM, trim, remove audio |
| **Video → GIF** | Size, frame rate, colors, dithering, trim |
| **GIF** | Compress (colors, size, frame rate, dithering) |
| **GIF → video** | MP4 or WebM, quality, loop it N times |

Settings you change are remembered as defaults. If compressing would make a file bigger, Squish keeps the original.

## Layout

- `public/`: the whole app, deployed as-is to GitHub Pages by `.github/workflows/pages.yml`
  - `shared.js`: ffmpeg command building used by both engines
  - `engine-browser.js` / `engine-native.js`: the in-browser and local-server engines
  - `vendor/ffmpeg/`: the ffmpeg.wasm wrapper (refresh with `npm run vendor`); the wasm core itself loads from jsDelivr
- `server.js`: optional local server with native ffmpeg + sharp
