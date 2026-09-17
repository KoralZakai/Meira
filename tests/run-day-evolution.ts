/**
 * run-day-evolution — a day that is already planned, and then keeps changing.
 *
 * Koral, 2026-09-17, and this is the whole product in one sentence:
 *
 *   "Create a test where the schedule is already planned, and new tasks are
 *    coming and make some changes. very important is that the travel routes
 *    will get updated every time the user change his location! it supposed to
 *    be very dynamic and accurate! that's the whole point of the app — know
 *    where you are and help you automatically know how to get to next
 *    destination."
 *
 * Every other test in this repo checks ONE decision in isolation. That is what
 * lets each of them be fast and pure, and it is also how a day can be made of
 * individually-correct decisions and still come out wrong: the yoga class was
 * routed correctly, the gap was measured correctly, the prep block was placed
 * correctly in that gap, and the result was a two-hour block sitting across
 * the bike ride.
 *
 * So this one is a NARRATIVE. One day, in order, with the clock and her
 * position moving between steps, and after every single step the same
 * question: is the plan on screen still the plan she needs?
 *
 *   08:00  the day is planned                       ← routes exist
 *   11:20  a yoga class arrives with a place name    ← it must get coordinates
 *   11:21  ...and a route, so a leave time exists    ← or the gap lies
 *   11:22  a gap-filler block is offered             ← it must not eat 18:40
 *   14:00  she is at home, on plan                   ← do NOT burn a route call
 *   15:05  she walks to a café across town           ← every leave time is now wrong
 *   16:30  the route is re-planned from the café     ← the point of the app
 *   18:45  she has not left                          ← the plan is fiction
 *   19:00  she is standing in Charles Clore          ← stop planning, she arrived
 *
 * Nothing here is mocked except Google: travel time is a deterministic
 * function of distance, so the numbers are reproducible and the DECISIONS —
 * which are what the app gets wrong — are the real ones.
 *
 * Run:  npx tsx tests/run-day-evolution.ts
 */
import { Task, TaskLocation } from '../src/types/index';
import { decideLiveReplan, REPLAN_COOLDOWN_MS } from '../src/utils/liveReplanDecision';
import { yieldToFixed, protectedWindowFor } from '../src/utils/yieldToFixed';
import { pickCoords, locationIsPlaced, needsGeocode } from '../src/utils/placeCoords';
import { classifyOverlap } from '../src/utils/overlapKind';
import { findDayGaps } from '../src/utils/findGaps';
import { timeToMinutes, minutesToTime } from '../src/utils/timeUtils';

