-- LUMI AI — the server's own state, out of JSON files and into Postgres
--
-- Everything the WhatsApp/app brain remembers lived in ~15 flat JSON files on
-- the Fly.io /data volume: user_memory.json, profiles.json, conversations.json,
-- reminders.json, agents.json, known_places.json, travel_prefs.json,
-- sessions.json. No locking, no transactions, no backups, one volume, one
-- machine. A restart on a new volume is a user with amnesia.
--
-- The unified key is "userKey" — what app_auth resolves a caller to: the linked
-- WhatsApp number when there is one, otherwise the Supabase auth user id. It is
-- the same key the whole server already passes around, so nothing has to learn
-- a new identity. lumi_identities maps it back to both, which is what makes a
-- row reachable from either channel.
--
-- Two things deliberately do NOT move here:
--   * pending_mirror.json — the retry queue for writes that failed BECAUSE
--     Supabase was unreachable. A queue for "the database is down" cannot live
--     in the database.
--   * the encrypted-at-rest handling in secure_store — Postgres storage is
--     encrypted by Supabase; the file path keeps its own key for the mirror.
--
-- RLS is on everywhere. The server writes with the service role (which bypasses
-- it); the policies exist so that if these tables are ever read with a user
-- token — from the app, or a future web client — a user can only ever see
-- their own rows. There is no anon access to any of it.

create extension if not exists vector;

-- ─── identity ───────────────────────────────────────────────────────────────
create table if not exists public.lumi_identities (
  "userKey"   text primary key,
  "userId"    uuid references auth.users (id) on delete cascade,
  "phone"     text,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);
create index if not exists lumi_identities_user_idx on public.lumi_identities ("userId");
create index if not exists lumi_identities_phone_idx on public.lumi_identities ("phone");

-- ─── distilled memory (the RAG store) ───────────────────────────────────────
-- Only distilled facts, never raw transcript: "always studies after 21:00",
-- "prefers coding in the morning". The prompt used to carry the whole JSON blob
-- every turn, which grows without bound and is why a long-standing user costs
-- more per message than a new one. With an embedding per fact the turn can
-- retrieve the handful that matter instead.
--
-- `embedding` is intentionally dimensionless: EMBED_MODEL is not fixed yet
-- (Qwen3-Embedding-8B is 4096-wide, and pgvector's ANN indexes cap at 2000
-- dimensions). Exact search over a few hundred rows per user is fast enough to
-- ship; add `vector(N)` plus an hnsw index in a later migration once the model
-- is pinned, and never merge two memories below cosine 0.912.
create table if not exists public.lumi_memories (
  "id"        uuid primary key default gen_random_uuid(),
  "userKey"   text not null,
  "kind"      text not null check ("kind" in ('behavior','preference','routine','contact','task')),
  "content"   text not null,
  "meta"      jsonb not null default '{}'::jsonb,
  "embedding" vector,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);
create index if not exists lumi_memories_user_idx on public.lumi_memories ("userKey", "kind");
create unique index if not exists lumi_memories_unique on public.lumi_memories ("userKey", "kind", md5("content"));

-- ─── the server's profile of the user ───────────────────────────────────────
-- public.user_profiles is the APP's row, written by the client. This is the
-- server's, written by save_profile over WhatsApp and by the onboarding
-- endpoint. They overlap on purpose and database_service reads this one first;
-- the merge into a single row is a later migration, once every writer is here.
create table if not exists public.lumi_profiles (
  "userKey"                text primary key,
  "name"                   text,
  "homeAddress"            text,
  "workAddress"            text,
  "transportType"          text,
  "morningRoutineMinutes"  integer,
  "routineVerified"        boolean,
  "hobbies"                text,
  "routinesNotes"          text,
  "mbtiType"               text,
  "onboarded"              boolean not null default false,
  "extra"                  jsonb not null default '{}'::jsonb,
  "createdAt"              timestamptz not null default now(),
  "updatedAt"              timestamptz not null default now()
);

-- ─── conversation history (short, rolling) ──────────────────────────────────
create table if not exists public.lumi_conversations (
  "id"        bigserial primary key,
  "userKey"   text not null,
  "role"      text not null check ("role" in ('user','assistant')),
  "text"      text not null,
  "channel"   text,
  "createdAt" timestamptz not null default now()
);
create index if not exists lumi_conversations_user_idx
  on public.lumi_conversations ("userKey", "createdAt" desc);

