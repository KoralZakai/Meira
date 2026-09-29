/**
 * buildDaySchedule — lay a day's tasks on a timeline by assigning each a
 * scheduledTime, ordered by urgency (priority → leaveHomeBy/fixedTime) with a
 * cursor that fills forward. Lifted from LLMService's build_schedule so a
 * screen button can call it directly (no LLM needed).
 *
 * Rules (matching the agent tool):
 * - The cursor NEVER starts in the past: it begins at max(wakeTime, `now`
 *   rounded up to the next quarter hour) — building at 12:56 schedules from
 *   13:00, not 00:00/08:00.
 * - `importantOnly`: only tasks that matter get on the timeline — fixed-time,
 *   must/have_to priority, a deadline today/tomorrow, or interview/exam/study
 *   keywords. The rest keep their place in the task list, unscheduled.
 * - Sort by sortTasksByPriorityAndTime (priority tier, then getSortKey).
 * - Fixed tasks own their clock time; flexible tasks take the running cursor.
 * - A flexible task's stale scheduledTime (already passed) is reassigned; a
 *   user-pinned time (isFixed via the detail sheet's From/To pickers) is kept,
 *   so blocks stay resizable/replaceable and survive a rebuild.
 * - Study/learning/coding tasks get a MINIMUM 3h (180 min) block.
 *
 * Dependencies: timeUtils. Pure — the caller persists the returned tasks.
 * Consumed by MyTasks "Build schedule" / "Refine with AI".
 */
import { Task } from '../types/index';
import { addMinutes, sortTasksByPriorityAndTime, getTodayString, getTomorrowString } from './timeUtils';

// Building software is a focus block too ("לסדר את כל הבאגים" got 30 min).
// Same words as server/day_schedule.py STUDY_KEYWORDS.
const STUDY_KEYWORDS = /study|learn|code|coding|course|lecture|homework|קורס|ללמוד|שיעור|תרגיל|debug|bugs|לפתח|פיתוח|לתכנת|באגים/i;
const STUDY_CATEGORIES = new Set(['course', 'class', 'aspiration']);
const IMPORTANT_KEYWORDS = /interview|exam|test|deadline|ראיון|מבחן|בחינה|דדליין|הגשה/i;

/** Bump study/learning/coding tasks to a 3h minimum block. */
function enforceMinBlock(t: Task): Task {
  const isStudy = STUDY_CATEGORIES.has(t.category as string) || STUDY_KEYWORDS.test(t.text);
  return isStudy ? { ...t, durationMinutes: Math.max(t.durationMinutes || 30, 180) } : t;
}

/** Does this task deserve a slot on today's timeline? */
export function isImportantToday(t: Task): boolean {
  if (t.isFixed && t.fixedTime) return true;
  if (t.priority === 'must' || t.priority === 'have_to') return true;
  if (t.deadline && t.deadline <= getTomorrowString()) return true;
  return IMPORTANT_KEYWORDS.test(t.text) || STUDY_KEYWORDS.test(t.text);
}

/** HH:MM rounded UP to the next quarter hour. */
function roundUpQuarter(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const total = Math.ceil((h * 60 + m) / 15) * 15;
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export interface BuildDayOptions {
  /** Current clock HH:MM — the cursor never starts before it (for today). */
  now?: string;
  /** Schedule only important tasks; the rest come back untouched. */
  importantOnly?: boolean;
}

/**
 * Return the tasks with an assigned scheduledTime, timeline tasks first in
 * timeline order, skipped (unimportant) tasks after, untouched.
 * `wakeTime` is where the cursor starts (HH:MM), default 08:00.
 */
export function buildDaySchedule(tasks: Task[], wakeTime = '08:00', opts: BuildDayOptions = {}): Task[] {
  const startAt = opts.now && roundUpQuarter(opts.now) > wakeTime ? roundUpQuarter(opts.now) : wakeTime;
  const pool = opts.importantOnly ? tasks.filter(isImportantToday) : tasks;
  const skipped = opts.importantOnly ? tasks.filter((t) => !isImportantToday(t)) : [];

  const enforced = pool.map(enforceMinBlock);
  const sorted = sortTasksByPriorityAndTime(enforced) as Task[];
  let cursor = startAt;
  const scheduled = sorted.map((task) => {
    // A stale flexible slot (already passed) is reassigned; pinned times stay.
    const keepExisting = task.isFixed
      ? task.fixedTime
      : task.scheduledTime && task.scheduledTime >= startAt
        ? task.scheduledTime
        : undefined;
    const start = keepExisting || cursor;
    const end = addMinutes(start, task.durationMinutes || 30);
    if (end > cursor) cursor = end;
    return { ...task, scheduledTime: start };
  });
  return [...scheduled, ...skipped];
}

// Self-check: npx tsx src/utils/buildDaySchedule.ts
if (typeof require !== 'undefined' && require.main === module) {
  const mk = (o: Partial<Task>): Task => ({
    id: Math.random().toString(36).slice(2), text: '', category: 'general' as any,
    priority: 'need_to' as any, isFixed: false, durationMinutes: 30, date: getTodayString(),
    status: 'pending' as any, createdAt: 0, historicalDurations: [], ...o,
  });
  const out = buildDaySchedule([
    mk({ text: 'gym', category: 'gym' as any, durationMinutes: 60, priority: 'must' as any }),
    mk({ text: 'interview', category: 'interview' as any, isFixed: true, fixedTime: '10:00', priority: 'must' as any }),
    mk({ text: 'study PPO', category: 'course' as any, durationMinutes: 30, priority: 'have_to' as any }),
    mk({ text: 'water the plants', priority: 'nice_to_do' as any }),
  ], '08:00', { now: '12:56', importantOnly: true });
  const study = out.find((t) => t.text === 'study PPO')!;
  const interview = out.find((t) => t.text === 'interview')!;
  const plants = out.find((t) => t.text === 'water the plants')!;
  const gym = out.find((t) => t.text === 'gym')!;
  console.assert(study.durationMinutes >= 180, '3h study minimum enforced');
  console.assert(interview.scheduledTime === '10:00', 'fixed task keeps its time');
  console.assert(gym.scheduledTime! >= '13:00', `cursor starts from now, got ${gym.scheduledTime}`);
  console.assert(!plants.scheduledTime, 'unimportant task left unscheduled');
  console.log('buildDaySchedule self-check OK:', out.map((t) => `${t.scheduledTime ?? '—'} ${t.text}`));
}
