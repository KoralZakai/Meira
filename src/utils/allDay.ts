/**
 * allDay — a task for a whole day, or from one date to another (29.10, Koral).
 *
 * "All day" used to be a timed task 08:00–16:00, so Meira planned Zumba at
 * 16:15 on her Midburn vacation; a range ("Monday to Saturday") was six
 * unrelated tasks; and all-day calendar events were dropped on import. Now a
 * task carries `allDay` and an optional `endDate` (inclusive), shows on EVERY
 * day it covers, as a strip above the timeline — never as a card at 08:00.
 * Pure (tests/run-all-day.ts).
 */
import type { Task } from '../types';

export function isAllDay(t: Pick<Task, 'allDay'> | null | undefined): boolean {
  return Boolean(t?.allDay);
}

/** The last day the task covers (inclusive). */
export function lastDay(t: Pick<Task, 'date' | 'endDate'>): string {
  return t.endDate && t.endDate > t.date ? t.endDate : t.date;
}

/** Does this task belong on that day? A range covers every day in it. */
export function coversDay(t: Pick<Task, 'date' | 'endDate' | 'allDay'>, iso: string): boolean {
  if (!t?.date) return false;
  if (!isAllDay(t) || !t.endDate) return t.date === iso;
  return t.date <= iso && iso <= lastDay(t);
}

function dayNumber(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}

/** How many days it spans (1 for a single day). */
export function spanDays(t: Pick<Task, 'date' | 'endDate'>): number {
  return dayNumber(lastDay(t)) - dayNumber(t.date) + 1;
}

/** Day n of N, for the strip ("יום 2/6"). */
export function dayOf(t: Pick<Task, 'date' | 'endDate'>, iso: string): { n: number; of: number } {
  return { n: dayNumber(iso) - dayNumber(t.date) + 1, of: spanDays(t) };
}

/** The patch for the toggle. On: the hours go (kept nowhere — a whole day has none). */
export function allDayPatch(on: boolean, t: Pick<Task, 'date' | 'endDate'>): Partial<Task> {
  if (on) {
    return { allDay: true, isFixed: false, fixedTime: undefined, scheduledTime: undefined, endTime: undefined,
      durationMinutes: 24 * 60 };
  }
  return { allDay: false, endDate: undefined, durationMinutes: 60 };
}

/** A new first day keeps the range's length; a new last day before the first is the first. */
export function startPatch(t: Pick<Task, 'date' | 'endDate' | 'allDay'>, iso: string): Partial<Task> {
  if (!isAllDay(t) || !t.endDate) return { date: iso };
  const end = new Date((dayNumber(iso) + spanDays(t) - 1) * 86400000).toISOString().slice(0, 10);
  return { date: iso, endDate: end };
}

export function endPatch(t: Pick<Task, 'date'>, iso: string): Partial<Task> {
  return { endDate: iso > t.date ? iso : undefined };
}

const short = (iso: string) => `${Number(iso.slice(8, 10))}.${Number(iso.slice(5, 7))}`;

/** "כל היום · 2.11–7.11 · יום 1/6" / "All day · 2.11–7.11 · day 1/6". */
export function allDayLabel(t: Pick<Task, 'date' | 'endDate'>, iso: string, he: boolean): string {
  const head = he ? 'כל היום' : 'All day';
  if (spanDays(t) <= 1) return head;
  const { n, of } = dayOf(t, iso);
  return `${head} · ${short(t.date)}–${short(lastDay(t))} · ${he ? 'יום' : 'day'} ${n}/${of}`;
}

/** Google / Outlook all-day `end.date` is EXCLUSIVE; ours is inclusive. Undefined for one day. */
export function endFromExclusive(start: string, endExclusive?: string | null): string | undefined {
  if (!endExclusive || endExclusive <= start) return undefined;
  const last = new Date(dayNumber(endExclusive) * 86400000 - 86400000).toISOString().slice(0, 10);
  return last > start ? last : undefined;
}