-- ─── reminders the poller fires ─────────────────────────────────────────────
create table if not exists public.lumi_reminders (
  "id"        text primary key,
  "userKey"   text not null,
  "text"      text not null,
  "fireAt"    timestamptz not null,
  "kind"      text,
  "taskId"    text,
  "payload"   jsonb not null default '{}'::jsonb,
  "sent"      boolean not null default false,
  "createdAt" timestamptz not null default now()
);
-- The poller's only question: what is due and unsent?
create index if not exists lumi_reminders_due_idx
  on public.lumi_reminders ("fireAt") where "sent" = false;

-- ─── user-created agents ────────────────────────────────────────────────────
create table if not exists public.lumi_agents (
  "id"        text primary key,
  "userKey"   text not null,
  "name"      text not null,
  "emoji"     text,
  "soul"      text,
  "enabled"   boolean not null default true,
  "days"      jsonb not null default '[]'::jsonb,
  "time"      text,
  "config"    jsonb not null default '{}'::jsonb,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);
create index if not exists lumi_agents_user_idx on public.lumi_agents ("userKey");

-- ─── places she actually goes, and how she gets there ───────────────────────
create table if not exists public.lumi_known_places (
  "id"        uuid primary key default gen_random_uuid(),
  "userKey"   text not null,
  "name"      text not null,
  "address"   text,
  "lat"       double precision,
  "lng"       double precision,
  "uses"      integer not null default 1,
  "lastUsed"  timestamptz not null default now()
);
create unique index if not exists lumi_known_places_unique
  on public.lumi_known_places ("userKey", lower("name"));

create table if not exists public.lumi_travel_prefs (
  "userKey"   text not null,
  "route"     text not null,          -- normalised "origin→destination"
  "mode"      text not null,
  "count"     integer not null default 1,
  "updatedAt" timestamptz not null default now(),
  primary key ("userKey", "route")
);

-- ─── provenance: which turn created which task ──────────────────────────────
create table if not exists public.lumi_sessions (
  "id"        uuid primary key default gen_random_uuid(),
  "userKey"   text not null,
  "kind"      text,
  "payload"   jsonb not null default '{}'::jsonb,
  "createdAt" timestamptz not null default now()
);
create index if not exists lumi_sessions_user_idx
  on public.lumi_sessions ("userKey", "createdAt" desc);

-- ─── RLS ────────────────────────────────────────────────────────────────────
-- Owner-only reads for anything reached with a user token; the server uses the
-- service role and bypasses these. A user is the owner of a row when their auth
-- id maps to that row's userKey in lumi_identities.
do $$
declare t text;
begin
  foreach t in array array['lumi_identities','lumi_memories','lumi_profiles',
                           'lumi_conversations','lumi_reminders','lumi_agents',
                           'lumi_known_places','lumi_travel_prefs','lumi_sessions']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "own rows" on public.%I', t);
  end loop;
end $$;

create policy "own rows" on public.lumi_identities
  for all using ("userId" = auth.uid()) with check ("userId" = auth.uid());

do $$
declare t text;
begin
  foreach t in array array['lumi_memories','lumi_profiles','lumi_conversations',
                           'lumi_reminders','lumi_agents','lumi_known_places',
                           'lumi_travel_prefs','lumi_sessions']
  loop
    execute format($f$
      create policy "own rows" on public.%I
        for all using (exists (
          select 1 from public.lumi_identities i
          where i."userKey" = %I."userKey" and i."userId" = auth.uid()))
        with check (exists (
          select 1 from public.lumi_identities i
          where i."userKey" = %I."userKey" and i."userId" = auth.uid()))
    $f$, t, t, t);
  end loop;
end $$;

-- ─── semantic recall ────────────────────────────────────────────────────────
-- The RAG entry point: the N most similar memories for one user. Called with
-- the service role, so it takes the userKey explicitly rather than inferring an
-- identity it would not have.
create or replace function public.lumi_match_memories(
  p_user_key text,
  p_embedding vector,
  p_limit int default 8,
  p_min_similarity float default 0.2
)
returns table ("id" uuid, "kind" text, "content" text, "similarity" float)
language sql stable
as $$
  select m."id", m."kind", m."content",
         1 - (m."embedding" <=> p_embedding) as "similarity"
  from public.lumi_memories m
  where m."userKey" = p_user_key
    and m."embedding" is not null
    and 1 - (m."embedding" <=> p_embedding) >= p_min_similarity
  order by m."embedding" <=> p_embedding
  limit p_limit;
$$;
