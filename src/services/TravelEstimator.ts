/**
 * TravelEstimator — how long it takes to get from one place to another, with
 * an answer for every case including "we cannot ask Google right now".
 *
 * Two callers needed exactly this and had grown their own half of it: the
 * feasibility answer ("can I fit two hours in Haifa at 14:00?") and the free
 * window suggestions ("the gym is 25 minutes away — this hour doesn't hold
 * it"). One copy, one cache.
 *
 * Three levels of answer, in order:
 *   1. Google Directions for that date, hour and mode (RoutePlanner).
 *   2. A straight-line estimate from the two coordinates, scaled per mode.
 *      Rough, and flagged as such — but a rough number is what stops Lumi
 *      scheduling a study block for the minute the gym ends, which is the
 *      failure that not knowing produces.
 *   3. null — no key, no coordinates, no addresses. The caller must SAY it
 *      could not check rather than assume the road is clear.
 *
 * The cache is per (from, to, mode, date, hour) and lives for ten minutes:
 * opening four slots in a row must not mean four Directions calls for the
 * same trip, and traffic does not change meaningfully inside ten minutes.
 *
 * Dependencies: RoutePlanner, types. Consumed by GapFillService,
 * ScheduleQueryService.
 */
import { TransportType, UserProfile } from '../types/index';
import { getPlanForMode } from './RoutePlanner';

export interface TravelPoint {
  address?: string;
  lat?: number;
  lng?: number;
}

export interface TravelEstimate {
  minutes: number;
  /** 'route' = Google for that hour; 'estimate' = straight line, scaled. */
  source: 'route' | 'estimate';
}

/** Average door-to-door km/h by mode — deliberately pessimistic (city, stops). */
const SPEED_KMH: Record<TransportType, number> = {
  walk: 4.5,
  bike: 13,
  bus: 18,
  train: 30,
  car: 28,
};

/** Straight-line km underestimates the road; this is the usual correction. */
const ROAD_FACTOR = 1.35;
const CACHE_TTL_MS = 10 * 60 * 1000;

const cache = new Map<string, { value: TravelEstimate | null; at: number }>();

/** Clear the memoised trips (tests, and a manual "recalculate"). */
export function clearTravelCache(): void {
  cache.clear();
}

function haversineKm(a: Required<Pick<TravelPoint, 'lat' | 'lng'>>, b: Required<Pick<TravelPoint, 'lat' | 'lng'>>): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

/** Level 2: minutes from the coordinates alone. Exported for tests. */
export function roughMinutes(from: TravelPoint, to: TravelPoint, mode: TransportType): number | null {
  if (typeof from.lat !== 'number' || typeof from.lng !== 'number'
    || typeof to.lat !== 'number' || typeof to.lng !== 'number') return null;
  const km = haversineKm(
    { lat: from.lat, lng: from.lng },
    { lat: to.lat, lng: to.lng },
  ) * ROAD_FACTOR;
  if (km < 0.15) return 0;
  return Math.max(5, Math.round((km / SPEED_KMH[mode]) * 60));
}

const same = (a?: string, b?: string) =>
  Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());

/**
 * Minutes from `from` to `to`, arriving by `arriveBy` on `date`.
 *
 * Returns null only when neither a route nor an estimate is possible. Same
 * place → 0, which is what makes "two things at the same address" free.
 */
export async function travelBetween(
  from: TravelPoint | undefined,
  to: TravelPoint | undefined,
  arriveBy: string,
  date: string,
  profile: UserProfile | null,
): Promise<TravelEstimate | null> {
  if (!from || !to) return null;
  if (same(from.address, to.address)) return { minutes: 0, source: 'route' };
  if (typeof from.lat === 'number' && typeof to.lat === 'number') {
    const near = roughMinutes(from, to, 'walk');
    if (near === 0) return { minutes: 0, source: 'estimate' };
  }

  const mode: TransportType = profile?.transportType || 'bus';
  const key = `${from.address ?? `${from.lat},${from.lng}`}|${to.address ?? `${to.lat},${to.lng}`}|${mode}|${date}|${arriveBy}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  let value: TravelEstimate | null = null;

  if (from.address && to.address && profile) {
    // RoutePlanner routes FROM the profile's home, so a trip starting anywhere
    // else is asked by handing it a profile whose home IS that start — the
    // same swap GoogleSync.ensureTravelChain makes for multi-stop days.
    const plan = await getPlanForMode(
      mode,
      to.address,
      arriveBy,
      { ...profile, homeAddress: from.address, homeLat: undefined, homeLng: undefined } as unknown as UserProfile,
      date,
    ).catch(() => null);
    if (plan) value = { minutes: plan.totalDurationMinutes, source: 'route' };
  }

  if (!value) {
    const rough = roughMinutes(from, to, mode);
    if (rough !== null) value = { minutes: rough, source: 'estimate' };
  }

  cache.set(key, { value, at: Date.now() });
  return value;
}

// Self-check: npx tsx src/services/TravelEstimator.ts
if (typeof require !== 'undefined' && require.main === module) {
  // Tel Aviv centre → Herzliya, about 13 km of road.
  const minutes = roughMinutes(
    { lat: 32.0853, lng: 34.7818 },
    { lat: 32.1624, lng: 34.8443 },
    'car',
  );
  console.assert(minutes !== null && minutes > 15 && minutes < 60, `plausible drive, got ${minutes}`);
  console.assert(roughMinutes({ lat: 32.0853, lng: 34.7818 }, { lat: 32.0853, lng: 34.7818 }, 'walk') === 0,
    'the same spot takes no time');
  console.log('TravelEstimator self-check OK:', minutes, 'min by car');
}
