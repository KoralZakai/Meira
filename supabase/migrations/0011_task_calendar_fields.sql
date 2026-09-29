-- LUMI AI — the two calendar fields the app owned and could not keep
--
-- `attendees` and `meetingUrl` are written by the calendar import and
-- reconciled against Google on every sync, but neither was ever a column. So
-- every push dropped them, cloud hydration returned rows without them, and the
-- next reconcile "corrected" them again — a write and a cloud push every 15
-- minutes, forever, over nothing. Seen in her logcat as:
--
--   [GoogleSync] reconcile: {"updated":1,
--     "notes":["corrected \"Your in-person interview with Ceva\": attendees"]}
--
-- on every single run. A reconcile of a field that cannot be stored cannot
-- converge, whatever the comparison does.
--
-- Until this is applied, upsertTolerant drops both columns and warns; nothing
-- breaks, they simply keep not persisting.

alter table public.tasks add column if not exists "meetingUrl" text;
alter table public.tasks add column if not exists "attendees" jsonb;
