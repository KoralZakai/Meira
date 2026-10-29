/**
 * MultiModalPlanner — the train to the station, and something else for the
 * last mile.
 *
 * This is the fix for the worst route this app has produced: an interview at
 * 10:00 in Emek Hefer, one hour of train, and a leave time of 06:00. Nothing
 * was miscalculated. Google was asked for a TRANSIT route and answered
 * honestly: train to Hadera West, and then — because no bus goes there and the
 * request allowed nothing else — an hour and a half of WALKING. Four hours
 * door to door, and a departure time that reads like a bug because the plan
 * behind it is one no person would follow.
 *
 * A real Israeli journey is two decisions, not one: the long leg by train, and
 * the last mile by whatever is actually available — a lift, a car left at the
 * station, a bike, a scooter, a taxi. Ask a single-mode router for that and it
 * cannot answer; it can only stretch one mode across both halves.
 *
 * So the journey is planned as a chain:
 *
 *     home ──transit──▶ station ──car/bike/scooter/taxi──▶ destination
 *
 *   1. find the interchange (the station she names, or the ones near the
 *      destination),
 *   2. price the LAST leg first — station → destination by the chosen mode,
 *      for that hour,
 *   3. work backwards: the transit half must arrive by
 *      (appointment − last leg − a small buffer),
 *   4. return ONE plan whose legs read end to end, so every screen, alert and
 *      wake time already understands it.
 *
 * Backwards is the only correct order. Planning the train first and then
 * asking how to finish gets a train that arrives too late, and no way to know
 * it until it is too late to matter.
 *
 * Dependencies: RoutePlanner (transit + per-mode legs), transitParse, types.
 * Consumed by screens/TripsScreen. Tested by tests/run-multimodal.ts.
 */
import { TransitLeg, TransitPlan, TransportType, UserProfile } from '../types/index';
import { getTransitAlternatives, getPlanForMode, placeTextSearch } from './RoutePlanner';
import { hhmmMinus, hhmmPlus } from '../utils/transitParse';
import { timeToMinutes } from '../utils/timeUtils';

/** Modes that can cover a last mile no bus serves. */
export type LastLegMode = 'car' | 'bike' | 'walk' | 'taxi' | 'scooter';

/** Minutes to allow between stepping off the train and setting off again. */
const INTERCHANGE_BUFFER = 6;
/** A last leg longer than this is not a "last mile" — the plan is wrong. */
const MAX_LAST_LEG_MINUTES = 45;
/** How far from the destination to look for an interchange. */
const STATION_SEARCH_RADIUS_M = 25000;

export interface Interchange {
  name: string;
  address: string;
  lat: number;
  lng: number;
}

export interface CombinedPlan {
  /** The whole journey, as one plan the rest of the app already understands. */
  plan: TransitPlan;
  station: Interchange;
  lastLeg: { mode: LastLegMode; minutes: number };
  /** Minutes saved against the single-mode transit answer, when known. */
  savedMinutes?: number;
}

/** How a mode is drawn and how it is asked of Google. */
const AS_GOOGLE_MODE: Record<LastLegMode, TransportType> = {
  car: 'car', taxi: 'car', scooter: 'bike', bike: 'bike', walk: 'walk',
};
const LEG_TYPE: Record<LastLegMode, TransitLeg['type']> = {
  car: 'car', taxi: 'car', scooter: 'bike', bike: 'bike', walk: 'walk',
};

/**
 * Interchanges worth trying: the one she named, else the real stations near
 * the destination.
 *
 * Nearby rather than "on the way": the last leg is what we are trying to keep
 * short, and a station 40 km before the destination makes a long drive out of
 * a short one however convenient the train was.
 */
export async function findInterchanges(
  destination: string,
  named?: string,
): Promise<Interchange[]> {
  const query = named
    ? `${named} train station`
    : `train station near ${destination}`;
  try {
    // Through the server (RoutePlanner.placeTextSearch): the APK key cannot ask.
    const hits = await placeTextSearch(query, { type: 'train_station', radius: STATION_SEARCH_RADIUS_M });
    return hits.slice(0, named ? 1 : 3).filter((s: Interchange) => s.name && s.address);
  } catch (e) {
    console.warn('[MultiModal] station search failed:', String((e as Error)?.message ?? e));
    return [];
  }
}

