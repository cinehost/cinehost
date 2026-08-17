import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '../env.js';
import { query } from '../db.js';
import { publish } from '../events.js';
import { putObject } from '../storage.js';
import { bustVideoCache } from '../routes/collect.js';

/**
 * Single-slot transcode queue.
 *
 * One job at a time, on purpose: ffmpeg will happily eat every core, and this
 * box is shared with another service. FFMPEG_THREADS caps it further.
 * Concurrency 1 also means "is something running" is a boolean, not a pool.
 */
const queue = [];
let running = false;

export function enqueue(videoId) {
  if (!queue.includes(videoId)) queue.push(videoId);
  drain();
}

async function drain() {
  if (running) return;
  const id = queue.shift();
  if (id === undefined) return;
  running = true;
  try {
    await process_(id);
  } catch (err) {
    console.error('[transcode] job crashed', err);
  } finally {
    running = false;
    if (queue.length) drain();
  }
}

const run = (cmd, args, { onStdout } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      onStdout?.(text);
    });
    // ffmpeg writes its human-readable log to stderr; keep the tail for errors.
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`${cmd} exited ${code}\n${stderr.trim()}`)),
    );
  });

const COLUMNS = 10;
const TILE_WIDTH = 160;

/**
 * Build a tiled sprite of frames for scrub-bar previews. Returns null rather
 * than throwing: a missing preview strip is a cosmetic loss, and it must never
 * cost someone their upload.
 */
async function buildSprite(mp4Path, workDir, duration, stream) {
  try {
    const count = Math.max(1, Math.min(100, Math.round(duration / 2) || 1));
    const interval = Math.max(1, Math.round(duration / count));
    const tiles = Math.min(100, Math.ceil(duration / interval));
    const rows = Math.ceil(tiles / COLUMNS);

    const ratio = stream.width && stream.height ? stream.height / stream.width : 9 / 16;
    // libx264 and the tile filter both want even dimensions.
    const tileHeight = Math.max(2, Math.round((TILE_WIDTH * ratio) / 2) * 2);

    const spritePath = join(workDir, 'thumbs.jpg');
    await run('ffmpeg', [
      '-nostdin', '-y', '-i', mp4Path,
      '-vf', `fps=1/${interval},scale=${TILE_WIDTH}:${tileHeight},tile=${COLUMNS}x${rows}`,
      '-frames:v', '1', '-q:v', '5',
      spritePath,
    ]);

    return {
      path: spritePath,
      meta: { interval, columns: COLUMNS, rows, count: tiles, width: TILE_WIDTH, height: tileHeight },
    };
  } catch (err) {
    console.warn('[transcode] sprite generation failed (continuing):', err.message);
    return null;
  }
}

const TEASER_SECONDS = 6;

/**
 * Short silent loop used as a hover preview, plus a GIF of the same moment.
 *
 * The player only ever loads the mp4: a 6s 480p clip is ~200-400 kB where the
 * equivalent GIF is several MB, and it is fetched with preload="none" so it
 * costs nothing until someone actually hovers. The GIF exists because GIFs
 * still play in places video does not - email, some social embeds - and is
 * offered as a copyable URL rather than shipped to viewers.
 *
 * Returns null on failure: a teaser is a nice-to-have and must never fail an
 * upload.
 */
async function buildTeaser(input, workDir, duration, startAt = null) {
  try {
    const length = Math.min(TEASER_SECONDS, Math.max(1, duration));
    const start = startAt === null
      ? Math.max(0, Math.min(duration * 0.1, Math.max(0, duration - length)))
      : Math.max(0, Math.min(Number(startAt) || 0, Math.max(0, duration - length)));

    const mp4Path = join(workDir, 'teaser.mp4');
    await run('ffmpeg', [
      '-nostdin', '-y', '-ss', String(start), '-t', String(length), '-i', input,
      '-an',
      '-threads', String(env.ffmpegThreads),
      '-vf', 'scale=480:-2',
      '-c:v', 'libx264', '-crf', '26', '-preset', 'veryfast',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      mp4Path,
    ]);

    const gifPath = join(workDir, 'teaser.gif');
    await run('ffmpeg', [
      '-nostdin', '-y', '-ss', String(start), '-t', String(length), '-i', input,
      // One pass would quantise to the 216-colour web palette and band badly;
      // palettegen/paletteuse builds a palette from these exact frames.
      '-vf', 'fps=10,scale=320:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3',
      '-loop', '0',
      gifPath,
    ]);

    return { mp4Path, gifPath, meta: { start: Math.round(start * 10) / 10, duration: length } };
  } catch (err) {
    console.warn('[transcode] teaser generation failed (continuing):', err.message);
    return null;
  }
}

