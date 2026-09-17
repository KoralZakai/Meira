/**
 * RoutePlanner — Google Directions route planning (transit timetable probing,
 * car/walk/bike legs, mode comparison). Pure network + parsing: no expo-*
 * imports, so it runs in the app AND in a plain node test harness
 * (tests/run-week-schedule.ts) that hits the real Directions API.
 *
 * Extracted from GoogleService, which now delegates here and keeps the OAuth /
 * Calendar / Gmail surface. Routes go FROM userProfile.homeAddress — callers
 * that start somewhere else swap the confirmed origin into that field (see
 * GoogleSync.ensureTravelChain, LLMService get_transit_plan).
 *
 * Dependencies: utils/transitParse, utils/fuzzyMatch, EXPO_PUBLIC_GOOGLE_MAPS_API_KEY.
 */
import { UserProfile, TransitPlan, TransportType } from '../types/index';
import {
  parseTransitRoute, parseTransitAlternatives, hhmmMinus, hhmmPlus,
} from '../utils/transitParse';
import { nowHHMM } from '../utils/liveRoutePlan';
import { correctPlaceName } from '../utils/fuzzyMatch';

/** Read lazily: a node harness can set the env var before the first call. */
const mapsKey = (): string => process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY || '';

/**
 * The last `max` consecutive transit departures that arrive at or before
 * `arrivalDeadline`, earliest-first. Probes Google Directions with
 * arrival_time = deadline, then re-probes at each found trip's real arrival
 * minus 1 minute — so no intermediate train is skipped (a fixed-offset second
 * probe used to jump over timetable entries).
 */
export async function getTransitPlans(
  destinationAddress: string,
  arrivalDeadline: string,
  userProfile: UserProfile,
  date: string,
  max = 3,
  transitMode?: 'bus' | 'rail',
): Promise<TransitPlan[]> {
  const key = mapsKey();
  if (!key) return [];
  const corrected = correctPlaceName(destinationAddress);
  const plans: TransitPlan[] = [];
  // Vehicle preference: 'bus' vs 'rail' lets the caller offer both ways.
  const pref = transitMode === 'bus'
    ? '&transit_mode=bus'
    : transitMode === 'rail'
      ? `&transit_mode=${encodeURIComponent('train|tram|subway')}`
      : '';
  let deadline = arrivalDeadline;
  for (let i = 0; i < max; i++) {
    try {
      const arrivalTimestamp = Math.floor(new Date(`${date}T${deadline}:00`).getTime() / 1000);
      if (Number.isNaN(arrivalTimestamp)) break;
      // alternatives=true or Google answers with ONE route, and its first is
      // not always the sensible one: on a real Holon trip it led with 38+172
      // while a single bus 176 sat further down, three minutes faster.
      const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(userProfile.homeAddress)}&destination=${encodeURIComponent(corrected)}&mode=transit${pref}&alternatives=true&arrival_time=${arrivalTimestamp}&region=il&language=he&key=${key}`;
      const res = await fetch(url);
      const data = await res.json();
      // Best of THIS probe's alternatives (fewest changes, then fastest).
      const plan = parseTransitAlternatives(
        data, deadline, corrected, userProfile.homeAddress, deadline)[0] ?? null;
      if (!plan) break;
      // Same trip returned again (or non-time text) → timetable exhausted.
      if (plans.some((p) => p.firstBusDeparture === plan.firstBusDeparture)) break;
      plans.push(plan);
      deadline = hhmmMinus(plan.arriveAt, 1); // probe for the previous departure
    } catch (e) {
      console.log('[RoutePlanner] transit error:', e);
      break;
    }
  }
  return plans.reverse(); // earliest-first
}

/**
 * Every way to make this appointment by transit, best first.
 *
 * The app used to show exactly one route and no way to see the others, so a
 * two-bus plan looked like the only plan — while Google Maps, which the user
 * checks alongside, showed a single bus. Same API, same key: the difference was
 * that Lumi never asked for alternatives and read only the first route.
 *
 * Ranking lives in parseTransitAlternatives: on time first, then FEWEST rides
 * (a transfer is a second chance to miss something, not just minutes), then
 * shortest, then latest departure.
 */
export async function getTransitAlternatives(
  destinationAddress: string,
  arrivalDeadline: string,
  userProfile: UserProfile,
  date: string,
  transitMode?: 'bus' | 'rail',
  max = 4,
): Promise<TransitPlan[]> {
  const key = mapsKey();
  if (!key) return [];
  const corrected = correctPlaceName(destinationAddress);
  const pref = transitMode === 'bus'
    ? '&transit_mode=bus'
    : transitMode === 'rail'
      ? `&transit_mode=${encodeURIComponent('train|tram|subway')}`
      : '';
  try {
    const arrivalTimestamp = Math.floor(new Date(`${date}T${arrivalDeadline}:00`).getTime() / 1000);
    if (Number.isNaN(arrivalTimestamp)) return [];
    const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(userProfile.homeAddress)}&destination=${encodeURIComponent(corrected)}&mode=transit${pref}&alternatives=true&arrival_time=${arrivalTimestamp}&region=il&language=he&key=${key}`;
    const res = await fetch(url);
    const data = await res.json();
    const plans = parseTransitAlternatives(
      data, arrivalDeadline, corrected, userProfile.homeAddress, arrivalDeadline);
    // Two routes on the same lines at the same minute are one option twice.
    const seen = new Set<string>();
    const unique = plans.filter((p) => {
      const sig = `${p.leaveHomeAt}|${p.legs.filter((l) => l.type !== 'walk').map((l) => l.lineNumber).join('+')}`;
      if (seen.has(sig)) return false;
      seen.add(sig);
      return true;
    });
    return unique.slice(0, max);
  } catch (e) {
    console.log('[RoutePlanner] alternatives error:', e);
    return [];
  }
}

