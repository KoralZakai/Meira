/**
 * leadTime — HOW EARLY Lumi warns you about something, and where that number
 * comes from.
 *
 * Three sources, most specific first:
 *   1. task.remindMinutesBefore  — you said it out loud ("30 minutes before")
 *   2. profile.learnedLeadMinutes[category] — Lumi watched you run late for
 *      interviews and started warning earlier
 *   3. CATEGORY_DEFAULT_LEAD[category] — a sane starting point
 *
 * The numbers are minutes before the task starts. Anything >= a full day is
 * rendered as "the evening before" rather than a literal 24h offset, because a
 * 10:00 meeting reminded at 10:00 yesterday is a worse reminder than one at
 * 20:00 last night. See alertPlan.planFixedTimeAlerts for that rendering.
 *
 * Pure: no storage, no notifications. Consumers: utils/alertPlan,
 * services/ReminderService, services/MorningRoutineService (the learning side).
 */
import { TaskCategory } from '../types/index';

/** One full day, in minutes. A lead >= this renders as "the evening before". */
export const DAY = 1440;

/** Minutes-before offsets a category gets when nothing more specific applies. */
export const CATEGORY_DEFAULT_LEAD: Record<TaskCategory, number[]> = {
  // High-stakes and hard to reschedule: warn the night before, then twice more.
  interview:   [DAY, 120, 30],
  doctor:      [DAY, 120, 30],
  conference:  [DAY, 120, 60],
  // Recurring commitments: same-day is enough, but with real runway.
  course:      [60, 15],
  class:       [60, 30],
  hobby_class: [60, 30],
  meeting:     [60, 15],
  work:        [30, 10],
  zoom:        [30, 10],
  // Low-stakes: one nudge.
  gym:         [30],
  aspiration:  [30],
  leisure:     [30],
  call:        [10],
  general:     [60, 15],
};

/** Hour the "tomorrow you have…" alert lands on the previous evening. */
export const DAY_BEFORE_HOUR = 20;

/** Clamp: below this a reminder is indistinguishable from the event itself. */
const MIN_LEAD = 2;
/** Above a week out, a "heads up" is noise, not help. */
const MAX_LEAD = 7 * DAY;

export interface LeadTimeSources {
  /** Per-category minutes Lumi has learned for this user. */
  learned?: Partial<Record<TaskCategory, number>>;
}

/**
 * The lead-time offsets for a task, largest first, de-duplicated.
 *
 * A learned value replaces the *largest same-day* default rather than being
 * appended: learning that you need 45 minutes for interviews should move the
 * existing warning, not bolt a fourth alert onto an already-noisy task.
 */
export function resolveLeadMinutes(
  task: { category?: TaskCategory; remindMinutesBefore?: number[] },
  sources: LeadTimeSources = {},
): number[] {
  const explicit = task.remindMinutesBefore?.filter((n) => Number.isFinite(n));
  if (explicit?.length) return normalize(explicit);

  const category = task.category ?? 'general';
  const defaults = CATEGORY_DEFAULT_LEAD[category] ?? CATEGORY_DEFAULT_LEAD.general;
  const learned = sources.learned?.[category];
  if (!learned || !Number.isFinite(learned)) return normalize(defaults);

  // Keep the day-before heads-up; swap the biggest same-day offset for what
  // Lumi actually measured, and keep any shorter final nudge.
  const dayBefore = defaults.filter((n) => n >= DAY);
  const sameDay = defaults.filter((n) => n < DAY);
  const tail = sameDay.length > 1 ? sameDay.slice(1) : [];
  return normalize([...dayBefore, Math.round(learned), ...tail]);
}

function normalize(mins: number[]): number[] {
  return Array.from(new Set(mins.map((n) => Math.min(MAX_LEAD, Math.max(MIN_LEAD, Math.round(n))))))
    .sort((a, b) => b - a);
}

/** Human phrasing for a lead offset — used in Lumi's confirmations. */
export function describeLead(minutes: number, he: boolean): string {
  if (minutes >= DAY) {
    const days = Math.round(minutes / DAY);
    if (days === 1) return he ? 'ערב קודם' : 'the evening before';
    return he ? `${days} ימים לפני` : `${days} days before`;
  }
  if (minutes >= 60) {
    const hours = minutes / 60;
    const label = Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
    if (minutes === 60) return he ? 'שעה לפני' : '1 hour before';
    return he ? `${label} שעות לפני` : `${label} hours before`;
  }
  return he ? `${minutes} דק' לפני` : `${minutes} min before`;
}
