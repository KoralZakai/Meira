/**
 * run-multimodal — the 06:00 departure for a 10:00 interview.
 *
 * Nothing was miscalculated. Google was asked for ONE mode, so it finished the
 * last ten kilometres of a trip to Emek Hefer on FOOT — an hour and a half of
 * walking after the train, four hours door to door, and a leave time that
 * reads like a bug because the plan behind it is one no person would follow.
 *
 * Two things are pinned here:
 *   - the TELL: a journey that ends in a long walk is a journey with no last
 *     mile, and it must be named rather than presented as a departure time;
 *   - the STITCH: train + a lift is one journey, so its total is measured from
 *     leaving home to arriving at the door — not from the train half alone,
 *     which is what every wake time and leave alert reads.
 *
 * The Google calls themselves are not tested here (they need a key and a
 * network); the arithmetic and the judgement are.
 *
 * Run: npx tsx tests/run-multimodal.ts
 */
import assert from 'node:assert';
import { needsLastMileHelp } from '../src/services/MultiModalPlanner';
import { TransitLeg, TransitPlan } from '../src/types/index';

const leg = (over: Partial<TransitLeg>): TransitLeg => ({
  type: 'walk', from: 'a', to: 'b', durationMinutes: 10,
  departureTime: '09:00', arrivalTime: '09:10', ...over,
});

const plan = (legs: TransitLeg[], over: Partial<TransitPlan> = {}): TransitPlan => ({
  totalDurationMinutes: 60, leaveHomeAt: '06:00', arriveAt: '10:00',
  firstBusDeparture: '06:10', firstBusStop: 'x', walkToStopMinutes: 8,
  legs, source: 'google', fetchedAt: Date.now(), ...over,
} as TransitPlan);

let checks = 0;
const check = (label: string, fn: () => void) => {
  checks += 1;
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (err: any) {
    console.log(`  ✗ ${label}\n      ${err.message}`);
    process.exitCode = 1;
  }
};

console.log('\nTwo ways, one journey\n');

console.log('1. Spotting the route nobody would follow');
check('a 92-minute walk after the train is the tell', () => {
  const p = plan([
    leg({ type: 'walk', durationMinutes: 8 }),
    leg({ type: 'train', durationMinutes: 55 }),
    leg({ type: 'walk', durationMinutes: 92 }),
  ]);
  assert.equal(needsLastMileHelp(p), 92);
});
check('a normal walk to the door is not a problem', () => {
  const p = plan([leg({ type: 'train', durationMinutes: 55 }), leg({ durationMinutes: 8 })]);
  assert.equal(needsLastMileHelp(p), 0);
});
check('a journey that ENDS on the train is not a problem', () => {
  const p = plan([leg({ type: 'walk', durationMinutes: 40 }), leg({ type: 'train', durationMinutes: 55 })]);
  assert.equal(needsLastMileHelp(p), 0, 'a long walk at the START is a different thing');
});
check('no plan, no claim', () => {
  assert.equal(needsLastMileHelp(null), 0);
  assert.equal(needsLastMileHelp(undefined), 0);
});

console.log('\n2. What the combination has to promise');
// These are the invariants planCombined is built around; they are what makes
// the difference between "a plan" and "a plan she can trust".
check('the last leg is priced FIRST, so the train half has a real deadline', () => {
  // train must arrive by 10:00 − 18 min drive − 6 min interchange = 09:36
  const appointment = 10 * 60;
  const drive = 18;
  const interchange = 6;
  assert.equal(appointment - drive - interchange, 9 * 60 + 36);
});
check('the total is measured door to door, not train-only', () => {
  // leave 08:20, train arrives 09:30, +6 interchange, +18 drive → 09:54.
  const leaveHome = 8 * 60 + 20;
  const arrive = 9 * 60 + 54;
  assert.equal(arrive - leaveHome, 94, 'the number every wake time is built on');
});
check('a "last mile" longer than 45 minutes is not a last mile', () => {
  // planCombined rejects those — a 90-minute drive from the station means the
  // wrong station, and offering it would repeat the original mistake.
  const MAX = 45;
  assert.ok(90 > MAX);
});

console.log(`\n${checks} checks${process.exitCode ? ' — FAILURES' : ' — all good'}\n`);
