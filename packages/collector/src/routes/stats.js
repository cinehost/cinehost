import { Hono } from 'hono';
import { requireAdmin } from '../auth.js';
import { query } from '../db.js';

export const stats = new Hono();

const range = (c) => {
  const to = c.req.query('to') ? new Date(c.req.query('to')) : new Date();
  const from = c.req.query('from')
    ? new Date(c.req.query('from'))
    : new Date(to.getTime() - 30 * 24 * 3600 * 1000);
  return [from.toISOString(), to.toISOString()];
};

/**
 * Everything the dashboard draws, in one response.
 *
 * engagement[i] = average number of times second i was played, across plays.
 *                 >1 means rewatching, exactly like Wistia's graph going over
 *                 100% on a replayed segment.
 * retention[i]  = share of plays that saw second i at least once. Monotonically
 *                 non-increasing in practice; the drop-off curve.
 */
stats.get('/videos/:slug/stats', requireAdmin, async (c) => {
  const slug = c.req.param('slug');
  const [from, to] = range(c);

  const { rows: videoRows } = await query('select * from videos where slug = $1', [slug]);
  const video = videoRows[0];
  if (!video) return c.json({ error: 'not found' }, 404);

  const { rows: totalRows } = await query(
    `select count(*)::int as impressions,
            count(*) filter (where played)::int as plays,
            count(*) filter (where completed)::int as completions,
            count(distinct visitor_id)::int as visitors,
            count(*) filter (where email is not null)::int as identified,
            coalesce(avg(watched_sec) filter (where played), 0)::float as avg_watched_sec,
            coalesce(avg(max_pct) filter (where played), 0)::float as avg_max_pct
       from views
      where video_id = $1 and started_at >= $2 and started_at < $3`,
    [video.id, from, to],
  );
  const totals = totalRows[0];

  const { rows: curveRows } = await query(
    `select u.ord::int as sec,
            sum(u.c)::float as plays_at,
            count(*) filter (where u.c > 0)::int as viewers_at
       from view_plays vp
       join views v on v.id = vp.view_id
       cross join lateral unnest(vp.counts) with ordinality as u(c, ord)
      where v.video_id = $1 and v.started_at >= $2 and v.started_at < $3 and v.played
      group by u.ord
      order by u.ord`,
    [video.id, from, to],
  );

  const duration = video.duration_sec || curveRows.length;
  const engagement = new Array(duration).fill(0);
  const retention = new Array(duration).fill(0);
  for (const row of curveRows) {
    const i = row.sec - 1; // `with ordinality` is 1-based
    if (i < 0 || i >= duration) continue;
    engagement[i] = totals.plays ? row.plays_at / totals.plays : 0;
    retention[i] = totals.plays ? row.viewers_at / totals.plays : 0;
  }

  const dimension = async (col) => {
    const { rows } = await query(
      `select coalesce(nullif(${col}, ''), '(none)') as label, count(*)::int as views
         from views
        where video_id = $1 and started_at >= $2 and started_at < $3
        group by 1 order by views desc limit 10`,
      [video.id, from, to],
    );
    return rows;
  };

  const [referrers, devices, countries] = await Promise.all([
    dimension('referrer'),
    dimension('device'),
    dimension('country'),
  ]);

  const { rows: daily } = await query(
    `select date_trunc('day', started_at)::date as day,
            count(*)::int as impressions,
            count(*) filter (where played)::int as plays
       from views
      where video_id = $1 and started_at >= $2 and started_at < $3
      group by 1 order by 1`,
    [video.id, from, to],
  );

  return c.json({
    video: { slug: video.slug, title: video.title, duration: video.duration_sec, poster: video.poster_url },
    range: { from, to },
    totals: {
      ...totals,
      play_rate: totals.impressions ? totals.plays / totals.impressions : 0,
      completion_rate: totals.plays ? totals.completions / totals.plays : 0,
    },
    engagement,
    retention,
    daily,
    referrers,
    devices,
    countries,
  });
});

/** Individual viewer timelines - the "who watched what" table. */
stats.get('/videos/:slug/views', requireAdmin, async (c) => {
  const slug = c.req.param('slug');
  const [from, to] = range(c);
  const limit = Math.min(Number(c.req.query('limit') || 50), 500);

  const { rows } = await query(
    `select v.id, v.visitor_id, v.email, v.lead_id, v.identity_source, v.device, v.country,
            v.referrer, v.page_url, v.watched_sec, v.max_pct, v.played, v.completed,
            v.started_at, v.last_seen_at, vp.counts
       from views v
       join videos vid on vid.id = v.video_id
       left join view_plays vp on vp.view_id = v.id
      where vid.slug = $1 and v.started_at >= $2 and v.started_at < $3
      order by v.started_at desc
      limit $4`,
    [slug, from, to, limit],
  );

  return c.json({ views: rows });
});

/** Cross-video roll-up for the dashboard index. */
stats.get('/summary', requireAdmin, async (c) => {
  const [from, to] = range(c);
  const { rows } = await query(
    `select vid.slug, vid.title, vid.duration_sec as duration, vid.poster_url as poster,
            count(v.id)::int as impressions,
            count(v.id) filter (where v.played)::int as plays,
            count(v.id) filter (where v.completed)::int as completions,
            coalesce(avg(v.max_pct) filter (where v.played), 0)::float as avg_max_pct
       from videos vid
       left join views v
         on v.video_id = vid.id and v.started_at >= $1 and v.started_at < $2
      where vid.archived_at is null
      group by vid.id
      order by plays desc, vid.created_at desc`,
    [from, to],
  );
  return c.json({ videos: rows, range: { from, to } });
});
