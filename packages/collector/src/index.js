import { dirname, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { env, originAllowed } from './env.js';
import { requireAdmin } from './auth.js';
import { query } from './db.js';
import { staticHandler } from './static.js';
import { collect } from './routes/collect.js';
import { videos } from './routes/videos.js';
import { identify } from './routes/identify.js';
import { stats } from './routes/stats.js';
import { embed } from './routes/embed.js';
import { uploads } from './routes/uploads.js';
import { recoverInterrupted } from './jobs/transcode.js';
import { r2Configured } from './storage.js';

const here = dirname(fileURLToPath(import.meta.url));
const playerDist = join(here, '..', '..', 'player', 'dist');
const dashboardDir = join(here, '..', 'public', 'app');

const app = new Hono();

// CORS. Beacons post text/plain on purpose (a CORS-simple content type), so
// the only preflight that ever happens is for the JSON identify call.
app.use('*', async (c, next) => {
  const origin = c.req.header('origin');
  if (origin && originAllowed(origin)) {
    c.header('access-control-allow-origin', origin);
    c.header('vary', 'Origin');
    c.header('access-control-allow-headers', 'content-type,x-site-key');
    c.header('access-control-allow-methods', 'GET,POST,OPTIONS');
    c.header('access-control-max-age', '86400');
  }
  if (c.req.method === 'OPTIONS') return c.body(null, 204);
  await next();
});

app.get('/healthz', async (c) => {
  try {
    await query('select 1');
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ ok: false, error: err.message }, 503);
  }
});

app.route('/v1', collect);
app.route('/v1', uploads);
app.route('/v1', videos);
app.route('/v1', identify);
app.route('/v1', stats);
app.route('/', embed);

// Surfaced in the dashboard so a missing R2 config is visible before someone
// picks a file, not after the upload finishes.
app.get('/v1/config', requireAdmin, (c) =>
  c.json({
    r2: r2Configured(),
    mediaBaseUrl: env.mediaBaseUrl,
    maxUploadBytes: env.maxUploadBytes,
    publicBaseUrl: env.publicBaseUrl,
  }),
);

// Player bundle, immutable in production because the filename is stable and
// the content is versioned by deploy.
app.get('/player.js', staticHandler(playerDist, { prefix: '' }));
app.get('/player.css', staticHandler(playerDist, { prefix: '' }));
app.get('/e.js', staticHandler(playerDist, { prefix: '' }));

// Dashboard, behind HTTP Basic.
app.use('/app', requireAdmin);
app.use('/app/*', requireAdmin);
app.get('/app', staticHandler(dashboardDir, { prefix: '/app', index: 'index.html', cacheControl: 'no-store' }));
app.get('/app/*', staticHandler(dashboardDir, { prefix: '/app', index: 'index.html', cacheControl: 'no-store' }));

// Local media, dev only. In production R2 + Cloudflare serve these bytes and
// this service never touches a video file.
if (process.env.MEDIA_LOCAL_DIR) {
  app.get('/media/*', staticHandler(process.env.MEDIA_LOCAL_DIR, { prefix: '/media' }));
}

app.get('/', (c) => c.redirect('/app'));

serve({ fetch: app.fetch, port: env.port }, async (info) => {
  console.log(`[collector] listening on http://localhost:${info.port}`);
  console.log(`[collector] dashboard  ${env.publicBaseUrl}/app`);
  console.log(`[collector] R2 ${r2Configured() ? `configured (${env.mediaBaseUrl})` : 'NOT configured - uploads will fail'}`);

  await mkdir(env.uploadDir, { recursive: true }).catch(() => {});
  await mkdir(env.workDir, { recursive: true }).catch(() => {});
  // A restart mid-encode must not leave a row spinning forever.
  await recoverInterrupted().catch((err) => console.error('[collector] recovery failed', err));
});

export { app };
