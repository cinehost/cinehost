# CineHost — the open-source Wistia alternative

**Self-hosted video hosting with Wistia-style engagement analytics.** Upload a
video, get an embed code, and see exactly which seconds people watched, rewatched
and dropped off at — on your own infrastructure, with no per-video pricing and no
seat limits.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

Files live on Cloudflare R2 and are served by Cloudflare's CDN, so **video bytes
never touch your server** — and R2 egress through Cloudflare is free. The only
thing you host is a small Node service writing small JSON rows.

```
browser ──player + beacons──►  collector (your VPS)  ──webhooks──►  your app
   │                                │
   └──────video bytes──────►  R2 + Cloudflare CDN  (never touches the VPS)
```

## Why replace Wistia?

Hosted video analytics platforms price per video, per seat, or per bandwidth
tier, and the engagement data — arguably the whole reason you pay — lives in
someone else's database. CineHost gives you the same per-second engagement graph
on infrastructure you control.

| | CineHost | Wistia / Vidyard |
|---|---|---|
| **Cost** | R2 storage (~$0.015/GB/mo) + a small VPS | Per-video / per-seat plans |
| **Bandwidth** | Free egress via Cloudflare | Metered, tiered |
| **Per-second engagement graph** | ✅ | ✅ |
| **Rewatch detection (>100% engagement)** | ✅ | ✅ |
| **Viewer identity + full watch history** | ✅ | ✅ (higher tiers) |
| **Webhooks on watch thresholds** | ✅ | ✅ (higher tiers) |
| **Custom player skins + brand colour** | ✅ | ✅ |
| **Hover teaser previews** | ✅ | ✅ |
| **Raw SQL access to your own data** | ✅ | ❌ |
| **Self-hosted / no vendor lock-in** | ✅ | ❌ |
| **Adaptive bitrate (HLS/DASH)** | ❌ (see below) | ✅ |
| **Live streaming** | ❌ | ✅ |

If you need adaptive bitrate ladders or live streaming today, use a hosted
platform — that is an honest limitation, not a roadmap item.

## Features

- **Per-second engagement analytics** — retention curve, engagement curve
  (rewatches push it above 100%), play rate, reached %, unique %.
- **Custom player**, dependency-free, ~4.6 kB gzipped. Four skins, brand accent
  colour, scrub thumbnail previews, settings menu, keyboard controls.
- **Upload from the browser.** No CLI required. Server-side ffmpeg transcode with
  live progress over SSE.
- **Autoplay modes** (`off` / `muted` / `sound` with graceful fallback), loop, and
  a **controls-off mode** for ambient background video.
- **Hover teaser clips** — a 6 s silent loop generated at transcode time, plus a
  GIF of the same moment for email.
- **Viewer identity** — attach an email or your own record id to a visitor's
  entire watch history, retroactively.
- **Signed webhooks** on play, watch thresholds and completion.
- **Dashboard** — Tailwind + Radix Colors, SVG charts, no SPA framework.

## What's in the box

| Path | What it is |
|---|---|
| `packages/player` | Dependency-free player + engagement tracker. Builds `player.js` (iframe embed) and `e.js` (script embed). ~4.6 kB gzipped. |
| `packages/collector` | Hono API: beacon ingest, video registry, identify, stats, iframe embed page, dashboard. |
| `packages/collector/public/app` | Dashboard. Tailwind v4 + Radix Colors, vanilla JS, SVG charts. |
| `bin/publish-video.js` | Encode → upload to R2 → register. A CLI, not a service. |
| `db/migrations` | Plain numbered SQL. |

## The data model, in one paragraph

Every player that comes on screen creates a `views` row (that's an
*impression* — play rate is meaningless if a player below the fold counts).
The tracker sends the whole seconds actually played as `[start, end)` ranges;
the collector folds them into `view_plays.counts`, a `smallint[]` with one
entry per second of the video holding **how many times that second was
played**. Every metric is an aggregation over that array:

- **play rate** — plays ÷ impressions
- **retention[i]** — share of plays that saw second `i` at least once (drop-off)
- **engagement[i]** — average play count of second `i`; **above 100% means
  people rewatched that moment**
