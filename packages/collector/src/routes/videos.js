import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { requireServerKey, requireAdmin } from '../auth.js';
import { query } from '../db.js';
import { bustVideoCache } from './collect.js';
import { enqueue, generateThumbnails, generateTeaser, setPoster } from '../jobs/transcode.js';
import { deleteObjects } from '../storage.js';
import { purgeUrls } from '../cloudflare.js';
import { env } from '../env.js';
import { uniqueSlug } from './uploads.js';

export const videos = new Hono();

const SKIN_NAMES = new Set(['glass', 'edge', 'minimal', 'bar']);
const AUTOPLAY_MODES = new Set(['off', 'muted', 'sound']);

const publicShape = (row) => ({
  slug: row.slug,
  title: row.title,
  duration: row.duration_sec,
  aspectRatio: row.aspect_ratio,
  poster: row.poster_url,
  sources: row.sources,
  captions: row.captions,
  chapters: row.chapters,
  thumbnails: row.thumbnails,
  teaser: row.teaser,
  skin: row.skin,
  accent: row.accent,
  autoplay: row.autoplay,
  loop: row.loop,
  controls: row.controls,
});

/**
 * Player config. Public by design - it describes a public video file.
 * Only `ready` videos resolve: a half-transcoded row has no sources, and
 * serving it would render an embed that is permanently broken.
 */
videos.get('/videos/:slug', async (c) => {
  const { rows } = await query(
    "select * from videos where slug = $1 and archived_at is null and status = 'ready'",
    [c.req.param('slug')],
  );
  if (!rows[0]) return c.json({ error: 'not found' }, 404);
  return c.json(publicShape(rows[0]), 200, { 'cache-control': 'public, max-age=60' });
});

videos.get('/admin/videos', requireAdmin, async (c) => {
  const { rows } = await query(`
    select v.id, v.slug, v.title, v.status, v.progress, v.error, v.duration_sec,
           v.poster_url, v.aspect_ratio, v.source_bytes, v.original_name,
           v.skin, v.accent, v.thumbnails, v.teaser, v.autoplay, v.loop, v.controls,
           v.created_at, v.updated_at,
           count(vw.id)::int as impressions,
           count(vw.id) filter (where vw.played)::int as plays
      from videos v
      left join views vw on vw.video_id = v.id
     where v.archived_at is null
     group by v.id
     order by v.created_at desc
  `);
  return c.json({ videos: rows });
});

const CONFIG_FIELDS = ['title', 'duration_sec', 'aspect_ratio', 'poster_url', 'sources', 'captions', 'chapters', 'metadata'];
const JSON_FIELDS = new Set(['sources', 'captions', 'chapters', 'metadata']);

const fromBody = (body) => ({
  title: body.title,
  duration_sec: body.duration ?? body.duration_sec,
  aspect_ratio: body.aspectRatio ?? body.aspect_ratio,
  poster_url: body.poster ?? body.poster_url,
  sources: body.sources,
  captions: body.captions,
  chapters: body.chapters,
  metadata: body.metadata,
});

/** Upsert by slug. Used by the publish CLI; the UI goes through /v1/uploads. */
videos.post('/videos', requireServerKey, async (c) => {
  const body = await c.req.json();
  const slug = String(body.slug || '').trim();
  if (!/^[a-z0-9][a-z0-9-]{1,80}$/.test(slug)) {
    return c.json({ error: 'slug must be lowercase alphanumeric with dashes' }, 400);
  }

  const attrs = fromBody(body);
  const cols = [];
  const params = [slug];
  const placeholders = [];

  for (const field of CONFIG_FIELDS) {
    if (attrs[field] === undefined) continue;
    cols.push(field);
    params.push(JSON_FIELDS.has(field) ? JSON.stringify(attrs[field]) : attrs[field]);
    placeholders.push(`$${params.length}`);
  }

  const updates = cols
    .map((col) => `${col} = excluded.${col}`)
    .concat("updated_at = now()", 'archived_at = null', "status = 'ready'", 'progress = 100');

  const { rows } = await query(
    `insert into videos (slug, status, progress${cols.length ? `, ${cols.join(', ')}` : ''})
     values ($1, 'ready', 100${placeholders.length ? `, ${placeholders.join(', ')}` : ''})
     on conflict (slug) do update set ${updates.join(', ')}
     returning *`,
    params,
  );

  bustVideoCache(slug);
  return c.json({ video: rows[0] });
});

/** Rename. Changing the slug moves the public URL, so it is opt-in and warned about in the UI. */
videos.patch('/videos/:slug', requireAdmin, async (c) => {
  const current = c.req.param('slug');
  const body = await c.req.json().catch(() => ({}));

  const { rows: existing } = await query('select * from videos where slug = $1', [current]);
  const video = existing[0];
  if (!video) return c.json({ error: 'not found' }, 404);

  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 200) : video.title;

  let slug = video.slug;
  if (body.slug && body.slug !== video.slug) {
    // The R2 objects keep the OLD key - renaming would orphan every existing
    // embed AND require a copy in the bucket. Point the sources at the old
    // keys and only the dashboard URL changes.
    slug = await uniqueSlug(body.slug);
  }

  const skin = SKIN_NAMES.has(body.skin) ? body.skin : body.skin === null ? null : video.skin;
  const accent = body.accent === null
    ? null
    : /^#[0-9a-f]{6}$/i.test(body.accent || '')
      ? body.accent.toLowerCase()
      : video.accent;

  const autoplay = AUTOPLAY_MODES.has(body.autoplay) ? body.autoplay : video.autoplay;
  const loop = typeof body.loop === 'boolean' ? body.loop : video.loop;
  const controls = typeof body.controls === 'boolean' ? body.controls : video.controls;

  const { rows } = await query(
    `update videos set title = $2, slug = $3, skin = $4, accent = $5,
                       autoplay = $6, loop = $7, controls = $8, updated_at = now()
      where id = $1 returning *`,
    [video.id, title, slug, skin, accent, autoplay, loop, controls],
  );
  bustVideoCache(current);
  bustVideoCache(slug);
  return c.json({ video: rows[0] });
});

