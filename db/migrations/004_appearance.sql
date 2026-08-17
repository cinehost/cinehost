-- Per-video player appearance. `skin` already exists (003); this adds the
-- accent colour used for the progress bar, big play button and menu ticks.
alter table videos add column if not exists accent text;
