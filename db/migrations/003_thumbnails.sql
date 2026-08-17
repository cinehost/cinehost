-- Scrub-bar thumbnail sprite, produced during transcode.
-- { url, interval, columns, rows, count, width, height }
alter table videos add column if not exists thumbnails jsonb not null default '{}'::jsonb;

-- Which player skin an embed uses when the URL doesn't say.
alter table videos add column if not exists skin text;
