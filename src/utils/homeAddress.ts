/**
 * homeAddress — a new home address is believed only as far as it was said.
 *
 * 13.10: her home, "21, Mordei ha-Geta'ot Street, Tel Aviv-Yafo", was re-said
 * in the first meeting as "מורדי הגטאות 23". No city. The geocoder picked the
 * Mordey HaGeta'ot Street it liked best — in Be'er Sheva — and nothing
 * compared that with where her home had been a minute before. The day's Haifa
 * interview was then routed from Be'er Sheva: leave 08:58, 212 minutes, four
 * buses, for a 13:00 meeting she could reach by train from Tel Aviv.
 *
 * Two rules, both about what she did NOT say:
 *   1. A home with no city keeps the city of the home before it.
 *   2. A fix that lands far from the old home, for an address that names no
 *      town, is the geocoder's guess, not a move: the old coordinates stay,
 *      and the log says so. Naming a town ("…, חיפה") is how she moves.
 *
 * Pure. Consumed by services/UserProfileStorage.saveProfile; tested by
 * tests/run-home-address.ts.
 */
import { completeAddress, namesACity, cityOf } from './addressCompletion';
import { straightKm } from './travelLadder';

type LatLng = { lat: number; lng: number };

/** Further than this from the old home, with no town named, is not believed. */
export const HOME_JUMP_KM = 25;

/** The address to store and geocode: completed with the old home's city when it names none. */
export function settleHome(next: string, before?: string | null): string {
  const s = String(next || '').trim();
  if (!s || !before || cityOf(s) || namesACity(s)) return s;
  return completeAddress(s, before);
}

/**
 * The coordinates to keep for the new home. `null` from the geocoder stays
 * null (the caller already says "no coordinates"); a jump to another town for
 * an address that names none keeps the old fix.
 */
export function trustHomeFix(placed: LatLng | null, address: string, before: LatLng | null): LatLng | null {
  if (!placed || !before) return placed;
  const km = straightKm(placed, before);
  // A town written after a comma counts too — a move to a small town this file has never heard of is still a move.
  if (km !== undefined && km > HOME_JUMP_KM && !namesACity(address) && !cityOf(address)) {
    console.warn(`[homeAddress] "${address}" geocoded ${Math.round(km)} km from the old home with no town named — kept the old coordinates`);
    return before;
  }
  return placed;
}