/** The latest transit trip that still arrives by the deadline. */
export async function getTransitPlan(
  destinationAddress: string,
  arrivalDeadline: string,
  userProfile: UserProfile,
  date: string,
  transitMode?: 'bus' | 'rail',
): Promise<TransitPlan | null> {
  const plans = await getTransitPlans(destinationAddress, arrivalDeadline, userProfile, date, 1, transitMode);
  return plans[plans.length - 1] ?? null;
}

/**
 * One route plan for any transport mode, arriving by `arrivalDeadline`.
 * Transit reuses the timetable-aware getTransitPlan; car/walk/bike are a
 * single Google Directions leg. All plans carry overviewPolyline + start
 * coordinates so RouteMap can draw them. Returns null when no route.
 */
/**
 * Did the route actually come back on the vehicle she asked for?
 *
 * `transit_mode` is a PREFERENCE. Asking for rail on a corridor Google would
 * rather serve by bus returns the bus, with nothing in the response saying so
 * — which is how a selected 🚆 chip ended up sitting above "Bus 271". We
 * cannot make a train exist; we can refuse to pretend one was found.
 */
export const RAIL_LEGS = ['train', 'subway', 'tram'];

/** Every vehicle leg is rail — walking to and from the platform is fine. */
export function isRailOnly(plan: TransitPlan): boolean {
  const vehicles = (plan.legs ?? []).filter((l) => l.type !== 'walk');
  return vehicles.length > 0 && vehicles.every((l) => RAIL_LEGS.includes(l.type));
}

/** Every vehicle leg is a bus. */
export function isBusOnly(plan: TransitPlan): boolean {
  const vehicles = (plan.legs ?? []).filter((l) => l.type !== 'walk');
  return vehicles.length > 0 && vehicles.every((l) => l.type === 'bus');
}

export function flagUnmetMode(plan: TransitPlan, wanted: TransportType): TransitPlan {
  const honoured = wanted === 'bus' ? isBusOnly(plan) : isRailOnly(plan);
  return honoured ? plan : { ...plan, unavailableMode: wanted };
}

