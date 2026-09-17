-- LUMI AI — Supabase initial schema
-- Maps src/types/index.ts to Postgres. Shared source of truth for the Expo
-- mobile app and the Next.js web app.
--
-- Design notes:
--  * Column names are camelCase (quoted) to map 1:1 with the TypeScript models,
--    so the Step-3 TaskStorage rewrite needs almost no field translation.
--  * Client-generated string ids (e.g. "1718-abc123") are preserved: `id` is
--    text, supplied by the client on insert. This keeps the AsyncStorage cache
--    and offline-created rows compatible.
--  * App epoch-ms fields (createdAt/completedAt/...) are stored as bigint to
--    avoid timezone drift with the offline cache. A separate server-side
--    "updatedAt" timestamptz powers realtime sync / last-write-wins.
--  * Nested structures (location, contact, subtasks, transitPlan, the stats
--    rollups) are jsonb. `location` holds the TaskLocation shape; this is the
--    natural place to converge the flat/rich location representations later.
--  * category is free text (custom user categories are allowed); priority and
--    status use CHECK constraints over the canonical sets.

create extension if not exists "pgcrypto";

-- ─── shared updatedAt trigger ───────────────────────────────────────────────
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new."updatedAt" = now();
  return new;
end;
$$;

-- ─── user_profiles (one row per user) ───────────────────────────────────────
create table if not exists public.user_profiles (
  "userId"               uuid primary key references auth.users (id) on delete cascade,
  "name"                 text not null default '',
  "language"             text not null default 'en' check ("language" in ('en','he')),
  "theme"                text not null default 'light' check ("theme" in ('light','dark')),
  "transportType"        text not null default 'bus' check ("transportType" in ('bus','car','walk','bike')),
  "morningRoutineMinutes" integer not null default 45,
  "wakeBufferMinutes"    integer not null default 15,
  "homeAddress"          text not null default '',
  "homeLat"              double precision not null default 0,
  "homeLng"              double precision not null default 0,
  "defaultWakeTime"      text not null default '07:00',
  "sleepTime"            text not null default '23:00',
  "googleConnected"      boolean not null default false,
  "createdAt"            bigint not null,
  "updatedAt"            timestamptz not null default now()
);

-- ─── user_stats (one row per user) ──────────────────────────────────────────
create table if not exists public.user_stats (
  "userId"                   uuid primary key references auth.users (id) on delete cascade,
  "totalPoints"              integer not null default 0,
  "level"                    integer not null default 1,
  "currentStreak"            integer not null default 0,
  "longestStreak"            integer not null default 0,
  "totalTasksCompleted"      integer not null default 0,
  "totalTasksOnTime"         integer not null default 0,
  "totalTasksMissed"         integer not null default 0,
  "categoryDurationAverages" jsonb not null default '{}'::jsonb,
  "weeklyHoursByCategory"    jsonb not null default '{}'::jsonb,
  "weeklyTaskCountByCategory" jsonb not null default '{}'::jsonb,
  "lastUpdated"              bigint not null,
  "updatedAt"               timestamptz not null default now()
);

-- ─── app_settings (one row per user) ────────────────────────────────────────
create table if not exists public.app_settings (
  "userId"                   uuid primary key references auth.users (id) on delete cascade,
  "morningTime"              jsonb not null default '{"hour":7,"minute":30}'::jsonb,
  "afternoonTime"            jsonb not null default '{"hour":12,"minute":0}'::jsonb,
  "eveningTime"              jsonb not null default '{"hour":20,"minute":0}'::jsonb,
  "androidMorningWindowStart" integer not null default 6,
  "androidMorningWindowEnd"  integer not null default 10,
  "language"                 text not null default 'en' check ("language" in ('en','he')),
  "updatedAt"                timestamptz not null default now()
);

-- ─── tasks ──────────────────────────────────────────────────────────────────
create table if not exists public.tasks (
  "id"                    text not null,
  "userId"                uuid not null references auth.users (id) on delete cascade,
  "text"                  text not null,
  "category"              text,
  "priority"              text check ("priority" in ('must','have_to','need_to','nice_to_do')),
  "isFixed"               boolean not null default false,
  "fixedTime"             text,
  "durationMinutes"       integer not null default 30,
  "actualDurationMinutes" integer,
  "date"                  text not null,            -- YYYY-MM-DD
  "status"                text not null default 'pending'
                            check ("status" in ('pending','complete','missed','moved','partial')),
  "progress"              text,
  "subtasks"              jsonb,                    -- Subtask[]
  "deadline"             text,
  "deadlineTime"          text,
  "estimatedWorkMinutes"  integer,
  "latestStartBy"         text,
  "scheduledTime"         text,
  "location"              jsonb,                    -- TaskLocation
  "contact"               jsonb,                    -- TaskContact
  "gmailThreadId"         text,
  "calendarEventId"       text,
  "verifiedArrival"       boolean,
  "completedAt"           bigint,
  "createdAt"             bigint not null,
  "movedFromDate"         text,
  "historicalDurations"   jsonb not null default '[]'::jsonb,
  "notificationIds"       text[],
  -- convenience / flat fields kept from the current model
  "tags"                  text[],
  "subgroup"              text,
  "dueDate"               text,
  "how"                   text,
  "why"                   text,
  "contactName"           text,
  "contactPhone"          text,
  "source"                text check ("source" in ('voice','manual','suggested','email','calendar')),
  "hasLocation"           boolean,
  "hasDeadline"           boolean,
  "locationLat"           double precision,
  "locationLng"           double precision,
  "lastNearbyReminderAt"  bigint,
  "lastWakeReminderAt"    bigint,
  "lastDepartureDetectedAt" bigint,
  "lastArrivalDetectedAt" bigint,
  "updatedAt"             timestamptz not null default now(),
  primary key ("userId", "id")
);

