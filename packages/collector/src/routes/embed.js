import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { env } from '../env.js';
import { requireAdmin } from '../auth.js';
import { findVideo } from './collect.js';

export const embed = new Hono();

/**
 * Asset URLs carry the built bundle's mtime. Without it a deploy ships new
 * player code that returning viewers never fetch, because the previous
 * response is still inside its cache lifetime - which is exactly how a fixed
 * tracker bug keeps being reported as unfixed.
 */
const assetVersion = (() => {
  try {
    const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'player', 'dist', 'player.js');
    return String(Math.floor(statSync(dist).mtimeMs));
  } catch {
    return 'dev';
  }
})();

const escapeAttr = (val) => String(val).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/**
 * Iframe embed. This is the zero-integration path: any surface that already
 * takes a video URL and drops it in an <iframe> (funnel Video elements, the
 * onboarding setup modals, ActionText, a landing page) works by pasting
 *
 *   https://video.example.com/embed/<slug>
 *
 * with no code change on the consuming side. Analytics still record, because
 * the tracker runs inside the frame.
 */
embed.get('/embed/:slug', async (c) => {
  const slug = c.req.param('slug');
  const q = c.req.query();

  // 404 an unknown slug rather than serving a shell that fails client-side -
  // a 200 for a video that doesn't exist is a debugging trap.
  if (!(await findVideo(slug))) return c.text('Video not found', 404);

  const opts = {
    slug,
    endpoint: env.publicBaseUrl,
    siteKey: env.siteKey,
    // ?autoplay=1 is the muted variant; `sound` asks for audio and falls back
    // to muted-with-a-prompt when the browser refuses.
    autoplay: ['muted', 'sound', 'off'].includes(q.autoplay)
      ? q.autoplay
      : q.autoplay === '1'
        ? 'muted'
        : undefined,
    muted: q.muted === '1' || q.autoplay === '1' ? true : undefined,
    loop: q.loop === '1' ? true : q.loop === '0' ? false : undefined,
    teaser: q.teaser === '0' ? false : undefined,
    controls: q.controls === '0' ? false : q.controls === '1' ? true : undefined,
    start: Number(q.start || 0) || 0,
    color: q.color ? `#${String(q.color).replace(/^#/, '').slice(0, 6)}` : undefined,
    skin: ['glass', 'edge', 'minimal', 'bar'].includes(q.skin) ? q.skin : undefined,
    fill: true,
  };

  const frameAncestors = env.allowedOrigins.length ? env.allowedOrigins.join(' ') : "'self'";

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeAttr(slug)}</title>
<link rel="stylesheet" href="${env.publicBaseUrl}/player.css?v=${assetVersion}">
<style>
  html,body{margin:0;height:100%;background:#000;overflow:hidden}
  #root{position:absolute;inset:0}
</style>
</head>
<body>
<div id="root"></div>
<script src="${env.publicBaseUrl}/player.js?v=${assetVersion}"></script>
<script>
  CineHost.mount(document.getElementById('root'), ${JSON.stringify(opts)});
</script>
</body>
</html>`;

  return c.html(html, 200, {
    'content-security-policy': `frame-ancestors ${frameAncestors} 'self'`,
    // Short: this document is what carries the ?v= stamp to the assets, so its
    // cache lifetime is the real floor on how fast a player fix reaches people.
    'cache-control': 'public, max-age=60',
  });
});

const SKINS = [
  { id: 'glass', name: 'Floating glass', note: 'Blurred bar inset from the edge. Premium, designed.' },
  { id: 'edge', name: 'Edge-to-edge', note: 'Flush to the bottom over a gradient scrim. Familiar.' },
  { id: 'minimal', name: 'Minimal', note: 'A hairline until you interact. Lets the video dominate.' },
  { id: 'bar', name: 'Colour bar', note: 'A solid accent strip under the video. Always visible, brand-forward.' },
];

/** Side-by-side skin comparison, so the choice is made by looking, not guessing. */
embed.get('/skins/:slug', requireAdmin, async (c) => {
  const slug = c.req.param('slug');
  if (!(await findVideo(slug))) return c.text('Video not found', 404);

  const cards = SKINS.map(
    (skin) => `
    <section>
      <header><h2>${skin.name}</h2><code>?skin=${skin.id}</code></header>
      <p>${skin.note}</p>
      <div class="frame">
        <iframe src="/embed/${escapeAttr(slug)}?skin=${skin.id}" allowfullscreen loading="lazy"></iframe>
      </div>
    </section>`,
  ).join('');

  return c.html(
    `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Player skins — ${escapeAttr(slug)}</title>
<style>
  :root { color-scheme: light dark; --bg:#f9f9f9; --panel:#fff; --ink:#202020; --dim:#646464; --line:#d9d9d9; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#111; --panel:#191919; --ink:#eee; --dim:#b4b4b4; --line:#3a3a3a; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { max-width: 860px; margin: 0 auto; padding: 32px 20px 64px; display: grid; gap: 26px; }
  h1 { font-size: 18px; margin: 0; letter-spacing: -0.01em; }
  .lede { color: var(--dim); margin: 6px 0 0; }
  section { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 18px; }
  header { display: flex; align-items: baseline; gap: 10px; }
  h2 { font-size: 15px; margin: 0; }
  code { font-size: 12px; color: var(--dim); }
  section p { margin: 4px 0 14px; color: var(--dim); font-size: 13px; }
  .frame { position: relative; aspect-ratio: 16/9; border-radius: 10px; overflow: hidden; background:#000; }
  iframe { position:absolute; inset:0; width:100%; height:100%; border:0; }
</style>
</head><body>
<main>
  <div>
    <h1>Player skins — ${escapeAttr(slug)}</h1>
    <p class="lede">Same video, same controls, four treatments. Hover the scrub bar for thumbnail previews; the gear opens the settings menu. Pick one and I'll make it the default.</p>
  </div>
  ${cards}
</main>
</body></html>`,
    200,
    { 'cache-control': 'no-store' },
  );
});
