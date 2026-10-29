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
  parseTransitRoute, parseTransitAlternatives, hhmmMinus, hhmmPlus, soonestArrival,
} from '../utils/transitParse';
import { nowHHMM } from '../utils/liveRoutePlan';
import { correctPlaceName } from '../utils/fuzzyMatch';
import { StepDir, pickNeighbour } from '../utils/neighbourDeparture';
import {
  RouteFailure, classifyDirectionsStatus, networkFailure, failureLogLine,
} from '../utils/routeFailure';

/** Read lazily: a node harness can set the env var before the first call. */
const mapsKey = (): string => process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY || '';

/**
 * How route questions reach Google.
 *
 * A value, not an import: this module must stay free of expo-* so the node
 * harness can run it, and the real gateway reaches Supabase for a token. The
 * app installs `services/RouteGateway.askServerForDirections` at startup; the
 * harness installs nothing and the direct path below is used with whatever key
 * is in the environment.
 *
 * The phone's own Maps key CANNOT do this job. It is restricted to
 * `meira.secretary` + SHA-1, which Google enforces through headers only the Maps
 * SDK sends, so a `fetch()` from React Native is REQUEST_DENIED every time —
 * 107 times in one day on her device. The restriction is right; the asker was
 * wrong.
 */
export type DirectionsGateway = (req: {
  origin: string;
  destination: string;
  date: string;
  arriveBy?: string;
  queries: Array<{ mode: string; transit_mode?: string; depart_epoch?: number }>;
}) => Promise<Array<{ status: string; error_message?: string; data: any | null }>>;

let _gateway: DirectionsGateway | null = null;

/** Install (or, with null, remove) the server gateway. Called by App.tsx. */
export function setDirectionsGateway(g: DirectionsGateway | null): void {
  _gateway = g;
}

/** Whether routes currently go through the server. Read by diagnostics. */
export function hasDirectionsGateway(): boolean {
  return _gateway !== null;
}

const directionsGateway = (): DirectionsGateway | null => _gateway;

/**
 * Places Text Search, the same way: through the server (POST /app/place/search)
 * once RouteGateway installs it. The APK key is Android-restricted, so a fetch
 * from the phone was REQUEST_DENIED — and a key that allows a web-service API
 * at all is a key anyone who unzips the APK can bill (8.10). Throws on a
 * refusal: [] means only "Google found nothing".
 */
export type PlaceHit = { name: string; address: string; lat: number; lng: number };
export type PlacesGateway = (req: { query: string; type?: string; radius?: number }) => Promise<PlaceHit[]>;

let _places: PlacesGateway | null = null;

export function setPlacesGateway(g: PlacesGateway | null): void {
  _places = g;
}

