-- 0016 — follow-up to 0015.
--
-- The g_* policies were granted TO public and call g_is_member / g_shares_match.
-- After 0015 anon may not execute those, so an anonymous SELECT on a g_* table
-- would fail with "permission denied for function" instead of returning no rows.
-- Anon could never see a row here anyway (both helpers test auth.uid(), which is
-- null for anon), so scoping the policies to authenticated keeps the old result
-- for both roles: anon gets no matching policy → no rows, signed-in users as before.

do $$
declare p record;
begin
  for p in
    select tablename, policyname from pg_policies
    where schemaname = 'public' and tablename like 'g\_%'
      and roles = '{public}'
      and (coalesce(qual, '') ~ 'g_is_member|g_shares_match'
           or coalesce(with_check, '') ~ 'g_is_member|g_shares_match')
  loop
    execute format('alter policy %I on public.%I to authenticated', p.policyname, p.tablename);
  end loop;
end $$;
