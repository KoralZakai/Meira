-- MEIRA — the early-access waitlist behind site/index.html
--
-- The marketing page posts one row per email straight to PostgREST with the
-- public anon key (the same key every APK already ships). That is only safe
-- because of what anon may NOT do here: it can insert an email and a source
-- tag, and nothing else. No select, no update, no delete — a visitor cannot
-- read the list back, and nobody can page through other people's addresses
-- from a browser console. Read it from the Supabase dashboard or with the
-- service role.
--
-- Until this is applied the site's form answers 404 and says so in words
-- ("sign-up isn't open yet") — never a quiet "thanks".
--
-- Duplicates: the unique index on lower(email) makes a second sign-up a 409,
-- which the page reports as "You're already on the list ✓".

create table if not exists public.waitlist (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  source      text,
  created_at  timestamptz not null default now(),
  constraint waitlist_email_shape check (
    length(email) <= 254 and email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]{2,}$'
  ),
  constraint waitlist_source_short check (source is null or length(source) <= 32)
);

create unique index if not exists waitlist_email_lower_key on public.waitlist (lower(email));

alter table public.waitlist enable row level security;

-- Supabase grants ALL on new public tables to anon/authenticated by default.
-- Take it back, then give exactly the two insertable columns.
revoke all on public.waitlist from anon, authenticated;
grant insert (email, source) on public.waitlist to anon, authenticated;

drop policy if exists waitlist_insert_only on public.waitlist;
create policy waitlist_insert_only on public.waitlist
  for insert to anon, authenticated
  with check (true);
