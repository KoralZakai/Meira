/**
 * travelRowState — why there is no journey on screen, said out loud.
 *
 * Koral, 2026-09-16: "I just added a yoga class in some place — why doesn't it
 * tell me how to get there, when?"
 *
 * The app was not broken in the way that produces an error. TimelineTravelLeg
 * opened with `if (!loc?.leaveHomeBy && !plan) return null` — so a task with a
 * place but no computed route rendered NOTHING, and "I don't know how to get
 * you there yet" looked exactly like "there is nowhere to go". She has no way
 * to tell those apart, and nothing to act on either.
 *
 * There are three genuinely different reasons a located task has no journey,
 * and each has a different thing the user can do:
 *
 *   no-time     the task has a place but no hour. A leave time is the arrival
 *               time minus the journey — with no arrival there is nothing to
 *               subtract from, so the chain skips it (sortTimed drops it) and
 *               always will. She has to give it an hour. This is the one that
 *               silently persists forever.
 *   pending     place and hour are both there; the route simply has not been
 *               computed yet, or the last attempt failed. Worth offering a
 *               retry rather than waiting for a sweep.
 *   unroutable  the chain tried and Google had nothing for this mode — already
 *               flagged on the location as noRouteForMode.
 *   none        there is no place. Correct to render nothing.
 *
 * Pure, so tests/run-travel-row.ts covers every branch with no device.
 */
import { Task, TaskLocation } from '../types/index';

export type TravelRowState = 'route' | 'pending' | 'no-time' | 'unroutable' | 'none';

const locOf = (t: Task): TaskLocation | undefined =>
  t.location && typeof t.location === 'object' ? (t.location as TaskLocation) : undefined;

/** The address as text, in either storage shape. */
const addressOf = (t: Task): string | undefined => {
  if (typeof t.location === 'string') return t.location || undefined;
  const loc = locOf(t);
  return loc?.address || loc?.displayName || undefined;
};

/**
 * What the travel row should show for this task.
 *
 * `route` means a real plan exists and the caller should draw it as before —
 * this function changes nothing about the happy path.
 */
export function travelRowState(task: Task): TravelRowState {
  const loc = locOf(task);
  if (loc?.transitPlan || loc?.leaveHomeBy) return 'route';

  if (!addressOf(task)) return 'none';

  // A place with no hour can never be routed, however long anyone waits.
  if (!task.fixedTime && !task.scheduledTime) return 'no-time';

  if ((loc as { noRouteForMode?: string } | undefined)?.noRouteForMode) return 'unroutable';

  return 'pending';
}

/**
 * One short line for each state, in her language — and, where there is one,
 * the action that fixes it.
 *
 * Deliberately concrete about the cause. "No route" tells her nothing she
 * cannot already see; "I need an hour before I can plan the trip" tells her
 * what to do next, which is the whole difference between a blank space and a
 * usable screen.
 */
export function describeTravelRow(
  state: TravelRowState, he: boolean,
): { text: string; action?: string } | null {
  switch (state) {
    case 'no-time':
      return he
        ? { text: '📍 יש מקום, אין שעה — בלי שעת התחלה אי אפשר לחשב מתי לצאת', action: 'קבעי שעה' }
        : { text: '📍 A place but no time — without a start hour there is no leave time to work out', action: 'Set a time' };
    case 'pending':
      return he
        ? { text: '🧭 עוד לא חישבתי מסלול לכאן', action: 'חשבי עכשיו' }
        : { text: '🧭 No route worked out for this yet', action: 'Work it out now' };
    case 'unroutable':
      return he
        ? { text: '🚫 לא נמצא מסלול באמצעי שנבחר', action: 'נסי אמצעי אחר' }
        : { text: '🚫 No route for the chosen way of getting there', action: 'Try another mode' };
    default:
      return null;
  }
}
