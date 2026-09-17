/**
 * run-position-drift — re-plan when the user has actually moved, not otherwise.
 *
 * Two ways to get this wrong, and both are bad:
 *   re-plan too eagerly → the leave time jitters with GPS noise while standing
 *                         still, and stops being believable
 *   re-plan never       → the plan stays anchored to home while the user is
 *                         across town, which is the bug being fixed
 *
 * The third failure is subtler: treating "no GPS fix" as "moved", which would
 * replace a correct plan with a guess.
 *
 * Run:  npx tsx tests/run-position-drift.ts
 */
import {
  distanceMetres, assessDrift, describeReplan, DRIFT_THRESHOLD_METRES,
} from '../src/utils/positionDrift';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

// Real Tel Aviv coordinates, so the distances are meaningful.
const HOME = { lat: 32.0614, lng: 34.7715 };       // Mordei ha-Geta'ot 25
const YOGA = { lat: 32.0713, lng: 34.7942 };       // Yigal Alon 94
const NEXT_DOOR = { lat: 32.0615, lng: 34.7716 };  // ~14 m away
const HAIFA = { lat: 32.7940, lng: 34.9896 };

function main() {
  console.log('\nPosition drift\n');

  console.log('1. Distances are real');
  const d = Math.round(distanceMetres(HOME, YOGA));
  check('home → yoga studio is roughly 2.3 km', d > 2000 && d < 2800, `${d} m`);
  check('a point 14 m away measures as such',
    Math.round(distanceMetres(HOME, NEXT_DOOR)) < 25,
    `${Math.round(distanceMetres(HOME, NEXT_DOOR))} m`);
  check('the same point is zero away', distanceMetres(HOME, HOME) === 0);
  check('Tel Aviv → Haifa is about 85 km',
    Math.round(distanceMetres(HOME, HAIFA) / 1000) > 75, `${Math.round(distanceMetres(HOME, HAIFA) / 1000)} km`);

  console.log('\n2. Standing still must not re-plan');
  // GPS drifts by tens of metres indoors. If that triggered a re-plan the
  // leave time would jitter while the user sits on the sofa.
  check('a 14 m wobble does not re-plan', !assessDrift(HOME, NEXT_DOOR).shouldReplan);
  check('being exactly at the assumed origin does not re-plan',
    !assessDrift(HOME, HOME).shouldReplan);
  check('the reason is reported', assessDrift(HOME, HOME).reason === 'at-assumed-origin');

  console.log('\n3. Genuinely having moved must re-plan');
  const moved = assessDrift(HOME, YOGA);
  check('2.3 km away re-plans', moved.shouldReplan, `${moved.metres} m`);
  check('the distance is reported', moved.metres > 2000);
  check('the reason is "moved"', moved.reason === 'moved');
  check('just past the threshold re-plans',
    assessDrift(HOME, { lat: HOME.lat + 0.004, lng: HOME.lng }).shouldReplan,
    `${assessDrift(HOME, { lat: HOME.lat + 0.004, lng: HOME.lng }).metres} m vs ${DRIFT_THRESHOLD_METRES} m`);

  console.log('\n4. No fix is not the same as having moved');
  // The dangerous case: replacing a correct plan with one computed from a
  // position we do not actually have.
  check('a missing fix does not re-plan', !assessDrift(HOME, null).shouldReplan);
  check('...and says why', assessDrift(HOME, null).reason === 'no-fix');
  check('NaN coordinates do not re-plan',
    !assessDrift(HOME, { lat: NaN, lng: NaN }).shouldReplan);
  check('a real fix with no recorded origin DOES re-plan',
    assessDrift(null, YOGA).shouldReplan, 'planning from a real position beats planning from none');

  console.log('\n5. The change is explained, not just applied');
  const msg = describeReplan({
    he: false, metres: 2300, placeLabel: 'Dizengoff',
    oldLeave: '10:43', newLeave: '10:21', newArrive: '11:06', appointment: '11:00',
  });
  console.log(`     ${msg}`);
  check('it names where the user is', msg.includes('Dizengoff'));
  check('it gives both the old and the new leave time',
    msg.includes('10:21') && msg.includes('10:43'));
  check('it says outright that this arrives late', msg.includes('after 11:00'));

  const he = describeReplan({ he: true, metres: 2300, newLeave: '10:21', newArrive: '10:55', appointment: '11:00' });
  console.log(`     ${he}`);
  check('Hebrew renders without the late clause when on time', !he.includes('אחרי'));

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} checks passed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