export async function placeTextSearch(
  query: string,
  opts: { type?: string; radius?: number } = {},
): Promise<PlaceHit[]> {
  if (_places) return _places({ query, ...opts });
  // Node harness only (no server session there): the key from the environment.
  const key = mapsKey();
  if (!key) throw new Error('no Places route: no server gateway and no key');
  const url = 'https://maps.googleapis.com/maps/api/place/textsearch/json'
    + `?query=${encodeURIComponent(query)}&region=il&language=he`
    + (opts.type ? `&type=${opts.type}` : '') + (opts.radius ? `&radius=${opts.radius}` : '')
    + `&key=${key}`;
  const data = await (await fetch(url)).json();
  if (data.status && !['OK', 'ZERO_RESULTS'].includes(data.status)) {
    throw new Error(`Places ${data.status}`);
  }
  return (data.results || []).slice(0, 5).map((r: any) => ({
    name: r.name,
    address: r.formatted_address || r.name,
    lat: r.geometry?.location?.lat,
    lng: r.geometry?.location?.lng,
  }));
}

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
  const gateway = directionsGateway();
  // A gateway replaces the key; without either there is nothing to ask with.
  if (!key && !gateway) return [];
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
      // Same door as everything else: the server when one is installed, the
      // direct URL only in the node harness.
      let data: any;
      if (gateway) {
        // Address, else coordinates. profileFromPoint blanks the address on
        // purpose ("route me from HERE"), and this sent '' — the server's 400
        // "origin and destination are required", 28.9 21:10, every re-plan
        // from her live position.
        const origin = userProfile.homeAddress
          || (userProfile.homeLat && userProfile.homeLng ? `${userProfile.homeLat},${userProfile.homeLng}` : '');
        if (!origin) {
          console.warn('[RoutePlanner] transit probe: no origin — no home address and no position');
          break;
        }
        const r = (await gateway({
          origin,
          destination: corrected,
          date,
          arriveBy: deadline,
          queries: [{ mode: 'transit', ...(transitMode ? { transit_mode: transitMode } : {}) }],
        }))[0];
        if (r && r.status !== 'OK') {
          console.warn('[RoutePlanner] transit probe', r.status, r.error_message ?? '');
          break;
        }
        data = r?.data;
      } else {
        const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(userProfile.homeAddress)}&destination=${encodeURIComponent(corrected)}&mode=transit${pref}&alternatives=true&arrival_time=${arrivalTimestamp}&region=il&language=he&key=${key}`;
        const res = await fetch(url);
        data = await res.json();
      }
      // Best of THIS probe's alternatives (fewest changes, then fastest).
      const plan = parseTransitAlternatives(
        data, deadline, corrected, userProfile.homeAddress, deadline)[0] ?? null;
      if (!plan) break;
      // Same trip returned again (or non-time text) → timetable exhausted.
      if (plans.some((p) => p.firstBusDeparture === plan.firstBusDeparture)) break;
      plans.push(plan);
      deadline = hhmmMinus(plan.arriveAt, 1); // probe for the previous departure
    } catch (e) {
      console.warn('[RoutePlanner] transit error:', e);
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
  return (await transitAlternatives(
    destinationAddress, arrivalDeadline, userProfile, date, transitMode, max)).plans;
}

/**
 * The same lookup, and WHY it came back empty.
 *
 * `getTransitAlternatives` above is kept as the array-returning wrapper so the
 * five other callers are untouched, but nothing new should use it: an `[]` it
 * hands back is the very ambiguity this exists to remove. Six different
 * situations produced that empty array and the app reported the one it had not
 * checked — "no route for the chosen way of getting there" — while her Google
 * console recorded 107 Directions requests at a 99% error rate and a 9 ms
 * median, i.e. every single one rejected before any routing was attempted.
 *
 * Two of the six are decided here, before a request is sent, because sending
 * one would be pointless and would still bill her quota:
 *   - no key in the bundle
 *   - no home address to route FROM (an empty `origin=` is a guaranteed error,
 *     and an unsynced profile is exactly how routes vanished once before)
 *
 * The rest come from Google, which has always said which one it was in
 * `status` and `error_message`. Nothing read those two fields until now.
 */
export async function transitAlternatives(
  destinationAddress: string,
  arrivalDeadline: string,
  userProfile: UserProfile,
  date: string,
  transitMode?: 'bus' | 'rail',
  max = 4,
): Promise<{ plans: TransitPlan[]; failure?: RouteFailure }> {
  return (await transitAlternativesMulti(
    destinationAddress, arrivalDeadline, userProfile, date, [transitMode], max))[0];
}

/**
 * Several vehicle preferences, ONE round trip.
 *
 * The chain wants rail, bus and unconstrained for every stop — "is there a
 * direct train" and "is there a direct bus" is one comparison, not two
 * questions whose answers never meet. Those were three separate requests from
 * the phone; through the gateway they are one, fanned out concurrently on the
 * server and cached there, so a day with four stops costs four requests rather
 * than twelve.
 *
 * Every entry of the result lines up with `transitModes` by index, and each
 * carries its own verdict — a refused query and an empty timetable must stay
 * distinguishable all the way up to `worstFailure`.
 */
export async function transitAlternativesMulti(
  destinationAddress: string,
  arrivalDeadline: string,
  userProfile: UserProfile,
  date: string,
  transitModes: Array<'bus' | 'rail' | undefined>,
  max = 4,
): Promise<Array<{ plans: TransitPlan[]; failure?: RouteFailure }>> {
  const labels = transitModes.map((m) => m ?? 'transit');
  const everywhere = (failure: RouteFailure) =>
    labels.map((mode) => ({ plans: [] as TransitPlan[], failure: { ...failure, mode } }));

  const gateway = directionsGateway();
  // Without a gateway the only way left is asking Google from here, which
  // needs a key. With one, the phone never holds a key at all.
  if (!gateway && !mapsKey()) {
    return everywhere({ kind: 'no_key', at: Date.now() });
  }
  const origin = String(userProfile.homeAddress ?? '').trim();
  if (!origin) return everywhere({ kind: 'no_origin', at: Date.now() });

  const corrected = correctPlaceName(destinationAddress);
  const arrivalTimestamp = Math.floor(new Date(`${date}T${arrivalDeadline}:00`).getTime() / 1000);
  if (Number.isNaN(arrivalTimestamp)) {
    return everywhere({ kind: 'bad_time', detail: `${date}T${arrivalDeadline}`, at: Date.now() });
  }

  /** One Google response body → the plans it contains, or why it has none. */
  const readOne = (
    mode: string, status: string | undefined, errorMessage: string | undefined, data: any,
  ): { plans: TransitPlan[]; failure?: RouteFailure } => {
    // Google's own verdict, read BEFORE the parser — which returns [] for a
    // rejection and for a free timetable alike, and cannot be asked to tell
    // them apart because by then the difference is gone.
    const failure = classifyDirectionsStatus(status, errorMessage, mode);
    if (failure) {
      console.warn('[RoutePlanner]', failureLogLine(failure, corrected));
      return { plans: [], failure };
    }
    const plans = parseTransitAlternatives(
      data, arrivalDeadline, corrected, origin, arrivalDeadline);
    // Two routes on the same lines at the same minute are one option twice.
    const seen = new Set<string>();
    const unique = plans.filter((p) => {
      const sig = `${p.leaveHomeAt}|${p.legs.filter((l) => l.type !== 'walk').map((l) => l.lineNumber).join('+')}`;
      if (seen.has(sig)) return false;
      seen.add(sig);
      return true;
    });
    // Status OK and still nothing usable: that is ours, not Google's, and it
    // must not be dressed up as "no transport there".
    if (!unique.length) {
      const own: RouteFailure = {
        kind: 'unknown', status: 'OK', mode, at: Date.now(),
        detail: `Google returned ${data?.routes?.length ?? 0} route(s) that did not parse into a plan`,
      };
      console.warn('[RoutePlanner]', failureLogLine(own, corrected));
      return { plans: [], failure: own };
    }
    return { plans: unique.slice(0, max) };
  };

  if (gateway) {
    try {
      const results = await gateway({
        origin,
        destination: corrected,
        date,
        arriveBy: arrivalDeadline,
        queries: transitModes.map((m) => ({
          mode: 'transit' as const,
          ...(m ? { transit_mode: m } : {}),
        })),
      });
      return labels.map((mode, i) => {
        const r = results[i];
        if (!r) {
          return { plans: [], failure: {
            kind: 'unknown' as const, mode, at: Date.now(),
            detail: `the server answered ${results.length} of ${labels.length} queries`,
          } };
        }
        return readOne(mode, r.status, r.error_message, r.data);
      });
    } catch (e) {
      // The server is how routes are asked for now, so failing to reach it is
      // a network failure — named as one, not silently retried against a key
      // that is guaranteed to be refused.
      const failure = networkFailure(e);
      console.warn('[RoutePlanner]', failureLogLine(failure, corrected));
      return everywhere(failure);
    }
  }

  // No gateway: the direct path, which the node harness uses with an
  // unrestricted key in the environment.
  const key = mapsKey();
  return Promise.all(transitModes.map(async (transitMode, i) => {
    const mode = labels[i];
    const pref = transitMode === 'bus'
      ? '&transit_mode=bus'
      : transitMode === 'rail'
        ? `&transit_mode=${encodeURIComponent('train|tram|subway')}`
        : '';
    try {
      const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(corrected)}&mode=transit${pref}&alternatives=true&arrival_time=${arrivalTimestamp}&region=il&language=he&key=${key}`;
      const res = await fetch(url);
      const data = await res.json();
      return readOne(mode, data?.status, data?.error_message, data);
    } catch (e) {
      // console.WARN, not log: release builds drop console.log, which is why a
      // dropped connection has been invisible on her phone this whole time.
      const failure = networkFailure(e, mode);
      console.warn('[RoutePlanner]', failureLogLine(failure, corrected));
      return { plans: [] as TransitPlan[], failure };
    }
  }));
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
  return (await planForMode(mode, destination, arrivalDeadline, userProfile, date)).plan;
}

