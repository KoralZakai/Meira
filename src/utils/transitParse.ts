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
        lineNumber: td.line?.short_name || td.line?.name || '',
        stopName: td.departure_stop?.name,
        stopLat: s.start_location?.lat,
        stopLng: s.start_location?.lng,
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
 *   2. FEWEST RIDES. A transfer is not merely time — it is a second thing that
 *      can be missed, in a place you do not know, and that cost does not show
 *      up in the duration Google prints. One bus beats two at equal time;
 *   3. shortest door to door;
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
  const rides = (p: TransitPlan) => p.legs.filter((l) => l.type !== 'walk').length;
  const onTime = (p: TransitPlan) => (deadline ? p.arriveAt <= deadline : true);
  return plans.sort((a, b) => {
    if (onTime(a) !== onTime(b)) return onTime(a) ? -1 : 1;
    if (rides(a) !== rides(b)) return rides(a) - rides(b);
    if (a.totalDurationMinutes !== b.totalDurationMinutes) {
      return a.totalDurationMinutes - b.totalDurationMinutes;
    }
    return a.leaveHomeAt < b.leaveHomeAt ? 1 : -1;
  });
}

/** How many vehicles this plan puts you on (walking legs are not rides). */
export function rideCount(plan: TransitPlan): number {
  return plan.legs.filter((l) => l.type !== 'walk').length;
}

/** "🚌 176 · 32 min · one bus · arrive 16:06" — one line per option. */
export function describePlanOption(plan: TransitPlan, he: boolean): string {
  const rides = plan.legs.filter((l) => l.type !== 'walk');
  const lines = rides.map((l) => l.lineNumber).filter(Boolean).join(' + ');
  const changes = rides.length <= 1
    ? (he ? 'ישיר' : 'direct')
    : (he ? `${rides.length - 1} החלפות` : `${rides.length - 1} changes`);
  return he
    ? `🚌 ${lines || 'נסיעה'} · ${changes} · ${plan.totalDurationMinutes} דק' · יציאה ${plan.leaveHomeAt}, הגעה ${plan.arriveAt}`
    : `🚌 ${lines || 'ride'} · ${changes} · ${plan.totalDurationMinutes} min · leave ${plan.leaveHomeAt}, arrive ${plan.arriveAt}`;
}
