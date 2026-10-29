/**
 * hourRows — the rows of the drag ruler (components/today/HourRuler): every
 * half hour from now to the end of the day, each saying what is already there.
 * Pure.
 */
import type { Task } from '../types/index';
import { timeToMinutes } from './timeUtils';

export interface HourRow {
  start: string;
  /** What occupies this half hour, or '' when free. */
  busy: string;
}

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export function hourRows(tasks: Task[], nowMin: number, dayEnd = '23:00', step = 30, maxRows = 22): HourRow[] {
  let from = Math.ceil((nowMin + 5) / step) * step;
  // A bedtime after midnight (00:30) is the END of today, not 30 minutes into it.
  let end = timeToMinutes(dayEnd);
  if (end <= from || end < 6 * 60) end = 24 * 60;
  // Too many half hours for one screen → whole hours.
  let s = step;
  if ((end - from) / s > maxRows) { s = 60; from = Math.ceil((nowMin + 5) / 60) * 60; }
  const timed = tasks
    .filter((t) => !['complete', 'missed', 'moved'].includes(String(t.status)) && (t.fixedTime || t.scheduledTime))
    .map((t) => {
      const a = timeToMinutes((t.fixedTime || t.scheduledTime)!);
      return { a, b: a + (t.durationMinutes || 30), text: t.text };
    });
  const out: HourRow[] = [];
  for (let m = from; m < end; m += s) {
    const hit = timed.find((x) => x.a < m + s && x.b > m);
    out.push({ start: hhmm(m), busy: hit ? hit.text : '' });
  }
  return out;
}
