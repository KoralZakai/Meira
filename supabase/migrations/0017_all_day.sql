-- 0017 — a task for a whole day, or from one date to another (29.10, Koral).
--
-- "All day" was a timed 08:00–16:00 task, so Meira planned Zumba at 16:15 on
-- her vacation; a range was six unrelated rows; all-day calendar events were
-- dropped. Two nullable columns, nothing rewritten: old rows read as before.
--   allDay   true → no hour; drawn as a strip above the day (src/utils/allDay.ts)
--   endDate  YYYY-MM-DD, inclusive; the row covers date … endDate
-- RLS is per row (userId) and unchanged: no new policy is needed.
alter table public.tasks add column if not exists "allDay" boolean;
alter table public.tasks add column if not exists "endDate" text;
