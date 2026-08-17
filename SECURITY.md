# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub's
[private vulnerability reporting](https://github.com/cinehost/cinehost/security/advisories/new)
on this repository. You should get an acknowledgement within a few days.

Useful things to include: affected version or commit, a description of the
impact, and steps to reproduce.

## Scope

CineHost is self-hosted, so the deployment is yours. Findings in **this code**
are in scope — for example:

- authentication bypass on the server-key or site-key routes
- the dashboard's HTTP Basic gate being avoidable
- SQL injection, path traversal in the upload/transcode paths
- XSS in the dashboard or the embed page
- webhook signature forgery or replay
- one install's data being reachable from another origin

Out of scope: misconfiguration of *your* deployment (a public Postgres port, a
missing `ALLOWED_ORIGINS`, leaked R2 credentials).

## Things worth knowing when you deploy

These are design decisions, not bugs, and they affect how you configure it:

- **`INGEST_SITE_KEY` is public.** It ships in page source. It identifies an
  install; it does not authenticate anyone. Beacon writes are guarded by the
  origin allowlist, not by the key.
- **Analytics from the browser are attacker-controllable.** Anyone can post
  beacons for a valid slug from an allowed origin. Treat watch data as
  observational. If a business decision depends on "watched 75%", act on the
  **webhook**, not on a client-side claim.
- **`/v1/identify/client` is unverified by design.** It records an email a viewer
  typed into a gate. It is a lead hint, not a verified identity — the row records
  `identity_source = 'client'` so you can tell the two apart.
- **`SERVER_API_KEY` is a full-power credential.** It can read every view,
  register videos and identify people. Server-side only.
- **Set `ALLOWED_ORIGINS`.** It backs both the beacon origin check and the embed
  page's `frame-ancestors` CSP. `*` disables both.
- **Bind Postgres to localhost.** The provided `docker-compose.yml` publishes it
  on `127.0.0.1:5433` only.
- **Verify webhooks properly.** HMAC over the *raw* body, constant-time compare,
  and reject timestamps older than a few minutes — otherwise a captured delivery
  is replayable indefinitely.

## Supported versions

Pre-1.0. Fixes land on `main`; there are no backport branches yet.
