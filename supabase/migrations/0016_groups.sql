-- 0016_groups — "find time together" (Feature 3, 20.10)
--
-- A group of people looking for one slot (a party, a meeting). The organizer
-- proposes slots; each member's answer is either MANUAL (stored here) or AUTO —
-- free/busy computed from that member's own tasks at read time
-- (server/group_time.py), never stored, never shown as what the busy thing is.
--
--   lumi_groups          one per search; "userKey" = the organizer (so the
--                        account deletion of the organizer takes the group)
--   lumi_group_members   who was invited. memberKey is set only when the
--                        contact's phone is VERIFIABLY linked to a Meira user
--                        (phone_links) — the organizer is never told which.
--                        tokenHash: the single-use link for people not on Meira
--   lumi_group_slots     the candidate times
--   lumi_group_answers   manual yes/no per member × slot (beats auto)
--
-- Personal columns (title, displayName) are ciphertext (field_crypto, the
-- organizer's key). Service role only.

create table if not exists public.lumi_groups (
  "id"          uuid primary key default gen_random_uuid(),
  "userKey"     text not null,
  "title"       text,
  "minutes"     integer not null default 60 check ("minutes" between 15 and 1440),
  "status"      text not null default 'open' check ("status" in ('open', 'locked', 'cancelled')),
  "lockedSlot"  uuid,
  "createdAt"   timestamptz not null default now()
);
create index if not exists lumi_groups_owner on public.lumi_groups ("userKey");

create table if not exists public.lumi_group_members (
  "id"           uuid primary key default gen_random_uuid(),
  "groupId"      uuid not null references public.lumi_groups("id") on delete cascade,
  "userKey"      text not null,
  "memberKey"    text,
  "displayName"  text,
  "role"         text not null default 'member' check ("role" in ('owner', 'member')),
  "status"       text not null default 'invited' check ("status" in ('invited', 'joined', 'declined')),
  "tokenHash"    text unique,
  "tokenExpires" timestamptz,
  "invitedAt"    timestamptz not null default now(),
  "remindedAt"   timestamptz
);
create index if not exists lumi_group_members_group on public.lumi_group_members ("groupId");
create index if not exists lumi_group_members_member on public.lumi_group_members ("memberKey");

create table if not exists public.lumi_group_slots (
  "id"       uuid primary key default gen_random_uuid(),
  "groupId"  uuid not null references public.lumi_groups("id") on delete cascade,
  "day"      date not null,
  "start"    text not null check ("start" ~ '^[0-2][0-9]:[0-5][0-9]$')
);
create index if not exists lumi_group_slots_group on public.lumi_group_slots ("groupId");

create table if not exists public.lumi_group_answers (
  "memberId"  uuid not null references public.lumi_group_members("id") on delete cascade,
  "slotId"    uuid not null references public.lumi_group_slots("id") on delete cascade,
  "groupId"   uuid not null references public.lumi_groups("id") on delete cascade,
  "value"     text not null check ("value" in ('yes', 'no')),
  "updatedAt" timestamptz not null default now(),
  primary key ("memberId", "slotId")
);
create index if not exists lumi_group_answers_group on public.lumi_group_answers ("groupId");

do $$
declare t text;
begin
  foreach t in array array['lumi_groups','lumi_group_members','lumi_group_slots','lumi_group_answers']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
