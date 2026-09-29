/**
 * leaveCountdown — how long until she leaves, counted across DAYS.
 *
 * Koral, 2026-09-22, looking at tomorrow's interview: the Leave-Now screen
 * showed a red **LATE BY 165 min** badge over a route that was perfectly on
 * time. The journey leaves at 13:18 TOMORROW; it was 16:03 today. 16:03 − 13:18
 * is 165 minutes, and the screen had no idea those were different days:
 *
 *     const minutesLeft =
 *       timeToMinutes(leaveStep.time) - (now.getHours() * 60 + now.getMinutes());
 *     const late = minutesLeft < 0;
 *
 * Clock arithmetic with the calendar thrown away. Every future trip read as
 * missed, in red, on the one screen whose whole job is telling her whether she
 * is about to miss something. CLAUDE.md rule 4: data from another day must show
 * that day — and it certainly must not be judged by this day's clock.
 *
 * Pure, so tests/run-leave-countdown.ts covers it with no device and no clock.
 */
import { AppLanguage } from '../types/index';

/** Minutes from `now` until `hhmm` on `dateISO`. Negative means it has gone. */
export function minutesUntilDeparture(
  dateISO: string | undefined,
  hhmm: string | undefined,
  now: Date,
): number | null {
  if (!hhmm) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const [hh, mm] = [Number(m[1]), Number(m[2])];
  if (hh > 23 || mm > 59) return null;

  // No date is NOT "today" by default — that assumption is the bug. A step
  // with no day attached cannot be judged late, so it is not judged at all.
  if (!dateISO || !/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return null;

  const [y, mo, d] = dateISO.split('-').map(Number);
  // Local calendar, like every other date key in this app. Built field by
  // field rather than parsed from a string so no timezone suffix can creep in.
  const departure = new Date(y, mo - 1, d, hh, mm, 0, 0);
  return Math.round((departure.getTime() - now.getTime()) / 60_000);
}

/**
 * Is she actually late — meaning the departure is behind her?
 *
 * Only ever true for a departure that has genuinely passed. A trip on a later
 * date is never late, however small the clock difference looks.
 */
export function isLate(minutesLeft: number | null): boolean {
  return minutesLeft !== null && minutesLeft < 0;
}

/**
 * The countdown as words. "165 min" is fine for the next hour and absurd for
 * tomorrow — a number without a unit she can feel is not information.
 */
export function formatCountdown(
  minutesLeft: number,
  lang: AppLanguage,
): { value: string; unit: string } {
  const he = lang === 'he';
  const total = Math.abs(minutesLeft);
  if (total < 60) return { value: String(total), unit: he ? 'דק׳' : 'min' };
  const hours = Math.floor(total / 60);
  if (hours < 24) {
    const mins = total % 60;
    return {
      value: mins ? `${hours}:${String(mins).padStart(2, '0')}` : String(hours),
      unit: he ? 'שעות' : mins ? 'hrs' : 'hr',
    };
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return {
    value: restHours ? `${days}d ${restHours}h` : String(days),
    unit: he ? 'ימים' : days === 1 && !restHours ? 'day' : 'days',
  };
}

/**
 * The label above the number.
 *
 * Three states, not two. "leave in" and "late by" were the whole vocabulary,
 * so a trip two days out had to be described as one of them.
 */
export function countdownLabel(
  minutesLeft: number | null,
  lang: AppLanguage,
): string {
  const he = lang === 'he';
  if (minutesLeft === null) return he ? 'אין שעת יציאה' : 'NO LEAVE TIME';
  if (minutesLeft < 0) return he ? 'איחור' : 'LATE BY';
  return he ? 'לצאת בעוד' : 'LEAVE IN';
}
