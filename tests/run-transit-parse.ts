/**
 * run-transit-parse — assert-based check for utils/transitParse.
 *
 * Regression under test: a 45-minute two-bus route (walk 6 → bus 15 →
 * transfer walk 4 → bus 20 → walk 3) used to collapse into ONE transit step,
 * so Lumi showed "15 min" where Google says 45.
 *
 * Run: npx tsx tests/run-transit-parse.ts
 */
import assert from 'node:assert';
import {
  parseTransitRoute, parseTransitAlternatives, rideCount, describePlanOption, lineLabel,
} from '../src/utils/transitParse';

const walk = (mins: number, instr = 'Walk') => ({
  travel_mode: 'WALKING',
  duration: { value: mins * 60 },
  html_instructions: instr,
});

const ride = (
  mins: number, line: string, from: string, to: string,
  dep: string, arr: string, vehicle = 'BUS',
) => ({
  travel_mode: 'TRANSIT',
  duration: { value: mins * 60 },
  start_location: { lat: 32.1, lng: 34.8 },
  transit_details: {
    line: { short_name: line, vehicle: { type: vehicle } },
    departure_stop: { name: from },
    arrival_stop: { name: to },
    departure_time: { text: dep },
    arrival_time: { text: arr },
  },
});

// Google's own numbers: leg duration 45 min, door departure 08:00, arrival 08:45.
const twoBusRoute = {
  routes: [{
    overview_polyline: { points: 'abc' },
    legs: [{
      duration: { value: 45 * 60 },
      departure_time: { text: '8:00' },
      arrival_time: { text: '8:45' },
      start_location: { lat: 32.0, lng: 34.7 },
      steps: [
        walk(6),
        ride(15, '251', 'Arlozerov', 'Central Station', '8:06', '8:21'),
        walk(4),
        ride(17, '18', 'Central Station', 'Igal Alon', '8:25', '8:42'),
        walk(3),
      ],
    }],
  }],
};

const plan = parseTransitRoute(twoBusRoute, '09:00', 'Space Gym')!;
assert.ok(plan, 'expected a plan');

// The bug: total must be Google's door-to-door 45, never the first ride's 15.
assert.strictEqual(plan.totalDurationMinutes, 45, 'total minutes');
assert.strictEqual(plan.legs.length, 5, 'every step becomes a leg');
assert.deepStrictEqual(
  plan.legs.map((l) => l.durationMinutes), [6, 15, 4, 17, 3], 'per-leg minutes');
assert.deepStrictEqual(
  plan.legs.map((l) => l.type), ['walk', 'bus', 'walk', 'bus', 'walk'], 'leg types');

// Both lines survive — the transfer used to vanish entirely.
assert.deepStrictEqual(
  plan.legs.filter((l) => l.type !== 'walk').map((l) => l.lineNumber), ['251', '18']);

// Clock chaining: the walk before a ride ends when that ride departs.
assert.strictEqual(plan.legs[0].departureTime, '08:00');
assert.strictEqual(plan.legs[0].arrivalTime, '08:06');
assert.strictEqual(plan.legs[2].arrivalTime, '08:25', 'transfer walk meets bus 18');
assert.strictEqual(plan.legs[4].arrivalTime, '08:45', 'final walk lands at arrival');

assert.strictEqual(plan.firstBusDeparture, '08:06');
assert.strictEqual(plan.firstBusStop, 'Arlozerov');
assert.strictEqual(plan.walkToStopMinutes, 6);
assert.strictEqual(plan.arriveAt, '08:45');
assert.strictEqual(plan.leaveHomeAt, '07:55', 'door departure minus the 5 min margin');

// A train route keeps its vehicle type (used for the 🚆 icon).
const trainPlan = parseTransitRoute({
  routes: [{ legs: [{
    duration: { value: 30 * 60 },
    departure_time: { text: '9:00' }, arrival_time: { text: '9:30' },
    steps: [ride(30, 'R1', 'Binyamina', 'Tel Aviv', '9:00', '9:30', 'HEAVY_RAIL')],
  }] }],
}, '10:00', 'Tel Aviv')!;
assert.strictEqual(trainPlan.legs[0].type, 'train');
assert.strictEqual(trainPlan.walkToStopMinutes, 0, 'no leading walk');

assert.strictEqual(parseTransitRoute({ routes: [] }, '10:00', 'X'), null, 'no route → null');

// ── Alternatives: Google returns several routes and they are NOT equivalent ──
// The real case this comes from: for one Holon appointment Google led with
// 38+172 and listed a single bus 176, three minutes faster, further down. Lumi
// read routes[0] only, so it proposed two buses where Maps showed one.
const oneRide = (line: string, mins: number, dep: string, arr: string) => ({
  overview_polyline: { points: 'x' },
  legs: [{
    duration: { value: mins * 60 },
    departure_time: { text: dep }, arrival_time: { text: arr },
    steps: [ride(mins, line, 'Home stop', 'Dest stop', dep, arr)],
  }],
});
const twoRides = (a: string, b: string, mins: number, dep: string, arr: string) => ({
  overview_polyline: { points: 'y' },
  legs: [{
    duration: { value: mins * 60 },
    departure_time: { text: dep }, arrival_time: { text: arr },
    steps: [
      ride(15, a, 'Home stop', 'Middle', dep, '15:59'),
      walk(2),
      ride(6, b, 'Middle', 'Dest stop', '16:10', arr),
    ],
  }],
});

