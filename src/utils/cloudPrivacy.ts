/**
 * cloudPrivacy — what a task may carry when it leaves the phone (7.10).
 *
 * Her choice: where she IS right now is used, never kept. Two fields broke it:
 *   - a re-plan "from where I am" stores the GPS fix as the route's origin,
 *     `transitPlan.originAddress = "32.0853,34.7818"` (LiveRoute);
 *   - "I left" stores `departedFromLat/Lng` (LiveRoute.confirmDeparture).
 * Both synced to Supabase and to the server on every edit — a trail of exact
 * positions with timestamps. They stay on the phone (encrypted, EncryptedStorage)
 * and are stripped here from every copy that goes to the cloud. A named origin
 * ("Home", an address she typed) is a plan, not a position, and is kept.
 *
 * 17.10: "will you leave tomorrow from here?" — a start she confirmed from her
 * position (utils/tripStart kind 'set') is the same thing in words: the place
 * NAME of where she stood (`originLabel`, and the "From <place>, as you said"
 * line of `routeWhy`) goes with the coordinates. The generic labels ("My
 * location now") name nothing and stay.
 */
import type { Task } from '../types/index';
import { SET_START_LINE_RE } from './tripStart';

const COORDS = /^\s*-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+\s*$/;

/** Labels that name no place — safe to keep next to a dropped GPS origin. */
const GENERIC_ORIGIN_LABELS = new Set(['My location now', 'המיקום שלי עכשיו', 'Where you said', 'המקום שאמרת']);

export function isBareCoords(s: unknown): boolean {
  return typeof s === 'string' && COORDS.test(s);
}

export function forCloud<T extends Partial<Task>>(task: T): T {
  if (!task || typeof task !== 'object') return task;
  const out: any = { ...task };
  delete out.departedFromLat;
  delete out.departedFromLng;
  const loc = out.location;
  if (loc && typeof loc === 'object') {
    let next = loc;
    if (loc.transitPlan && isBareCoords(loc.transitPlan.originAddress)) {
      const { originAddress: _drop, ...plan } = loc.transitPlan;
      if (plan.originLabel && !GENERIC_ORIGIN_LABELS.has(plan.originLabel)) delete plan.originLabel;
      next = { ...next, transitPlan: plan };
    }
    if (Array.isArray(loc.routeWhy) && loc.routeWhy.some((l: unknown) => typeof l === 'string' && SET_START_LINE_RE.test(l))) {
      next = { ...next, routeWhy: loc.routeWhy.filter((l: unknown) => !(typeof l === 'string' && SET_START_LINE_RE.test(l))) };
    }
    if (next !== loc) out.location = next;
  }
  return out as T;
}
