-- Task nesting: "fix the notifications bug" belongs under "improve Lumi".
--
-- A real parent link rather than reusing the lightweight `subtasks` jsonb,
-- because a child is a full task — it can carry its own time, place, contact
-- and alerts, none of which a Subtask can hold.
--
-- ON DELETE SET NULL, not CASCADE: deleting a parent must never silently take
-- its children with it. They surface again as top-level tasks instead.
alter table public.tasks
  add column if not exists "parentId" text;

create index if not exists tasks_parent_idx on public.tasks ("userId", "parentId");

-- Self-reference is intentionally NOT a foreign key: task ids are text and
-- rows arrive out of order from two devices, so a FK would reject a child that
-- syncs before its parent. Orphans are handled in the app (treated as
-- top-level) rather than blocked at write time.