/**
 * The same single-mode lookup, and WHY it came back null.
 *
 * `getPlanForMode` stays as the null-returning wrapper for existing callers.
 * A `null` from it is the ambiguity: no key, no origin, a refused key, a dead
 * connection and a genuinely unreachable destination were one value, and the
 * card picked the last one to display regardless of which had happened.
 *
 * The rail branch keeps its absoluteness — "an explicit no-train, never a bus
 * in disguise" — but now says which kind of no it is. A rejected key is not a
 * statement about trains, and a ladder that falls back on one (see
 * utils/transitFallback) would be falling back for the wrong reason.
 */
export async function planForMode(
  mode: TransportType,
  destination: string,
  arrivalDeadline: string,
  userProfile: UserProfile,
  date: string,
): Promise<{ plan: TransitPlan | null; failure?: RouteFailure }> {
  const key = mapsKey();
  // A gateway does not need a key on the phone — that is the point of it.
  if (!key && !directionsGateway()) {
    return { plan: null, failure: { kind: 'no_key', mode, at: Date.now() } };
  }
  // Public transport splits by vehicle preference so compareModes can offer
  // "by bus vs by train" as two distinct options.
  // Asking for a train and being handed a bus is not a smaller answer to the
  // same question — it is a different journey. Google's transit_mode is only a
  // preference, so the filtering has to happen here: take the alternatives,
  // keep the ones made ENTIRELY of rail (walking to the platform is still
  // rail travel), and if none exist say so. No silent downgrade.
  if (mode === 'bus' || mode === 'train') {
    const wantRail = mode === 'train';
    const { plans: alts, failure } = await transitAlternatives(
      destination, arrivalDeadline, userProfile, date, wantRail ? 'rail' : 'bus', 4);
    const pure = alts.filter((p) => (wantRail ? isRailOnly(p) : isBusOnly(p)));
    const best = pickLatestArrivingInTime(pure, arrivalDeadline);
    if (best) return { plan: best };
    // Routes came back but none were pure rail/bus: that IS a fact about
    // transport, and it outranks whatever the query reported.
    const why: RouteFailure | undefined = alts.length
      ? { kind: 'no_service', mode, at: Date.now(), status: 'OK',
        detail: `${alts.length} route(s), none entirely by ${wantRail ? 'rail' : 'bus'}` }
      : failure;
    if (wantRail) return { plan: null, failure: why };   // an explicit "no train"
    const plan = await getTransitPlan(destination, arrivalDeadline, userProfile, date, 'bus');
    return plan ? { plan: flagUnmetMode(plan, mode) } : { plan: null, failure: why };
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
    if (!origin) return { plan: null, failure: { kind: 'no_origin', mode, at: Date.now() } };
    const gateway = directionsGateway();
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

    // The last response's verdict, so a null `hit` can name its own cause
    // instead of being reported as "there is no way to get there".
    let lastFailure: RouteFailure | undefined;
    const fetchLeg = async (departEpoch?: number) => {
      // Through the server when one is installed, so the key stays off the
      // phone for driving and walking too — not only for transit.
      //
      // The STATUS is read from the envelope, not from `data`: the server
      // sends `data: null` whenever the status is not OK, so reading the
      // status off the body would turn every named refusal back into
      // "unknown" — reintroducing, one layer up, the exact ambiguity this
      // whole change exists to remove.
      let status: string | undefined;
      let errorMessage: string | undefined;
      let d: any = null;
      if (gateway) {
        const r = (await gateway({
          origin,
          destination: corrected,
          date,
          queries: [{ mode: gmode, ...(departEpoch ? { depart_epoch: departEpoch } : {}) }],
        }))[0];
        status = r?.status;
        errorMessage = r?.error_message;
        d = r?.data ?? null;
        if (!r) {
          status = 'NO_RESULT';
          errorMessage = 'the server answered with no result for this query';
        }
      } else {
        d = await (await fetch(build(departEpoch))).json();
        status = d?.status;
        errorMessage = d?.error_message;
      }
      lastFailure = classifyDirectionsStatus(status, errorMessage, mode) ?? undefined;
      return d?.routes?.length ? { data: d, leg: d.routes[0].legs[0] } : null;
    };

    let hit = await fetchLeg(carProbe);
    if (!hit) {
      const why: RouteFailure = lastFailure ?? {
        kind: 'unknown', status: 'OK', mode, at: Date.now(),
        detail: 'Google returned no routes and no error status',
      };
      console.warn('[RoutePlanner]', failureLogLine(why, corrected));
      return { plan: null, failure: why };
    }
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
    return { plan: {
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
    } };
  } catch (e) {
    const failure = networkFailure(e, mode);
    console.warn('[RoutePlanner]', failureLogLine(failure, destination));
    return { plan: null, failure };
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
  const gateway = directionsGateway();
  if (!key && !gateway) {
    console.warn('[RoutePlanner] depart-now: no server gateway and no key');
    return null;
  }
  const corrected = correctPlaceName(destination);
  const origin =
    userProfile.homeLat && userProfile.homeLng
      ? `${userProfile.homeLat},${userProfile.homeLng}`
      : userProfile.homeAddress;
  if (!origin) {
    console.warn('[RoutePlanner] depart-now: no origin');
    return null;
  }
  const departEpoch = Math.floor(now.getTime() / 1000);
  const transit = mode === 'bus' || mode === 'train';
  const gmode = mode === 'car' ? 'driving' : mode === 'bike' ? 'bicycling' : mode === 'walk' ? 'walking' : 'transit';

  // Same door as every other route: the server when one is installed. This
  // was the one path left asking Google straight from the phone, with a key
  // Google refuses from a raw fetch (REQUEST_DENIED, 9 ms) — so "you're still
  // home, here is the next option" failed every time, and said nothing.
  // Transit with no arrival time is Google's "depart now".
  let data: any = null;
  try {
    if (gateway) {
      const r = (await gateway({
        origin,
        destination: corrected,
        date,
        // depart_epoch (to the minute) is part of the server's cache key. Without it every "now"
        // transit question looked the same for five minutes and returned a departure that had gone.
        queries: [transit
          ? { mode: 'transit', transit_mode: mode === 'bus' ? 'bus' : 'train|tram|subway', depart_epoch: Math.floor(departEpoch / 60) * 60 }
          : { mode: gmode, depart_epoch: departEpoch }],
      }))[0];
      if (!r || r.status !== 'OK') {
        console.warn('[RoutePlanner] depart-now', mode, r?.status ?? 'NO_RESULT', r?.error_message ?? '');
        return null;
      }
      data = r.data;
    } else {
      const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(origin)}`
        + `&destination=${encodeURIComponent(corrected)}&mode=${gmode}`
        + (transit ? `&transit_mode=${encodeURIComponent(mode === 'bus' ? 'bus' : 'train|tram|subway')}&alternatives=true&language=he` : '')
        + `&departure_time=${departEpoch}&region=il&key=${key}`;
      data = await (await fetch(url)).json();
      if (data?.status !== 'OK') {
        console.warn('[RoutePlanner] depart-now', mode, data?.status, data?.error_message ?? '');
        return null;
      }
    }
  } catch (e) {
    console.warn('[RoutePlanner] depart-now', mode, 'unreachable:', e);
    return null;
  }

  if (transit) {
    // fallbackArrival is only used if Google omits times; a depart-now query
    // returns real arrival_time, so the parsed arriveAt is the true ETA.
    // Same ranking as the arrive-by path: the NEXT bus should also be the
    // simplest one, not whichever route Google happened to list first.
    // …but "leave now" wants the one that ARRIVES first, not the simplest:
    // the simplest can leave hours later (utils/transitParse.soonestArrival).
    return soonestArrival(parseTransitAlternatives(data, '', corrected, userProfile.homeAddress), nowHHMM(now));
  }

  // Car / bike / walk: leave now, arrive now + duration (traffic-aware for car).
  const legType = mode === 'car' ? 'car' : mode === 'bike' ? 'bike' : 'walk';
  const leg = data?.routes?.[0]?.legs?.[0];
  if (!leg) {
    console.warn('[RoutePlanner] depart-now', mode, 'OK but no route to read');
    return null;
  }
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
  const gateway = directionsGateway();
  if (!key && !gateway) return [];

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
    let plans: TransitPlan[] = [];
    try {
      // Through the server, like every route: the phone's key is refused on
      // a raw fetch, so this list — the "tap for the next ones" under MISSED —
      // came back empty every time.
      let data: any;
      if (gateway) {
        const r = (await gateway({
          origin,
          destination: corrected,
          date,
          queries: [{ mode: 'transit', transit_mode: wantRail ? 'train|tram|subway' : 'bus', depart_epoch: departEpoch }],
        }))[0];
        if (!r || r.status !== 'OK') {
          console.warn('[RoutePlanner] next departures', mode, r?.status ?? 'NO_RESULT', r?.error_message ?? '');
          break;
        }
        data = r.data;
      } else {
        const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(origin)}`
          + `&destination=${encodeURIComponent(corrected)}&mode=transit${pref}`
          + `&departure_time=${departEpoch}&alternatives=true&region=il&language=he&key=${key}`;
        data = await (await fetch(url)).json();
      }
      plans = parseTransitAlternatives(data, '', corrected, userProfile.homeAddress);
    } catch (e) {
      console.warn('[RoutePlanner] next departures unreachable:', e);
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
 * "‹ earlier · later ›" — the journey just before or after `current`, from the
 * SAME origin (where the stored plan starts) to the same place. Koral, 13.10:
 * "you chose a train that arrives too early for me and I want to see later".
 *
 * Later = depart after the current one leaves; a later feeder bus to the same
 * train is skipped (up to four probes) so the arrow lands on the next TRAIN.
 * Earlier = arrive by a minute before the current arrival.
 *
 * Returns the reason with the empty answer (rule 1): "no later one today" and
 * "Google refused" are different things to tell her.
 */
export async function getNeighbourDeparture(
  current: TransitPlan,
  destination: string,
  userProfile: UserProfile,
  date: string,
  dir: StepDir,
): Promise<{ plan: TransitPlan | null; reason?: 'none' | 'no-origin' | 'refused' | 'unreachable' }> {
  const gateway = directionsGateway();
  const key = mapsKey();
  if (!gateway && !key) return { plan: null, reason: 'refused' };
  const origin = (current.startLat && current.startLng)
    ? `${current.startLat},${current.startLng}`
    : (current.originAddress
      || (userProfile.homeLat && userProfile.homeLng ? `${userProfile.homeLat},${userProfile.homeLng}` : userProfile.homeAddress));
  if (!origin) return { plan: null, reason: 'no-origin' };
  const corrected = correctPlaceName(destination);
  const epochOf = (hhmm: string) => Math.floor(new Date(`${date}T${hhmm.padStart(5, '0')}:00`).getTime() / 1000);

  const ask = async (q: { depart_epoch?: number; arriveBy?: string }): Promise<TransitPlan[] | 'refused'> => {
    let data: any;
    if (gateway) {
      const r = (await gateway({
        origin, destination: corrected, date,
        ...(q.arriveBy ? { arriveBy: q.arriveBy } : {}),
        queries: [{ mode: 'transit', ...(q.depart_epoch ? { depart_epoch: q.depart_epoch } : {}) }],
      }))[0];
      if (!r || r.status !== 'OK') {
        console.warn('[RoutePlanner] neighbour departure', dir, r?.status ?? 'NO_RESULT', r?.error_message ?? '');
        return r?.status === 'ZERO_RESULTS' ? [] : 'refused';
      }
      data = r.data;
    } else {
      const when = q.arriveBy ? `&arrival_time=${epochOf(q.arriveBy)}` : `&departure_time=${q.depart_epoch}`;
      data = await (await fetch(`https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(origin)}`
        + `&destination=${encodeURIComponent(corrected)}&mode=transit${when}&alternatives=true&region=il&language=he&key=${key}`)).json();
      if (data?.status !== 'OK') {
        console.warn('[RoutePlanner] neighbour departure', dir, data?.status, data?.error_message ?? '');
        return data?.status === 'ZERO_RESULTS' ? [] : 'refused';
      }
    }
    return parseTransitAlternatives(data, '', corrected, current.originLabel || 'Home');
  };

  try {
    if (dir === 'earlier') {
      const plans = await ask({ arriveBy: hhmmMinus(current.arriveAt, 1) });
      if (plans === 'refused') return { plan: null, reason: 'refused' };
      const plan = pickNeighbour(plans, current, 'earlier');
      return plan ? { plan } : { plan: null, reason: 'none' };
    }
    let anchor = hhmmPlus(current.leaveHomeAt, 1);
    for (let i = 0; i < 4; i += 1) {
      const plans = await ask({ depart_epoch: epochOf(anchor) });
      if (plans === 'refused') return { plan: null, reason: 'refused' };
      const plan = pickNeighbour(plans, current, 'later');
      if (plan) return { plan };
      // Only the same train again (a later feeder bus): step past it.
      const same = plans.filter((p) => p.leaveHomeAt >= anchor).sort((a, b) => a.leaveHomeAt.localeCompare(b.leaveHomeAt))[0];
      if (!same) break;
      const next = hhmmPlus(same.leaveHomeAt, 1);
      if (next <= anchor) break;   // wrapped past midnight
      anchor = next;
    }
    return { plan: null, reason: 'none' };
  } catch (e) {
    console.warn('[RoutePlanner] neighbour departure unreachable:', e);
    return { plan: null, reason: 'unreachable' };
  }
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
  try {
    const hits = await placeTextSearch(correctPlaceName(query));
    return hits.slice(0, 3).map((r, i) => ({
      ...r,
      confidence: i === 0 ? 0.9 : i === 1 ? 0.7 : 0.5,
    }));
  } catch (e) {
    console.warn('[RoutePlanner] place search failed:', String((e as Error)?.message ?? e));
    return [];
  }
}
