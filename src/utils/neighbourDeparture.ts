/**
 * neighbourDeparture — "‹ earlier · later ›" on a trip, like Moovit.
 *
 * Koral, 13.10: "you chose a train that arrives too early for me and I want to
 * see later". The card showed one journey and no way to look at the next one.
 * The arrows step through the timetable ONE departure at a time from the
 * journey on the card; nothing is saved until she picks one.
 *
 * Pure: plans in, the neighbour out. The Google probing is
 * RoutePlanner.getNeighbourDeparture; tests/run-neighbour-departure.ts drives
 * this with no network.
 */
import { TransitPlan } from '../types/index';
import { checkPlan } from './planIntegrity';
import { railCarries } from './transitFallback';

export type StepDir = 'earlier' | 'later';

const rides = (p: TransitPlan) => (p.legs ?? []).filter((l) => l.type !== 'walk');

/** The ride that carries the journey — the longest one. A feeder bus is not it. */
export function mainRide(p: TransitPlan) {
  return [...rides(p)].sort((a, b) => (b.durationMinutes ?? 0) - (a.durationMinutes ?? 0))[0];
}

/** "The same train": a later feeder bus to the 10:34 is still the 10:34. */
export function sameMainRide(a: TransitPlan, b: TransitPlan): boolean {
  const x = mainRide(a);
  const y = mainRide(b);
  if (!x || !y) return false;
  return x.type === y.type && (x.lineNumber ?? '') === (y.lineNumber ?? '') && x.departureTime === y.departureTime;
}

/**
 * The next journey after (or the last before) `current`.
 *
 * Same kind first: stepping from a train should show the next TRAIN, not a bus
 * that happens to leave a minute later. When no plan of that kind came back,
 * the nearest of any kind is better than "nothing" — the card names the vehicle.
 */
export function pickNeighbour(
  plans: (TransitPlan | null | undefined)[],
  current: TransitPlan,
  dir: StepDir,
): TransitPlan | null {
  const ok = plans.filter((p): p is TransitPlan => Boolean(p && p.leaveHomeAt && p.arriveAt && checkPlan(p).ok))
    .filter((p) => !sameMainRide(p, current))
    .filter((p) => (dir === 'later'
      ? p.leaveHomeAt > current.leaveHomeAt && p.arriveAt >= current.arriveAt
      : p.leaveHomeAt < current.leaveHomeAt && p.arriveAt <= current.arriveAt));
  if (!ok.length) return null;
  const rail = railCarries(current);
  const sameKind = ok.filter((p) => railCarries(p) === rail);
  const pool = sameKind.length ? sameKind : ok;
  // Later: the soonest of the later ones. Earlier: the latest of the earlier ones.
  const sorted = [...pool].sort((a, b) => (dir === 'later'
    ? a.leaveHomeAt.localeCompare(b.leaveHomeAt) || a.arriveAt.localeCompare(b.arriveAt)
    : b.arriveAt.localeCompare(a.arriveAt) || b.leaveHomeAt.localeCompare(a.leaveHomeAt)));
  return sorted[0];
}

/** Minutes early (+) or late (−) against the appointment; undefined when unknowable. */
export function earlyBy(plan: TransitPlan, appointment?: string): number | undefined {
  if (!appointment || !/^\d{1,2}:\d{2}$/.test(appointment) || !/^\d{1,2}:\d{2}$/.test(plan.arriveAt)) return undefined;
  const m = (s: string) => Number(s.split(':')[0]) * 60 + Number(s.split(':')[1]);
  return m(appointment) - m(plan.arriveAt);
}

/**
 * "🚆 10:34 → 12:07 · 53 דק׳ מוקדם" — the line the arrows step through.
 *
 * The arrow follows the direction the line is READ in: a Hebrew line is a
 * right-to-left paragraph (Android picks the direction from the first strong
 * letter, and the Hebrew tail is one), so "from → to" runs leftwards and the
 * arrow must be ← — the same call OverlapPick makes for "X ← 14:30". → and ←
 * are not mirrored by the bidi algorithm, so the glyph is what is drawn.
 */
export function neighbourLine(plan: TransitPlan, appointment: string | undefined, he: boolean): string {
  const icon = railCarries(plan) ? '🚆' : rides(plan).length ? '🚌' : '🚶';
  const e = earlyBy(plan, appointment);
  const tail = e === undefined ? ''
    : e >= 0 ? (he ? ` · ${e} דק׳ מוקדם` : ` · ${e} min early`)
      : (he ? ` · ${-e} דק׳ איחור` : ` · ${-e} min late`);
  return `${icon} ${plan.leaveHomeAt} ${he ? '←' : '→'} ${plan.arriveAt}${tail}`;
}
