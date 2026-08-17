# Contributing to CineHost

Thanks for helping out. This is a small, deliberately dependency-light codebase —
the bar for adding a package is high, and the bar for adding a build step is
higher.

## Getting set up

Requirements: **Node 20+**, **Postgres 15+**, **ffmpeg**.

```bash
git clone https://github.com/cinehost/cinehost.git
cd cinehost
cp .env.example .env
npm install
npm run build      # player bundles + dashboard css
npm run migrate
npm test
npm run dev        # collector on :8080
```

You do not need Cloudflare R2 to develop. Set `MEDIA_LOCAL_DIR` and publish with
`--local`; encodes are written to disk and served from `/media/...`:

```bash
echo "MEDIA_LOCAL_DIR=$(pwd)/media-out" >> .env
node --env-file=.env bin/publish-video.js --input raw/clip.mov --slug dev-clip --local
```

## Repository layout

| Path | What lives here |
|---|---|
| `packages/player` | The player and tracker. Ships to browsers — no dependencies, ever. |
| `packages/collector` | Hono API, transcode queue, stats, dashboard. |
| `db/migrations` | Numbered plain SQL. Never edit a migration that has shipped; add a new one. |
| `bin/` | One-shot CLI scripts. |

## Conventions

- **No runtime dependencies in the player.** It is embedded on other people's
  pages; every kilobyte is theirs, not ours. Utility helpers go inline.
- **Migrations are append-only.** `007_thing.sql`, never an edit to `003`.
  Everything is `create table if not exists` / `add column if not exists` so a
  re-run is a no-op.
- **Comment the *why*, not the *what*.** Several comments in this codebase exist
  because a behaviour cost hours to find (the `crossorigin` stall, the Postgres 18
  volume path, `text/plain` beacons). Those are the valuable ones. Don't narrate
  syntax.
- **No polling where an event will do.** Transcode progress is SSE for a reason.
- Match the surrounding style. There is no formatter config; the code is
  consistent, so read a neighbouring file.

## Tests

```bash
npm test            # node --test, no framework
```

Anything touching `ranges.js` — the per-second accumulation that every metric is
derived from — **must** come with tests. It is the one place a subtle bug
silently corrupts historical data rather than throwing.

Test the arithmetic directly rather than through HTTP where you can. `node --test`
only; no test framework dependency.

## Pull requests

1. Branch off `main`.
2. Keep it focused — one concern per PR.
3. `npm test` and `npm run build` must both pass.
4. Describe the behaviour change and *why*. If you found a platform quirk, put it
   in a code comment as well as the PR body — the PR gets forgotten, the comment
   doesn't.

Breaking changes to the beacon payload, the webhook payload, or the database
schema need a note in the PR description explaining the upgrade path for existing
installs.

## Reporting bugs

Open an issue with:

- what you expected and what happened
- the CineHost version or commit
- Node, Postgres and ffmpeg versions
- for player bugs, the browser and whether it reproduces in the iframe embed
  (`/embed/:slug`) or only the script embed

For anything security-related, **do not open a public issue** — see
[SECURITY.md](SECURITY.md).
