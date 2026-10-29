/**
 * transitParse — pure Google Directions → TransitPlan conversion + the HH:MM
 * helpers around it. Extracted from GoogleService so it can be unit-tested
 * without the Expo runtime (GoogleService pulls expo-auth-session/secure-store
 * at import time). GoogleService re-exports nothing new — it imports from here.
 *
 * Dependencies: types (TransitPlan, TransitLeg) only. No I/O, no side effects.
 * Consumers: services/GoogleService, tests/run-transit-parse.ts.
 */
import { TransitPlan, TransitLeg } from '../types/index';

/** Normalize a Directions time text ("8:14", "08:14 בבוקר") to padded "HH:MM"; returns input if no time found. */
export function padHHMM(text: string): string {
  const m = (text || '').match(/(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : text;
}

/** HH:MM minus N minutes, wrapping at midnight. */
export function hhmmMinus(hhmm: string, mins: number): string {
  const [h, m] = hhmm.split(':').map(Number);
  const total = (((h * 60 + m - mins) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** HH:MM plus N minutes, wrapping at midnight. */
export function hhmmPlus(hhmm: string, mins: number): string {
  return hhmmMinus(hhmm, -mins);
}

/** Google vehicle type → our leg type (bus is the catch-all). */
export function legTypeOf(vehicle: string): 'bus' | 'train' | 'subway' {
  const v = String(vehicle || 'BUS').toUpperCase();
  if (v === 'SUBWAY' || v === 'METRO_RAIL') return 'subway';
  return /RAIL|TRAIN|TRAM|MONORAIL/.test(v) ? 'train' : 'bus';
}

/**
 * What to print for "which vehicle is this".
 *
 * A bus gives `short_name` — "567" — which is exactly the thing she is looking
 * for on the front of it. Israel Railways gives no `short_name` at all, so the
 * fallback reached for `line.name`, and for rail that name is the LINE'S TWO
 * TERMINI:
 *
 *   "אשקלון-אשקלון<->בנימינה-בנימינה גבעת עדה"
 *
 * which reached her interview card as "גבעת עדה" — a station eighty kilometres
 * north of Ra'anana, on a trip to Ra'anana. Koral read it at midnight the night
 * before and could not make it mean anything, which is correct: it does not
 * describe her journey. It is the name of the rails she happens to be on, and
 * she gets off in the middle.
 *
 * So a two-terminus name is never printed whole. What she needs is the
 * DIRECTION — the thing written on the front of the train and on the platform
 * board — and Google's word for that is `headsign`, which the leg already
 * carries and the card already prints. When a headsign exists this returns
 * nothing at all rather than saying the same thing twice; when there is none,
 * the far terminus is that same information and is used instead.
 *
 * Anything that is not rail, and any rail name that is not two termini, is
 * passed through untouched — this refuses to guess at prose it does not
 * recognise (rule 8).
 */
const TERMINI_SEPARATOR = /<->|<=>|↔/;

/** "בנימינה-בנימינה גבעת עדה" → "בנימינה גבעת עדה". Israel Railways prefixes a
 *  station's short name to its full one; printing both reads as two places. */
function collapseStationName(part: string): string {
  const [head, ...rest] = part.split('-');
  const tail = rest.join('-').trim();
  const short = head.trim();
  if (tail && short && tail.startsWith(short)) return tail;
  return part.trim();
}

export function lineLabel(
  shortName: string | undefined,
  name: string | undefined,
  headsign: string | undefined,
  type: 'walk' | 'bus' | 'train' | 'subway',
): string {
  const short = (shortName || '').trim();
  if (short) return short;
  const full = (name || '').trim();
  if (type !== 'train' && type !== 'subway') return full;
  const parts = full.split(TERMINI_SEPARATOR);
  if (parts.length < 2) return full;
  // The headsign says the direction better, and the card prints it already.
  if ((headsign || '').trim()) return '';
  return collapseStationName(parts[parts.length - 1]);
}

/**
 * Parse one Directions transit response into a TransitPlan (null when no route).
 *
 * EVERY step becomes a leg. The old version kept a single walk step + a single
 * transit step, so a real 45-min trip (bus 15 min → transfer → bus 25 min)
 * displayed as "15m" and every downstream duration/ETA was wrong. Same shape as
 * the backend's geo._transit_legs.
 */
export function parseTransitRoute(
  data: any,
  fallbackArrival: string,
  destination: string,
  /** Where the trip starts. Not always home — a chained day leaves from the
   *  previous appointment, and labelling that leg "Home" was simply wrong. */
  originLabel = 'Home',
  /** Which of Google's routes to read. Google returns several when asked
   *  (alternatives=true) and they are NOT equivalent: for one real trip it
   *  offered 38+172 first and, further down the list, a single bus 176 that was
   *  three minutes faster. Reading only index 0 is why Lumi kept proposing two
   *  buses where Google Maps showed one. */
  routeIndex = 0,
): TransitPlan | null {
  if (!data.routes?.[routeIndex]) return null;

  const route = data.routes[routeIndex].legs[0];
  const steps: any[] = route.steps || [];
  const transitSteps = steps.filter((s: any) => s.travel_mode === 'TRANSIT');
  const firstTransit = transitSteps[0];

  // Door-to-door anchors of THIS departure. Google times the initial walk to
  // meet the actual vehicle, so departure_time IS "when you must start moving".
  const arriveAt = padHHMM(route.arrival_time?.text || fallbackArrival);
  const doorDeparture = padHHMM(
    route.departure_time?.text
      || firstTransit?.transit_details?.departure_time?.text
      || fallbackArrival,
  );

  // Walk-to-first-stop = the leading walking step (0 when you board at the door).
  const walkMinutes =
    steps[0]?.travel_mode === 'WALKING' ? Math.ceil(steps[0].duration.value / 60) : 0;
  const busDeparture = padHHMM(
    firstTransit?.transit_details?.departure_time?.text || doorDeparture,
  );
  const stopName = firstTransit?.transit_details?.departure_stop?.name || '';

  // Times: transit steps carry their own timetable times; walking steps get
  // chained off the previous arrival so the whole list reads as one clock.
  let cursor = doorDeparture;
  const legs: TransitLeg[] = [];
  steps.forEach((s: any, i: number) => {
    const minutes = Math.max(1, Math.round((s.duration?.value ?? 60) / 60));
    if (s.travel_mode === 'TRANSIT') {
      const td = s.transit_details || {};
      const dep = padHHMM(td.departure_time?.text || cursor);
      const arr = padHHMM(td.arrival_time?.text || hhmmPlus(dep, minutes));
      cursor = arr;
      legs.push({
        type: legTypeOf(td.line?.vehicle?.type),
        from: td.departure_stop?.name || (i === 0 ? originLabel : ''),
        to: td.arrival_stop?.name || '',
        durationMinutes: minutes,
        departureTime: dep,
        arrivalTime: arr,
        lineNumber: lineLabel(
          td.line?.short_name, td.line?.name, td.headsign, legTypeOf(td.line?.vehicle?.type),
        ),
        stopName: td.departure_stop?.name,
        stopLat: s.start_location?.lat,
        stopLng: s.start_location?.lng,
        // The direction, which is how a platform is actually signed. Google
        // gives no platform number in Israel; `headsign` is the real answer
        // to "which of these two trains am I standing in front of".
        headsign: td.headsign || undefined,
        // Read where a provider offers it. Google does not, today.
        platform: td.departure_stop?.platform_code || td.platform || undefined,
      });
      return;
    }
    const dep = cursor;
    // A walk that leads into a vehicle ends when that vehicle departs (Google
    // folds the wait into the walk), otherwise it just runs its own length.
    const nextTransitDep = steps[i + 1]?.transit_details?.departure_time?.text;
    const arr = nextTransitDep ? padHHMM(nextTransitDep) : hhmmPlus(dep, minutes);
    cursor = arr;
    legs.push({
      type: 'walk',
      from: i === 0 ? originLabel : legs[legs.length - 1]?.to || '',
      to: steps[i + 1]?.transit_details?.departure_stop?.name
        || (i === steps.length - 1 ? destination : ''),
      durationMinutes: minutes,
      departureTime: dep,
      arrivalTime: arr,
    });
  });

  // Small safety margin on top of Google's own door departure time.
  const leaveHomeAt = hhmmMinus(doorDeparture, 5);

  return {
    // Door-to-door total straight from Google (walks + rides + transfers).
    totalDurationMinutes: Math.max(1, Math.round(route.duration.value / 60)),
    leaveHomeAt,
    arriveAt,
    firstBusDeparture: busDeparture,
    firstBusStop: stopName,
    walkToStopMinutes: walkMinutes,
    legs,
    overviewPolyline: data.routes[routeIndex].overview_polyline?.points,
    startLat: route.start_location?.lat,
    startLng: route.start_location?.lng,
    destLat: route.end_location?.lat,
    destLng: route.end_location?.lng,
    source: 'google',
    fetchedAt: Date.now(),
  };
}


/**
 * Every route Google returned, best first — the answer to "why is Lumi sending
 * me on two buses when Maps shows one?".
 *
 * Ranking, in order:
 *   1. arrives by the deadline (a route that gets you there late is not an
 *      option, however elegant);
 *   2. LOWEST transitScore: door to door PLUS what the changes cost — a change is a second thing
 *      that can be missed (CHANGE_COST_MIN), every minute standing at a change past OK_WAIT_MIN
 *      counts, and a connection with no time to make it is not a plan. One bus still beats two
 *      at equal time, but a tidy 35-minute train-and-bus beats a 60-minute direct;
 *   3. fewest rides;
 *   4. latest departure (less standing at a stop).
 *
 * `deadline` may be '' for depart-now queries, where every route is on time by
 * definition.
 */
export function parseTransitAlternatives(
  data: any,
  fallbackArrival: string,
  destination: string,
  originLabel = 'Home',
  deadline = '',
): TransitPlan[] {
  const count = data?.routes?.length ?? 0;
  const plans: TransitPlan[] = [];
  for (let i = 0; i < count; i++) {
    const plan = parseTransitRoute(data, fallbackArrival, destination, originLabel, i);
    if (plan) plans.push(plan);
  }
  const onTime = (p: TransitPlan) => (deadline ? p.arriveAt <= deadline : true);
  return plans.sort((a, b) => {
    if (onTime(a) !== onTime(b)) return onTime(a) ? -1 : 1;
    const sa = transitScore(a); const sb = transitScore(b);
    if (sa !== sb) return sa - sb;
    if (rideCount(a) !== rideCount(b)) return rideCount(a) - rideCount(b);
    return a.leaveHomeAt < b.leaveHomeAt ? 1 : -1;
  });
}

const legMin = (s: string): number => {
  const [h, m] = (s || '').split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : NaN;
};

/**
 * Minutes spent STANDING between two vehicles, one number per change: next vehicle's departure,
 * minus the last one's arrival, minus the walking in between. A negative number is a connection
 * that cannot be made (21.10, Koral: "the changes between train and bus are very slow — or do
 * not happen at all"). Walking legs are not changes.
 */
export function transferWaits(plan: TransitPlan): number[] {
  const waits: number[] = [];
  let lastArrive = NaN;
  let walked = 0;
  for (const leg of plan.legs) {
    if (leg.type === 'walk') { walked += leg.durationMinutes || 0; continue; }
    const dep = legMin(leg.departureTime);
    if (Number.isFinite(lastArrive) && Number.isFinite(dep)) waits.push(dep - lastArrive - walked);
    lastArrive = legMin(leg.arrivalTime);
    walked = 0;
  }
  return waits;
}

/** How long a wait at a change is acceptable before it starts to cost (minutes). */
const OK_WAIT_MIN = 6;
/** A change is a second thing that can be missed: it costs this much even when the wait is short. */
const CHANGE_COST_MIN = 4;

/**
 * Door-to-door minutes PLUS what the changes really cost. Ranking used to be "fewest rides, then
 * fastest", so a 60-minute direct bus beat a 35-minute train-and-bus with a tidy change. Now a
 * change costs CHANGE_COST_MIN, every minute standing beyond OK_WAIT_MIN costs a minute, and a
 * connection with no time to make it costs a wall (+60): it is not a plan.
 */
export function transitScore(plan: TransitPlan): number {
  const waits = transferWaits(plan);
  const wait = waits.reduce((sum, w) => sum + (w < 1 ? 60 : Math.max(0, w - OK_WAIT_MIN)), 0);
  return plan.totalDurationMinutes + CHANGE_COST_MIN * waits.length + wait;
}

/** How many vehicles this plan puts you on (walking legs are not rides). */
export function rideCount(plan: TransitPlan): number {
  return plan.legs.filter((l) => l.type !== 'walk').length;
}

/** "🚌 176 · 32 min · one bus · arrive 16:06" — one line per option. */
/** The vehicle she is actually on. 🚌 above a train is the app not listening. */
const RIDE_ICON: Record<string, string> = {
  train: '🚆', subway: '🚇', tram: '🚊', bus: '🚌',
};

export function describePlanOption(plan: TransitPlan, he: boolean): string {
  const rides = plan.legs.filter((l) => l.type !== 'walk');
  const lines = rides.map((l) => l.lineNumber).filter(Boolean).join(' + ');
  const changes = rides.length <= 1
    ? (he ? 'ישיר' : 'direct')
    : (he ? `${rides.length - 1} החלפות` : `${rides.length - 1} changes`);
  // The FIRST vehicle, which is the one she is deciding whether to run for.
  // This was hard-coded to 🚌 and drew a bus over her train every time.
  const icon = RIDE_ICON[rides[0]?.type ?? ''] ?? '🚌';
  return he
    ? `${icon} ${lines || 'נסיעה'} · ${changes} · ${plan.totalDurationMinutes} דק' · יציאה ${plan.leaveHomeAt}, הגעה ${plan.arriveAt}`
    : `${icon} ${lines || 'ride'} · ${changes} · ${plan.totalDurationMinutes} min · leave ${plan.leaveHomeAt}, arrive ${plan.arriveAt}`;
}

/**
 * "Leave now" → the journey that gets her there FIRST.
 *
 * parseTransitAlternatives ranks for an arrive-by plan: fewest changes, then
 * fastest. That is the wrong question once she is late. On 29.9 at 15:19,
 * still home for a 16:00 birthday, Google's depart-now answer held the 15:36
 * bus AND a direct line 2 at 18:16 — same minutes, three hours on, because the
 * line runs a clock-face timetable — and "simplest" picked 18:16: "arrive
 * 18:57, 177 min late", when she could have been there by 16:12.
 *
 * Earliest arrival wins (measured from `now`, so a trip past midnight counts
 * as later, not earlier); fewer rides only break a tie.
 */
export function soonestArrival(plans: TransitPlan[], nowHHMM: string): TransitPlan | null {
  const toMin = (s: string) => {
    const [h, m] = (s || '').split(':').map(Number);
    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : NaN;
  };
  const now = toMin(nowHHMM);
  const ahead = (s: string) => {
    const t = toMin(s);
    if (!Number.isFinite(t) || !Number.isFinite(now)) return Infinity;
    return (t - now + 1440) % 1440;
  };
  // A departure that has already GONE is not an option, however early it arrives: 21.10, 09:38,
  // a cached "now" answer from 09:32 (arrive 10:06) beat the real next bus (arrive 10:29) and she
  // was told to leave on one that had left. Leave times within the last 12 h count as passed.
  const gone = (p: TransitPlan) => {
    const leave = toMin(p.leaveHomeAt);
    if (!Number.isFinite(leave) || !Number.isFinite(now)) return false;
    const pastBy = (now - leave + 1440) % 1440;
    return pastBy >= 2 && pastBy <= 720;
  };
  const live = plans.filter((p) => !gone(p));
  if (plans.length && !live.length) return null;   // every answer is stale: say so (the caller warns), never pick one
  plans = live;
  const usable = plans.filter((p) => Number.isFinite(ahead(p.arriveAt)));
  if (!usable.length) return plans[0] ?? null;
  return [...usable].sort((a, b) => ahead(a.arriveAt) - ahead(b.arriveAt) || rideCount(a) - rideCount(b))[0];
}

/** Israel Railways' "headsign" is the train's NUMBER (256), not where it goes —
 *  "towards 256" read as nonsense. The number is what the station boards show. */
export function headsignText(headsign: string | undefined, he: boolean): string {
  if (!headsign) return '';
  if (/^\d+$/.test(headsign.trim())) return he ? `רכבת מס׳ ${headsign.trim()}` : `train no. ${headsign.trim()}`;
  return he ? `לכיוון ${headsign}` : `towards ${headsign}`;
}
