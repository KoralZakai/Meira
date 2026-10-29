/**
 * returnHome — "when do I get home?" (21.10, Koral: "tomorrow I have a trip to Assaf
 * Harofe in the morning — when do I get back? Rule: if nothing in the calendar follows
 * a task, assume she goes home, and work out the route and about when she arrives").
 *
 * The last timed task of the day, when it is somewhere she TRAVELS to and nothing
 * follows it, gets a "back home" row: she leaves when it ends and the way takes about
 * as long as the way there did (same place, same vehicle). An estimate, said as one
 * ("~"): no Directions call, so it exists the moment the day does.
 *
 * Pure. tests/run-return-home.ts.
 */
import type { Task } from '../types/index';
import { addrOf, locOf } from './dayPlanning';
import { isRemoteTask } from './meetingLink';
import { addMinutes, timeToMinutes } from './timeUtils';

export interface HomeReturn {
  /** The task she leaves from. */
  fromId: string;
  fromTitle: string;
  /** When she leaves: the task's end. HH:MM */
  leaveAt: string;
  /** About when she is home. HH:MM */
  arriveAt: string;
  minutes: number;
  mode?: string;
}

/** The task Meira makes for the way home (services/ReturnHomeTasks): `home-return-<the trip it leaves from>`. */
export const RETURN_HOME_PREFIX = 'home-return-';
export const returnHomeId = (fromId: string): string => `${RETURN_HOME_PREFIX}${fromId}`;
export const isReturnHomeTask = (t: { id?: string }): boolean => String(t?.id || '').startsWith(RETURN_HOME_PREFIX);

const norm = (s: string): string => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const startOf = (t: Task): string => t.fixedTime || t.scheduledTime || '';
// Capped at 23:59: addMinutes wraps at midnight, so a trip ending at 24:00 would "leave" at 00:00 — the day's start.
const endOf = (t: Task): string => {
  const end = timeToMinutes(startOf(t)) + (t.durationMinutes || 30);
  return end >= 24 * 60 ? '23:59' : addMinutes(startOf(t), t.durationMinutes || 30);
};

/** Is this place her own home? (Same street line; a different city is not.) */
function atHome(t: Task, homeAddress?: string | null): boolean {
  const a = norm(addrOf(t) || '');
  const h = norm(homeAddress || '');
  return Boolean(a && h && (a === h || a.includes(h) || h.includes(a)));
}

/** Why the day has no way home — said, never silent (rule 1). */
export type NoReturnHome =
  | { why: 'no_trip' }                                     // nothing away from home that day
  | { why: 'later_has_place'; byId: string; byTitle: string } // another trip follows: the chain plans that leg
  | { why: 'no_minutes'; fromId: string; fromTitle: string }; // no way there on record: no honest estimate back

export function returnHomeWhy(
  tasks: Task[], date: string, homeAddress?: string | null,
): { ret: HomeReturn } | NoReturnHome {
  const day = (tasks || [])
    .filter((t) => !isReturnHomeTask(t))
    // A cancelled / postponed trip ('missed') is not made, so no way home is owed for it (28.10).
    .filter((t) => t.date === date && !['complete', 'moved', 'missed'].includes(String(t.status)) && startOf(t))
    .sort((a, b) => timeToMinutes(startOf(a)) - timeToMinutes(startOf(b)));
  // The last trip she makes AWAY from home. What comes after it decides whether a way home is
  // still owed: another trip away, or a task AT home (the travel chain plans that trip itself),
  // means no; a task with no place at all (study, a call) means she is home by then — and still
  // has to GET there, so the way home stays.
  const isAway = (t: Task) => !isRemoteTask(t as any) && Boolean(addrOf(t)) && !atHome(t, homeAddress);
  const awayIdx = day.map(isAway).lastIndexOf(true);
  if (awayIdx < 0) return { why: 'no_trip' };
  const last = day[awayIdx];
  const byPlace = day.slice(awayIdx + 1).find((t) => Boolean(addrOf(t)));
  if (byPlace) return { why: 'later_has_place', byId: byPlace.id, byTitle: byPlace.text };
  const loc: any = locOf(last);
  const minutes: number | undefined = loc?.transitPlan?.totalDurationMinutes ?? loc?.travelMinutes;
  if (!minutes || minutes <= 0 || !Number.isFinite(minutes)) return { why: 'no_minutes', fromId: last.id, fromTitle: last.text };
  const leaveAt = endOf(last);
  return {
    ret: {
      fromId: last.id, fromTitle: last.text, leaveAt,
      arriveAt: addMinutes(leaveAt, Math.round(minutes)), minutes: Math.round(minutes),
      mode: loc?.transportType,
    },
  };
}

export function returnHomeFor(
  tasks: Task[], date: string, homeAddress?: string | null,
): HomeReturn | null {
  const r = returnHomeWhy(tasks, date, homeAddress);
  return 'ret' in r ? r.ret : null;
}

export function homeReturnLine(r: HomeReturn, he: boolean): string {
  return he
    ? `🏠 בדרך הביתה · יציאה ${r.leaveAt} · בבית ~${r.arriveAt}`
    : `🏠 Heading home · leave ${r.leaveAt} · home ~${r.arriveAt}`;
}
