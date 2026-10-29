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
 * WHICH VEHICLE is not a stored setting read once: it is the travel ladder
 * (utils/travelLadder) — car if she has one and drives; otherwise walk a short
 * hop, public transport (direct train › bus, whatever arrives in time), then a
 * bike or scooter if the ride is short, then her car or a taxi. It used to ask
 * for her one stored vehicle, so "train" plus a place no train reaches came
 * back as "I couldn't check the travel time".
 *
 * Dependencies: RoutePlanner, travelLadder, transitFallback. Consumed by
 * GapFillService, ScheduleQueryService.
 */
import { TransitPlan, TransportType, UserProfile } from '../types/index';
import { getPlanForMode } from './RoutePlanner';
import {
  LadderChoice, ReasonStep, TravelRung, hasCarOf, rungMode, straightKm, walkLadder,
} from '../utils/travelLadder';
import { pickByPreference } from '../utils/transitFallback';

export interface TravelPoint {
  address?: string;
  lat?: number;
  lng?: number;
}

export interface TravelEstimate {
  minutes: number;
  /** 'route' = Google for that hour; 'estimate' = straight line, scaled. */
  source: 'route' | 'estimate';
  /** The vehicle that answered (a taxi is stored as 'car'). */
  mode?: TransportType;
  /** Which rung of the ladder answered. */
  rung?: TravelRung;
  /** False when even the best way gets her there late. */
  inTime?: boolean;
  /** Said when the ladder had to step down from what she prefers. */
  noteEn?: string;
  noteHe?: string;
  /** Why this vehicle — thought / action / observation. */
  steps?: ReasonStep[];
}

export interface TravelOptions {
  /** Someone is holding the slot (interview, doctor, must): a taxi is a real option. */
  highStakes?: boolean;
}

/** Average door-to-door km/h by mode — deliberately pessimistic (city, stops). */
const SPEED_KMH: Record<TransportType, number> = {
  walk: 4.5,
  bike: 13,
  bus: 18,
  train: 30,
  car: 28,
};

/**
 * Minutes every trip of this kind costs before the vehicle moves (13.10, Koral:
 * "many times it said 10-15 minutes and it took 40"). A straight line at bus
 * speed is only the ride: walking to the stop, waiting for the bus and
 * walking from the last stop are the other half of a city bus trip, and none
 * of it was counted. A car parks.
 */
const OVERHEAD_MIN: Record<TransportType, number> = {
  walk: 0,
  bike: 3,
  bus: 15,     // ~5 walk to the stop + ~7 wait + ~3 from the last stop
  train: 22,   // to the station, the wait, from the station
  car: 7,      // finding parking and walking from it
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
  return Math.max(5, Math.round((km / SPEED_KMH[mode]) * 60) + OVERHEAD_MIN[mode]);
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
  opts: TravelOptions = {},
): Promise<TravelEstimate | null> {
  if (!from || !to) return null;
  if (same(from.address, to.address)) {
    return { minutes: 0, source: 'route', steps: [{ thought: 'Same address — no trip.' }] };
  }
  if (typeof from.lat === 'number' && typeof to.lat === 'number') {
    const near = roughMinutes(from, to, 'walk');
    if (near === 0) return { minutes: 0, source: 'estimate', steps: [{ thought: 'Same spot — no trip.' }] };
  }

  const preferred: TransportType = profile?.transportType || 'bus';
  const hasCar = hasCarOf(profile as any);
  const km = straightKm(from, to);
  const key = `${from.address ?? `${from.lat},${from.lng}`}|${to.address ?? `${to.lat},${to.lng}`}`
    + `|${preferred}|${hasCar}|${opts.highStakes ? 1 : 0}|${date}|${arriveBy}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  let value: TravelEstimate | null = null;
  let choice: LadderChoice | null = null;

  if (from.address && to.address && profile) {
    // RoutePlanner routes FROM the profile's home, so a trip starting anywhere
    // else is asked by handing it a profile whose home IS that start — the
    // same swap GoogleSync.ensureTravelChain makes for multi-stop days.
    const origin = {
      ...profile, homeAddress: from.address, homeLat: undefined, homeLng: undefined,
    } as unknown as UserProfile;
    const dest = to.address;
    const ask = async (rung: TravelRung): Promise<TransitPlan | null> => {
      if (rung === 'transit') {
        // Direct train › direct bus › mixed, in time first — the ranking the
        // route chain uses, over both vehicle queries at once.
        const [rail, bus] = await Promise.all([
          getPlanForMode('train', dest, arriveBy, origin, date).catch(() => null),
          getPlanForMode('bus', dest, arriveBy, origin, date).catch(() => null),
        ]);
        const plans = [rail, bus].filter((p): p is TransitPlan => Boolean(p));
        return pickByPreference(plans, arriveBy)?.plan ?? null;
      }
      return getPlanForMode(rungMode(rung, preferred), dest, arriveBy, origin, date).catch(() => null);
    };
    choice = await walkLadder(
      { preferred, hasCar, km, highStakes: Boolean(opts.highStakes) }, arriveBy, ask,
    );
    if (choice) {
      value = {
        minutes: choice.plan.totalDurationMinutes,
        source: 'route',
        mode: rungMode(choice.rung, preferred),
        rung: choice.rung,
        inTime: choice.inTime,
        noteEn: choice.noteEn,
        noteHe: choice.noteHe,
        steps: choice.steps,
      };
    }
  }

  if (!value) {
    // No route by any way: a straight-line estimate for the vehicle she would
    // most likely use, flagged as an estimate.
    const mode: TransportType = preferred === 'car' && hasCar
      ? 'car'
      : typeof km === 'number' && km <= 1 ? 'walk' : preferred === 'car' ? 'bus' : preferred;
    const rough = roughMinutes(from, to, mode);
    if (rough !== null) {
      value = {
        minutes: rough,
        source: 'estimate',
        mode,
        steps: [...(choice?.steps ?? []), {
          thought: `No route came back; estimate from the map: ${km?.toFixed(1)} km by ${mode} ≈ ${rough} min.`,
        }],
      };
    }
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
