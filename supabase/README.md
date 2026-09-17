# LUMI — Supabase backend

Shared source of truth for the Expo mobile app and the (upcoming) Next.js web app.

## Apply the schema

**Option 1 — Dashboard (quickest):**
1. Create a project at https://supabase.com.
2. Open **SQL Editor** → paste the contents of `migrations/0001_initial_schema.sql` → **Run**.

**Option 2 — Supabase CLI:**
```bash
npm i -g supabase
supabase link --project-ref <your-project-ref>
supabase db push
```

## What the schema gives you
- Tables mapped 1:1 (camelCase columns) from `src/types/index.ts`:
  `user_profiles`, `user_stats`, `app_settings`, `tasks`, `goals`,
  `daily_logs`, `schedules`, `reward_events`, `custom_categories`.
- **Row Level Security** on every table — a user can only read/write rows where
  `userId = auth.uid()`.
- Client-generated string ids preserved (offline-first friendly).
- `updatedAt` timestamps (auto-updated by trigger) for realtime sync / conflict resolution.

## Auth
Enable **Google** under Authentication → Providers, reusing the existing
`EXPO_PUBLIC_GOOGLE_OAUTH_CLIENT_ID`. The same identity then works on mobile and web.

## Next steps (per the architecture plan)
- **Step 2:** wire Supabase Auth (Google) so every row gets a `userId`.
- **Step 3:** rewrite `src/services/TaskStorage.ts` against Supabase (same function
  signatures), and converge the flat-vs-rich `location` representation into the
  `location` jsonb column at that boundary.

## Env (add to .env, do NOT commit secrets)
```
EXPO_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=<anon-key>
```
