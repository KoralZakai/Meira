/**
 * timelineNow — where "now" sits on the day, as a fraction.
 *
 * The timeline drew the day but never drew the moment. On a 09:00–18:00
 * conference that is the difference between a block and a block you are three
 * hours into: the schedule was accurate and still could not answer "where am I
 * in this?".
 *
 * Pure so the arithmetic is testable without a clock or a renderer; the pulse
 * and the pixels live in components/DayTimeline.
 */
import { timeToMinutes } from './timeUtils';

export interface NowInBlock {
  /** True when `now` falls inside [start, end). */
  active: boolean;
  /** How far through, 0..1. 0 when not active. */
  progress: number;
  /** Minutes remaining, for "3h 10m left". 0 when not active. */
  minutesLeft: number;
}

/**
 * Where `now` falls inside one block.
 *
 * A zero-length block is never "active": it has no inside to be in, and
 * dividing by its length is how a progress bar becomes NaN.
 */
export function nowInBlock(
  nowHHMM: string | undefined,
  startHHMM: string | undefined,
  endHHMM: string | undefined,
): NowInBlock {
  const idle = { active: false, progress: 0, minutesLeft: 0 };
  if (!nowHHMM || !startHHMM || !endHHMM) return idle;
  const now = timeToMinutes(nowHHMM);
  const start = timeToMinutes(startHHMM);
  const end = timeToMinutes(endHHMM);
  if (![now, start, end].every(Number.isFinite)) return idle;
  if (end <= start) return idle;
  if (now < start || now >= end) return idle;
  const span = end - start;
  return {
    active: true,
    progress: Math.min(1, Math.max(0, (now - start) / span)),
    minutesLeft: end - now,
  };
}

/** "3h 10m left" / "נותרו 3ש׳ 10ד׳" — short, for the indicator's label. */
export function describeRemaining(minutesLeft: number, he: boolean): string {
  if (minutesLeft <= 0) return '';
  const h = Math.floor(minutesLeft / 60);
  const m = minutesLeft % 60;
  const en = h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
  const heb = h ? (m ? `${h}ש׳ ${m}ד׳` : `${h}ש׳`) : `${m}ד׳`;
  return he ? `נותרו ${heb}` : `${en} left`;
}
