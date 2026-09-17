/**
 * run-presence — she is already there, so stop routing her there.
 *
 * Reported: "The system keeps trying to build a route to Task A (Hackathon),
 * but the user is ALREADY physically at Task A's location."
 *
 * Run:  npx tsx tests/run-presence.ts
 */
import { isUserAtLocation, presenceFor, ARRIVAL_RADIUS_METRES } from '../src/utils/presence';
import { nextTrip } from '../src/utils/liveRoutePlan';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

// Tel Aviv University — the conference.
const TAU = { lat: 32.1133, lng: 34.8044 };
// Her home, Yad Harutzim / HaMasger.
const HOME = { lat: 32.0620, lng: 34.7860 };
// A bench just outside the TAU gate: ~180 m from the pin.
const AT_GATE = { lat: 32.1149, lng: 34.8044 };

function main() {
  console.log('\nPresence\n');

  console.log('1. Geometry');
  check('standing on the pin is "at" it', isUserAtLocation(TAU, TAU));
  check('180 m away is still "at" it — a campus is not a point',
    isUserAtLocation(AT_GATE, TAU), `${ARRIVAL_RADIUS_METRES} m radius`);
  check('home is NOT the university', !isUserAtLocation(HOME, TAU));
  check('no fix is never "at"', !isUserAtLocation(null, TAU));
  check('a task with no coordinates is never "at"', !isUserAtLocation(TAU, null));
  check('NaN coordinates do not slip through',
    !isUserAtLocation({ lat: NaN, lng: 34.8 }, TAU));

  console.log('\n2. The reported case: at the conference, mid-morning');
  const atConf = presenceFor(TAU, TAU,
    { startsAt: '09:00', endsAt: '18:00', nowHHMM: '10:30' });
  check('she counts as ARRIVED', atConf.presence === 'arrived', atConf.presence);
  check('and the distance is reported', atConf.metres === 0, `${atConf.metres} m`);

  console.log('\n3. …and the cases it must not swallow');
  const onTheWay = presenceFor(HOME, TAU,
    { startsAt: '09:00', endsAt: '18:00', nowHHMM: '08:00' });
  check('still at home → travelling', onTheWay.presence === 'travelling');
  check('the distance is real', (onTheWay.metres ?? 0) > 5000, `${onTheWay.metres} m`);

  const early = presenceFor(TAU, TAU,
    { startsAt: '09:00', endsAt: '18:00', nowHHMM: '08:40' });
  check('arriving EARLY still counts as arrived', early.presence === 'arrived');

  const justAfter = presenceFor(TAU, TAU,
    { startsAt: '09:00', endsAt: '18:00', nowHHMM: '18:20' });
  check('20 min after the end she has not teleported away',
    justAfter.presence === 'arrived');

  const longAfter = presenceFor(TAU, TAU,
    { startsAt: '09:00', endsAt: '18:00', nowHHMM: '22:00' });
  check('but at 22:00 being near the campus is not attending it',
    longAfter.presence === 'travelling', longAfter.presence);

  const noClock = presenceFor(TAU, TAU, {});
  check('with no times given, geometry alone decides', noClock.presence === 'arrived');

  const noFix = presenceFor(null, TAU, { nowHHMM: '10:30' });
  check('no GPS fix decides NOTHING — it must not claim she is travelling',
    noFix.presence === 'unknown', noFix.presence);

  console.log('\n4. The next trip is no longer the one she is standing in');
  const t = (id: string, time: string, over: any = {}): any => ({
    id, text: id, category: 'conference', priority: 'must', isFixed: true,
    fixedTime: time, durationMinutes: 540, date: '2026-09-07', status: 'pending',
    createdAt: 0, historicalDurations: [],
    location: { address: id, lat: TAU.lat, lng: TAU.lng, confirmed: true },
    ...over,
  });
  const conference = t('conference', '09:00');
  const meetup = t('meetup', '18:00', {
    durationMinutes: 180,
    location: { address: 'Yigal Alon 94', lat: 32.0713, lng: 34.7936, confirmed: true },
  });

  const before = nextTrip([conference, meetup], new Date('2026-09-07T08:00:00'));
  check('before leaving, the conference IS the next trip',
    before?.id === 'conference', before?.id);

  const reached = { ...conference, verifiedArrival: true };
  const after = nextTrip([reached, meetup], new Date('2026-09-07T10:30:00'));
  check('once she has arrived, it is NOT routed to again',
    after?.id !== 'conference', after?.id ?? 'none');
  check('the next trip becomes the meetup', after?.id === 'meetup', after?.id);

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
