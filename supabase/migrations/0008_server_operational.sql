-- LUMI AI — the last of the JSON files: server records, spend, bug reports
--
-- Migration 0007 moved the user's own state. This moves what is left on the
-- /data volume so the volume can actually be retired rather than merely
-- shrunk: the server's small records (push token, language, MBTI signals,
-- handoff tokens), the token-spend ledger, the bug reports filed over WhatsApp,
-- and the LLM judge's rewrite log.
--
-- lumi_user_records is the one with a history. It used to be a Postgres that
-- was never provisioned: DATABASE_URL was never set as a Fly secret, so every
-- call raised "Connection refused" into a bare except and the server carried
-- on with a JSON file. The casualty was not log noise — set_push_token_by_phone
-- failed too, so the app's Expo push token had nowhere to land and the reminder
-- loop could never reach the phone. That column is the reason this table exists.
--
-- Still deliberately NOT here, and not an oversight:
--   * pending_mirror.json — the retry queue for writes that failed because
--     Supabase was unreachable.
--   * active_session.json — the 45-minute conversational focus. It is written
--     on nearly every turn and expires faster than it could ever be useful to
--     recover, so shadowing it would be the highest write volume in the system
--     for the least durable data in it.

create table if not exists public.lumi_user_records (
  "userKey"     text primary key,
  "userId"      uuid references auth.users (id) on delete cascade,
  "phone"       text,
  "name"        text,
  "language"    text,
  "mbtiType"    text,
  "pushToken"   text,
  "signals"     jsonb not null default '[]'::jsonb,
  "extra"       jsonb not null default '{}'::jsonb,
  "createdAt"   timestamptz not null default now(),
  "updatedAt"   timestamptz not null default now()
);
create index if not exists lumi_user_records_phone_idx on public.lumi_user_records ("phone");

-- Spend, per day per source. The Nebius console is the invoice truth; this is
-- what lets us see WHICH path spent it — the reason we know one stray endpoint
-- was burning $91/month.
create table if not exists public.lumi_llm_usage (
  "day"        date not null,
  "source"     text not null,
  "tokensIn"   bigint not null default 0,
  "tokensOut"  bigint not null default 0,
  "calls"      integer not null default 0,
  "updatedAt"  timestamptz not null default now(),
  primary key ("day", "source")
);

create table if not exists public.lumi_bug_reports (
  "id"         text primary key,
  "userKey"    text,
  "text"       text not null,
  "status"     text not null default 'open',
  "fields"     jsonb not null default '{}'::jsonb,
  "createdAt"  timestamptz not null default now(),
  "updatedAt"  timestamptz not null default now()
);
create index if not exists lumi_bug_reports_status_idx on public.lumi_bug_reports ("status");

-- The judge rewrites the system prompt every ~10 replies with no human review.
-- Keeping the log in a table is what makes "when did the prompt change, and to
-- what" answerable — today it is a file on a volume nobody reads.
create table if not exists public.lumi_judge_log (
  "id"         bigserial primary key,
  "userKey"    text,
  "verdict"    jsonb not null default '{}'::jsonb,
  "createdAt"  timestamptz not null default now()
);

-- RLS: the server uses the service role and bypasses these. lumi_llm_usage and
-- lumi_judge_log carry no user rows and are simply closed to user tokens.
alter table public.lumi_user_records enable row level security;
alter table public.lumi_llm_usage enable row level security;
alter table public.lumi_bug_reports enable row level security;
alter table public.lumi_judge_log enable row level security;

drop policy if exists "own rows" on public.lumi_user_records;
create policy "own rows" on public.lumi_user_records
  for all using ("userId" = auth.uid()) with check ("userId" = auth.uid());

drop policy if exists "own rows" on public.lumi_bug_reports;
create policy "own rows" on public.lumi_bug_reports
  for all using (exists (
    select 1 from public.lumi_identities i
    where i."userKey" = public.lumi_bug_reports."userKey" and i."userId" = auth.uid()));