/**
 * The kindest of several routes: leave as late as you can and still arrive.
 *
 * Google does not return alternatives in departure order, so "take the last
 * one" — which is what the single-plan path does after its own sort — picked
 * essentially at random here. On a real morning that meant a two-train,
 * 26-minutes-of-walking combination winning over the direct train three
 * minutes later.
 *
 * Latest departure first (every minute earlier is a minute spent waiting),
 * then fewer vehicles, because a transfer is a chance to miss something.
 */
export function pickLatestArrivingInTime(
  plans: TransitPlan[],
  arrivalDeadline: string,
): TransitPlan | null {
  const inTime = plans.filter((p) => !p.arriveAt || p.arriveAt <= arrivalDeadline);
  const pool = inTime.length ? inTime : plans;
  if (!pool.length) return null;
  const vehicles = (p: TransitPlan) => (p.legs ?? []).filter((l) => l.type !== 'walk').length;
  return [...pool].sort((a, b) => (
    a.leaveHomeAt !== b.leaveHomeAt
      ? b.leaveHomeAt.localeCompare(a.leaveHomeAt)   // latest departure wins
      : vehicles(a) - vehicles(b)                     // then fewest changes
  ))[0];
}

export async function getPlanForMode(
  mode: TransportType,
  destination: string,
  arrivalDeadline: string,
  userProfile: UserProfile,
  date: string,
): Promise<TransitPlan | null> {
  const key = mapsKey();
  if (!key) return null;
  // Public transport splits by vehicle preference so compareModes can offer
  // "by bus vs by train" as two distinct options.
  // Asking for a train and being handed a bus is not a smaller answer to the
  // same question — it is a different journey. Google's transit_mode is only a
  // preference, so the filtering has to happen here: take the alternatives,
  // keep the ones made ENTIRELY of rail (walking to the platform is still
  // rail travel), and if none exist say so. No silent downgrade.
  if (mode === 'bus' || mode === 'train') {
    const wantRail = mode === 'train';
    const alts = await getTransitAlternatives(
      destination, arrivalDeadline, userProfile, date, wantRail ? 'rail' : 'bus', 4);
    const pure = alts.filter((p) => (wantRail ? isRailOnly(p) : isBusOnly(p)));
    const best = pickLatestArrivingInTime(pure, arrivalDeadline);
    if (best) return best;
    if (wantRail) return null;   // an explicit "no train", never a bus in disguise
    const plan = await getTransitPlan(destination, arrivalDeadline, userProfile, date, 'bus');
    return plan ? flagUnmetMode(plan, mode) : plan;
  }

  const gmode = mode === 'car' ? 'driving' : mode === 'bike' ? 'bicycling' : 'walking';
  const legType = mode === 'car' ? 'car' : mode === 'bike' ? 'bike' : 'walk';
  try {
    const corrected = correctPlaceName(destination);
    // Some callers only carry an address (no geocoded homeLat/homeLng).
    const origin =
      userProfile.homeLat && userProfile.homeLng
        ? `${userProfile.homeLat},${userProfile.homeLng}`
        : userProfile.homeAddress;
    if (!origin) return null;
    const build = (departEpoch?: number) =>
      `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(corrected)}&mode=${gmode}`
      + (departEpoch ? `&departure_time=${departEpoch}` : '')
      + `&region=il&key=${key}`;

    // Traffic depends on WHEN you drive, not on when Lumi asks. Probe the
    // traffic at the arrival hour, then re-probe at the resulting departure
    // time — 'departure_time=now' made an 08:00 commute planned at 22:00 look
    // free-flowing. Past deadlines fall back to now.
    const arriveEpoch = Math.floor(new Date(`${date}T${arrivalDeadline}:00`).getTime() / 1000);
    const nowEpoch = Math.floor(Date.now() / 1000);
    const carProbe = mode === 'car'
      ? (Number.isNaN(arriveEpoch) ? nowEpoch : Math.max(arriveEpoch, nowEpoch))
      : undefined;

    const fetchLeg = async (departEpoch?: number) => {
      const r = await fetch(build(departEpoch));
      const d = await r.json();
      return d.routes?.length ? { data: d, leg: d.routes[0].legs[0] } : null;
    };

    let hit = await fetchLeg(carProbe);
    if (!hit) return null;
    let minutes = Math.round((hit.leg.duration_in_traffic ?? hit.leg.duration).value / 60);
    if (carProbe && carProbe > nowEpoch) {
      const second = await fetchLeg(Math.max(carProbe - minutes * 60, nowEpoch));
      if (second) {
        hit = second;
        minutes = Math.round((second.leg.duration_in_traffic ?? second.leg.duration).value / 60);
      }
    }
    const { data, leg } = hit;
    const leaveAt = hhmmMinus(arrivalDeadline, minutes + (userProfile.wakeBufferMinutes || 10));
    return {
      totalDurationMinutes: minutes,
      leaveHomeAt: leaveAt,
      arriveAt: arrivalDeadline,
      firstBusDeparture: leaveAt,
      firstBusStop: userProfile.homeAddress,
      walkToStopMinutes: 0,
      legs: [
        {
          type: legType,
          from: userProfile.homeAddress,
          to: corrected,
          durationMinutes: minutes,
          departureTime: leaveAt,
          arrivalTime: arrivalDeadline,
        },
      ],
      overviewPolyline: data.routes[0].overview_polyline?.points,
      startLat: leg.start_location?.lat,
      startLng: leg.start_location?.lng,
      destLat: leg.end_location?.lat,
      destLng: leg.end_location?.lng,
      source: 'google',
      fetchedAt: Date.now(),
    };
  } catch (e) {
    console.error(`[RoutePlanner] getPlanForMode(${mode}) error:`, e);
    return null;
  }
}

