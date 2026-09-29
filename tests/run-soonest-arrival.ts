/**
 * run-soonest-arrival — "leave now" picks the journey that arrives FIRST.
 *
 * 29.9, 15:19, still home for a 16:00 birthday: the depart-now answer held the
 * 15:36 bus and a direct line 2 at 18:16 (clock-face timetable, same minutes
 * three hours on). Ranked "simplest first", the plan became 18:16 → 18:57,
 * 177 min late.
 *
 * Run:  npx tsx tests/run-soonest-arrival.ts
 */
import { soonestArrival } from '../src/utils/transitParse';
import { TransitPlan } from '../src/types/index';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

const plan = (leave: string, arrive: string, rides: number): TransitPlan => ({
  totalDurationMinutes: 30, leaveHomeAt: leave, arriveAt: arrive, firstBusDeparture: leave,
  firstBusStop: 'x', walkToStopMinutes: 3,
  legs: Array.from({ length: rides }, (_, i) => ({
    type: 'bus', from: 'a', to: 'b', durationMinutes: 10, departureTime: leave, arrivalTime: arrive, lineNumber: String(i),
  })),
  source: 'google', fetchedAt: 0,
} as TransitPlan);

// Ranked the old way (simplest first) — the direct 18:16 came first.
const googleAnswer = [plan('18:16', '18:57', 1), plan('15:36', '16:12', 2), plan('15:46', '16:27', 1)];
const pick = soonestArrival(googleAnswer, '15:19');
check('the birthday: 15:36 → 16:12, not 18:16 → 18:57', pick?.leaveHomeAt === '15:36', `${pick?.leaveHomeAt}→${pick?.arriveAt}`);
check('a tie on arrival goes to fewer rides',
  soonestArrival([plan('15:30', '16:10', 2), plan('15:35', '16:10', 1)], '15:19')?.leaveHomeAt === '15:35');
check('past midnight counts as later, not earlier',
  soonestArrival([plan('23:50', '00:20', 1), plan('23:40', '23:59', 2)], '23:30')?.arriveAt === '23:59');
check('nothing parseable falls back to the first', soonestArrival([plan('x', 'y', 1)], '15:00')?.leaveHomeAt === 'x');
check('empty is null', soonestArrival([], '15:00') === null);

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) process.exit(1);
