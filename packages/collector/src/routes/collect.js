import { Hono } from 'hono';
import { validSiteKey } from '../auth.js';
import { env, originAllowed } from '../env.js';
import { query, tx } from '../db.js';
import { applyRanges } from '../ranges.js';
import { emit } from '../webhooks.js';

export const collect = new Hono();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_KINDS = new Set([
  'impression', 'play', 'pause', 'seek', 'ended', 'ratechange',
  'fullscreen', 'mute', 'unmute', 'error', 'cta_click', 'gate_submit',
]);

// Slug -> video row. Videos change rarely; beacons are hot.
const videoCache = new Map();
const CACHE_TTL_MS = 30000;

export async function findVideo(slug) {
  const hit = videoCache.get(slug);
  if (hit && hit.expires > Date.now()) return hit.video;

  const { rows } = await query(
    'select id, slug, duration_sec from videos where slug = $1 and archived_at is null',
    [slug],
  );
  const video = rows[0] || null;
  videoCache.set(slug, { video, expires: Date.now() + CACHE_TTL_MS });
  return video;
}

export const bustVideoCache = (slug) => (slug ? videoCache.delete(slug) : videoCache.clear());

/**
 * Beacons are sent as text/plain on purpose: it is a CORS-simple content type,
 * so neither fetch(keepalive) nor sendBeacon triggers a preflight the browser
 * would drop during pagehide.
 */
async function readBody(c) {
  const text = await c.req.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const deviceFrom = (ua = '') => {
  if (/iPad|Tablet/i.test(ua)) return 'tablet';
  if (/Mobi|Android|iPhone/i.test(ua)) return 'mobile';
  return 'desktop';
};

const truncate = (val, len) => (typeof val === 'string' ? val.slice(0, len) : null);

collect.post('/collect', async (c) => {
  const origin = c.req.header('origin');
  if (origin && !originAllowed(origin)) return c.json({ error: 'origin not allowed' }, 403);

  const body = await readBody(c);
  if (!body) return c.json({ error: 'bad payload' }, 400);
  if (!validSiteKey(body.k)) return c.json({ error: 'bad site key' }, 401);
  if (!UUID_RE.test(body.id || '')) return c.json({ error: 'bad view id' }, 400);

  const video = await findVideo(String(body.v || ''));
  if (!video) return c.json({ error: 'unknown video' }, 404);

  const ctx = body.ctx || {};
  const ua = c.req.header('user-agent') || '';

  // A video registered with duration 0 learns its own length from the first
  // viewer's metadata, so publishing without probing the file still works.
  let duration = video.duration_sec;
  if (!duration && Number(ctx.dur) > 0) {
    duration = Math.min(env.maxDurationSec, Math.round(Number(ctx.dur)));
    await query('update videos set duration_sec = $2, updated_at = now() where id = $1', [video.id, duration]);
    bustVideoCache(video.slug);
  }
  if (!duration) duration = 0;

  const events = Array.isArray(body.e) ? body.e.slice(0, 100) : [];
  const hasPlay = events.some((e) => e?.k === 'play');

  const result = await tx(async (client) => {
    const { rows: viewRows } = await client.query(
      `insert into views (id, video_id, visitor_id, session_id, page_url, referrer, user_agent, device, country, played)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (id) do update
         set last_seen_at = now(),
             played = views.played or excluded.played
       returning id, played, completed, max_pct, video_id`,
      [
        body.id,
        video.id,
        truncate(body.vid, 64) || 'anon',
        truncate(body.sid, 64) || 'anon',
        truncate(ctx.url, 1024),
        truncate(ctx.ref, 1024),
        truncate(ua, 512),
        deviceFrom(ua),
        truncate(c.req.header('cf-ipcountry'), 8),
        hasPlay,
      ],
    );
    const view = viewRows[0];

    if (events.length) {
      const values = [];
      const params = [];
      events.forEach((e, i) => {
        if (!EVENT_KINDS.has(e?.k)) return;
        const base = params.length;
        values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
        params.push(view.id, e.k, Number.isFinite(Number(e.s)) ? Number(e.s) : null, JSON.stringify(e.m || {}));
      });
      if (values.length) {
        await client.query(
          `insert into events (view_id, kind, at_sec, meta) values ${values.join(',')}`,
          params,
        );
      }
    }

    let progress = null;
    if (duration > 0 && Array.isArray(body.r) && body.r.length) {
      const { rows: playRows } = await client.query(
        'select counts from view_plays where view_id = $1 for update',
        [view.id],
      );
      const applied = applyRanges(playRows[0]?.counts, body.r, duration);

      await client.query(
        `insert into view_plays (view_id, counts) values ($1, $2)
         on conflict (view_id) do update set counts = excluded.counts`,
        [view.id, applied.counts],
      );

      const { rows: updated } = await client.query(
        `update views
            set watched_sec = $2,
                max_pct = greatest(views.max_pct, $3),
                completed = views.completed or $4,
                played = true,
                last_seen_at = now()
          where id = $1
        returning max_pct, completed`,
        [view.id, applied.watchedSec, applied.maxPct, applied.completed],
      );

      progress = {
        ...applied,
        previousPct: view.max_pct,
        wasCompleted: view.completed,
        maxPct: updated[0].max_pct,
        completed: updated[0].completed,
      };
    }

    return { view, progress };
  });

  // Webhooks last, outside the transaction, so a slow endpoint never holds a
  // row lock open.
  queueMicrotask(() => fireWebhooks(video, result, body).catch((err) => console.error('[collect]', err)));

  return c.json({ ok: true });
});

/**
 * thresholds_fired doubles as the once-only guard for view.started (pct 0).
 * Racing beacons from the same view can't double-fire because the insert
 * either wins the primary key or reports zero rows.
 */
async function fireOnce(viewId, pct) {
  const { rowCount } = await query(
    'insert into thresholds_fired (view_id, pct) values ($1, $2) on conflict do nothing',
    [viewId, pct],
  );
  return rowCount === 1;
}

async function fireWebhooks(video, { view, progress }, body) {
  const base = { video_slug: video.slug, view_id: view.id, visitor_id: body.vid, session_id: body.sid };

  if (body.e?.some((e) => e?.k === 'play') && (await fireOnce(view.id, 0))) {
    await emit('view.started', base);
  }

  if (!progress) return;

  for (const pct of env.webhookThresholds) {
    if (progress.maxPct < pct) continue;
    if (await fireOnce(view.id, pct)) {
      await emit('view.threshold', { ...base, pct, max_pct: progress.maxPct, watched_sec: progress.watchedSec });
    }
  }

  if (progress.completed && !progress.wasCompleted) {
    await emit('view.completed', { ...base, watched_sec: progress.watchedSec, unique_pct: progress.uniquePct });
  }
}
