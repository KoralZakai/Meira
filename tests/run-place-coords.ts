/**
 * run-place-coords — a place the app cannot point at is not a place.
 *
 * Koral, 2026-09-17: "it did understand that צ׳ארלס קלור it's a place but
 * didn't put it as a real location on map! — need to fix."
 *
 * The name was understood. find_place resolved it to Kaufmann Street, Tel
 * Aviv, which is genuinely where Charles Clore Park is. What was lost were the
 * COORDINATES — dropped on the server one line after being fetched, then
 * replaced on the phone by `{ lat: 0, lng: 0 }` at five separate call sites.
 *
 * 0,0 is in the Atlantic. RouteMap refused to pin it, correctly, and the map
 * stayed empty with nothing to say why. The defect was that 0,0 was doing the
 * job of "unknown" while being typed as a known number, so nothing could tell
 * the two apart and nothing was ever prompted to find the real answer.
 *
 * These tests pin the rule in both directions: a real coordinate is used, a
 * placeholder is recognised as absent, and no branch is allowed to invent one.
 *
 * Run:  npx tsx tests/run-place-coords.ts
 */
import {
  hasRealCoords, locationIsPlaced, pickCoords, needsGeocode, placeLocation,
} from '../src/utils/placeCoords';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

// Charles Clore Park, Tel Aviv — the real thing.
const CLORE = { lat: 32.0632, lng: 34.7606 };

function main() {
  console.log('\nPlace coordinates — 0,0 is the Atlantic, not a yoga class\n');

  console.log('1. Telling a coordinate from a placeholder');
  check('a real Tel Aviv coordinate is real', hasRealCoords(CLORE.lat, CLORE.lng));
  check('0,0 is NOT a location', !hasRealCoords(0, 0));
  check('undefined is not a location', !hasRealCoords(undefined, undefined));
  check('NaN is not a location', !hasRealCoords(NaN, 5));
  check('a half-placeholder still counts — 0 longitude is real at Greenwich',
    hasRealCoords(51.47, 0));
  check('...and 0 latitude is real on the equator', hasRealCoords(0, 34.76));

  console.log('\n2. The stored shape she actually had');
  const nullIsland = { address: '11א, Kaufmann Street, Tel Aviv', lat: 0, lng: 0, confirmed: false };
  check('a location at 0,0 is not placed', !locationIsPlaced(nullIsland));
  check('...and it is exactly what needs a geocode', needsGeocode(nullIsland));
  check('a placed location does not ask for one again',
    !needsGeocode({ ...nullIsland, ...CLORE }));
  check('no address means no geocode to ask for — that is a missing PLACE',
    !needsGeocode({ address: '', lat: 0, lng: 0, confirmed: false }));
  check('a displayName alone is still an address worth resolving',
    needsGeocode({ address: '', displayName: 'צ׳ארלס קלור', lat: 0, lng: 0, confirmed: false }));

  console.log('\n3. Google already knew — the route ends at the door');
  const plan = { leaveHomeAt: '18:30', destLat: CLORE.lat, destLng: CLORE.lng } as any;
  check('the destination comes off the plan when the location has nothing',
    pickCoords(nullIsland, plan)?.lat === CLORE.lat);
  check('...and it costs no extra lookup — it rode in with the travel time',
    pickCoords(undefined, plan)?.lng === CLORE.lng);

  console.log('\n4. What is already known wins');
  const known = { address: 'x', lat: 32.07, lng: 34.79, confirmed: true };
  check('a real stored coordinate beats the plan',
    pickCoords(known, plan)?.lat === 32.07);
  check('a placeholder does NOT beat the plan',
    pickCoords(nullIsland, plan)?.lat === CLORE.lat);
  check('nothing known and nothing routed = null, not a guess',
    pickCoords(nullIsland, { leaveHomeAt: '18:30' } as any) === null);
  check('a plan sitting at 0,0 is refused too',
    pickCoords(nullIsland, { destLat: 0, destLng: 0 } as any) === null);

  console.log('\n5. Writing it back never invents anything');
  check('the route places the yoga class',
    placeLocation(nullIsland, plan).lat === CLORE.lat);
  check('a geocode places it when no route could be built',
    placeLocation(nullIsland, null, CLORE).lat === CLORE.lat);
  check('the route wins over a geocode — it is the door, not the street',
    placeLocation(nullIsland, plan, { lat: 1, lng: 1 }).lat === CLORE.lat);
  check('with nothing to add, the location comes back untouched',
    placeLocation(nullIsland, null, null) === nullIsland);
  check('...and is NOT quietly moved to the Atlantic',
    placeLocation(nullIsland, null, { lat: 0, lng: 0 }).lat === 0
    && !locationIsPlaced(placeLocation(nullIsland, null, { lat: 0, lng: 0 })));
  check('an already-placed location is never overwritten by a stale plan',
    placeLocation(known, { destLat: 1, destLng: 1 } as any).lat === 32.07);

  console.log(`\n${failures ? '✗' : '✓'} ${checks - failures}/${checks} checks passed\n`);
  process.exit(failures ? 1 : 0);
}

main();