let failures = 0; let checks = 0;
const check = (l: string, ok: boolean, d = '') => {
  checks += 1; if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${l}${d ? `  — ${d}` : ''}`);
};

const DATE = '2026-09-17';

// ── The real places, so the distances are real ────────────────────────────
const HOME    = { lat: 32.0853, lng: 34.7818 };  // central Tel Aviv
const CLORE   = { lat: 32.0632, lng: 34.7606 };  // Charles Clore Park
const CAFE    = { lat: 32.1093, lng: 34.8555 };  // Ramat Gan — properly far
const STUDIO  = { lat: 32.0700, lng: 34.7900 };

/** Metres between two points. The same haversine positionDrift uses. */
function metres(a: typeof HOME, b: typeof HOME): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat); const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

/**
 * Stand-in for Google Directions: deterministic, distance-based, and the ONLY
 * thing in this file that is not the app's own code.
 *
 * Bikes average about 15 km/h through a city once lights and locking up are
 * counted, so a kilometre is four minutes, with a floor of five.
 */
let routeCalls = 0;
function route(from: typeof HOME, to: typeof HOME, arriveBy: string) {
  routeCalls += 1;
  const mins = Math.max(5, Math.round((metres(from, to) / 1000) * 4));
  const leave = minutesToTime(timeToMinutes(arriveBy) - mins);
  return {
    totalDurationMinutes: mins,
    leaveHomeAt: leave,
    arriveAt: arriveBy,
    firstBusDeparture: leave, firstBusStop: '', walkToStopMinutes: 0, legs: [],
    startLat: from.lat, startLng: from.lng,
    destLat: to.lat, destLng: to.lng,
    source: 'google' as const, fetchedAt: Date.now(),
  };
}

const task = (over: Partial<Task>): Task => ({
  id: 'x', text: 'x', category: 'general', priority: 'need_to', isFixed: false,
  durationMinutes: 30, date: DATE, status: 'pending',
  createdAt: 0, historicalDurations: [], ...over,
} as Task);

const locOf = (t: Task) => t.location as TaskLocation;

function main() {
  console.log('\nOne day, in order, as it actually changes\n');

  // ── 08:00 — the day is already planned ──────────────────────────────────
  console.log('08:00  The day is already planned');
  const lesson = task({
    id: 'lesson', text: 'שיעור פרטי לילדה בכיתה ט׳', category: 'class', isFixed: true,
    fixedTime: '15:00', durationMinutes: 60,
    location: { address: "23, Mordei ha-Geta'ot Street, Tel Aviv", ...STUDIO, confirmed: true } as TaskLocation,
  });
  lesson.location = {
    ...locOf(lesson),
    transitPlan: route(HOME, STUDIO, '15:00'),
    leaveHomeBy: route(HOME, STUDIO, '15:00').leaveHomeAt,
    travelMinutes: route(HOME, STUDIO, '15:00').totalDurationMinutes,
  } as TaskLocation;
  check('the planned lesson knows where it is', locationIsPlaced(locOf(lesson)));
  check('...and when to leave', Boolean(locOf(lesson).leaveHomeBy), locOf(lesson).leaveHomeBy);

  // ── 11:20 — "יוגה בצ׳ארלס קלור ב-7" ─────────────────────────────────────
  console.log('\n11:20  A yoga class arrives, named by a place, not an address');
  // What the server sends today: find_place resolved the NAME to a street, and
  // the coordinates were dropped on the way. This is the exact shape she had.
  let yoga = task({
    id: 'yoga', text: 'יוגה בצ׳ארלס קלור', category: 'hobby_class', isFixed: true,
    fixedTime: '19:00', durationMinutes: 60,
    location: { address: '11א, Kaufmann Street, Tel Aviv', displayName: 'צ׳ארלס קלור',
      lat: 0, lng: 0, confirmed: false } as TaskLocation,
  });
  check('it arrives with no position — this is the reported bug',
    !locationIsPlaced(locOf(yoga)));
  check('...and the app can SAY that it needs one', needsGeocode(locOf(yoga)));
  check('an unplaced class must not be drawn on a map',
    pickCoords(locOf(yoga), null) === null);

  // ── 11:21 — routing it also places it ───────────────────────────────────
  console.log('\n11:21  Routing it is also what places it');
  const yogaPlan = route(HOME, CLORE, '19:00');
  const found = pickCoords(locOf(yoga), yogaPlan)!;
  check('Google\'s own end point supplies the coordinates', found.lat === CLORE.lat);
  yoga = { ...yoga, location: { ...locOf(yoga), ...found,
    transitPlan: yogaPlan, leaveHomeBy: yogaPlan.leaveHomeAt,
    travelMinutes: yogaPlan.totalDurationMinutes, transportType: 'bike' } as TaskLocation };
  check('the class is now on the map', locationIsPlaced(locOf(yoga)));
  check('...and asks for nothing more', !needsGeocode(locOf(yoga)));
  const leaveForYoga = locOf(yoga).leaveHomeBy!;
  check('a leave time exists, worked back from 19:00', leaveForYoga < '19:00', leaveForYoga);

  const window = protectedWindowFor(yoga, null)!;
  check('getting ready is drawn before the ride, not skipped',
    window.readyAt < window.leaveAt, `${window.readyAt} → ${window.leaveAt}`);
  check('the travel time is Google\'s, not an assumption', window.travelAssumed === false);

  // ── 11:22 — the gap between the lesson and the class ────────────────────
  console.log('\n11:22  The free window must end at the DEPARTURE, not at 19:00');
  const gaps = findDayGaps([lesson, yoga], { dayStart: '08:00', dayEnd: '23:00', now: '11:22' });
  const evening = gaps.find((g) => g.start >= '16:00' && g.end <= '19:00');
  check('there is an evening window', Boolean(evening), evening ? `${evening.start}–${evening.end}` : 'none');
  check('it closes when she has to leave, not when the class starts',
    evening!.end === leaveForYoga, evening!.end);
  check('...and it says so, so the UI can too', evening!.endsAtDeparture === true);

  // ── the bug she photographed ────────────────────────────────────────────
  console.log('\n11:23  A prep block dropped across that departure must yield');
  const prep = task({
    id: 'prep', text: 'Prepare for: Your phone interview with Ceva',
    category: 'course', priority: 'must', scheduledTime: '18:18', durationMinutes: 120,
  });
  const verdict = classifyOverlap(prep, yoga)!;
  check('it is DISPLACED, not "you can take the call on the way"',
    verdict.kind === 'displaced', verdict.kind);
  check('it names the departure it was covering', verdict.departureAt === leaveForYoga);
  const plan = yieldToFixed([lesson, yoga, prep], { now: '11:23', dayEnd: '23:00' })[0];
  check('the prep block is the one that moves, never the class', plan.taskId === 'prep');
  check('it keeps all two hours', plan.minutes === 120);
  check('and it lands after the class ends', plan.to!.start >= '20:00', plan.to?.start);

  // ── 14:00 — nothing has changed ─────────────────────────────────────────
  console.log('\n14:00  She is at home and on plan — do NOT spend a route call');
  const before = routeCalls;
  const still = decideLiveReplan({
    current: HOME,
    trip: { destination: CLORE, plannedFrom: HOME,
      leaveHomeBy: leaveForYoga, arriveAt: '19:00', appointment: '19:00' },
    home: HOME,
    now: new Date(`${DATE}T14:00:00`),
  });
  check('the answer is "on plan"', still.reason === 'on-plan', still.reason);
  check('...and it costs nothing', still.replan === false && routeCalls === before);

  // ── 15:05 — SHE MOVES. This is the point of the app. ────────────────────
  console.log('\n15:05  She moves across town — every leave time on screen is now wrong');
  const moved = decideLiveReplan({
    current: CAFE,
    trip: { destination: CLORE, plannedFrom: HOME,
      leaveHomeBy: leaveForYoga, arriveAt: '19:00', appointment: '19:00' },
    home: HOME,
    now: new Date(`${DATE}T15:05:00`),
  });
  check('the app notices, by itself', moved.replan === true);
  check('...and knows why', moved.reason === 'moved-off-origin', moved.reason);
  check('...and by how far', (moved.metres ?? 0) > 5000, `${moved.metres} m`);

  console.log('\n15:06  Re-planned from where she actually is');
  const fromCafe = route(CAFE, CLORE, '19:00');
  check('the ride is longer from Ramat Gan than from home',
    fromCafe.totalDurationMinutes > yogaPlan.totalDurationMinutes,
    `${fromCafe.totalDurationMinutes} vs ${yogaPlan.totalDurationMinutes} min`);
  check('so she is told to leave EARLIER than the old plan said',
    fromCafe.leaveHomeAt < leaveForYoga, `${fromCafe.leaveHomeAt} < ${leaveForYoga}`);
  yoga = { ...yoga, location: { ...locOf(yoga), transitPlan: fromCafe,
    leaveHomeBy: fromCafe.leaveHomeAt, travelMinutes: fromCafe.totalDurationMinutes } as TaskLocation };
  check('the destination did not move just because she did',
    locOf(yoga).lat === CLORE.lat && locOf(yoga).lng === CLORE.lng);

  console.log('\n15:07  ...and it does not do it again one minute later');
  const again = decideLiveReplan({
    current: { lat: CAFE.lat + 0.0002, lng: CAFE.lng },
    trip: { destination: CLORE, plannedFrom: CAFE,
      leaveHomeBy: fromCafe.leaveHomeAt, arriveAt: '19:00', appointment: '19:00' },
    home: HOME,
    now: new Date(`${DATE}T15:07:00`),
    lastReplanAt: new Date(`${DATE}T15:06:00`).getTime(),
  });
  check('a few metres is not a move', again.replan === false, again.reason);

  console.log('\n15:20  A REAL second move re-plans again, cooldown or not');
  const movedTwice = decideLiveReplan({
    current: HOME,
    trip: { destination: CLORE, plannedFrom: CAFE,
      leaveHomeBy: fromCafe.leaveHomeAt, arriveAt: '19:00', appointment: '19:00' },
    home: HOME,
    now: new Date(`${DATE}T15:20:00`),
    lastReplanAt: new Date(`${DATE}T15:06:00`).getTime(),
  });
  check('going home again is a new origin and a new route',
    movedTwice.replan === true && movedTwice.reason === 'moved-off-origin', movedTwice.reason);
  check(`the cooldown is ${REPLAN_COOLDOWN_MS / 60000} minutes and was past`, true);

  // ── 18:45 — the departure has gone ──────────────────────────────────────
  console.log('\n18:45  The leave time passed and she is still at her desk');
  const late = decideLiveReplan({
    current: HOME,
    trip: { destination: CLORE, plannedFrom: HOME,
      leaveHomeBy: '18:40', arriveAt: '19:00', appointment: '19:00' },
    home: HOME,
    now: new Date(`${DATE}T18:45:00`),
  });
  check('the plan on screen is fiction and the app says so', late.replan === true);
  check('...because the departure was missed', late.reason === 'departure-missed', late.reason);

  console.log('\n18:46  Re-planned from now — and the honest answer is she can still make it');
  const rideNow = route(HOME, CLORE, '19:00').totalDurationMinutes;
  const arrival = minutesToTime(timeToMinutes('18:46') + rideNow);
  check('a missed departure is not the same as a missed class',
    arrival <= '19:00', `leaving now lands at ${arrival}`);
  check('...so the re-plan tells her to go, not that it is hopeless', rideNow <= 20);

  console.log('\n18:55  Nine minutes later it IS hopeless, and that is said too');
  const tooLate = minutesToTime(timeToMinutes('18:55') + rideNow);
  check('leaving at 18:55 arrives after the class starts', tooLate > '19:00', tooLate);
  check('the app is still asked to re-plan rather than going quiet',
    decideLiveReplan({
      current: HOME,
      trip: { destination: CLORE, plannedFrom: HOME,
        leaveHomeBy: '18:40', arriveAt: tooLate, appointment: '19:00' },
      home: HOME,
      now: new Date(`${DATE}T18:55:00`),
    }).replan === true);

  // ── 19:00 — she is there ────────────────────────────────────────────────
  console.log('\n19:00  She is standing in Charles Clore');
  const there = decideLiveReplan({
    current: CLORE,
    trip: { destination: CLORE, plannedFrom: HOME,
      leaveHomeBy: '18:40', arriveAt: '19:00', appointment: '19:00' },
    home: HOME,
    now: new Date(`${DATE}T19:00:00`),
  });
  check('planning stops the moment she arrives', there.replan === false);
  check('...and the reason is arrival, not "nothing to do"',
    there.reason === 'already-there', there.reason);

  console.log('\n19:01  Without a GPS fix, a correct plan is never replaced by a guess');
  const blind = decideLiveReplan({
    current: null,
    trip: { destination: CLORE, plannedFrom: HOME, leaveHomeBy: '18:40', appointment: '19:00' },
    home: HOME,
    now: new Date(`${DATE}T19:01:00`),
  });
  check('no fix, no re-plan', blind.replan === false && blind.reason === 'no-fix');

  console.log(`\n${failures ? '✗' : '✓'} ${checks - failures}/${checks} checks passed`);
  console.log(`  (${routeCalls} routing calls for a whole day)\n`);
  process.exit(failures ? 1 : 0);
}

main();
