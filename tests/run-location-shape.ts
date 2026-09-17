/**
 * run-location-shape — `Task.location` is a string on a hand-typed task and a
 * TaskLocation object on anything that has been routed. Every consumer must
 * survive both.
 *
 * This is not a style point. The two shapes crashed the app in three separate
 * ways, all of them on the most ordinary action there is — pressing a task:
 *
 *   - `task.location?.trim()` — `.trim` is not a function on an object, so the
 *     Home screen threw while rendering the known-places list;
 *   - `setEditLocation(task.location)` put the OBJECT into a TextInput value;
 *   - `task.location.displayName` read straight off a string rendered nothing,
 *     silently, which is how the bug survived so long in the timeline card.
 *
 * A routed task is the NORMAL case — every trip becomes one the moment Lumi
 * plans a bus. So the fixture here is the real thing: the yoga class, exactly
 * as the server stores it (address, zeroed coordinates, a bike route).
 *
 * Run:  npx tsx tests/run-location-shape.ts
 */
import { locationTextOf, locOf, addrOf } from '../src/utils/dayPlanning';
import { normalizeTravelKey } from '../src/services/MorningRoutineService';
import { Task } from '../src/types/index';

let failures = 0;
let checks = 0;

function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

/** Nothing here may throw — a TypeError in any of these is a dead screen. */
function survives(label: string, fn: () => unknown): unknown {
  try {
    const value = fn();
    check(label, true, typeof value === 'string' ? JSON.stringify(value) : String(value));
    return value;
  } catch (e) {
    check(label, false, `threw: ${(e as Error).message}`);
    return undefined;
  }
}

const base = {
  id: 't1', text: 'יוגה', category: 'hobby_class', priority: 'need_to',
  isFixed: true, fixedTime: '11:00', durationMinutes: 90, date: '2026-08-29',
  status: 'pending', createdAt: 1, historicalDurations: [],
} as unknown as Task;

// The routed shape, as the server actually stores it: address + zeroed coords.
const routed = {
  ...base,
  location: {
    lat: 0, lng: 0, confirmed: true,
    address: 'יגאל אלון 94', displayName: 'יגאל אלון 94',
    leaveHomeBy: '10:43', travelMinutes: 7, transportType: 'bike',
    transitPlan: {
      totalDurationMinutes: 7, leaveHomeAt: '10:43', arriveAt: '11:00',
      firstBusDeparture: '10:43', firstBusStop: "Mordei ha-Geta'ot St 23",
      walkToStopMinutes: 0, source: 'google', fetchedAt: 1,
      legs: [{
        type: 'bike', from: "Mordei ha-Geta'ot St 23", to: 'יגאל אלון 94',
        durationMinutes: 7, departureTime: '10:43', arrivalTime: '11:00',
      }],
    },
  },
} as unknown as Task;

const typed = { ...base, location: 'יגאל אלון 94' } as unknown as Task;
const zoom = { ...base, location: 'https://us02web.zoom.us/j/123' } as unknown as Task;
const bare = { ...base } as Task;

console.log('\nTask.location: string on a typed task, object on a routed one\n');

console.log('1. Reading the place as text');
check('routed task → the place, not "[object Object]"',
  locationTextOf(routed) === 'יגאל אלון 94', locationTextOf(routed));
check('typed task → the same text back',
  locationTextOf(typed) === 'יגאל אלון 94', locationTextOf(typed));
check('no location → empty string, never undefined',
  locationTextOf(bare) === '', JSON.stringify(locationTextOf(bare)));
check('the result is always a string (it lands in a TextInput)',
  [routed, typed, bare, zoom].every((t) => typeof locationTextOf(t) === 'string'));

console.log('\n2. The calls that used to throw');
survives('.trim() on a routed location', () => locationTextOf(routed).trim());
survives('travel-learning key for a routed task', () => normalizeTravelKey(routed));
survives('travel-learning key for a typed task', () => normalizeTravelKey(typed));
check('the two shapes of the same place learn under ONE key',
  normalizeTravelKey(routed) === normalizeTravelKey(typed),
  normalizeTravelKey(routed));

console.log('\n3. Routing still refuses what it should');
check('a routed place is routable', addrOf(routed) === 'יגאל אלון 94');
check('a Zoom link is NOT somewhere to travel to', addrOf(zoom) === undefined);
check('but the link is still shown as the location text',
  locationTextOf(zoom).startsWith('https://'));
check('locOf only ever returns the object shape',
  locOf(routed) !== undefined && locOf(typed) === undefined);

console.log('\n4. A trip with no coordinates is still a trip');
// The Trips tab used to require truthy lat/lng, which dropped exactly this
// task — an address Google can route from, geocoded to 0,0.
const loc = locOf(routed)!;
check('it has somewhere to go', Boolean(loc.address || loc.displayName));
check('…even though its coordinates are 0,0', loc.lat === 0 && loc.lng === 0);
check('and it carries a real route with a leave time',
  loc.transitPlan?.leaveHomeAt === '10:43');

console.log(
  failures === 0
    ? `\n✅ ${checks}/${checks} checks passed\n`
    : `\n❌ ${failures} of ${checks} checks failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