/**
 * "If I leave RIGHT NOW, when do I arrive?" — the re-plan for a missed departure.
 *
 * The stored plan is anchored to an arrival deadline; once the planned leave
 * time passes and she is still home, that plan is fiction. This asks Google the
 * opposite question — depart at `now` — so transit returns the NEXT bus and its
 * real arrival, and driving/cycling/walking return leave-now + travel time.
 *
 * Origin is home (she has not moved — that is the whole premise). Returns null
 * when there is no route or no key, same as getPlanForMode.
 */
export async function getDepartNowPlan(
  mode: TransportType,
  destination: string,
  userProfile: UserProfile,
  date: string,
  now: Date = new Date(),
): Promise<TransitPlan | null> {
  const key = mapsKey();
  if (!key) return null;
  const corrected = correctPlaceName(destination);
  const origin =
    userProfile.homeLat && userProfile.homeLng
      ? `${userProfile.homeLat},${userProfile.homeLng}`
      : userProfile.homeAddress;
  if (!origin) return null;
  const departEpoch = Math.floor(now.getTime() / 1000);

  if (mode === 'bus' || mode === 'train') {
    const pref = mode === 'bus'
      ? '&transit_mode=bus'
      : `&transit_mode=${encodeURIComponent('train|tram|subway')}`;
    const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(origin)}`
      + `&destination=${encodeURIComponent(corrected)}&mode=transit${pref}`
      + `&departure_time=${departEpoch}&alternatives=true&region=il&language=he&key=${key}`;
    try {
      const res = await fetch(url);
      const data = await res.json();
      // fallbackArrival is only used if Google omits times; a depart-now query
      // returns real arrival_time, so the parsed arriveAt is the true ETA.
      // Same ranking as the arrive-by path: the NEXT bus should also be the
      // simplest one, not whichever route Google happened to list first.
      return parseTransitAlternatives(data, '', corrected, userProfile.homeAddress)[0] ?? null;
    } catch (e) {
      console.log('[RoutePlanner] depart-now transit error:', e);
      return null;
    }
  }

  // Car / bike / walk: leave now, arrive now + duration (traffic-aware for car).
  const gmode = mode === 'car' ? 'driving' : mode === 'bike' ? 'bicycling' : 'walking';
  const legType = mode === 'car' ? 'car' : mode === 'bike' ? 'bike' : 'walk';
  const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(origin)}`
    + `&destination=${encodeURIComponent(corrected)}&mode=${gmode}`
    + `&departure_time=${departEpoch}&region=il&key=${key}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    const leg = data.routes?.[0]?.legs?.[0];
    if (!leg) return null;
    const minutes = Math.round((leg.duration_in_traffic ?? leg.duration).value / 60);
    const leaveAt = nowHHMM(now);
    const arriveAt = hhmmPlus(leaveAt, minutes);
    return {
      totalDurationMinutes: minutes,
      leaveHomeAt: leaveAt,
      arriveAt,
      firstBusDeparture: leaveAt,
      firstBusStop: userProfile.homeAddress,
      walkToStopMinutes: 0,
      legs: [{
        type: legType, from: userProfile.homeAddress, to: corrected,
        durationMinutes: minutes, departureTime: leaveAt, arrivalTime: arriveAt,
      }],
      overviewPolyline: data.routes[0].overview_polyline?.points,
      startLat: leg.start_location?.lat,
      startLng: leg.start_location?.lng,
      destLat: leg.end_location?.lat,
      destLng: leg.end_location?.lng,
      source: 'google',
      fetchedAt: Date.now(),
    } as TransitPlan;
  } catch (e) {
    console.log('[RoutePlanner] depart-now drive error:', e);
    return null;
  }
}

/**
 * The next `count` CONSECUTIVE departures, earliest first.
 *
 * getDepartNowPlan answers "when is the next one" — one plan, one sentence.
 * That is an answer, not a choice. Having missed the 08:30 at 09:00, knowing
 * only about the 09:15 tells her nothing about whether the 09:45 still makes
 * the appointment, which is the actual decision in front of her.
 *
 * One Google call returns alternatives, but they are alternatives for the SAME
 * departure — different walking routes to one platform — not the timetable.
 * So this probes forward: ask for now, take the earliest route that comes
 * back, then ask again from one minute after that departure. `count` probes,
 * `count` calls, and it stops early when the timetable repeats itself (the
 * last service of the day).
 *
 * Origin is `profile.homeAddress` like every other planner here — callers that
 * start somewhere else (she is at the university, planning the leg to Tel
 * Aviv) swap their own origin into that field first.
 */
export async function getDepartNowOptions(
  mode: TransportType,
  destination: string,
  userProfile: UserProfile,
  date: string,
  now: Date = new Date(),
  count = 3,
): Promise<TransitPlan[]> {
  const key = mapsKey();
  if (!key) return [];

  // Driving, cycling and walking have no timetable: there is exactly one
  // honest option, "leave now". Pretending otherwise by offering the same
  // journey shifted by fifteen minutes would be inventing choices.
  if (mode !== 'bus' && mode !== 'train') {
    const one = await getDepartNowPlan(mode, destination, userProfile, date, now);
    return one ? [one] : [];
  }

  const corrected = correctPlaceName(destination);
  const origin =
    userProfile.homeLat && userProfile.homeLng
      ? `${userProfile.homeLat},${userProfile.homeLng}`
      : userProfile.homeAddress;
  if (!origin) return [];

  const wantRail = mode === 'train';
  const pref = wantRail
    ? `&transit_mode=${encodeURIComponent('train|tram|subway')}`
    : '&transit_mode=bus';

  const out: TransitPlan[] = [];
  const seen = new Set<string>();
  let departEpoch = Math.floor(now.getTime() / 1000);

  for (let i = 0; i < count; i += 1) {
    const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(origin)}`
      + `&destination=${encodeURIComponent(corrected)}&mode=transit${pref}`
      + `&departure_time=${departEpoch}&alternatives=true&region=il&language=he&key=${key}`;
    let plans: TransitPlan[] = [];
    try {
      const res = await fetch(url);
      const data = await res.json();
      plans = parseTransitAlternatives(data, '', corrected, userProfile.homeAddress);
    } catch (e) {
      console.log('[RoutePlanner] depart-now options error:', e);
      break;
    }
    // Train is strict everywhere else in this file and must be strict here:
    // offering a bus under a 🚆 heading is the bug that started all of this.
    const honest = plans.filter((p) => (wantRail ? isRailOnly(p) : isBusOnly(p)));
    const pool = honest.length ? honest : (wantRail ? [] : plans);
    // The EARLIEST departure of this probe — the timetable, not the ranking.
    const next = [...pool].sort((a, b) => a.leaveHomeAt.localeCompare(b.leaveHomeAt))[0];
    if (!next) break;
    const sig = `${next.leaveHomeAt}|${next.arriveAt}`;
    if (seen.has(sig)) break;   // same trip again — the timetable is exhausted
    seen.add(sig);
    out.push(next);

    // Advance past this departure so the next probe cannot return it again.
    const [h, m] = next.leaveHomeAt.split(':').map(Number);
    const anchorDay = new Date(now);
    anchorDay.setHours(h, m + 1, 0, 0);
    const advanced = Math.floor(anchorDay.getTime() / 1000);
    // A departure that reads as EARLIER than the probe is tomorrow's timetable
    // wrapping around; stop rather than loop over midnight.
    if (advanced <= departEpoch) break;
    departEpoch = advanced;
  }
  return out;
}

