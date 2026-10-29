/**
 * routineOrigin — "after the meeting you have yoga at 19:00 on Igal Alon. Home first, or straight there?"
 * (21.10, Koral: the way home ignored a routine later the same day — "Meira should ask!").
 *
 * A routine is not a task until she taps "Going", so the day's last trip got a way home
 * even when she was plainly heading to the routine from there. Whether she goes home in
 * between is HERS to say, not ours to guess: Meira asks once per (day, trip, routine)
 * and remembers.
 *
 *   'home'    → the way home stays, and the routine is planned from home (today's behaviour)
 *   'skip'    → she is not going today: the routine is waved off for that date ("Not today") and the way home stays
 *   'direct'  → no way home after that trip; she goes on to the routine from where she is
 *   no answer → the way home stays (the safe default) and the question is open
 *
 * Pure. tests/run-routine-origin.ts. Wiring: questions/kinds/routineOrigin.ts (asks),
 * services/ReturnHomeTasks (reads the answer).
 */
import type { Task } from '../types/index';
import { returnHomeFor, type HomeReturn } from './returnHome';
import type { RoutineRow } from './routineRows';
import { timeToMinutes } from './timeUtils';

export const ROUTINE_ORIGIN_KIND = 'routineOrigin' as const;
export type RoutineOriginChoice = 'direct' | 'home' | 'skip';

export const routineOriginKey = (date: string, fromId: string, routineKey: string): string =>
  `${ROUTINE_ORIGIN_KIND}:${date}:${fromId}:${routineKey}`;

export interface RoutineOriginData {
  date: string;
  /** The last trip of the day before the routine: the one a way home would leave from. */
  fromId: string;
  fromTitle: string;
  /** When that trip ends (HH:MM). */
  fromEnd: string;
  routineKey: string;
  routineTitle: string;
  routineStart: string;
  routineAddress: string;
}

/**
 * The routine that follows the day's last trip, if one has a place and starts after
 * that trip ends. null when there is no trip owed a way home or no such routine.
 * Only the FIRST such routine counts: it is the one she would head to.
 */
export function routineAfterLastTrip(
  tasks: Task[], rows: RoutineRow[], date: string, home?: string | null,
): { ret: HomeReturn; row: RoutineRow } | null {
  const ret = returnHomeFor(tasks, date, home);
  if (!ret) return null;
  const end = timeToMinutes(ret.leaveAt);
  const row = rows
    .filter((r) => Boolean(r.address) && timeToMinutes(r.start) >= end)
    .sort((a, b) => timeToMinutes(a.start) - timeToMinutes(b.start))[0];
  return row ? { ret, row } : null;
}

export type RoutineOriginNoAsk = 'no_trip' | 'answered';

/** The question for one day, or why there is none. `answers` = the stored choices by key. */
export function decideRoutineOrigin(a: {
  date: string; tasks: Task[]; rows: RoutineRow[]; home?: string | null;
  answers: Record<string, RoutineOriginChoice | undefined>;
}): { ask: true; data: RoutineOriginData } | { ask: false; reason: RoutineOriginNoAsk } {
  const hit = routineAfterLastTrip(a.tasks, a.rows, a.date, a.home);
  if (!hit) return { ask: false, reason: 'no_trip' };
  const key = routineOriginKey(a.date, hit.ret.fromId, hit.row.key);
  if (a.answers[key]) return { ask: false, reason: 'answered' };
  return {
    ask: true,
    data: {
      date: a.date, fromId: hit.ret.fromId, fromTitle: hit.ret.fromTitle, fromEnd: hit.ret.leaveAt,
      routineKey: hit.row.key, routineTitle: hit.row.title, routineStart: hit.row.start,
      routineAddress: hit.row.address as string,
    },
  };
}

/** True when she said "straight there" for the routine that follows this day's last trip. */
export function goesStraightToRoutine(
  tasks: Task[], rows: RoutineRow[], date: string, home: string | null | undefined,
  answers: Record<string, RoutineOriginChoice | undefined>,
): boolean {
  const hit = routineAfterLastTrip(tasks, rows, date, home);
  return Boolean(hit && answers[routineOriginKey(date, hit.ret.fromId, hit.row.key)] === 'direct');
}