create index if not exists tasks_user_date_idx on public.tasks ("userId", "date");
create index if not exists tasks_user_status_idx on public.tasks ("userId", "status");

-- ─── goals ──────────────────────────────────────────────────────────────────
create table if not exists public.goals (
  "id"                  text not null,
  "userId"              uuid not null references auth.users (id) on delete cascade,
  "text"                text not null,
  "category"            text not null,
  "type"                text not null check ("type" in ('project','aspiration')),
  "targetDate"          text,
  "linkedTaskIds"       text[] not null default '{}',
  "completedTasksCount" integer not null default 0,
  "totalTasksCount"     integer not null default 0,
  "progressPercent"     integer not null default 0,
  "status"              text not null default 'active' check ("status" in ('active','achieved','paused')),
  "createdAt"           bigint not null,
  "achievedAt"          bigint,
  "updatedAt"           timestamptz not null default now(),
  primary key ("userId", "id")
);

-- ─── daily_logs (one row per user per date) ─────────────────────────────────
create table if not exists public.daily_logs (
  "userId"             uuid not null references auth.users (id) on delete cascade,
  "date"               text not null,            -- YYYY-MM-DD
  "morningDone"        boolean not null default false,
  "afternoonDone"      boolean not null default false,
  "eveningDone"        boolean not null default false,
  "wakeUpTime"         text,
  "scheduleGeneratedAt" bigint,
  "updatedAt"          timestamptz not null default now(),
  primary key ("userId", "date")
);

-- ─── schedules (one DailySchedule per user per date) ────────────────────────
create table if not exists public.schedules (
  "userId"         uuid not null references auth.users (id) on delete cascade,
  "date"           text not null,                -- YYYY-MM-DD
  "tasks"          jsonb not null default '[]'::jsonb,  -- Task[] snapshot
  "wakeUpTime"     text not null default '',
  "generatedAt"    bigint not null,
  "lumiSummary"    text not null default '',
  "lumiSummaryHe"  text not null default '',
  "updatedAt"      timestamptz not null default now(),
  primary key ("userId", "date")
);

-- ─── reward_events ──────────────────────────────────────────────────────────
create table if not exists public.reward_events (
  "id"         text not null,
  "userId"     uuid not null references auth.users (id) on delete cascade,
  "type"       text not null
                 check ("type" in ('task_complete','on_time','streak','level_up','perfect_day','arrival')),
  "points"     integer not null default 0,
  "message"    text not null default '',
  "messageHe"  text not null default '',
  "timestamp"  bigint not null,
  primary key ("userId", "id")
);

create index if not exists reward_events_user_ts_idx on public.reward_events ("userId", "timestamp" desc);

-- ─── custom_categories (user-created categories) ────────────────────────────
create table if not exists public.custom_categories (
  "userId"   uuid not null references auth.users (id) on delete cascade,
  "key"      text not null,
  "icon"     text not null default '📌',
  "color"    text not null default '#8A8A9A',
  "labelEn"  text not null default '',
  "labelHe"  text not null default '',
  "updatedAt" timestamptz not null default now(),
  primary key ("userId", "key")
);

-- ─── updatedAt triggers ─────────────────────────────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array[
    'user_profiles','user_stats','app_settings','tasks','goals',
    'daily_logs','schedules','custom_categories'
  ]
  loop
    execute format(
      'drop trigger if exists set_updated_at on public.%I;', t
    );
    execute format(
      'create trigger set_updated_at before update on public.%I
         for each row execute function public.set_updated_at();', t
    );
  end loop;
end;
$$;

-- ─── Row Level Security: each user sees only their own rows ──────────────────
do $$
declare
  t text;
  uidcol text;
begin
  foreach t in array array[
    'user_profiles','user_stats','app_settings','tasks','goals',
    'daily_logs','schedules','reward_events','custom_categories'
  ]
  loop
    uidcol := '"userId"';
    execute format('alter table public.%I enable row level security;', t);

    execute format('drop policy if exists "own_select" on public.%I;', t);
    execute format('drop policy if exists "own_insert" on public.%I;', t);
    execute format('drop policy if exists "own_update" on public.%I;', t);
    execute format('drop policy if exists "own_delete" on public.%I;', t);

    execute format(
      'create policy "own_select" on public.%I for select
         using (auth.uid() = %s);', t, uidcol);
    execute format(
      'create policy "own_insert" on public.%I for insert
         with check (auth.uid() = %s);', t, uidcol);
    execute format(
      'create policy "own_update" on public.%I for update
         using (auth.uid() = %s) with check (auth.uid() = %s);', t, uidcol, uidcol);
    execute format(
      'create policy "own_delete" on public.%I for delete
         using (auth.uid() = %s);', t, uidcol);
  end loop;
end;
$$;
