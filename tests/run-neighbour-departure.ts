/**
 * 13.10, Koral: "insert in today's screen the options to check later options
 * (like in Moovit — later, next train / next bus), because you chose a train
 * that arrives too early for me and I want to see later".
 *
 * Two halves, both pinned:
 *   1. the ‹ earlier · later › arrows land on the neighbouring TRAIN, not on
 *      a later feeder bus to the same train, nor on a bus;
 *   2. the default for an interview is the latest train still on time.
 */
import { pickNeighbour, sameMainRide, neighbourLine, earlyBy } from '../src/utils/neighbourDeparture';
import { rankPlans, MUST_ARRIVAL_BUFFER_MIN } from '../src/utils/transitFallback';
import { TransitPlan } from '../src/types/index';

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); } else { fail += 1; console.error(`  ✗ ${label}`); }
};

const add = (hhmm: string, m: number) => {
  const t = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)) + m;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};
/** A real-shaped journey: walk 5 → [feeder bus] → train → walk 13. */
const trip = (leave: string, trainAt: string, opts: { feeder?: boolean; bus?: boolean } = {}): TransitPlan => {
  const legs: any[] = [];
  let t = leave;
  const push = (type: string, mins: number, lineNumber?: string, dep?: string) => {
    const from = dep ?? t;
    legs.push({ type, from: 'a', to: 'b', durationMinutes: mins, departureTime: from, arrivalTime: add(from, mins), lineNumber });
    t = add(from, mins);
  };
  push('walk', 5);
  if (opts.feeder) push('bus', 8, '10');
  if (opts.bus) push('bus', 85, '910', trainAt); else push('train', 55, undefined, trainAt);
  push('walk', 13);
  const total = Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) - (Number(leave.slice(0, 2)) * 60 + Number(leave.slice(3)));
  return {
    totalDurationMinutes: total, leaveHomeAt: leave, arriveAt: t, firstBusDeparture: '', firstBusStop: '',
    walkToStopMinutes: 5, legs, source: 'google', fetchedAt: 0,
  };
};

const current = trip('10:29', '10:34');           // arrives 11:42 — an hour early for 13:00
const sameTrainLater = trip('10:20', '10:34', { feeder: true }); // leaves earlier: not "later"
const sameTrainFeeder = trip('10:31', '10:34');   // same train, a later start: not a NEW option
const nextTrain = trip('10:59', '11:04');
const busLater = trip('10:35', '10:40', { bus: true });
const afterThat = trip('11:29', '11:34');

// 1 — the arrows
{
  ok(sameMainRide(sameTrainFeeder, current), 'a later start for the same train is the same train');
  ok(pickNeighbour([sameTrainFeeder, busLater, afterThat, nextTrain], current, 'later') === nextTrain,
    'later → the NEXT train (not the same train again, not a bus a minute later)');
  ok(pickNeighbour([busLater], current, 'later') === busLater, 'no later train came back → the nearest of any kind');
  ok(pickNeighbour([sameTrainFeeder, sameTrainLater], current, 'later') === null, 'only the same train → nothing (the probe steps past it)');
  const prev = trip('09:59', '10:04');
  ok(pickNeighbour([trip('09:29', '09:34'), prev, nextTrain], current, 'earlier') === prev, 'earlier → the train just before');
  ok(pickNeighbour([], current, 'later') === null, 'nothing back → null, and the caller says why');
  ok(earlyBy(nextTrain, '13:00') === 48 && earlyBy(trip('11:59', '12:04'), '13:00') === -12,
    'minutes early / late against the interview');
  ok(neighbourLine(nextTrain, '13:00', true) === '🚆 10:59 ← 12:12 · 48 דק׳ מוקדם',
    'the line on the card (he) — a right-to-left line runs leftwards, so the arrow is ←');
  ok(!neighbourLine(nextTrain, '13:00', true).includes('→') && !neighbourLine(nextTrain, '13:00', false).includes('←'),
    'each language uses only its own arrow');
  ok(neighbourLine(busLater, '13:00', false).startsWith('🚌 10:35 →'), 'a bus says bus');
}

// 2 — the default: the latest train still on time
{
  ok(MUST_ARRIVAL_BUFFER_MIN === 20, 'the target margin is 20 minutes');
  const t1207 = trip('10:29', '10:34'); // 11:42? use explicit arrivals below
  const at = (leave: string, arrive: string): TransitPlan => ({ ...t1207, leaveHomeAt: leave, arriveAt: arrive,
    legs: [{ type: 'walk', from: '', to: '', durationMinutes: 5, departureTime: leave, arrivalTime: add(leave, 5) },
      { type: 'train', from: '', to: '', durationMinutes: 55, departureTime: add(leave, 5), arrivalTime: add(leave, 60) }],
    totalDurationMinutes: 0 });
  const early = at('10:34', '12:07');
  const right = at('11:04', '12:37');
  const tight = at('11:20', '12:50');
  ok(rankPlans([early, right, tight], '13:00', { minBufferMinutes: MUST_ARRIVAL_BUFFER_MIN })[0] === right,
    '13:00 interview → the 12:37 (23 early), not the 12:07 (53) nor the 12:50 (10)');
  // 22.9: "better arrive 14:00 … the train which leaves 13:20 and arrives 13:58" over 14:16.
  ok(rankPlans([at('13:30', '14:16'), at('13:20', '13:58')], '14:30', { minBufferMinutes: MUST_ARRIVAL_BUFFER_MIN })[0].arriveAt === '13:58',
    'and 22.9 still holds: 13:58 over 14:16 for 14:30');
  ok(rankPlans([at('11:34', '13:07'), early], '13:00', { minBufferMinutes: MUST_ARRIVAL_BUFFER_MIN })[0] === early,
    'never a train that makes her late');
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
