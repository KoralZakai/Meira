/**
 * questionQueue — WHEN one of Meira's questions may pop up (6.10, her pick:
 * a sheet from below, one at a time, at most 2 a day, never in the hour before
 * a departure; "Not now" means tomorrow; the question also stays on its row).
 *
 * A question that interrupts the wrong moment teaches her to dismiss them all,
 * so the limits live here, pure and tested (tests/run-question-queue.ts):
 *
 *   - at most ONE popup each time the app comes to the front,
 *   - at most LIMITS.perDay a day, at least LIMITS.gapMs apart,
 *   - never within LIMITS.departureQuietMin of leaving, never over another sheet,
 *   - "Not now" hides it for LIMITS.snoozeMs; after LIMITS.maxSnoozes it never
 *     pops up again — the chip on its row and You → "Meira's questions" stay,
 *   - right after she saves a routine, its question is asked at once: she is
 *     looking at it, which is the best moment there is.
 */
import type { MeiraQuestion } from '../questions/types';
import type { Task } from '../types/index';
import { timeToMinutes } from './timeUtils';

export interface AskState {
  /** key → when she answered. Answered questions are never asked again. */
  answered: Record<string, number>;
  snoozed: Record<string, { until: number; count: number }>;
  /** Popups shown today. */
  day: { date: string; shown: number; lastAt: number };
}

export const EMPTY_ASK_STATE: AskState = { answered: {}, snoozed: {}, day: { date: '', shown: 0, lastAt: 0 } };

export const LIMITS = {
  perDay: 2,
  gapMs: 3 * 60 * 60_000,
  departureQuietMin: 60,
  snoozeMs: 24 * 60 * 60_000,
  maxSnoozes: 3,
};

export interface AskContext {
  now: number;
  /** YYYY-MM-DD, local. */
  today: string;
  minutesToDeparture?: number | null;
  /** A popup was already shown since the app last came to the front. */
  shownThisOpen: boolean;
  /** Another sheet or modal is open. */
  sheetOpen?: boolean;
  /** She just saved the thing this question is about. */
  justSaved?: boolean;
}

/** Still waiting for her: not answered, not snoozed right now. */
export function isOpen(q: MeiraQuestion, state: AskState, now: number): boolean {
  if (state.answered[q.key]) return false;
  const s = state.snoozed[q.key];
  return !s || s.until <= now;
}

/**
 * May this question interrupt her at all — as a popup or as a notification?
 * Open, and not put off for good ("Not now" LIMITS.maxSnoozes times). The chip
 * on its row and You → "Meira's questions" do not ask this: they only count.
 */
export function mayInterrupt(q: MeiraQuestion, state: AskState, now: number): boolean {
  return isOpen(q, state, now) && (state.snoozed[q.key]?.count ?? 0) < LIMITS.maxSnoozes;
}

/** Unanswered at all — what the row chip and You → "Meira's questions (n)" count. */
export function unanswered(questions: MeiraQuestion[], state: AskState): MeiraQuestion[] {
  return questions.filter((q) => !state.answered[q.key]);
}

/** The question that may pop up now, or null. */
export function pickNext(questions: MeiraQuestion[], state: AskState, ctx: AskContext): MeiraQuestion | null {
  if (ctx.sheetOpen) return null;
  const candidates = questions.filter((q) => mayInterrupt(q, state, ctx.now));
  if (!candidates.length) return null;
  if (ctx.justSaved) return candidates[0];
  if (ctx.shownThisOpen) return null;
  if (ctx.minutesToDeparture != null && ctx.minutesToDeparture >= 0 && ctx.minutesToDeparture <= LIMITS.departureQuietMin) {
    return null;
  }
  const day = state.day.date === ctx.today ? state.day : { date: ctx.today, shown: 0, lastAt: 0 };
  if (day.shown >= LIMITS.perDay) return null;
  if (day.lastAt && ctx.now - day.lastAt < LIMITS.gapMs) return null;
  return candidates[0];
}

export function afterShown(state: AskState, ctx: Pick<AskContext, 'now' | 'today'>): AskState {
  const day = state.day.date === ctx.today ? state.day : { date: ctx.today, shown: 0, lastAt: 0 };
  return { ...state, day: { date: ctx.today, shown: day.shown + 1, lastAt: ctx.now } };
}

export function afterSnooze(state: AskState, key: string, now: number): AskState {
  const count = (state.snoozed[key]?.count ?? 0) + 1;
  return { ...state, snoozed: { ...state.snoozed, [key]: { until: now + LIMITS.snoozeMs, count } } };
}

export function afterAnswer(state: AskState, key: string, now: number): AskState {
  const { [key]: _gone, ...snoozed } = state.snoozed;
  return { ...state, answered: { ...state.answered, [key]: now }, snoozed };
}

/** Minutes until the next "leave home by" today, or null when nothing is left to leave for. */
export function minutesToNextDeparture(tasks: Task[], today: string, nowHHMM: string): number | null {
  const now = timeToMinutes(nowHHMM);
  const leaveOf = (t: Task) => (typeof t.location === 'object' ? t.location?.leaveHomeBy : undefined);
  const next = tasks
    .filter((t) => t.date === today && t.status === 'pending' && leaveOf(t))
    .map((t) => timeToMinutes(leaveOf(t)!) - now)
    .filter((m) => m >= 0)
    .sort((a, b) => a - b);
  return next.length ? next[0] : null;
}
