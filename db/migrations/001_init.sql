-- Core schema. One row per video, one row per view, one packed per-second
-- play-count array per view. Everything the dashboard shows is an aggregation
-- over view_plays.counts.

create table if not exists videos (
  id           bigserial primary key,
  slug         text not null unique,
  title        text not null default '',
  duration_sec integer not null default 0,
  aspect_ratio text not null default '16/9',
  poster_url   text,
  -- [{ "src": "...", "type": "video/mp4", "label": "1080p", "width": 1920 }]
  sources      jsonb not null default '[]'::jsonb,
  -- [{ "src": "...", "srclang": "en", "label": "English", "default": true }]
  captions     jsonb not null default '[]'::jsonb,
  -- [{ "start": 0, "title": "Intro" }]
  chapters     jsonb not null default '[]'::jsonb,
  metadata     jsonb not null default '{}'::jsonb,
  archived_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- A view row is created the moment a player becomes visible, played or not.
-- play_rate = count(played) / count(*), so impressions must be rows too.
create table if not exists views (
  id           uuid primary key,
  video_id     bigint not null references videos(id) on delete cascade,
  visitor_id   text not null,
  session_id   text not null,
  played       boolean not null default false,
  completed    boolean not null default false,
  watched_sec  integer not null default 0,
  max_pct      real not null default 0,
  page_url     text,
  referrer     text,
  user_agent   text,
  device       text,
  country      text,
  -- identity, filled in later by /v1/identify or a client-side gate
  email        text,
  lead_id      text,
  external_id  text,
  identified_at timestamptz,
  identity_source text,
  traits       jsonb not null default '{}'::jsonb,
  started_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists views_video_started_idx on views (video_id, started_at desc);
create index if not exists views_visitor_idx on views (visitor_id);
create index if not exists views_email_idx on views (email) where email is not null;
create index if not exists views_played_idx on views (video_id) where played;

-- counts[i] = how many times second (i-1) was played in this view.
-- >1 means the viewer rewatched that second, which is what makes the
-- engagement graph exceed 100% the way Wistia's does.
create table if not exists view_plays (
  view_id uuid primary key references views(id) on delete cascade,
  counts  smallint[] not null default '{}'
);

create table if not exists events (
  id      bigserial primary key,
  view_id uuid not null references views(id) on delete cascade,
  kind    text not null,
  at_sec  real,
  meta    jsonb not null default '{}'::jsonb,
  ts      timestamptz not null default now()
);

create index if not exists events_view_idx on events (view_id, ts);
create index if not exists events_kind_idx on events (kind, ts desc);

-- Idempotency guard so a threshold webhook fires exactly once per view.
create table if not exists thresholds_fired (
  view_id uuid not null references views(id) on delete cascade,
  pct     integer not null,
  fired_at timestamptz not null default now(),
  primary key (view_id, pct)
);

create table if not exists webhook_deliveries (
  id          bigserial primary key,
  event       text not null,
  payload     jsonb not null,
  status_code integer,
  error       text,
  attempts    integer not null default 0,
  delivered_at timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists webhook_deliveries_pending_idx
  on webhook_deliveries (created_at desc) where delivered_at is null;