async function setStatus(video, patch) {
  const fields = Object.keys(patch);
  const sets = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
  await query(`update videos set ${sets}, updated_at = now() where id = $1`, [
    video.id,
    ...fields.map((f) => patch[f]),
  ]);
  bustVideoCache(video.slug);
  publish(video.slug, { status: patch.status ?? video.status, ...patch });
}

async function process_(videoId) {
  const { rows } = await query('select * from videos where id = $1', [videoId]);
  const video = rows[0];
  if (!video || !video.original_path) return;

  const workDir = join(env.workDir, video.slug);
  await mkdir(workDir, { recursive: true });
  const mp4Path = join(workDir, 'video.mp4');
  const posterPath = join(workDir, 'poster.jpg');

  try {
    await setStatus(video, { status: 'processing', progress: 0, error: null });

    // ---- probe ----
    const probe = JSON.parse(
      await run('ffprobe', [
        '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', video.original_path,
      ]),
    );
    const stream = probe.streams.find((s) => s.codec_type === 'video');
    if (!stream) throw new Error('No video stream in the uploaded file');

    const duration = Math.round(Number(probe.format.duration) || 0);
    if (!duration) throw new Error('Could not read a duration from the uploaded file');
    const aspect = stream.width && stream.height ? `${stream.width}/${stream.height}` : '16/9';

    // ---- encode ----
    // -progress pipe:1 gives machine-readable key=value lines on stdout; the
    // percentage comes from out_time_us against the probed duration.
    let lastPct = -1;
    await run('ffmpeg', [
      '-nostdin', '-y', '-i', video.original_path,
      '-threads', String(env.ffmpegThreads),
      '-c:v', 'libx264', '-crf', String(env.crf), '-preset', env.preset,
      '-profile:v', 'high', '-pix_fmt', 'yuv420p',
      '-vf', "scale='min(1920,iw)':-2",
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      '-progress', 'pipe:1', '-nostats',
      mp4Path,
    ], {
      onStdout: (text) => {
        for (const line of text.split('\n')) {
          const [key, value] = line.split('=');
          if (key !== 'out_time_us' && key !== 'out_time_ms') continue;
          const seconds = key === 'out_time_us' ? Number(value) / 1e6 : Number(value) / 1e3;
          if (!Number.isFinite(seconds)) continue;
          // Encoding is ~90% of the wall clock; upload is the rest.
          const pct = Math.min(90, Math.round((seconds / duration) * 90));
          if (pct > lastPct) {
            lastPct = pct;
            publish(video.slug, { status: 'processing', progress: pct });
            query('update videos set progress = $2 where id = $1', [video.id, pct]).catch(() => {});
          }
        }
      },
    });

    // ---- poster ----
    await run('ffmpeg', [
      '-nostdin', '-y', '-ss', String(Math.min(3, duration / 4)), '-i', mp4Path,
      '-frames:v', '1', '-update', '1', '-q:v', '3', posterPath,
    ]);

    // ---- scrub-bar thumbnails ----
    // One sprite sheet, up to a 10x10 grid, so hovering the scrub bar costs a
    // single cached request instead of one per frame. The interval stretches
    // with duration so a long video still fits in 100 tiles.
    const sprite = await buildSprite(mp4Path, workDir, duration, stream);

    // ---- teaser ----
    await setStatus(video, { status: 'processing', progress: 91 });
    const teaser = await buildTeaser(mp4Path, workDir, duration);

    // ---- upload ----
    await setStatus(video, { status: 'processing', progress: 92 });
    const videoSize = (await stat(mp4Path)).size;
    await putObject(`${video.slug}/video.mp4`, createReadStream(mp4Path), 'video/mp4', videoSize);

    await setStatus(video, { status: 'processing', progress: 97 });
    const posterSize = (await stat(posterPath)).size;
    await putObject(`${video.slug}/poster.jpg`, createReadStream(posterPath), 'image/jpeg', posterSize);

    const base = env.mediaBaseUrl.replace(/\/$/, '');
    let thumbnails = {};
    if (sprite) {
      const spriteSize = (await stat(sprite.path)).size;
      await putObject(`${video.slug}/thumbs.jpg`, createReadStream(sprite.path), 'image/jpeg', spriteSize);
      thumbnails = { url: `${base}/${video.slug}/thumbs.jpg`, ...sprite.meta };
    }

    let teaserMeta = {};
    if (teaser) {
      teaserMeta = await uploadTeaser(video.slug, teaser);
    }

    await query(
      `update videos
          set status = 'ready', progress = 100, error = null,
              duration_sec = $2, aspect_ratio = $3,
              poster_url = $4, sources = $5::jsonb, thumbnails = $6::jsonb, teaser = $7::jsonb,
              original_path = null, updated_at = now()
        where id = $1`,
      [
        video.id,
        duration,
        aspect,
        `${base}/${video.slug}/poster.jpg`,
        JSON.stringify([{ src: `${base}/${video.slug}/video.mp4`, type: 'video/mp4', label: '1080p' }]),
        JSON.stringify(thumbnails),
        JSON.stringify(teaserMeta),
      ],
    );
    bustVideoCache(video.slug);
    publish(video.slug, { status: 'ready', progress: 100, duration });

    // Original is only insurance against a failed encode; the encode succeeded.
    await rm(video.original_path, { force: true });
    await rm(workDir, { recursive: true, force: true });
    console.log(`[transcode] ${video.slug} ready (${duration}s, ${(videoSize / 1e6).toFixed(1)} MB)`);
  } catch (err) {
    console.error(`[transcode] ${video.slug} failed:`, err.message);
    await query(
      "update videos set status = 'failed', error = $2, updated_at = now() where id = $1",
      [video.id, String(err.message).slice(0, 2000)],
    );
    bustVideoCache(video.slug);
    publish(video.slug, { status: 'failed', error: String(err.message).slice(0, 500) });
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * A restart mid-encode leaves rows claiming to be processing. Requeue the ones
 * whose upload is still on disk; fail the rest honestly rather than leaving a
 * spinner that never resolves.
 */
export async function recoverInterrupted() {
  const { rows } = await query(
    "select id, slug, original_path from videos where status in ('processing','uploading')",
  );
  for (const row of rows) {
    let resumable = false;
    if (row.original_path) {
      resumable = await stat(row.original_path).then(() => true).catch(() => false);
    }
    if (resumable) {
      console.log(`[transcode] resuming ${row.slug} after restart`);
      enqueue(row.id);
    } else {
      await query(
        "update videos set status = 'failed', error = 'Interrupted by a server restart', updated_at = now() where id = $1",
        [row.id],
      );
    }
  }
}

export const queueDepth = () => queue.length + (running ? 1 : 0);

/**
 * Replace the poster, either from a moment in the video or from an uploaded
 * image. Both paths go through ffmpeg so the result is always a sane,
 * consistently sized jpg regardless of what was handed in.
 *
 * The new object gets a NEW key every time. Media is served
 * `max-age=31536000, immutable`, so overwriting `poster.jpg` in place would
 * leave every edge and every browser showing the old frame - possibly for a
 * year. A fresh key sidesteps the cache entirely instead of depending on a
 * purge token we may not have.
 */
export async function setPoster(videoId, { atSec = null, sourceFile = null } = {}) {
  const { rows } = await query('select * from videos where id = $1', [videoId]);
  const video = rows[0];
  if (!video) throw new Error('not found');

  const input =
    sourceFile ||
    (video.sources || []).find((s) => !/m3u8|mpegurl/i.test(s.type || s.src || ''))?.src;
  if (!input) throw new Error('no source to take a frame from');

  const workDir = join(env.workDir, `${video.slug}-poster`);
  await mkdir(workDir, { recursive: true });
  const posterPath = join(workDir, 'poster.jpg');

  try {
    const seek = sourceFile ? [] : ['-ss', String(Math.max(0, Number(atSec) || 0))];
    await run('ffmpeg', [
      '-nostdin', '-y', ...seek, '-i', input,
      '-frames:v', '1', '-update', '1', '-q:v', '3',
      '-vf', "scale='min(1920,iw)':-2",
      posterPath,
    ]);

    const key = `${video.slug}/poster-${Date.now()}.jpg`;
    const size = (await stat(posterPath)).size;
    await putObject(key, createReadStream(posterPath), 'image/jpeg', size);

    const url = `${env.mediaBaseUrl.replace(/\/$/, '')}/${key}`;
    await query('update videos set poster_url = $2, updated_at = now() where id = $1', [video.id, url]);
    bustVideoCache(video.slug);
    return url;
  } finally {
    await rm(workDir, { recursive: true, force: true });
    if (sourceFile) await rm(sourceFile, { force: true });
  }
}

/**
 * Teaser objects are versioned by timestamp for the same reason posters are:
 * regenerating under a stable key would leave the old clip cached at the edge
 * for a year.
 */
async function uploadTeaser(slug, teaser) {
  const stamp = Date.now();
  const base = env.mediaBaseUrl.replace(/\/$/, '');

  const mp4Key = `${slug}/teaser-${stamp}.mp4`;
  await putObject(mp4Key, createReadStream(teaser.mp4Path), 'video/mp4', (await stat(teaser.mp4Path)).size);

  const gifKey = `${slug}/teaser-${stamp}.gif`;
  await putObject(gifKey, createReadStream(teaser.gifPath), 'image/gif', (await stat(teaser.gifPath)).size);

  return {
    mp4: `${base}/${mp4Key}`,
    gif: `${base}/${gifKey}`,
    gif_bytes: (await stat(teaser.gifPath)).size,
    ...teaser.meta,
  };
}

/** Rebuild the teaser, optionally from a different moment. */
export async function generateTeaser(videoId, { start = null } = {}) {
  const { rows } = await query('select * from videos where id = $1', [videoId]);
  const video = rows[0];
  if (!video) throw new Error('not found');

  const source = (video.sources || []).find((s) => !/m3u8|mpegurl/i.test(s.type || s.src || ''));
  if (!source) throw new Error('no progressive source to read from');

  const workDir = join(env.workDir, `${video.slug}-teaser`);
  await mkdir(workDir, { recursive: true });
  try {
    const duration = video.duration_sec || 0;
    if (!duration) throw new Error('unknown duration');
    const teaser = await buildTeaser(source.src, workDir, duration, start);
    if (!teaser) throw new Error('teaser generation failed');

    const meta = await uploadTeaser(video.slug, teaser);
    await query('update videos set teaser = $2::jsonb, updated_at = now() where id = $1', [
      video.id,
      JSON.stringify(meta),
    ]);
    bustVideoCache(video.slug);
    return meta;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Backfill a scrub sprite for a video that was published before sprites
 * existed. The uploaded original is long gone by then, so ffmpeg reads the
 * published mp4 straight off its public URL - it only needs to decode frames,
 * and the file is already edge-cached.
 */
export async function generateThumbnails(videoId) {
  const { rows } = await query('select * from videos where id = $1', [videoId]);
  const video = rows[0];
  if (!video) throw new Error('not found');

  const source = (video.sources || []).find((s) => !/m3u8|mpegurl/i.test(s.type || s.src || ''));
  if (!source) throw new Error('no progressive source to read frames from');

  const workDir = join(env.workDir, `${video.slug}-thumbs`);
  await mkdir(workDir, { recursive: true });

  try {
    const probe = JSON.parse(
      await run('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', source.src]),
    );
    const stream = probe.streams.find((s) => s.codec_type === 'video');
    const duration = Math.round(Number(probe.format.duration) || video.duration_sec || 0);
    if (!stream || !duration) throw new Error('could not probe the published file');

    const sprite = await buildSprite(source.src, workDir, duration, stream);
    if (!sprite) throw new Error('sprite generation failed');

    const size = (await stat(sprite.path)).size;
    await putObject(`${video.slug}/thumbs.jpg`, createReadStream(sprite.path), 'image/jpeg', size);

    const meta = { url: `${env.mediaBaseUrl.replace(/\/$/, '')}/${video.slug}/thumbs.jpg`, ...sprite.meta };
    await query('update videos set thumbnails = $2::jsonb, updated_at = now() where id = $1', [
      video.id,
      JSON.stringify(meta),
    ]);
    bustVideoCache(video.slug);
    return meta;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
