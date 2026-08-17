import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { requireAdmin } from '../auth.js';
import { env } from '../env.js';
import { query } from '../db.js';
import { subscribe } from '../events.js';
import { enqueue } from '../jobs/transcode.js';
import { r2Configured } from '../storage.js';

export const uploads = new Hono();

const ALLOWED_EXT = new Set([
  '.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.mpg', '.mpeg',
  '.wmv', '.flv', '.ts', '.mts', '.m2ts', '.3gp', '.ogv',
]);

export const slugify = (value) =>
  String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

/** First free slug in the `base`, `base-2`, `base-3` … sequence. */
export async function uniqueSlug(base) {
  const root = slugify(base) || `video-${Date.now()}`;
  for (let n = 1; n < 200; n += 1) {
    const candidate = n === 1 ? root : `${root}-${n}`;
    const { rows } = await query('select 1 from videos where slug = $1', [candidate]);
    if (!rows.length) return candidate;
  }
  return `${root}-${randomUUID().slice(0, 8)}`;
}

/**
 * Raw-body upload. The file is the request body, not a multipart part, so it
 * streams straight to disk - parsing multipart would buffer a multi-gigabyte
 * video in memory. The browser sends it with XHR so it can report progress.
 */
uploads.post('/uploads', requireAdmin, async (c) => {
  if (!r2Configured()) {
    return c.json({ error: 'R2 is not configured on the server' }, 500);
  }

  const filename = c.req.query('filename') || 'video.mp4';
  const ext = extname(filename).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    return c.json({ error: `Unsupported file type "${ext || 'unknown'}"` }, 415);
  }

  const declared = Number(c.req.header('content-length') || 0);
  if (declared > env.maxUploadBytes) {
    return c.json({ error: `File is larger than the ${Math.round(env.maxUploadBytes / 1024 ** 3)} GB limit` }, 413);
  }

  const title = (c.req.query('title') || filename.replace(/\.[^.]+$/, '')).slice(0, 200);
  const slug = c.req.query('slug')
    ? await uniqueSlug(c.req.query('slug'))
    : await uniqueSlug(title);

  await mkdir(env.uploadDir, { recursive: true });
  const path = join(env.uploadDir, `${randomUUID()}${ext}`);

  let written = 0;
  try {
    if (!c.req.raw.body) throw new Error('Empty request body');
    const source = Readable.fromWeb(c.req.raw.body);
    source.on('data', (chunk) => {
      written += chunk.length;
      if (written > env.maxUploadBytes) source.destroy(new Error('Upload exceeded the size limit'));
    });
    await pipeline(source, createWriteStream(path));
  } catch (err) {
    await rm(path, { force: true });
    return c.json({ error: `Upload failed: ${err.message}` }, 400);
  }

  if (written === 0) {
    await rm(path, { force: true });
    return c.json({ error: 'Uploaded file was empty' }, 400);
  }

  const { rows } = await query(
    `insert into videos (slug, title, status, progress, original_path, original_name, source_bytes)
     values ($1, $2, 'processing', 0, $3, $4, $5)
     returning id, slug, title, status`,
    [slug, title, path, filename.slice(0, 255), written],
  );

  enqueue(rows[0].id);
  return c.json({ video: rows[0] }, 201);
});

/**
 * Progress stream. One event per meaningful change, pushed - the dashboard
 * never polls for it.
 */
uploads.get('/videos/:slug/events', requireAdmin, (c) => {
  const slug = c.req.param('slug');

  return streamSSE(c, async (stream) => {
    const { rows } = await query(
      'select status, progress, error, duration_sec from videos where slug = $1',
      [slug],
    );
    if (rows[0]) {
      await stream.writeSSE({ event: 'status', data: JSON.stringify(rows[0]) });
      if (rows[0].status === 'ready' || rows[0].status === 'failed') return;
    }

    let done = false;
    const pending = [];
    let wake = () => {};

    const unsubscribe = subscribe(slug, (payload) => {
      pending.push(payload);
      if (payload.status === 'ready' || payload.status === 'failed') done = true;
      wake();
    });

    c.req.raw.signal?.addEventListener('abort', () => {
      done = true;
      wake();
    });

    try {
      // Heartbeat every 20s so intermediaries don't reap an idle stream.
      while (!done) {
        if (!pending.length) {
          await Promise.race([
            new Promise((resolve) => { wake = resolve; }),
            new Promise((resolve) => setTimeout(resolve, 20000)),
          ]);
        }
        if (!pending.length) {
          await stream.writeSSE({ event: 'ping', data: '1' });
          continue;
        }
        while (pending.length) {
          await stream.writeSSE({ event: 'status', data: JSON.stringify(pending.shift()) });
        }
      }
      while (pending.length) {
        await stream.writeSSE({ event: 'status', data: JSON.stringify(pending.shift()) });
      }
    } finally {
      unsubscribe();
    }
  });
});
