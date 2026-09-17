/**
 * taskMerge — the pure duplicate-merging logic behind StoreMigration.
 *
 * Split from the service so it imports without AsyncStorage (and therefore all
 * of react-native): this is the half that decides whether two rows are the
 * same task, which is the half worth testing hard. A false merge hides a real
 * appointment on a phone nobody can inspect afterwards.
 *
 * Dependencies: utils/fuzzyMatch. Consumed by services/StoreMigration.
 */
import { Task } from '../types/index';
import { textSimilarity } from './fuzzyMatch';

/**
 * How alike two same-day tasks must read to be called the same task.
 *
 * Deliberately high. A false merge hides a real task, which is far worse than
 * leaving a duplicate visible — the user can delete a duplicate they can see.
 */
const MERGE_SIMILARITY = 0.82;

/** Normalized form used for the cheap exact-duplicate pass. */
function norm(text: string): string {
  return (text || '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ');
}

/** How much a row is worth keeping when two describe the same thing. */
function richness(t: Task): number {
  return (t.fixedTime ? 4 : 0)
    + (typeof t.location === 'object' && t.location?.transitPlan ? 3 : 0)
    + (t.location ? 2 : 0)
    + (t.deadline ? 1 : 0)
    + (t.subtasks?.length ? 1 : 0)
    + (t.parentId ? 1 : 0);
}

/** YYYY-MM-DD `days` before today, on the local calendar. */
function daysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Group same-day tasks that mean the same thing, keeping the richest of each.
 *
 * Only compares within a single date. Two "yoga" tasks on different days are
 * two yoga classes, not a duplicate — collapsing across dates would delete a
 * real appointment.
 */
export function mergeByMeaning(tasks: Task[]): { kept: Task[]; mergedIds: string[] } {
  const byDate = new Map<string, Task[]>();
  for (const t of tasks) {
    if (!byDate.has(t.date)) byDate.set(t.date, []);
    byDate.get(t.date)!.push(t);
  }

  const kept: Task[] = [];
  const mergedIds: string[] = [];

  for (const sameDay of byDate.values()) {
    const survivors: Task[] = [];
    for (const task of sameDay) {
      // Only ever a twin of a row with the SAME completion state.
      //
      // This used to pair across statuses and then hand the win to whichever
      // row said 'complete'. That is the rule dedupeTasks was fixed to remove,
      // and the reasoning is the same here: two rows that disagree about
      // whether the work is done are not a duplicate, they are a question, and
      // a merge is not entitled to answer it. Answering it put a ✓ on work
      // that was never done — and worse, it silently undid a tick the user had
      // just REMOVED, because the completed twin was still there to outvote
      // her.
      //
      // Same-status rows still collapse: two finished copies are clutter, two
      // pending copies are clutter. A visible duplicate is a small annoyance;
      // a task marked done that is not done is the app lying about her
      // workload.
      const done = task.status === 'complete';
      const twinIndex = survivors.findIndex((s) =>
        (s.status === 'complete') === done
        && (norm(s.text) === norm(task.text)
          || textSimilarity(s.text, task.text) >= MERGE_SIMILARITY));

      if (twinIndex === -1) {
        survivors.push(task);
        continue;
      }
      const twin = survivors[twinIndex];
      const taskWins = richness(task) > richness(twin);

      if (taskWins) {
        mergedIds.push(twin.id);
        survivors[twinIndex] = task;
      } else {
        mergedIds.push(task.id);
      }
    }
    kept.push(...survivors);
  }
  return { kept, mergedIds };
}