/**
 * Plans for several modes at once, sorted fastest-first (modes with no route
 * are dropped).
 */
/**
 * The profile to plan a route FROM a point rather than from home.
 *
 * Every router in this file takes its origin from `userProfile` — either
 * homeLat/homeLng or homeAddress — so "route me from where I am standing" is
 * expressed by handing it a profile whose home IS that point. `homeAddress`
 * must be blanked, not merely shadowed: the coordinate branch is only reached
 * when there is no address to prefer, so leaving the stored address in place
 * silently plans from her flat while reporting a live origin.
 *
 * This trick was written out by hand in six places in LiveRoute, each with its
 * own copy of that reasoning. One name, one comment, one place to be wrong.
 */
export function profileFromPoint(
  userProfile: UserProfile,
  point: { lat: number; lng: number },
): UserProfile {
  return {
    ...userProfile,
    homeAddress: '',
    homeLat: point.lat,
    homeLng: point.lng,
    homeLatLng: { lat: point.lat, lng: point.lng },
  } as unknown as UserProfile;
}

export async function compareModes(
  destination: string,
  arrivalDeadline: string,
  userProfile: UserProfile,
  date: string,
  modes: TransportType[] = ['bus', 'train', 'car', 'walk', 'bike'],
  // Where she IS. Without this every comparison answers a question about her
  // flat, which is the wrong answer whenever she is not in it — and she asks
  // "how do I get there from here" precisely when she is out.
  opts: { from?: { lat: number; lng: number } } = {},
): Promise<Array<{ mode: TransportType; plan: TransitPlan }>> {
  const profile = opts.from ? profileFromPoint(userProfile, opts.from) : userProfile;
  const results = await Promise.all(
    modes.map(async (mode) => ({
      mode,
      plan: await getPlanForMode(mode, destination, arrivalDeadline, profile, date),
    })),
  );
  return results
    .filter((r): r is { mode: TransportType; plan: TransitPlan } => r.plan !== null)
    .sort((a, b) => a.plan.totalDurationMinutes - b.plan.totalDurationMinutes);
}

/** Google Places text search — top 3 matches with a rough confidence. */
export async function searchPlaces(
  query: string,
): Promise<{ name: string; address: string; lat: number; lng: number; confidence: number }[]> {
  const key = mapsKey();
  if (!key) return [];
  try {
    const corrected = correctPlaceName(query);
    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(corrected)}&region=il&key=${key}`;
    const res = await fetch(url);
    const data = await res.json();
    return (data.results || []).slice(0, 3).map((r: any, i: number) => ({
      name: r.name,
      address: r.formatted_address,
      lat: r.geometry.location.lat,
      lng: r.geometry.location.lng,
      confidence: i === 0 ? 0.9 : i === 1 ? 0.7 : 0.5,
    }));
  } catch { return []; }
}