// Google's order, deliberately worst-first — as it actually came back.
const alts = parseTransitAlternatives(
  { routes: [
    twoRides('38', '172', 35, '15:44', '16:19'),   // Google's first
    oneRide('271', 35, '15:36', '16:10'),
    oneRide('176', 32, '15:34', '16:06'),
    oneRide('999', 40, '15:00', '16:45'),          // arrives LATE
  ] },
  '16:20', 'Holon', 'Home', '16:20',
);

assert.strictEqual(alts.length, 4, 'every route is parsed, not just the first');
assert.strictEqual(rideCount(alts[0]), 1, 'the winner is a single bus, not the two-bus first route');
assert.strictEqual(alts[0].totalDurationMinutes, 32, 'among direct routes, the fastest wins');
assert.strictEqual(rideCount(alts[3]), 1, 'a route arriving after the deadline sinks to last');
assert.ok(alts[3].arriveAt > '16:20', 'the last one is the late one');
// A transfer is a second thing that can be missed, so it loses at equal time.
const equalTime = parseTransitAlternatives(
  { routes: [twoRides('38', '172', 35, '15:44', '16:19'), oneRide('271', 35, '15:36', '16:10')] },
  '16:20', 'Holon', 'Home', '16:20',
);
assert.strictEqual(rideCount(equalTime[0]), 1, 'at equal duration, fewer changes wins');
assert.ok(describePlanOption(alts[0], false).includes('direct'), 'a one-bus option says so');
assert.ok(describePlanOption(alts[0], true).includes('ישיר'), 'and says so in Hebrew');

console.log('✅ transit parse: 45-min two-bus route reports 45 min across 5 legs');
console.log('✅ alternatives: single bus 176 beats Google\'s first-listed 38+172');

// ───────────────────────────────────────────────────────────────────────────
// "גבעת עדה" — the station eighty kilometres past where she was going.
//
// Read off Koral's interview card the night before, and off the device log the
// same night. The line name below is verbatim from Google Directions for the
// train she was actually being sent on, Tel Aviv area → Herzliya. Israel
// Railways publishes no `short_name` for rail, so `line.name` was taken, and
// `line.name` for rail is the route's TWO TERMINI. She reads the end of the
// string, sees a town in the north, and correctly concludes the app has sent
// her somewhere else. Nothing was wrong with the route.
const RAIL_LINE = 'אשקלון-אשקלון<->בנימינה-בנימינה גבעת עדה';

assert.strictEqual(
  lineLabel(undefined, RAIL_LINE, 'בנימינה גבעת עדה', 'train'), '',
  'a two-terminus rail name is not printed as a line number — the headsign says the direction',
);
assert.strictEqual(
  lineLabel(undefined, RAIL_LINE, undefined, 'train'), 'בנימינה גבעת עדה',
  'with no headsign, the FAR terminus stands in for the direction — never both ends',
);
assert.ok(
  !lineLabel(undefined, RAIL_LINE, undefined, 'train').includes('אשקלון'),
  'the station she boards at is never presented as where the train goes',
);
// The duplicated station prefix Israel Railways uses ("בנימינה-בנימינה גבעת עדה")
// reads as two separate places on a narrow card.
assert.strictEqual(
  lineLabel(undefined, 'א<->בנימינה-בנימינה גבעת עדה', undefined, 'train'), 'בנימינה גבעת עדה',
);
// Everything that was already right stays right.
assert.strictEqual(lineLabel('567', RAIL_LINE, 'anywhere', 'bus'), '567', 'a bus keeps its number');
assert.strictEqual(lineLabel(undefined, '567', undefined, 'bus'), '567', 'so does a named bus route');
assert.strictEqual(
  lineLabel(undefined, 'קו העמק', 'חיפה', 'train'), 'קו העמק',
  'a rail name that is NOT two termini is passed through untouched — no guessing at prose',
);
assert.strictEqual(lineLabel(undefined, undefined, undefined, 'train'), '', 'nothing in, nothing out');

// End to end, through the parser: the leg carries the direction and no longer
// carries the line's far end as if it were hers.
const railRoute = parseTransitRoute(
  { routes: [{
    legs: [{
      duration: { value: 50 * 60 },
      departure_time: { text: '13:21' },
      arrival_time: { text: '13:58' },
      steps: [{
        travel_mode: 'TRANSIT',
        duration: { value: 22 * 60 },
        transit_details: {
          line: { name: RAIL_LINE, vehicle: { type: 'HEAVY_RAIL' } },
          headsign: 'בנימינה גבעת עדה',
          departure_stop: { name: 'רחובות' },
          arrival_stop: { name: 'הרצליה' },
          departure_time: { text: '13:21' },
          arrival_time: { text: '13:43' },
        },
      }],
    }],
  }] },
  '14:30', '7 HaPnina Street, Raanana',
)!;
assert.strictEqual(railRoute.legs[0].type, 'train');
assert.strictEqual(railRoute.legs[0].lineNumber, '', 'no two-terminus string on the leg');
assert.strictEqual(railRoute.legs[0].headsign, 'בנימינה גבעת עדה', 'the direction is kept, once');
assert.ok(
  !describePlanOption(railRoute, true).includes('גבעת עדה'),
  'and the one-line summary cannot print it either',
);

console.log('✅ rail line names: the route\'s two termini never reach her card as a destination');
