#!/usr/bin/env node
/**
 * Encode a source file, put it on R2 (or a local dir for testing), and register
 * it with the collector.
 *
 *   node bin/publish-video.js --input raw/tour.mov --slug product-tour --title "Product tour"
 *   node bin/publish-video.js --input raw/tour.mov --slug product-tour --local
 *
 * Deliberately a CLI and not a service: a handful of marketing videos a month
 * does not justify a transcode pipeline, and this repo has no business running
 * one. When volume justifies a ladder, the ffmpeg args below grow an
 * -var_stream_map and nothing else changes.
 */
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, arg, i, list) => {
    if (!arg.startsWith('--')) return acc;
    const key = arg.slice(2);
    const next = list[i + 1];
    acc.push([key, next && !next.startsWith('--') ? next : true]);
    return acc;
  }, []),
);

const die = (msg) => {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
};

const input = args.input && resolve(String(args.input));
if (!input || !existsSync(input)) die('--input <file> is required and must exist');

const slug = String(args.slug || basename(input, extname(input)))
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '');
const title = String(args.title || slug.replace(/-/g, ' '));
const local = Boolean(args.local);

const outDir = resolve(args.out ? String(args.out) : 'media-out');
mkdirSync(join(outDir, slug), { recursive: true });

const run = (cmd, cmdArgs) => execFileSync(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();

// ---- probe ---------------------------------------------------------------
const probe = JSON.parse(
  run('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', input]),
);
const videoStream = probe.streams.find((s) => s.codec_type === 'video');
if (!videoStream) die('no video stream in input');
const duration = Math.round(Number(probe.format.duration) || 0);
const aspect = `${videoStream.width}/${videoStream.height}`;
console.log(`  ${slug}  ${videoStream.width}x${videoStream.height}  ${duration}s`);

// ---- encode --------------------------------------------------------------
const mp4Path = join(outDir, slug, 'video.mp4');
const posterPath = join(outDir, slug, 'poster.jpg');

if (args['skip-encode'] && existsSync(mp4Path)) {
  console.log('  reusing existing encode');
} else {
  console.log('  encoding (faststart mp4)...');
  run('ffmpeg', [
    '-y', '-i', input,
    '-c:v', 'libx264', '-crf', String(args.crf || 21), '-preset', String(args.preset || 'medium'),
    '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    // even dimensions, capped at 1080p - required by libx264 and by sanity
    '-vf', "scale='min(1920,iw)':-2",
    '-c:a', 'aac', '-b:a', '128k',
    // The whole point: moov atom at the front so the browser can start playing
    // and seeking before the file has finished downloading.
    '-movflags', '+faststart',
    mp4Path,
  ]);

  console.log('  poster frame...');
  // -update 1 tells the image2 muxer this is a single file, not a numbered
  // sequence; without it ffmpeg warns on every run.
  run('ffmpeg', [
    '-y', '-ss', String(args.poster || Math.min(3, duration / 4)), '-i', mp4Path,
    '-frames:v', '1', '-update', '1', '-q:v', '3', posterPath,
  ]);
}

console.log(`  encoded ${(statSync(mp4Path).size / 1e6).toFixed(1)} MB`);

// ---- upload --------------------------------------------------------------
const mediaBase = (process.env.MEDIA_BASE_URL || '').replace(/\/$/, '');
let videoUrl;
let posterUrl;

if (local) {
  const base = (process.env.PUBLIC_BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
  videoUrl = `${base}/media/${slug}/video.mp4`;
  posterUrl = `${base}/media/${slug}/poster.jpg`;
  console.log(`  local mode - serve with MEDIA_LOCAL_DIR=${outDir}`);
} else {
  if (!mediaBase) die('MEDIA_BASE_URL must be set (your R2 custom domain), or pass --local');
  const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');

  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });

  const put = async (file, key, contentType) => {
    console.log(`  uploading ${key}`);
    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: key,
      Body: createReadStream(file),
      ContentLength: statSync(file).size,
      ContentType: contentType,
      // Keys are per-slug and content is replaced by republishing under a new
      // slug, so a long immutable TTL is safe and keeps egress at the edge.
      CacheControl: 'public, max-age=31536000, immutable',
    }));
  };

  await put(mp4Path, `${slug}/video.mp4`, 'video/mp4');
  await put(posterPath, `${slug}/poster.jpg`, 'image/jpeg');
  videoUrl = `${mediaBase}/${slug}/video.mp4`;
  posterUrl = `${mediaBase}/${slug}/poster.jpg`;
}

// ---- register ------------------------------------------------------------
const collector = (process.env.PUBLIC_BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
const res = await fetch(`${collector}/v1/videos`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: `Bearer ${process.env.SERVER_API_KEY}`,
  },
  body: JSON.stringify({
    slug,
    title,
    duration,
    aspectRatio: aspect,
    poster: posterUrl,
    sources: [{ src: videoUrl, type: 'video/mp4', label: '1080p' }],
  }),
});

if (!res.ok) die(`register failed: ${res.status} ${await res.text()}`);

console.log(`
  published ${slug}

  iframe   <iframe src="${collector}/embed/${slug}" allowfullscreen style="border:0;width:100%;aspect-ratio:${aspect}"></iframe>
  script   <div data-cine data-video="${slug}"></div>
  stats    ${collector}/app?video=${slug}
`);
