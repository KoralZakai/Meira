-- "She unticked it" has to be a fact the database can hold.
--
-- `uncompletedAt` is stamped locally the moment the user removes a tick. It
-- exists so that anything reconciling two versions of a task can tell a row
-- that was NEVER done from one she has just corrected — without it, every
-- "completion wins" rule silently re-ticks work she said was not finished.
--
-- The column was missing, so every sync logged
--
--   [supabaseRepo] tasks.uncompletedAt does not exist in this database
--
-- and upsertTolerant dropped the field to save the rest of the row. The stamp
-- therefore never left the device: the correction was real on one phone and
-- invisible everywhere else, and any other writer (the WhatsApp server, a
-- second device) could re-assert `complete` with nothing to contradict it.
--
-- Nullable with no default and no backfill on purpose: NULL means "never
-- corrected", which is the truth for every existing row. Inventing a timestamp
-- would claim she had unticked things she never touched.
alter table public.tasks
  add column if not exists "uncompletedAt" bigint;

-- Read on every cloud→local reconciliation for rows the cloud calls complete.
create index if not exists tasks_uncompleted_idx
  on public.tasks ("userId", "uncompletedAt")
  where "uncompletedAt" is not null;
