-- 0013 — identity lockdown (7.10 security audit)
--
-- THE HOLE. lumi_identities had `"own rows" for all ... with check ("userId" =
-- auth.uid())`: any signed-in user could INSERT {userKey: <someone's phone>,
-- userId: <me>} and every lumi_* table's "own rows" policy would then hand them
-- that person's conversations, known places, profile, memories and reminders.
--
-- THE FIX. The app never touches a lumi_* table (grep src/ for "lumi_": none).
-- They are the SERVER's state, written and read with the service role, which
-- bypasses grants and RLS. So users get no privilege on them at all — not
-- read, not write — and the RPC that reads memories by an explicit userKey is
-- the server's alone too. RLS stays on as the second wall.
--
-- Safe to run twice.

do $$
declare t text;
begin
  foreach t in array array[
    'lumi_identities','lumi_memories','lumi_profiles','lumi_conversations',
    'lumi_reminders','lumi_agents','lumi_known_places','lumi_travel_prefs',
    'lumi_sessions','lumi_user_records','lumi_llm_usage','lumi_bug_reports',
    'lumi_judge_log']
  loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I enable row level security', t);
      execute format('revoke all on public.%I from anon, authenticated', t);
    end if;
  end loop;
end $$;

-- The write-anything policy that made the hole; replaced by read-own only
-- (inert while the grant above is revoked, correct if one is ever re-added).
drop policy if exists "own rows" on public.lumi_identities;
drop policy if exists "own select" on public.lumi_identities;
create policy "own select" on public.lumi_identities
  for select using ("userId" = auth.uid());

-- Takes the userKey as an argument: never callable by a user.
do $$
begin
  if to_regprocedure('public.lumi_match_memories(text,vector,integer,double precision)') is not null then
    revoke all on function public.lumi_match_memories(text, vector, integer, double precision)
      from public, anon, authenticated;
  end if;
end $$;

-- Review after running: identities whose userKey is a phone number. Each one
-- should belong to the person who owns that number (the server's verified
-- links are at GET /admin/links). Anything unexpected here was inserted by a user.
--   select "userKey", "userId", "createdAt" from public.lumi_identities
--   where "userKey" ~ '^[0-9]{9,15}$' order by "createdAt" desc;
