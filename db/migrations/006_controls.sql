-- Whether the embed shows player chrome at all. `false` gives a bare video,
-- for ambient / background autoplay embeds.
alter table videos add column if not exists controls boolean not null default true;
