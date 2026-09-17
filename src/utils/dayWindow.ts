/**
 * dayWindow — which of the day's tasks the schedule screen actually draws.
 *
 * The day list is capped: a long day rendered in full is what makes the screen
 * feel unmanageable. But the cap used to be `dayOrder.slice(0, 6)` — the first
 * six tasks in CLOCK order — so by the afternoon every visible card was already
 * over, and a phone call added for 16:00 on a busy day appeared nowhere. It was
 * saved, Lumi could answer questions about it, and the screen had spent its
 * whole budget on the morning.
 *
 * The rule here: what is still ahead is the point of the screen, so the cut
 * comes off the other end. Everything upcoming is kept (to a limit a real day
 * does not reach); what is done or past is trimmed to the last couple, so the
 * list still opens on where she is rather than on where she was.
 *
 * Pure — no react-native, no storage — so tests/run-day-window.ts can pin it.
 */
import { Task } from '../types/index';
import { timeToMinutes, addMinutes } from './timeUtils';

/** Upcoming cards kept. Higher than the old total: the future is the point. */
export const VISIBLE_AHEAD_LIMIT = 8;
/** How much of the finished day stays on screen for context. */
export const VISIBLE_BEHIND_LIMIT = 2;

/**
 * Has this task already happened?
 *
 * Completed, or its slot has ended. A task with no hour yet is NOT behind —
 * it has not happened, it just has no time, and hiding it would be the same
 * bug in a different shape.
 */
export function isBehind(task: Task, nowHHMM: string): boolean {
  if (task.status === 'complete') return true;
  const start = task.fixedTime || task.scheduledTime;
  if (!start) return false;
  const startMin = timeToMinutes(start);
  const end = timeToMinutes(addMinutes(start, task.durationMinutes || 30));
  const now = timeToMinutes(nowHHMM);
  if (![startMin, end, now].every(Number.isFinite)) return false;
  // A slot that runs past midnight wraps to a small number of minutes, which
  // would read as "ended hours ago" and hide a task that has not started.
  if (end < startMin) return false;
  return end <= now;
}

/**
 * The ids to draw, given the day in clock order.
 *
 * Returns ids rather than tasks so the caller keeps rendering in its own order
 * — the chain's "previous stop" depends on the full day, not on this subset.
 */
export function visibleDayIds(
  dayOrder: ReadonlyArray<Task>,
  nowHHMM: string,
  limits: { ahead?: number; behind?: number } = {},
): Set<string> {
  const ahead = limits.ahead ?? VISIBLE_AHEAD_LIMIT;
  const behind = limits.behind ?? VISIBLE_BEHIND_LIMIT;
  const past = dayOrder.filter((t) => isBehind(t, nowHHMM));
  const upcoming = dayOrder.filter((t) => !isBehind(t, nowHHMM));
  return new Set([
    ...past.slice(-behind),
    ...upcoming.slice(0, ahead),
  ].map((t) => t.id));
}
