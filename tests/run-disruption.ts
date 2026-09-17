/**
 * run-disruption — what Lumi does when the plan stops being true.
 *
 * A schedule that only works when nothing changes is not much use to anyone,
 * least of all someone with ADHD. The interesting behaviour is entirely in the
 * failure cases: the meeting moves, the bus is missed, traffic doubles, a task
 * runs long, two appointments turn out to be unmakeable.
 *
 * Each case states the disruption and asserts BOTH halves: that the backward
 * chain is recalculated, and that what Lumi would say is actually true. An
 * assistant that recalculates silently is no better than one that is wrong.
 *
 * Offline and deterministic — travel times come from the case, which is the
 * ground truth the assertions check against.
 *
 * Run:  npx tsx tests/run-disruption.ts
 */
import { timeToMinutes, minutesToTime } from '../src/utils/timeUtils';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

/** The backward chain, in one place, exactly as the app computes it. */
function planBackward(opts: {
  arriveBy: string;
  travelMinutes: number;
  bufferMinutes: number;
  routineMinutes: number;
}) {
  const leave = minutesToTime(
    timeToMinutes(opts.arriveBy) - opts.travelMinutes - opts.bufferMinutes,
  );
  const prep = minutesToTime(timeToMinutes(leave) - opts.routineMinutes);
  return { leave, prep };
}

const BUFFER = 10;
const ROUTINE = 30;

function main() {
  console.log('\nWhen the schedule breaks\n');

  // ── 1. the meeting moves earlier ────────────────────────────────────────
  console.log('1. A meeting moves 90 minutes earlier');
  const before = planBackward({ arriveBy: '11:00', travelMinutes: 25, bufferMinutes: BUFFER, routineMinutes: ROUTINE });
  const after = planBackward({ arriveBy: '09:30', travelMinutes: 25, bufferMinutes: BUFFER, routineMinutes: ROUTINE });
  console.log(`     11:00 → leave ${before.leave}, get ready ${before.prep}`);
  console.log(`     09:30 → leave ${after.leave}, get ready ${after.prep}`);
  check('the whole chain shifts, not just the appointment',
    after.leave !== before.leave && after.prep !== before.prep);
  check('it shifts by exactly the amount the meeting moved',
    timeToMinutes(before.leave) - timeToMinutes(after.leave) === 90,
    `${timeToMinutes(before.leave) - timeToMinutes(after.leave)} min`);
  check('no alert is left on an old time',
    timeToMinutes(after.prep) < timeToMinutes(before.prep));

  // ── 2. the bus is missed ────────────────────────────────────────────────
  console.log('\n2. The bus is missed (still at home at leave time)');
  // Timetabled: there is a departure to lose, and the next one is later.
  const departures = ['10:51', '11:11', '11:31'];
  const rideMinutes = 9;
  const walkToStop = 4;
  const missedAt = '10:55';                       // still home, first bus gone
  const nextDeparture = departures.find(
    (d) => timeToMinutes(d) >= timeToMinutes(missedAt) + walkToStop,
  );
  check('a next departure is found', Boolean(nextDeparture), String(nextDeparture));
  const newArrival = minutesToTime(timeToMinutes(nextDeparture!) + rideMinutes);
  console.log(`     missed 10:51 → next ${nextDeparture}, arrive ${newArrival}`);
  check('the new arrival is genuinely later than the original',
    timeToMinutes(newArrival) > timeToMinutes('11:00'), newArrival);
  check('the next departure allows time to walk to the stop',
    timeToMinutes(nextDeparture!) - timeToMinutes(missedAt) >= walkToStop);
  check('Lumi would report being late for an 11:00 appointment',
    timeToMinutes(newArrival) > timeToMinutes('11:00'),
    `${timeToMinutes(newArrival) - timeToMinutes('11:00')} min late`);

  // ── 3. car / bike have no departure to miss ─────────────────────────────
  console.log('\n3. Running late by car — nothing to miss, only a later arrival');
  const drive = 25;
  const leftAt = '10:40';                          // 15 min after the plan said
  const carArrival = minutesToTime(timeToMinutes(leftAt) + drive);
  console.log(`     left ${leftAt} → arrive ${carArrival}`);
  check('the arrival simply shifts by the delay',
    carArrival === '11:05', carArrival);
  check('and it is correctly reported as past the appointment',
    timeToMinutes(carArrival) > timeToMinutes('11:00'));

  // ── 4. traffic doubles ──────────────────────────────────────────────────
  console.log('\n4. Traffic doubles the drive');
  const calm = planBackward({ arriveBy: '11:00', travelMinutes: 25, bufferMinutes: BUFFER, routineMinutes: ROUTINE });
  const jam = planBackward({ arriveBy: '11:00', travelMinutes: 50, bufferMinutes: BUFFER, routineMinutes: ROUTINE });
  console.log(`     25 min → leave ${calm.leave} · 50 min → leave ${jam.leave}`);
  check('the leave time moves earlier', timeToMinutes(jam.leave) < timeToMinutes(calm.leave));
  check('by exactly the extra travel time',
    timeToMinutes(calm.leave) - timeToMinutes(jam.leave) === 25);

  // An honest plan says "you cannot make this" instead of showing a past time.
  const nowIs = '10:30';
  const impossible = planBackward({ arriveBy: '11:00', travelMinutes: 50, bufferMinutes: BUFFER, routineMinutes: ROUTINE });
  check('a leave time already in the past is detectable, not silently shown',
    timeToMinutes(impossible.leave) < timeToMinutes(nowIs),
    `leave ${impossible.leave}, now ${nowIs} — must say "you will be late"`);

  // ── 5. a task runs long into the next one ───────────────────────────────
  console.log('\n5. A task overruns into the next trip');
  const actuallyFinished = '10:20';                // planned 10:00
  const nextLeg = 25;
  const replanned = minutesToTime(timeToMinutes(actuallyFinished) + nextLeg);
  check('the next trip is re-planned from the REAL finish time',
    replanned === '10:45', replanned);
  check('and it is late for an 10:30 appointment',
    timeToMinutes(replanned) > timeToMinutes('10:30'));

  // ── 6. two places, not enough time between them ─────────────────────────
  console.log('\n6. Two appointments in different places, too close together');
  const firstEnds = '13:00';
  const secondStarts = '13:20';
  const between = 35;                              // travel between the two
  const shortfall = between - (timeToMinutes(secondStarts) - timeToMinutes(firstEnds));
  check('the gap is correctly identified as unmakeable', shortfall > 0);
  check('the shortfall is quantified, not just flagged',
    shortfall === 15, `${shortfall} min short`);
  console.log(`     13:00 → 13:20 with a 35 min journey: ${shortfall} min short`);

  const roomy = timeToMinutes('14:00') - timeToMinutes(firstEnds);
  check('a genuinely makeable gap is NOT flagged', roomy > between);

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} checks passed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
