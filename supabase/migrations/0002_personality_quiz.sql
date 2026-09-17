-- ────────────────────────────────────────────────────────────────────────────
-- 0002_personality_quiz.sql
-- Cloud home for the 30-question MBTI quiz (see src/constants/mbti.ts).
-- One row per user, keyed on auth.uid(). Stores the full answer history +
-- section cursor so the user can save and resume across devices, plus the
-- derived 4-letter type once finished. This is the shared personality memory
-- the WhatsApp bot will read in the Phase 2 DB-unification.
-- Columns are quoted camelCase to map 1:1 to the TS QuizProgress model.
-- ────────────────────────────────────────────────────────────────────────────

create table if not exists public.personality_quiz (
  "userId"       uuid primary key references auth.users (id) on delete cascade,
  "answers"      jsonb   not null default '{}'::jsonb,  -- questionId -> chosen letter
  "sectionIndex" integer not null default 0,            -- next section of 5 to show
  "completed"    boolean not null default false,
  "finalType"    text,                                  -- 4-letter MBTI, set when completed
  "updatedAt"    timestamptz not null default now()
);

-- Row-level security: each user can only see/modify their own row (same policy
-- shape as the tables in 0001_initial_schema.sql).
alter table public.personality_quiz enable row level security;

drop policy if exists "own_select" on public.personality_quiz;
drop policy if exists "own_insert" on public.personality_quiz;
drop policy if exists "own_update" on public.personality_quiz;
drop policy if exists "own_delete" on public.personality_quiz;

create policy "own_select" on public.personality_quiz
  for select using (auth.uid() = "userId");
create policy "own_insert" on public.personality_quiz
  for insert with check (auth.uid() = "userId");
create policy "own_update" on public.personality_quiz
  for update using (auth.uid() = "userId") with check (auth.uid() = "userId");
create policy "own_delete" on public.personality_quiz
  for delete using (auth.uid() = "userId");
