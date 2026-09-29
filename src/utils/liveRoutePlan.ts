/**
 * liveRoutePlan — the PURE decisions behind LiveRoute (which trip, from which
 * assumed origin). Split out so it imports without react-native and can be
 * tested on its own; the service in LiveRoute.ts owns the GPS read, the Google
 * fetch and the notification.
 */
import { Task, TransitPlan } from '../types/index';
import { LatLng } from './positionDrift';
import { addrOf, timeOf } from './dayPlanning';

/**
 * How long after a thing has STARTED it is still worth routing her to it.
 * Half of it, at most an hour: late for karaoke is still karaoke; an all-day
 * conference she skipped must not nag "leave now" until the evening.
 */
export function stillWorthGoingUntil(startMin: number, durationMinutes: number): number {
  return startMin + Math.min(60, Math.max(10, Math.round(durationMinutes / 2)));
}

/**
 * The trip a live re-plan would act on: the next pending, located, timed task
 * — including one that has already STARTED while she has not arrived.
 *
 * Koral, 28.9: "if I have a task now and I haven't left for it — my location
 * didn't change — update the leave time and the arrival accordingly." This
 * used to take only tasks at or after the current minute, so the moment the
 * appointment began she dropped out of every re-plan: the screen kept a leave
 * time from the past and an arrival that was no longer true. A started trip
 * stays the trip (earliest first, so it wins) until she arrives, ticks it, or
 * it is too far gone to be worth going (stillWorthGoingUntil).
 */
export function nextTrip(tasks: Task[], now: Date = new Date()): Task | undefined {
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const toMin = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  };
  return tasks
    .filter((t) => {
      // Already there. Re-planning a journey to a place she is standing in is
      // the bug this guard exists for: it produced a live travel card to a
      // building she was inside, and pushed the NEXT trip's origin back home.
      if (t.status !== 'pending' || t.verifiedArrival || !addrOf(t) || !timeOf(t)) return false;
      const start = toMin(timeOf(t)!);
      if (!Number.isFinite(start)) return false;
      return start >= nowMin || nowMin < stillWorthGoingUntil(start, t.durationMinutes || 30);
    })
    .sort((a, b) => (timeOf(a)! < timeOf(b)! ? -1 : 1))[0];
}

/**
 * Where the plan for a task assumed the user starts.
 *
 * A route records its own origin coordinates (`startLat`/`startLng`) once the
 * server or the chain set them. Absent that there is no assumed origin to
 * compare against; assessDrift treats a null origin as "re-plan from the real
 * fix", which is strictly better than planning from an unknown.
 */
export function assumedOrigin(task: Task): LatLng | null {
  const loc = task.location;
  const plan = (loc && typeof loc === 'object'
    ? (loc.transitPlan as (TransitPlan & { startLat?: number; startLng?: number }) | undefined)
    : undefined);
  if (plan && Number.isFinite(plan.startLat) && Number.isFinite(plan.startLng)) {
    return { lat: plan.startLat as number, lng: plan.startLng as number };
  }
  return null;
}

/** Current wall-clock as "HH:MM" in the app's local timezone. */
export function nowHHMM(now: Date = new Date()): string {
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

/**
 * Has the planned departure already passed while she is still at the origin?
 *
 * The plan says "leave by 17:18 for the 17:30 bus". If 17:18 comes and she has
 * not left, that bus is gone and the whole plan — departure, arrival, the lot —
 * is now fiction. This is the signal to recompute from the NEXT departure, and
 * it is separate from drift: drift fires when she MOVES, this fires when she
 * does NOT. `graceMinutes` avoids re-planning in the same minute the alert
 * fires (she may be walking out the door right now).
 */
export function missedPlannedDeparture(
  leaveHomeBy: string | undefined,
  now: Date = new Date(),
  graceMinutes = 0,
): boolean {
  if (!leaveHomeBy || !/^\d{1,2}:\d{2}$/.test(leaveHomeBy)) return false;
  const [h, m] = leaveHomeBy.split(':').map(Number);
  const leaveMins = h * 60 + m;
  const nowMins = now.getHours() * 60 + now.getMinutes();
  // Same-day only: a leave time that reads as "earlier" but is really tomorrow
  // (a 00:40 flight) is not something an evening loop should treat as missed.
  return nowMins > leaveMins + graceMinutes && nowMins - leaveMins < 12 * 60;
}