/** Set the poster to a specific moment in the video. */
videos.post('/videos/:slug/poster/frame', requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { rows } = await query('select id from videos where slug = $1', [c.req.param('slug')]);
  if (!rows[0]) return c.json({ error: 'not found' }, 404);
  try {
    const poster = await setPoster(rows[0].id, { atSec: Number(body.at) || 0 });
    return c.json({ ok: true, poster });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif']);
const MAX_POSTER_BYTES = 15 * 1024 * 1024;

/** Upload a custom poster image (raw body, like the video upload). */
videos.post('/videos/:slug/poster/upload', requireAdmin, async (c) => {
  const type = (c.req.header('content-type') || '').split(';')[0].trim();
  if (!IMAGE_TYPES.has(type)) return c.json({ error: `Unsupported image type "${type || 'unknown'}"` }, 415);
  if (Number(c.req.header('content-length') || 0) > MAX_POSTER_BYTES) {
    return c.json({ error: 'Image is larger than 15 MB' }, 413);
  }

  const { rows } = await query('select id from videos where slug = $1', [c.req.param('slug')]);
  if (!rows[0]) return c.json({ error: 'not found' }, 404);

  await mkdir(env.uploadDir, { recursive: true });
  const path = join(env.uploadDir, `poster-${randomUUID()}`);
  try {
    if (!c.req.raw.body) throw new Error('empty body');
    await pipeline(Readable.fromWeb(c.req.raw.body), createWriteStream(path));
    const poster = await setPoster(rows[0].id, { sourceFile: path });
    return c.json({ ok: true, poster });
  } catch (err) {
    await rm(path, { force: true });
    return c.json({ error: err.message }, 500);
  }
});

/** Rebuild the teaser clip, optionally starting from a different moment. */
videos.post('/videos/:slug/teaser', requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { rows } = await query('select id from videos where slug = $1', [c.req.param('slug')]);
  if (!rows[0]) return c.json({ error: 'not found' }, 404);
  try {
    const teaser = await generateTeaser(rows[0].id, {
      start: body.start === undefined || body.start === null ? null : Number(body.start),
    });
    return c.json({ ok: true, teaser });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

/** Backfill scrub thumbnails for a video published before sprites existed. */
videos.post('/videos/:slug/thumbnails', requireAdmin, async (c) => {
  const { rows } = await query('select id from videos where slug = $1', [c.req.param('slug')]);
  if (!rows[0]) return c.json({ error: 'not found' }, 404);
  try {
    const thumbnails = await generateThumbnails(rows[0].id);
    return c.json({ ok: true, thumbnails });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

/** Requeue a failed transcode. Only works while the original upload survives. */
videos.post('/videos/:slug/retry', requireAdmin, async (c) => {
  const { rows } = await query('select id, status, original_path from videos where slug = $1', [
    c.req.param('slug'),
  ]);
  const video = rows[0];
  if (!video) return c.json({ error: 'not found' }, 404);
  if (!video.original_path) {
    return c.json({ error: 'The original upload is gone - upload the file again.' }, 409);
  }
  await query("update videos set status = 'processing', progress = 0, error = null where id = $1", [video.id]);
  enqueue(video.id);
  return c.json({ ok: true });
});

/**
 * Archive. Removes it from the dashboard and stops embeds resolving.
 * `?purge=1` also deletes the objects from R2 - unrecoverable, so the UI asks.
 */
videos.delete('/videos/:slug', requireAdmin, async (c) => {
  const slug = c.req.param('slug');
  const { rows } = await query(
    'update videos set archived_at = now() where slug = $1 and archived_at is null returning id, slug',
    [slug],
  );
  bustVideoCache(slug);
  if (!rows[0]) return c.json({ error: 'not found' }, 404);

  if (c.req.query('purge') === '1') {
    const keys = [`${slug}/video.mp4`, `${slug}/poster.jpg`];
    try {
      await deleteObjects(keys);
    } catch (err) {
      return c.json({ ok: true, archived: true, purge_error: err.message });
    }
    // Removing the object is not the same as retracting it: the edge copy has
    // a one-year immutable TTL and keeps serving until it is purged.
    const cache = await purgeUrls(keys.map((key) => `${env.mediaBaseUrl}/${key}`)).catch((err) => ({
      purged: false,
      reason: err.message,
    }));
    return c.json({
      ok: true,
      archived: true,
      purged: true,
      cache_purged: cache.purged,
      ...(cache.purged ? {} : { cache_note: `Still cached at the edge: ${cache.reason}` }),
    });
  }

  return c.json({ ok: true, archived: true });
});
