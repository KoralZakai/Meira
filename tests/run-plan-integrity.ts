/**
 * run-plan-integrity — a journey has to agree with itself.
 *
 * Koral, 2026-09-23, the morning of the interview:
 *
 *   "have you checked the trains you're offering? i checked and i saw on
 *    13:15-14:01, 13:20-13:58, 13:30-14:16. you wrote: 13:51-14:13 ?!?! this
 *    it really bad! Meira - the app should be super Accurate, correct, and
 *    reliable. Must be tested and validated!"
 *
 * The honest problem: a TransitPlan carries FOUR separate accounts of one trip
 * — leaveHomeAt, arriveAt, totalDurationMinutes, and the legs — each read out
 * of a different field of Google's response, and nothing in this app had ever
 * compared them. Whatever came back was rendered.
 *
 *   npx tsx tests/run-plan-integrity.ts
 */
import { checkPlan, planIsSound, planProblemLine, TOLERANCE_MIN } from '../src/utils/planIntegrity';
import { rankDepartureOptions } from '../src/utils/departureOptions';
import type { TransitPlan, TransitLeg } from '../src/types/index';

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}${detail ? `  — ${detail}` : ''}`); }
  else { fail += 1; console.error(`  ✗ ${label}${detail ? `  — ${detail}` : ''}`); }
};

const leg = (
  type: TransitLeg['type'], dep: string, arr: string, line?: string,
): TransitLeg => ({
  type, from: 'a', to: 'b',
  durationMinutes: Math.max(1, (Number(arr.slice(0, 2)) * 60 + Number(arr.slice(3)))
    - (Number(dep.slice(0, 2)) * 60 + Number(dep.slice(3)))),
  departureTime: dep, arrivalTime: arr, lineNumber: line,
});

/** Her real 13:20 train, door to door, as it should look. */
const good = (): TransitPlan => ({
  totalDurationMinutes: 50,
  leaveHomeAt: '13:15',
  arriveAt: '14:05',
  firstBusDeparture: '13:20',
  firstBusStop: "Tel Aviv Ha'Hagana",
  walkToStopMinutes: 5,
  legs: [
    leg('walk', '13:15', '13:20'),
    leg('train', '13:20', '13:58', 'אשקלון-בנימינה'),
    leg('walk', '13:58', '14:05'),
  ],
  source: 'google',
  fetchedAt: 0,
});

console.log('\n1. A journey that agrees with itself passes\n');

ok(planIsSound(good()), 'her real 13:20 train is sound');
ok(checkPlan(good()).problems.length === 0, 'with no problems listed');
ok(checkPlan(good()).detail === undefined, 'and nothing to say about it');

// Rounding must not read as a bug. leaveHomeAt carries a deliberate 5-minute
// margin and Google rounds durations, so small gaps are expected.
ok(planIsSound({ ...good(), totalDurationMinutes: 50 + TOLERANCE_MIN }),
  `a ${TOLERANCE_MIN}-minute disagreement is tolerated as rounding`);
ok(!planIsSound({ ...good(), totalDurationMinutes: 50 + TOLERANCE_MIN + 1 }),
  '...and one minute more is not');

console.log('\n2. The reported 13:51→14:13\n');

/*
 * 22 minutes, against three real trains that take 38-46. Whatever produced it,
 * a plan is only allowed on screen when its headline numbers are derivable
 * from its own legs. Two shapes this can take, both caught:
 */
const headlineOnly: TransitPlan = {
  ...good(),
  leaveHomeAt: '13:51',
  arriveAt: '14:13',
  totalDurationMinutes: 22,
  // ...while the itinerary underneath is still the real 38-minute train.
};
const v1 = checkPlan(headlineOnly);
ok(!v1.ok, 'a headline that does not match the itinerary is refused');
ok(v1.problems.includes('departure_mismatch'),
  'it cannot leave at 13:51 for a train that went at 13:20', v1.detail);
// Note what does NOT fire here: 13:51→14:13 IS 22 minutes, so the headline is
// internally consistent. It is the itinerary underneath that it has come
// loose from, which is exactly why the check compares both ENDS of the trip
// against the legs rather than checking the headline against itself.
ok(!v1.problems.includes('duration_mismatch'),
  'its headline duration is self-consistent — that was never the tell', v1.detail);

// The arrival check on its own, past the rounding tolerance.
const endsElsewhere = { ...good(), arriveAt: '14:45', totalDurationMinutes: 90 };
ok(!planIsSound(endsElsewhere), 'an arrival the legs do not reach is refused');
ok(checkPlan(endsElsewhere).problems.includes('arrival_mismatch'),
  '...naming the gap', checkPlan(endsElsewhere).detail);
// ...and within it, which is what keeps Google's rounding from reading as a bug.
ok(planIsSound({ ...good(), arriveAt: '14:13' }),
  'an 8-minute gap is rounding, not a contradiction');
ok(planProblemLine(headlineOnly, v1).includes('13:51→14:13'),
  'and the log line names the journey it dropped',
  planProblemLine(headlineOnly, v1));

const truncated: TransitPlan = {
  ...good(),
  leaveHomeAt: '13:51',
  arriveAt: '14:13',
  totalDurationMinutes: 22,
  firstBusDeparture: '13:51',
  // The last leg to the destination is missing — the trip ends at the station.
  legs: [leg('walk', '13:51', '13:51'), leg('train', '13:51', '14:13', 'x')],
};
ok(planIsSound(truncated) === true,
  'a self-consistent 22-minute journey is NOT refused on plausibility',
  'we do not know the geography, and guessing at it is a second thing to be wrong about');

console.log('\n3. Every way a plan can contradict itself\n');

ok(!planIsSound({ ...good(), legs: [] }), 'a journey with no legs');
ok(checkPlan({ ...good(), legs: [] }).problems[0] === 'no_legs', '...says so');
ok(!planIsSound({ ...good(), arriveAt: 'soon' as string }), 'a clock that is not a clock');
ok(checkPlan({ ...good(), arriveAt: 'soon' }).problems.includes('bad_times'), '...says so');

const backwards = {
  ...good(),
  legs: [leg('walk', '13:15', '13:20'), leg('train', '13:00', '13:58', 'x')],
};
ok(!planIsSound(backwards), 'legs that run backwards');
ok(checkPlan(backwards).problems.includes('out_of_order'), '...says so', checkPlan(backwards).detail);

const leaveAfterTrain = { ...good(), leaveHomeAt: '13:40' };
ok(!planIsSound(leaveAfterTrain), 'leaving after the train has gone');
ok(checkPlan(leaveAfterTrain).problems.includes('departure_mismatch'),
  '...says so', checkPlan(leaveAfterTrain).detail);

const wrongDuration = { ...good(), totalDurationMinutes: 22 };
ok(!planIsSound(wrongDuration), 'a duration that is not the span it describes');
ok(checkPlan(wrongDuration).problems.includes('duration_mismatch'),
  '...says so', checkPlan(wrongDuration).detail);

console.log('\n4. Midnight is not a contradiction\n');

const overnight: TransitPlan = {
  ...good(),
  leaveHomeAt: '23:40', arriveAt: '00:30', firstBusDeparture: '23:45',
  totalDurationMinutes: 50,
  legs: [leg('walk', '23:40', '23:45'), { ...leg('train', '23:45', '00:25', 'x'), durationMinutes: 40 },
    { ...leg('walk', '00:25', '00:30'), durationMinutes: 5 }],
};
ok(planIsSound(overnight), 'a journey across midnight is sound');

console.log('\n5. Nothing unsound reaches the list she chooses from\n');

const offered = rankDepartureOptions([good(), headlineOnly], { appointment: '14:30' });
ok(offered.length === 1, 'the broken one is not offered', `${offered.length} option(s)`);
ok(offered[0].departAt === '13:15' && offered[0].arriveAt === '14:05',
  'and the sound one still is', `${offered[0].departAt}→${offered[0].arriveAt}`);
ok(rankDepartureOptions([headlineOnly], { appointment: '14:30' }).length === 0,
  'a list of only broken plans comes back empty rather than wrong');

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
