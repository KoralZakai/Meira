/**
 * liveReplanDecision — when has the route on screen stopped being the route
 * she needs?
 *
 * The app already knew how to re-plan (LiveRoute) and already knew how to
 * measure a drift (positionDrift). What it did not have was ONE answer to the
 * question the user actually asked for, in her words:
 *
 *   "if location changed — show current location — and check the next task to
 *    occur; if location has changed and it's not the requested next location,
 *    recalculate the travel route to the next location. If user is late also
 *    need to recalculate (update time of bus, trains, driving...)"
 *
 * That is three triggers, not one, and until now only the middle one was wired
 * into the Today screen:
 *
 *   moved-off-origin   — she is somewhere other than where the shown route was
 *                        planned from. Every leave time on screen is then wrong
 *                        by exactly the distance she has moved.
 *   departure-missed   — the leave time passed and she did not go. The bus in
 *                        that plan has left; the plan is fiction.
 *   arriving-late      — the plan's OWN arrival is already after the
 *                        appointment. Nothing has to change for this to be
 *                        true: it can be true the moment it is computed.
 *
 * And two answers that are deliberately "do nothing", because doing something
 * would be worse:
 *
 *   already-there      — she is standing at the destination. Re-planning a
 *                        journey to a building she is inside is the exact bug
 *                        presence.ts was written to stop.
 *   no-fix             — re-planning from a position we do not have replaces a
 *                        correct plan with a guess.
 *
 * `cooling-down` is the rate limit, and it is reported as its own reason
 * rather than folded into "nothing to do": arriving-late stays true until a
 * better departure exists, so without a cooldown a late user would spend a
 * Google call every tick to be told the same thing. The caller can see the
 * difference between "on plan" and "would re-plan, but just did".
 *
 * Pure — the fix, the clock and the trip's own numbers are all passed in, so
 * tests/run-live-replan.ts drives every branch with no device and no network.
 */
import { LatLng, distanceMetres, DRIFT_THRESHOLD_METRES } from './positionDrift';
import { ARRIVAL_RADIUS_METRES } from './presence';
import { missedPlannedDeparture } from './liveRoutePlan';

export type ReplanReason =
  | 'moved-off-origin'
  | 'departure-missed'
  | 'arriving-late'
  | 'already-there'
  | 'cooling-down'
  | 'no-fix'
  | 'no-trip'
  | 'on-plan';

export interface ReplanDecision {
  /** True when the caller should recompute the route from the live position. */
  replan: boolean;
  reason: ReplanReason;
  /** Distance from the origin the shown route assumed, when both were known. */
  metres?: number;
}

/** Only what the decision needs from a task — so a test need not build a Task. */
export interface LiveTripFacts {
  /** Where she is going. */
  destination?: LatLng | null;
  /** Where the route currently on screen was planned FROM, if it stamped it. */
  plannedFrom?: LatLng | null;
  /** HH:MM the shown plan says to leave. */
  leaveHomeBy?: string;
  /** HH:MM the shown plan says she lands. */
  arriveAt?: string;
  /** HH:MM the thing actually starts. */
  appointment?: string;
}

/** Don't spend a routing call more often than this on the same trip. */
export const REPLAN_COOLDOWN_MS = 5 * 60 * 1000;

export function decideLiveReplan(input: {
  current?: LatLng | null;
  trip?: LiveTripFacts | null;
  /** Fallback origin: routes with no stamped origin were planned from home. */
  home?: LatLng | null;
  now?: Date;
  /** When this trip was last re-planned, for the cooldown. */
  lastReplanAt?: number;
  cooldownMs?: number;
  thresholdMetres?: number;
  arrivalRadiusMetres?: number;
}): ReplanDecision {
  const {
    current, trip, home,
    now = new Date(),
    lastReplanAt,
    cooldownMs = REPLAN_COOLDOWN_MS,
    thresholdMetres = DRIFT_THRESHOLD_METRES,
    arrivalRadiusMetres = ARRIVAL_RADIUS_METRES,
  } = input;

  if (!trip) return { replan: false, reason: 'no-trip' };

  const valid = (p?: LatLng | null): p is LatLng =>
    Boolean(p) && Number.isFinite(p!.lat) && Number.isFinite(p!.lng);

  if (!valid(current)) return { replan: false, reason: 'no-fix' };

  // She is there. No journey remains, whatever the clock says.
  if (valid(trip.destination)
    && distanceMetres(current, trip.destination) <= arrivalRadiusMetres) {
    return { replan: false, reason: 'already-there' };
  }

  // ── the three triggers, most specific first ──
  // "Moved" is checked before the clock ones because it is the one that
  // changes the ORIGIN; the other two keep the origin and ask for a later
  // departure from it.
  const origin = valid(trip.plannedFrom) ? trip.plannedFrom
    : (valid(home) ? home : null);
  const metres = origin ? Math.round(distanceMetres(origin, current)) : undefined;

  let reason: ReplanReason | null = null;
  if (origin && (metres as number) > thresholdMetres) {
    reason = 'moved-off-origin';
  } else if (missedPlannedDeparture(trip.leaveHomeBy, now)) {
    reason = 'departure-missed';
  } else if (trip.arriveAt && trip.appointment && trip.arriveAt > trip.appointment) {
    reason = 'arriving-late';
  }

  if (!reason) return { replan: false, reason: 'on-plan', metres };

  // A trigger fired — but not more often than the budget allows. Said as its
  // own reason so the caller can tell "nothing to do" from "not yet".
  if (lastReplanAt !== undefined
    && now.getTime() - lastReplanAt < cooldownMs) {
    return { replan: false, reason: 'cooling-down', metres };
  }

  return { replan: true, reason, metres };
}

/**
 * One line saying WHY the times just changed.
 *
 * A leave time that silently changes is not trustworthy — describeReplan in
 * positionDrift makes that argument for the "moved" case. These are the other
 * two, which that function had no words for.
 */
export function describeReplanReason(reason: ReplanReason, he: boolean): string {
  switch (reason) {
    case 'moved-off-origin':
      return he ? 'זזת ממקום המוצא — חישבתי מסלול מחדש' : "You've moved — re-routed from here";
    case 'departure-missed':
      return he ? 'זמן היציאה עבר — הנה האפשרות הבאה' : 'Departure time passed — next option';
    case 'arriving-late':
      return he ? 'ההגעה אחרי השעה — מחפשת מסלול מהיר יותר' : 'Arriving late — looking for a faster route';
    default:
      return '';
  }
}
