/**
 * run-all-day — a whole day, or from date to date (29.10).
 *   npx tsx tests/run-all-day.ts
 */
import { allDayLabel, allDayPatch, coversDay, endFromExclusive, endPatch, spanDays, startPatch } from '../src/utils/allDay';

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); } else { fail += 1; console.error(`  ✗ ${label}`); }
};

const midburn = { date: '2026-11-02', endDate: '2026-11-07', allDay: true };
ok(coversDay(midburn, '2026-11-02') && coversDay(midburn, '2026-11-05') && coversDay(midburn, '2026-11-07'), 'a range is on every day it covers');
ok(!coversDay(midburn, '2026-11-08') && !coversDay(midburn, '2026-11-01'), 'and on no other day');
ok(coversDay({ date: '2026-11-02' }, '2026-11-02') && !coversDay({ date: '2026-11-02' }, '2026-11-03'), 'an ordinary task stays on its day');
ok(spanDays(midburn) === 6, 'Mon–Sat is six days');
ok(allDayLabel(midburn, '2026-11-03', true) === 'כל היום · 2.11–7.11 · יום 2/6', 'the strip says which day of the range');
ok(allDayLabel({ date: '2026-11-02' }, '2026-11-02', false) === 'All day', 'one day says just "All day"');
const on = allDayPatch(true, midburn);
ok(on.allDay === true && on.fixedTime === undefined && on.isFixed === false, 'the toggle removes the hours');
ok(allDayPatch(false, midburn).endDate === undefined, 'off: back to one day');
ok(startPatch(midburn, '2026-11-09').endDate === '2026-11-14', 'moving the first day keeps the length');
ok(endPatch({ date: '2026-11-02' }, '2026-11-01').endDate === undefined, 'a last day before the first is no range');
ok(endFromExclusive('2026-11-02', '2026-11-08') === '2026-11-07', "Google's exclusive end → our last day");
ok(endFromExclusive('2026-11-02', '2026-11-03') === undefined, 'a one-day all-day event has no range');

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
