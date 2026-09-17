// buildSchedule — web port of the mobile buildDaySchedule util. Assigns each
// task a scheduledTime on a timeline ordered by urgency (priority, then
// fixedTime/scheduledTime), with a cursor filling forward from wake time and a
// 3h minimum for study/learning/coding blocks. Pure — the caller persists.
// Mirror of src/utils/buildDaySchedule.ts (kept in sync by hand; no shared code).

import { PRIORITY_ORDER, type Task, type TaskPriority } from './types';

const STUDY_KEYWORDS = /study|learn|code|coding|course|lecture|homework|קורס|ללמוד|שיעור|תרגיל/i;
const STUDY_CATEGORIES = new Set(['course', 'class', 'aspiration']);

function addMinutes(hhmm: string, mins: number): string {
  const [h, m] = hhmm.split(':').map(Number);
  const total = (((h * 60 + m + mins) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

const priRank = (p?: TaskPriority | null) => (p ? PRIORITY_ORDER.indexOf(p) : 99);
const sortKey = (t: Task) => t.fixedTime || t.scheduledTime || '23:59';

/** Return the tasks with an assigned scheduledTime, in timeline order. */
export function buildDaySchedule(tasks: Task[], wakeTime = '08:00'): Task[] {
  const enforced = tasks.map((t) => {
    const isStudy = STUDY_CATEGORIES.has(t.category ?? '') || STUDY_KEYWORDS.test(t.text);
    return isStudy ? { ...t, durationMinutes: Math.max(t.durationMinutes || 30, 180) } : t;
  });
  const sorted = [...enforced].sort(
    (a, b) => priRank(a.priority) - priRank(b.priority) || sortKey(a).localeCompare(sortKey(b)),
  );
  let cursor = wakeTime;
  return sorted.map((task) => {
    const start = task.isFixed ? task.fixedTime || cursor : task.scheduledTime || cursor;
    cursor = addMinutes(start, task.durationMinutes || 30);
    return { ...task, scheduledTime: start };
  });
}
