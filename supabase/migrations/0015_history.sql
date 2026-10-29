-- 0015_history — "how many times did I work out this week?" (Feature 2, 20.10)
--
-- The tasks table already says what was done. It forgets what HAPPENED to a
-- task on the way: it keeps only the LAST move (movedFromDate), so "moved three
-- times" is unknowable, and it never sees a focus session or a real trip time.
-- This is that log, one event per row, collected ONLY with her opt-in
-- (profile.historyOptIn) and kept 90 days (server/history_store.prune).
--
-- `text` and `data` are ciphertext (field_crypto, per-person key), like every
-- other personal lumi_* column. `embedding` is the task text's vector, for the
-- open questions ("how often did I work on the thesis?") — counting itself is
-- done in code (server/history_stats.py), never by the model.
--
-- Service role only: RLS on, nothing granted to anon/authenticated (0013).

create table if not exists public.lumi_history (
  "id"         uuid primary key default gen_random_uuid(),
  "userKey"    text not null,
  "kind"       text not null check ("kind" in ('moved', 'completed', 'missed', 'trip', 'study')),
  "taskId"     text,
  "category"   text,
  "day"        date not null,
  "at"         timestamptz not null default now(),
  "minutes"    integer,
  "text"       text,
  "data"       jsonb,
  "embedding"  vector,
  "dedupKey"   text not null,
  unique ("userKey", "dedupKey")
);

create index if not exists lumi_history_user_day on public.lumi_history ("userKey", "day");

alter table public.lumi_history enable row level security;
revoke all on public.lumi_history from anon, authenticated;

-- The RAG entry point for history: her nearest events since a day.
create or replace function public.lumi_match_history(
  p_user_key text,
  p_embedding vector,
  p_since date,
  p_limit int default 40,
  p_min_similarity float default 0.35
)
returns table ("id" uuid, "kind" text, "taskId" text, "category" text, "day" date,
               "minutes" integer, "text" text, "similarity" float)
language sql stable
as $$
  select h."id", h."kind", h."taskId", h."category", h."day", h."minutes", h."text",
         1 - (h."embedding" <=> p_embedding) as "similarity"
  from public.lumi_history h
  where h."userKey" = p_user_key
    and h."day" >= p_since
    and h."embedding" is not null
    and 1 - (h."embedding" <=> p_embedding) >= p_min_similarity
  order by h."embedding" <=> p_embedding
  limit p_limit;
$$;

revoke all on function public.lumi_match_history(text, vector, date, integer, double precision)
  from public, anon, authenticated;
