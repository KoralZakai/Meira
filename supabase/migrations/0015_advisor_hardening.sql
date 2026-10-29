-- 0015 — Supabase security advisor, 28.10.2026.
--
-- 1. g_is_member / g_shares_match: SECURITY DEFINER RLS helpers of the g_*
--    tables (not Meira's — another app on this project). Anonymous callers
--    could run them through /rest/v1/rpc. They stay DEFINER: they read
--    g_match_members from inside g_match_members' own policy, and as INVOKER
--    that recursion is an error. Signed-in users keep EXECUTE because their
--    policies call these functions as that role.
-- 2. lumi_match_memories / lumi_match_history: a role-mutable search_path.
--    Pinned; `vector` and its <=> operator live in public.

do $$
begin
  if to_regprocedure('public.g_is_member(uuid)') is not null then
    revoke execute on function public.g_is_member(uuid) from public, anon;
    grant execute on function public.g_is_member(uuid) to authenticated, service_role;
  end if;
  if to_regprocedure('public.g_shares_match(uuid)') is not null then
    revoke execute on function public.g_shares_match(uuid) from public, anon;
    grant execute on function public.g_shares_match(uuid) to authenticated, service_role;
  end if;
  if to_regprocedure('public.lumi_match_memories(text, vector, integer, double precision)') is not null then
    alter function public.lumi_match_memories(text, vector, integer, double precision)
      set search_path = public, pg_temp;
  end if;
  if to_regprocedure('public.lumi_match_history(text, vector, date, integer, double precision)') is not null then
    alter function public.lumi_match_history(text, vector, date, integer, double precision)
      set search_path = public, pg_temp;
  end if;
end $$;
