/**
 * run-time-range — moving "from" moves "until" with it.
 *
 * Run:  npx tsx tests/run-time-range.ts
 */
import { untilAfterFromChange, rangeMinutes } from '../src/utils/timeRange';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

const r = untilAfterFromChange;
check('14:00–15:00 moved to 16:00 → until 17:00', r('14:00', '15:00', '16:00') === '17:00', r('14:00', '15:00', '16:00'));
check('an 18:00–20:00 workout keeps its 2h', r('18:00', '20:00', '19:30') === '21:30');
check('no range yet → one hour', r(undefined, undefined, '16:00') === '17:00');
check('no range yet, a 30-min task → 30 min', r(undefined, undefined, '16:00', 30) === '16:30');
check('moving earlier keeps the length too', r('16:00', '17:30', '09:15') === '10:45');
check('past midnight wraps', r('22:00', '23:30', '23:00') === '00:30');
check('a range over midnight keeps its length', rangeMinutes('23:00', '01:00') === 120);
check('a zero-length range falls back', r('10:00', '10:00', '12:00', 45) === '12:45');

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) process.exit(1);