- **reached %** — the furthest second touched, what thresholds fire on
- **unique %** — how much of it they actually saw (skipping doesn't count)

10 minutes of video is 600 `smallint`s ≈ 1.2 kB per view. 100k views ≈ 120 MB.

## Quick start

Postgres 15+, Node 20+, ffmpeg.

```bash
cp .env.example .env          # set DATABASE_URL; the dev defaults are fine otherwise
npm install
npm run build                 # player bundles + dashboard css
npm run migrate
npm test

npm run dev                   # collector on :8080
```

Publish a video without touching R2 at all:

```bash
echo "MEDIA_LOCAL_DIR=$(pwd)/media-out" >> .env
node --env-file=.env bin/publish-video.js --input raw/tour.mov --slug product-tour --local
```

`--local` writes the encode to `media-out/` and serves it from `/media/...`.
Open `http://localhost:8080/embed/product-tour`, watch some of it, then open
`http://localhost:8080/app`.

## Publishing from the dashboard (the normal way)

Open `/app`, hit **Upload video**, drop a file in. The server transcodes it,
pushes it to R2, and hands back the embed snippet. Progress streams over SSE —
you can close the dialog or the tab and the encode carries on.

The library lists every video with its status, and gives you copy-embed,
retry (for a failed encode) and archive.

**Open** on any row expands a card in the same view with a live preview player
and its settings:

- **Thumbnail** — scrub the preview to a moment and hit *Use current frame*, or
  upload your own image. Both go through ffmpeg server-side, so the result is a
  consistent jpg whatever you feed it. Frame capture is done on the server on
  purpose: the media has no CORS headers, so a canvas grab in the browser would
  be tainted and `toBlob` would throw.
- **Skin** — glass / edge / minimal / bar, applied live and saved per video.
- **Accent colour** — colour picker, hex field, or presets. Applied live.
- **Playback** — autoplay `off` / `muted` / `sound`, plus loop. Browsers only
  reliably allow the muted variant; `sound` attempts audio, and on rejection
  falls back to muted playback with a "Tap for sound" prompt rather than
  silently not playing.
- **Teaser** — a 6s silent loop for hover previews, generated during transcode
  (or from any moment via *Use current moment*). The player loads the mp4
  (~30 kB) with `preload="none"`, so it costs nothing until someone hovers. A
  GIF of the same moment (~200 kB) is generated too and offered as a copyable
  URL, for the places a GIF still beats video — email, some social embeds. It is
  never shipped to viewers.

The preview mounts the real player with `track: false`. Without that, opening a
video to change its thumbnail would log an impression and a play against its own
analytics.

**Posters are written to a new key every time** (`poster-<epoch>.jpg`). Media is
served `immutable` for a year, so overwriting `poster.jpg` in place would leave
browsers and the edge showing the old frame indefinitely.

Operational notes on the upload path:

- The file streams to disk; it is never buffered in memory, and nginx is
  configured with `proxy_request_buffering off` so it isn't spooled twice.
- **One encode at a time.** ffmpeg will use every core it is given, and the box
  is usually shared, so the queue has a single slot and `FFMPEG_THREADS` caps it
  further.
- A restart mid-encode requeues the job if the uploaded original is still on the
  volume, and marks it failed if it isn't. It never leaves a row spinning.
- The original is deleted once the encode succeeds and **kept when it fails**, so
  Retry doesn't need a re-upload.

## Publishing from the CLI (still supported)

```bash
node --env-file=.env bin/publish-video.js --input raw/tour.mov --slug product-tour --title "Product tour"
```

Encodes a faststart H.264 mp4 (moov atom at the front, so the browser can play
and seek before the file finishes downloading), grabs a poster frame, uploads
both to R2 with a one-year immutable cache header, and registers the video.
Re-running with the same slug is an upsert.

**HLS is deliberately not implemented.** A faststart mp4 behind Cloudflare seeks
fine over Range requests and needs no player library. When videos get long
enough that an adaptive ladder pays for itself, the ffmpeg call grows a
`-var_stream_map` and `attachSource()` in `player.js` grows an hls.js branch.
Nothing else changes.

## R2 setup

1. Create a bucket (e.g. `my-video-bucket`).
2. **Bind a custom domain** to it — `video.example.com`. Never use the
   `*.r2.dev` URL: it is rate limited and not cached at the edge, which throws
   away the entire reason for using R2.
3. Create an API token with Object Read & Write; put the values in `.env` as
   `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET`,
   and set `MEDIA_BASE_URL` to the custom domain.

Egress is free **only through Cloudflare**, which is what the custom domain
buys. Storage is ~$0.015/GB/month.

**Bucket CORS is only needed if you ship captions.** An R2 custom domain sends
no `Access-Control-Allow-Origin` by default, and it doesn't need to: plain mp4
playback is not a CORS-governed request. The player therefore sets
`crossorigin` on the `<video>` element *only* when the video has subtitle
tracks, because a cross-origin `<track>` does require it. Setting it
unconditionally is a trap — the browser then demands CORS on the video file
too, and playback stalls silently at 0:00 with a fired `play` event and
nothing in the error handler.

If you add captions, add a CORS policy to the bucket first:

```json
[{ "AllowedOrigins": ["https://example.com", "https://*.example.com"],
   "AllowedMethods": ["GET", "HEAD"],
   "AllowedHeaders": ["range"],
   "ExposeHeaders": ["content-length", "content-range"],
   "MaxAgeSeconds": 3600 }]
```

## Embedding

**Iframe** — works anywhere that already accepts a video URL, with zero code
changes on the consuming side:

```html
<iframe src="https://video-api.example.com/embed/product-tour"
        allowfullscreen style="border:0;width:100%;aspect-ratio:16/9"></iframe>
```

Query params override the saved settings: `autoplay=muted|sound|off` (`1` means
muted), `muted=1`, `loop=1|0`, `controls=0`, `start=12`, `color=2563eb`,
`skin=glass|edge|minimal|bar`, `teaser=0`.

**Script** — better for marketing pages (no nested document, inherits page
layout):

```html
<script async src="https://video-api.example.com/e.js" data-key="pk_live_..."></script>
<div data-cine data-video="product-tour"></div>
```

**React** — only if you need the imperative handle:

```jsx
import { CineHost } from '@cinehost/player/react';
import '@cinehost/player/player.css';

<CineHost slug="product-tour" endpoint="https://video-api.example.com" siteKey="pk_live_..." />
```

## API

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /v1/collect` | site key + origin | Beacons. `text/plain` on purpose — a CORS-simple content type, so `sendBeacon` during `pagehide` is never dropped by a preflight. |
| `GET /v1/videos/:slug` | public | Player config |
| `POST /v1/videos` | server key | Register/upsert a video |
| `POST /v1/identify` | server key | Attach a person to a visitor's whole history |
| `POST /v1/identify/client` | site key | In-player email gate. Unverified — a lead *hint*. |
| `GET /v1/videos/:slug/stats` | server key or Basic | Everything the dashboard draws |
| `GET /v1/videos/:slug/views` | server key or Basic | Individual viewer timelines |
| `GET /v1/summary` | server key or Basic | Cross-video roll-up |
| `GET /embed/:slug` | public | Iframe embed page |
| `GET /app` | Basic | Dashboard |

## Webhooks

Set `WEBHOOK_URL` and `WEBHOOK_SECRET`. Events: `view.started`,
`view.threshold` (at each of `WEBHOOK_THRESHOLDS`), `view.completed`,
`view.identified`. Each fires **once per view** — `thresholds_fired` is a
primary-key guard, so racing beacons can't double-fire.

Signature is HMAC-SHA256 over `"<timestamp>.<raw body>"`. Verify against the raw
body *before* parsing, and reject stale timestamps or a captured delivery stays
replayable forever:

```ruby
def create
  raw = request.raw_post
  timestamp = request.headers['X-CineHost-Timestamp'].to_i
  head :unauthorized and return if (Time.now.to_i - timestamp).abs > 300

  expected = OpenSSL::HMAC.hexdigest('SHA256', ENV['CINEHOST_WEBHOOK_SECRET'], "#{timestamp}.#{raw}")
  head :unauthorized and return unless ActiveSupport::SecurityUtils
    .secure_compare("sha256=#{expected}", request.headers['X-CineHost-Signature'].to_s)

  VideoEngagementJob.perform_later(JSON.parse(raw))
  head :ok
end
```

```python
import hmac, hashlib, time

def verify(raw: bytes, timestamp: str, signature: str, secret: str) -> bool:
    if abs(time.time() - int(timestamp)) > 300:
        return False
    expected = hmac.new(secret.encode(), f"{timestamp}.".encode() + raw, hashlib.sha256).hexdigest()
    return hmac.compare_digest(f"sha256={expected}", signature)
```

> ⚠️ **Bot mitigation eats webhooks.** These are server-to-server POSTs with a
> non-browser user agent — exactly the shape Cloudflare Bot Fight Mode
> Managed-Challenges by default, silently, with nothing in the origin logs. If
> deliveries stall, check your WAF/bot events *before* debugging this service.
> `webhook_deliveries` records every attempt and its status, and
> `WEBHOOK_USER_AGENT` lets you set something a bypass rule can match on.

## Deploying to a VPS

```bash
cp .env.example .env    # real keys; set COLLECTOR_DOMAIN for Caddy
docker compose --profile vps up -d --build
```

Caddy gets its own ACME certificate, so the box's existing wildcard cert (or
lack of one) is irrelevant. Postgres is bound to `127.0.0.1` only. Migrations
run on container boot — they're idempotent and take milliseconds.

Already run nginx on the box? Use `deploy/nginx-video-api.conf` instead of the
Caddy profile.

Video delivery never touches this box. The VPS only handles small JSON writes.

## Operational notes

- **Cache layering.** `/embed/:slug` is cached 60s and stamps `?v=<build mtime>`
  onto `player.js`/`player.css`, which are then cached hard. `/e.js` is embedded
  unversioned on other people's pages, so it is capped at 300s — that window is
  the worst case for shipping a tracker fix.
- **Scaling the stats query.** `GET /stats` unnests every view's array on each
  request. That is fine into the tens of thousands of views per video; past
  that, add a nightly roll-up table keyed on (video, day) rather than making
  the query cleverer. Beacon ingest sustains 400–500 req/s on a small VPS and
  does not degrade as the table grows — the stats query is what breaks first.
- **`country`** comes from `CF-IPCountry`, so it is only populated when the
  service sits behind Cloudflare (orange-clouded).
- **Archiving is not deleting, and deleting is not retracting.** Archive hides a
  video and stops embeds resolving; the R2 objects stay. `DELETE ?purge=1` also
  removes the objects — but media is served `max-age=31536000, immutable`, so
  Cloudflare's edge keeps serving a cached copy until it is purged. Set
  `CF_ZONE_ID` + `CF_PURGE_TOKEN` to make that purge happen; without them the
  API response says `cache_purged: false` and why, rather than implying the file
  is gone when it is still being served.
- **Retention vs engagement.** Engagement is never below retention, so the chart
  draws engagement first and retention over it; drawn the other way the two
  lines coincide wherever nobody rewatched and the chart looks like it has one
  series.

## FAQ

### Is this a drop-in Wistia replacement?
For hosting, embedding, engagement analytics and webhooks, yes. For adaptive
bitrate streaming, live video, A/B testing and built-in CRM integrations, no.

### Do I need Cloudflare?
For R2 you need a Cloudflare account, and you should bind a custom domain to the
bucket — that is what makes egress free and cached. The collector itself runs
anywhere. You can also run fully local with `MEDIA_LOCAL_DIR` and no R2 at all.

### How much does it cost to run?
R2 storage is ~$0.015/GB/month with free egress through Cloudflare. The collector
is a small Node process and a Postgres database — a $5–10/month VPS is plenty for
hundreds of thousands of views.

### Does it need cookies or a consent banner?
The tracker uses `localStorage` for a visitor id and `sessionStorage` for a
session id — no cookies, no third-party trackers, no fingerprinting. Whether you
need consent still depends on your jurisdiction and what you do with the data;
identifying viewers by email certainly changes the answer.

### Can I self-host without Docker?
Yes. It's a Node 20 process and a Postgres database. Docker Compose is provided
for convenience, not as a requirement.

### How large can videos be?
`MAX_UPLOAD_BYTES` defaults to 5 GB. Duration is capped by `MAX_DURATION_SEC`
(6 hours), which bounds the per-second array.

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Security
reports: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
