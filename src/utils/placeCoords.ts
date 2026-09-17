/**
 * placeCoords — a place the app cannot point at is not a place.
 *
 * Koral, 2026-09-17, on a yoga class she added at "צ׳ארלס קלור":
 * "it did understand that צ׳ארלס קלור is a place but didn't put it as a real
 * location on map — need to fix."
 *
 * She was exactly right, and the failure was narrower than it looked. The name
 * WAS understood: the server's find_place resolved it to Kaufmann Street, Tel
 * Aviv, which is where Charles Clore Park actually is. What was thrown away
 * were the COORDINATES.
 *
 *   - server/lumi_agent.infer_task_details called geo.find_place, kept
 *     `place["formatted"]`, and dropped the lat/lng sitting next to it;
 *   - the task therefore reached the phone with `location` as a bare string;
 *   - and every site that turns a string into a TaskLocation wrote the same
 *     placeholder:  { address: dest, lat: 0, lng: 0, confirmed: false }.
 *
 * 0,0 is in the Atlantic Ocean, off the coast of Ghana. RouteMap already knew
 * that and refused to drop a pin there — correctly; a pin in the wrong ocean
 * is worse than no pin. So the map stayed empty and nothing anywhere said why.
 *
 * Five call sites wrote that placeholder and NOTHING ever replaced it. That is
 * the actual defect: 0,0 was serving as "unknown" while being typed as a known
 * number, so no code could tell a real coordinate from a missing one, and no
 * code was ever prompted to go and find the real one.
 *
 * This module gives that sentinel a name and a resolution order, so the
 * decision is one rule in one place instead of five copies of a literal:
 *
 *   1. coordinates already on the location, IF they are real;
 *   2. the route's own destination — Google Directions already told us where
 *      the journey ends, so this costs nothing and is the most accurate
 *      answer available;
 *   3. nothing. Say so, and let the caller geocode. Never invent 0,0 again.
 *
 * Pure: no network, no storage. tests/run-place-coords.ts drives every branch.
 */
import { TaskLocation, TransitPlan } from '../types/index';

export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * Is this a coordinate the app can actually point at?
 *
 * Null Island (0,0) is the placeholder, not a location. Treating it as one is
 * how a yoga class in Tel Aviv acquired a position in the Gulf of Guinea.
 * RouteMap carried a private copy of this test; it now reads this one, so the
 * map and the planner can never disagree about what "we know where it is"
 * means.
 */
export function hasRealCoords(lat?: number | null, lng?: number | null): boolean {
  return Number.isFinite(lat as number)
    && Number.isFinite(lng as number)
    && ((lat as number) !== 0 || (lng as number) !== 0);
}

/** The same test against a stored location. */
export function locationIsPlaced(loc?: Partial<TaskLocation> | null): boolean {
  return hasRealCoords(loc?.lat, loc?.lng);
}

/**
 * Where this place really is, from everything currently known — or null when
 * the honest answer is "not yet".
 *
 * Returning null is the point. The previous behaviour had no way to express
 * it, so it expressed it as 0,0 and every consumer downstream believed it.
 */
export function pickCoords(
  existing?: Partial<TaskLocation> | null,
  plan?: Partial<TransitPlan> | null,
): LatLng | null {
  if (locationIsPlaced(existing)) {
    return { lat: existing!.lat as number, lng: existing!.lng as number };
  }
  // Google already routed us to the door. Its end point IS the destination,
  // and it arrived in the same response the travel time came from.
  if (hasRealCoords(plan?.destLat, plan?.destLng)) {
    return { lat: plan!.destLat as number, lng: plan!.destLng as number };
  }
  return null;
}

/**
 * True when this location still needs a geocode before anything can draw it.
 *
 * A location with an address and no real coordinates is the exact shape that
 * produced the empty map. A location with no address at all is not missing
 * coordinates — it is missing a place, which is a different problem and a
 * different question to ask.
 */
export function needsGeocode(loc?: Partial<TaskLocation> | null): boolean {
  if (!loc) return false;
  const address = (loc.address || loc.displayName || '').trim();
  return Boolean(address) && !locationIsPlaced(loc);
}

/**
 * Build the location to store, filling in coordinates from whatever is known
 * and leaving the OLD ones alone when nothing better turned up.
 *
 * `base` may carry a stale 0,0 from before this fix. That placeholder is
 * preserved rather than cleared, because clearing it would break the
 * `lat: number` contract that eighty-odd call sites rely on — and because a
 * placeholder that `locationIsPlaced` can recognise is strictly better than a
 * missing field that reads as `undefined` in arithmetic. What matters is that
 * a REAL coordinate now overwrites it the moment one exists.
 */
export function placeLocation<T extends Partial<TaskLocation>>(
  base: T, plan?: Partial<TransitPlan> | null, geocoded?: LatLng | null,
): T {
  const found = pickCoords(base, plan) ?? (hasRealCoords(geocoded?.lat, geocoded?.lng)
    ? { lat: geocoded!.lat, lng: geocoded!.lng }
    : null);
  if (!found) return base;
  return { ...base, lat: found.lat, lng: found.lng };
}
