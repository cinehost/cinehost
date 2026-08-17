-- Playback defaults per video, plus the teaser clip used for hover previews.
--   autoplay: 'off' | 'muted' | 'sound'
--   teaser:   { mp4, gif, start, duration }
alter table videos add column if not exists autoplay text not null default 'off';
alter table videos add column if not exists loop boolean not null default false;
alter table videos add column if not exists teaser jsonb not null default '{}'::jsonb;
