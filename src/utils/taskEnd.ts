/**
 * taskEnd — has this task ended by `clock`? (21.10, Koral: "מפגש קמפ" at 21:00–00:00 sat at the top of
 * the morning, folded into "earlier today".)
 *
 * `addMinutes` wraps at midnight: 21:00 + 3h is "00:00", i.e. minute 0 — which is before any
 * morning clock, so an evening task that runs to midnight counted as already over. The end is
 * measured in minutes since the day began and may pass 24:00 (1440); it is never wrapped.
 *
 * Pure. tests/run-task-end.ts.
 */
import { timeToMinutes } from './timeUtils';

export function endMinutesOf(t: { fixedTime?: string; scheduledTime?: string; durationMinutes?: number }): number {
  return timeToMinutes(t.fixedTime || t.scheduledTime || '00:00') + (t.durationMinutes || 30);
}

/** True when the task's end is at or before `clock` (HH:MM) on the same day. */
export function endedBy(t: { fixedTime?: string; scheduledTime?: string; durationMinutes?: number }, clock: string): boolean {
  return endMinutesOf(t) <= timeToMinutes(clock);
}
