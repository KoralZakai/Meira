/**
 * run-round-trip — home → Nahariya → Tel Aviv, and knowing where she is.
 *
 * Two things the day needs and did not have:
 *
 *   1. The RETURN leg must start from the place she is at, not from her front
 *      door. The chain in GoogleSync advances prevAddress per stop; this pins
 *      that arithmetic down without a network call, using the same ordering
 *      helper (sortTimed) the real chain uses.
 *   2. A three-state answer to "where is she" — at home / in transit / at a
 *      venue — because the whole travel chain rests on an assumption about
 *      that which was previously invisible and unfalsifiable.
 *
 * Run:  npx tsx tests/run-round-trip.ts
 */
import { dayPresence, describeDayPresence } from '../src/utils/presence';
import { sortTimed, addrOf, timeOf, taskHasJourney } from '../src/utils/dayPlanning';
import { Task } from '../src/types/index';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

// Her home in south Tel Aviv, the morning stop in Nahariya, the evening one
// back in Tel Aviv.
const HOME = { lat: 32.0620, lng: 34.7860 };
const NAHARIYA = { lat: 33.0078, lng: 35.0950 };
const TLV_UNI = { lat: 32.1133, lng: 34.8044 };
// On the train somewhere near Hadera — neither home nor either venue.
const ON_THE_TRAIN = { lat: 32.4400, lng: 34.9200 };

const task = (
  id: string, text: string, at: string, place: { lat: number; lng: number }, name: string,
): Task => ({
  id,
  text,
  category: 'meeting',
  priority: 'must',
  isFixed: true,
  fixedTime: at,
  scheduledTime: at,
  durationMinutes: 120,
  date: '2026-09-09',
  status: 'pending',
  createdAt: Date.now(),
  historicalDurations: [],
  location: {
    address: name, displayName: name, lat: place.lat, lng: place.lng, confirmed: true,
  },
} as unknown as Task);

const morning = task('t-nahariya', 'כנס בנהריה', '10:00', NAHARIYA, 'נהריה');
const evening = task('t-tlv', 'AI Builders', '18:00', TLV_UNI, 'אוניברסיטת תל אביב');

/**
 * The origin the chain walks: home first, then each stop becomes the start of
 * the next leg. This mirrors ensureTravelChain's `prevAddress` exactly — it is
 * the arithmetic, without the Google calls.
 */
function chainOrigins(tasks: Task[], homeAddress: string): { dest: string; from: string }[] {
  const out: { dest: string; from: string }[] = [];
  let prev = homeAddress;
  for (const t of sortTimed(tasks.filter((x) => x.status !== 'complete' && addrOf(x)))) {
    out.push({ dest: addrOf(t)!, from: prev });
    prev = addrOf(t)!;
  }
  return out;
}

function main() {
  console.log('\nRound trip: home → Nahariya → Tel Aviv\n');

  console.log('1. The chain, in order, from the right places');
  const legs = chainOrigins([evening, morning], 'הבית');
  check('two legs for two stops', legs.length === 2, `${legs.length}`);
  check('the day is walked in time order, not the order they were added',
    legs[0].dest === 'נהריה' && legs[1].dest === 'אוניברסיטת תל אביב');
  check('the OUTBOUND leg starts at home', legs[0].from === 'הבית');
  check('the RETURN leg starts at Nahariya, not at home',
    legs[1].from === 'נהריה', legs[1].from);

  console.log('\n2. Both stops keep their own clock');
  check('morning at 10:00', timeOf(morning) === '10:00');
  check('evening at 18:00', timeOf(evening) === '18:00');

  console.log('\n3. Where is she?');
  const places = [morning, evening].map((t) => ({
    id: t.id,
    lat: (t.location as any).lat,
    lng: (t.location as any).lng,
    name: (t.location as any).displayName,
    startsAt: t.fixedTime,
  }));

  const atHome = dayPresence(HOME, places, HOME, '07:30');
  check('at home is at-home', atHome.state === 'at-home');
  check('…and says so', describeDayPresence(atHome, false) === '🏠 At home');

  const atNahariya = dayPresence(NAHARIYA, places, HOME, '10:20');
  check('standing in Nahariya is at-venue', atNahariya.state === 'at-venue');
  check('…and names WHICH venue', atNahariya.atTaskId === 't-nahariya', atNahariya.placeName);
  check('…in the chip too', describeDayPresence(atNahariya, false).includes('נהריה'));

  const between = dayPresence(ON_THE_TRAIN, places, HOME, '14:00');
  check('between the two is in-transit — a real state, not an error',
    between.state === 'in-transit');
  check('…and says so', describeDayPresence(between, false) === '🚆 In transit');

  const noFix = dayPresence(null, places, HOME, '14:00');
  check('no GPS fix decides nothing', noFix.state === 'unknown');

  console.log('\n4. Which task of an overlapping pair owns the travel leg');
  // The exact shape on her screen: a desk task from 09:00 overlapping the
  // 11:30 trip to Nahariya. The desk task sorts first, so it was the "lead"
  // and the timeline asked IT for a journey — got none, drew nothing, and the
  // fully planned train never appeared.
  const desk = {
    id: 'desk', text: 'תכנית עסקית', category: 'work', priority: 'must',
    isFixed: true, fixedTime: '09:00', durationMinutes: 212, date: '2026-09-09',
    status: 'pending', createdAt: 0, historicalDurations: [],
  } as unknown as Task;
  const trip = {
    ...morning,
    location: { ...(morning.location as any), leaveHomeBy: '11:34' },
  } as Task;

  check('the desk task has no journey', !taskHasJourney(desk));
  check('the Nahariya trip does', taskHasJourney(trip));
  const owners = [desk, trip].filter(taskHasJourney);
  check('exactly one leg is drawn for the pair', owners.length === 1, `${owners.length}`);
  check('and it belongs to the TRIP, not to the block that sorts first',
    owners[0].id === 't-nahariya', owners[0].id);
  check('a route with only a transitPlan still counts',
    taskHasJourney({ ...desk, location: { address: 'x', lat: 1, lng: 1, confirmed: true, transitPlan: {} } } as any));
  check('a located task with neither is not a journey',
    !taskHasJourney({ ...desk, location: { address: 'x', lat: 1, lng: 1, confirmed: true } } as any));

  console.log('\n5. What we do NOT know, we do not claim');
  const noHome = dayPresence(ON_THE_TRAIN, places, null, '14:00');
  check('no home coordinates → unknown, NOT "in transit"',
    noHome.state === 'unknown', noHome.state);
  check('…because otherwise her own kitchen reads as travelling',
    dayPresence(HOME, places, null, '07:30').state === 'unknown');
  check('a venue still resolves without a home address',
    dayPresence(NAHARIYA, places, null, '10:20').state === 'at-venue');
  check('garbage home coordinates are treated as no home',
    dayPresence(ON_THE_TRAIN, places, { lat: NaN, lng: 34.8 }, '14:00').state === 'unknown');

  console.log('\n6. The venue wins over home when both would match');
  const meetingAtHome = [{ id: 'h', lat: HOME.lat, lng: HOME.lng, name: 'הבית', startsAt: '09:00' }];
  check('a meeting held at her own address reads as at-venue',
    dayPresence(HOME, meetingAtHome, HOME, '09:10').state === 'at-venue');

  console.log(`\n${failures ? '✗' : '✓'} ${checks - failures}/${checks} checks passed\n`);
  process.exit(failures ? 1 : 0);
}

main();