/** Stitch the transit half and the last leg into one end-to-end plan. */
function stitch(
  transit: TransitPlan,
  station: Interchange,
  destination: string,
  mode: LastLegMode,
  lastLegMinutes: number,
  appointment: string,
): TransitPlan {
  const setOff = hhmmPlus(transit.arriveAt, INTERCHANGE_BUFFER);
  const arriveAt = hhmmPlus(setOff, lastLegMinutes);
  const lastLeg: TransitLeg = {
    type: LEG_TYPE[mode],
    from: station.name,
    to: destination,
    durationMinutes: lastLegMinutes,
    departureTime: setOff,
    arrivalTime: arriveAt,
  };
  return {
    ...transit,
    // The whole journey, not just the train half — every wake time, leave
    // alert and "will I make it" check reads this number.
    totalDurationMinutes:
      Math.max(1, timeToMinutes(arriveAt) - timeToMinutes(transit.leaveHomeAt)),
    arriveAt,
    legs: [...transit.legs, lastLeg],
    // Where the journey actually ends, so the map draws the real destination.
    source: 'google',
    fetchedAt: Date.now(),
  } as TransitPlan;
}

/**
 * Plan "train to a station, then something else" for one appointment.
 *
 * `station` is optional: name it ("Hadera West") when she already knows how
 * she is getting there, leave it out and the nearest stations to the
 * destination are tried and the best result returned.
 *
 * Returns null when no combination arrives in time — never a plan that is
 * late, and never a guess.
 */
export async function planCombined(
  destination: string,
  arriveBy: string,
  date: string,
  profile: UserProfile,
  opts: {
    lastLeg: LastLegMode;
    station?: string;
    firstLeg?: 'rail' | 'bus';
    /** Compare against this to report how much the combination saves. */
    singleModeMinutes?: number;
  },
): Promise<CombinedPlan | null> {
  const stations = await findInterchanges(destination, opts.station);
  if (!stations.length) return null;

  const results: CombinedPlan[] = [];

  for (const station of stations) {
    // 1. The LAST leg first — it decides when the train has to arrive.
    const lastPlan = await getPlanForMode(
      AS_GOOGLE_MODE[opts.lastLeg],
      destination,
      arriveBy,
      { ...profile, homeAddress: station.address, homeLat: station.lat, homeLng: station.lng } as UserProfile,
      date,
    ).catch(() => null);
    if (!lastPlan) continue;
    const lastLegMinutes = lastPlan.totalDurationMinutes;
    // A 90-minute "last mile" is the very problem this exists to fix.
    if (lastLegMinutes > MAX_LAST_LEG_MINUTES) continue;

    // 2. Work backwards: be at the station in time to make that leg.
    const stationDeadline = hhmmMinus(arriveBy, lastLegMinutes + INTERCHANGE_BUFFER);
    const options = await getTransitAlternatives(
      station.address, stationDeadline, profile, date, opts.firstLeg ?? 'rail', 3,
    ).catch(() => [] as TransitPlan[]);
    const transit = options.find((p) => p.arriveAt <= stationDeadline) ?? options[0];
    if (!transit) continue;

    const plan = stitch(transit, station, destination, opts.lastLeg, lastLegMinutes, arriveBy);
    // Never hand back a journey that arrives late — that is the one outcome
    // worse than saying "I couldn't plan this".
    if (plan.arriveAt > arriveBy) continue;

    results.push({
      plan,
      station,
      lastLeg: { mode: opts.lastLeg, minutes: lastLegMinutes },
      savedMinutes: opts.singleModeMinutes
        ? Math.max(0, opts.singleModeMinutes - plan.totalDurationMinutes)
        : undefined,
    });
  }

  // The latest possible departure that still arrives in time: an earlier train
  // is not a better plan, it is a longer morning.
  return results.sort((a, b) =>
    (a.plan.leaveHomeAt < b.plan.leaveHomeAt ? 1 : -1))[0] ?? null;
}

/**
 * Does this single-mode plan end in an absurd walk?
 *
 * The tell for "the last mile has no service": Google finishes the journey on
 * foot for longer than anyone walks to an interview. When this is true the
 * honest move is not to show a 06:00 departure — it is to offer the
 * combination.
 */
export function needsLastMileHelp(plan?: TransitPlan | null): number {
  if (!plan?.legs?.length) return 0;
  const last = plan.legs[plan.legs.length - 1];
  if (last.type !== 'walk') return 0;
  return last.durationMinutes >= 25 ? last.durationMinutes : 0;
}

// Self-check: npx tsx src/services/MultiModalPlanner.ts
if (typeof require !== 'undefined' && require.main === module) {
  const leg = (over: Partial<TransitLeg>): TransitLeg => ({
    type: 'walk', from: 'a', to: 'b', durationMinutes: 10,
    departureTime: '09:00', arrivalTime: '09:10', ...over,
  });
  const walkHome = {
    legs: [leg({ type: 'train', durationMinutes: 55 }), leg({ durationMinutes: 92 })],
  } as TransitPlan;
  console.assert(needsLastMileHelp(walkHome) === 92, 'a 92-minute walk is the tell');
  const fine = { legs: [leg({ type: 'train' }), leg({ durationMinutes: 8 })] } as TransitPlan;
  console.assert(needsLastMileHelp(fine) === 0, 'an 8-minute walk is just a walk');
  console.log('MultiModalPlanner self-check OK');
}
