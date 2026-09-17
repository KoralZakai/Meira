-- LUMI AI — make re-running the backfill safe
--
-- The backfill claimed to be idempotent and was not. Eleven of the thirteen
-- tables upsert on a natural key and re-ran cleanly; lumi_conversations
-- (bigserial) and lumi_sessions (uuid) have surrogate primary keys and nothing
-- to conflict on, so a second run duplicated every row: 18 turns became 36 and
-- 2 sessions became 4. Caught by re-running and counting, which is the only way
-- this kind of claim is ever actually tested.
--
-- The fix is a nullable "dedupeKey" with a UNIQUE index. Null values do not
-- collide in a Postgres unique index, which is exactly the behaviour wanted
-- here, because the two writers have opposite needs:
--
--   the BACKFILL sets it, so re-running upserts over its own rows;
--   the LIVE append leaves it null, because a person may genuinely say the
--     same sentence twice and both turns are real.
--
-- The de-duplication below is safe at this moment because both tables contain
-- only backfilled rows. It keeps the earliest of each group.

alter table public.lumi_conversations add column if not exists "dedupeKey" text;
alter table public.lumi_sessions      add column if not exists "dedupeKey" text;

-- Keep the first row of each duplicate group, drop the rest.
delete from public.lumi_conversations c
where c."id" > (
  select min(c2."id") from public.lumi_conversations c2
  where c2."userKey" = c."userKey" and c2."role" = c."role" and c2."text" = c."text"
);

delete from public.lumi_sessions s
where s."createdAt" > (
  select min(s2."createdAt") from public.lumi_sessions s2
  where s2."userKey" = s."userKey" and s2."kind" is not distinct from s."kind"
);

create unique index if not exists lumi_conversations_dedupe
  on public.lumi_conversations ("dedupeKey");
create unique index if not exists lumi_sessions_dedupe
  on public.lumi_sessions ("dedupeKey");
