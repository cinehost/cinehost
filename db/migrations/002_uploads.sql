-- Browser uploads + server-side transcode.
-- Existing rows were published by the CLI and are already playable, so the
-- default has to be 'ready' or they'd all disappear from the embed endpoint.

alter table videos add column if not exists status text not null default 'ready';
alter table videos add column if not exists progress integer not null default 100;
alter table videos add column if not exists error text;
-- Absolute path of the uploaded original while it is being processed. Cleared
-- once the encode succeeds; kept on failure so a retry doesn't need a re-upload.
alter table videos add column if not exists original_path text;
alter table videos add column if not exists original_name text;
alter table videos add column if not exists source_bytes bigint;

create index if not exists videos_status_idx on videos (status) where status <> 'ready';
