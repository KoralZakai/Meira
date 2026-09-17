/**
 * run-overlap-kind — a call during a drive is not a conflict.
 * Run: npx tsx tests/run-overlap-kind.ts
 */
import { classifyOverlap, overlapMinutesOf, isFloatingTask, suggestReschedule, ASSUMED_TRAVEL_MINUTES } from '../src/utils/overlapKind';
import { Task } from '../src/types/index';

let failures = 0; let checks = 0;
const check = (l: string, ok: boolean, d = '') => {
  checks += 1; if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${l}${d ? `  — ${d}` : ''}`);
};

const t = (id: string, time: string, mins: number, over: Partial<Task> = {}): Task => ({
  id, text: id, category: 'general', priority: 'need_to', isFixed: true,
  fixedTime: time, durationMinutes: mins, date: '2026-09-08', status: 'pending',
  createdAt: 0, historicalDurations: [], ...over,
} as unknown as Task);

const at = (place: string) => ({ location: { address: place, lat: 32.1, lng: 34.8, confirmed: true } });

function main() {
  console.log('\nOverlap classification\n');

  console.log('1. Parallel — nothing is physically impossible');
  const call = t('call', '15:00', 30, { category: 'call', meetingUrl: 'https://us02web.zoom.us/j/1' });
  const drive = t('conf', '14:30', 120, at('Tel Aviv University') as any);
  const p = classifyOverlap(call, drive)!;
  check('a Zoom call inside a conference is PARALLEL', p.kind === 'parallel', p.kind);
  check('the call is the one that rides along', p.remoteTaskId === 'call');
  check('it suggests taking it during the journey', p.suggestDuringTravel === true);
  check('no travel is implied', p.travelMinutes === 0);

  const twoCalls = classifyOverlap(call, t('zoom2', '15:10', 30, { category: 'zoom', meetingUrl: 'https://meet.google.com/x' }))!;
  check('two calls at once is still parallel, not spatial', twoCalls.kind === 'parallel');

  console.log('\n1b. Floating work has no place to be wrong about');
  const cv = t('cv', '15:00', 60);                       // "send the CV" — no location
  check('a task with no place is floating', isFloatingTask(cv));
  check('a located task is not', !isFloatingTask(t('x', '09:00', 60, at('Tel Aviv University') as any)));
  check('a Zoom with an address is STILL floating — the link is the venue',
    isFloatingTask(t('z', '15:00', 30, { category: 'zoom', meetingUrl: 'https://us02web.zoom.us/j/2', ...at('Somewhere') } as any)));
  const f = classifyOverlap(cv, t('conf2', '14:00', 240, at('Tel Aviv University') as any))!;
  check('send-the-CV inside a conference is PARALLEL, not a spatial clash',
    f.kind === 'parallel', f.kind);
  check('no travel warning is implied', f.travelMinutes === 0);

  console.log('\n2. Same place — double-booked, not impossible');
  const s = classifyOverlap(
    t('a', '15:00', 60, at('Yigal Alon 94') as any),
    t('b', '15:30', 60, at('Yigal Alon 94') as any))!;
  check('one address twice is SAME-PLACE', s.kind === 'same-place', s.kind);
  check('and needs no journey', s.travelMinutes === 0);

  console.log('\n3. Spatial — the hard one');
  const uni = t('uni', '09:00', 540, at('Tel Aviv University') as any);      // 09:00-18:00
  const meet = t('meet', '17:00', 120, at('Yigal Alon 94') as any);          // 17:00-19:00
  const hard = classifyOverlap(uni, meet, 25)!;
  check('two places at once is SPATIAL', hard.kind === 'spatial', hard.kind);
  check('the overlap is measured', hard.overlapMinutes === 60, `${hard.overlapMinutes} min`);
  check('Option A — leave at 16:35 (17:00 less 25 min)', hard.leaveEarlyAt === '16:35', hard.leaveEarlyAt);
  check('Option B — stay to 18:00, arrive 18:25', hard.arriveLateAt === '18:25', hard.arriveLateAt);
  check('…which is 85 min late', hard.arriveLateBy === 85, `${hard.arriveLateBy} min`);

  const noRoute = classifyOverlap(uni, meet)!;
  check('with no route, a small estimate stands in, never zero',
    noRoute.travelMinutes === ASSUMED_TRAVEL_MINUTES, `${noRoute.travelMinutes} min`);

  console.log('\n3b. DISPLACED — a work block that eats a departure');
  // Koral's own evening, 2026-09-17: a two-hour interview-prep block laid over
  // a yoga class in Charles Clore, and the app said "take the call on the way".
  const yogaRide = t('yoga', '19:00', 60, {
    category: 'hobby_class',
    location: {
      address: '11א, Kaufmann Street, Tel Aviv', lat: 32.0632, lng: 34.7606,
      confirmed: true, leaveHomeBy: '18:40', travelMinutes: 20, transportType: 'bike',
    },
  } as any);
  const prepBlock = t('prep', '18:18', 120, {
    text: 'Prepare for: Your phone interview with Ceva', category: 'course', isFixed: false,
    fixedTime: undefined, scheduledTime: '18:18',
  } as any);
  const d = classifyOverlap(prepBlock, yogaRide)!;
  check('prep-over-a-departure is DISPLACED, not parallel', d.kind === 'displaced', d.kind);
  check('the prep block is the one that gives way', d.displacedTaskId === 'prep');
  check('it names the departure it was covering', d.departureAt === '18:40', d.departureAt);
  check('it does NOT tell her to do it on the way',
    d.suggestDuringTravel === undefined && d.remoteTaskId === undefined);

  // The old, correct behaviour must survive: work inside an event she is
  // already AT is still parallel — there is no departure inside it.
  const seated = classifyOverlap(
    t('cv3', '15:00', 60, { isFixed: false, fixedTime: undefined, scheduledTime: '15:00' } as any),
    t('conf3', '14:00', 240, { location: { address: 'Tel Aviv University', lat: 32.1, lng: 34.8, confirmed: true, leaveHomeBy: '13:20' } } as any),
  )!;
  check('an hour of desk work inside a conference is still PARALLEL',
    seated.kind === 'parallel', seated.kind);

  console.log('\n3c. Advice has to be possible in the actual vehicle');
  const callOnBike = classifyOverlap(
    t('c1', '18:45', 20, { category: 'call', meetingUrl: 'https://us02web.zoom.us/j/9' }),
    t('ride', '19:00', 60, { location: { address: 'Kaufmann 11', lat: 32.06, lng: 34.76, confirmed: true, transportType: 'bike' } } as any),
  )!;
  check('a call during a BIKE ride is parallel but not "on the way"',
    callOnBike.kind === 'parallel' && callOnBike.suggestDuringTravel === false);
  const callOnBus = classifyOverlap(
    t('c2', '18:45', 20, { category: 'call', meetingUrl: 'https://us02web.zoom.us/j/9' }),
    t('ride2', '19:00', 60, { location: { address: 'Kaufmann 11', lat: 32.06, lng: 34.76, confirmed: true, transportType: 'bus' } } as any),
  )!;
  check('...on a bus it still is', callOnBus.suggestDuringTravel === true);

  console.log('\n4. Things it must not claim');
  check('tasks that do not overlap return nothing',
    classifyOverlap(t('x', '09:00', 60), t('y', '11:00', 60)) === null);
  check('back-to-back is not an overlap',
    classifyOverlap(t('x', '09:00', 60), t('y', '10:00', 60)) === null);
  check('an untimed task classifies nothing',
    classifyOverlap(t('x', '', 60, { fixedTime: undefined }), meet) === null);
  check('overlapMinutesOf agrees', overlapMinutesOf(uni, meet) === 60);

  console.log('\n5. An unfinished task looks for room TODAY first');
  const missed = t('cv2', '09:00', 60);
  const busyDay = [t('m1', '12:00', 60), t('m2', '15:00', 120)];
  const r1 = suggestReschedule(missed, busyDay, { now: '11:00', dayEnd: '22:00' });
  check('11:00 is free, so it goes there', r1.when === 'today' && r1.at === '11:00', `${r1.at}`);

  const r2 = suggestReschedule(missed, busyDay, { now: '12:15', dayEnd: '22:00' });
  check('landing inside a meeting jumps past it', r2.at === '13:00', `${r2.at}`);

  const r3 = suggestReschedule(missed, busyDay, { now: '14:30', dayEnd: '22:00' });
  check('…and past the next one too', r3.at === '17:00', `${r3.at}`);

  const r4 = suggestReschedule(missed, busyDay, { now: '21:30', dayEnd: '22:00' });
  check('a day with no room left falls back to tomorrow', r4.when === 'tomorrow', r4.when);

  check('a task is never in its own way',
    suggestReschedule(busyDay[0], busyDay, { now: '12:00', dayEnd: '22:00' }).at === '12:00');

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks\n`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
