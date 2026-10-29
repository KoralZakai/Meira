/**
 * run-weekday-parity — the phone reads a routine's days by the ONE spec the
 * server reads them by (tests/fixtures/weekday-lines.json), and the days
 * Meira writes back into a line read back as exactly those days (6.10).
 *
 * The server half is server/tests/test_weekday_parity.py, on the same fixture.
 *
 *   npx tsx tests/run-weekday-parity.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readDays, daysPhrase, withDays, stripDaysPhrase, parseRoutineNotes } from '../src/utils/routines';
import { routineRowsFor, routineTitle } from '../src/utils/routineRows';

let checks = 0;
let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  checks++;
  if (!ok) failures++;
  if (!ok || process.env.VERBOSE) console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `  — ${detail}`}`);
}

const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'weekday-lines.json'), 'utf8'));
console.log(`\nWeekday spec — ${fixture.cases.length} lines\n`);
for (const c of fixture.cases) {
  const got = readDays(c.text);
  const want = { days: c.days, from: c.from, perWeek: c.perWeek };
  const same = JSON.stringify(got.days) === JSON.stringify(want.days) && got.from === want.from
    && (got.perWeek ?? null) === (want.perWeek ?? null);
  check(c.text, same, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

console.log('Writing the answer back — every combination, both scripts\n');
let roundTrips = 0;
for (let mask = 1; mask < 128; mask += 1) {
  const days = [0, 1, 2, 3, 4, 5, 6].filter((d) => mask & (1 << d));
  for (const script of ['he', 'en'] as const) {
    const base = script === 'he' ? 'קיקבוקס 20:30-21:30 יגאל אלון 94' : 'climbing 19:00 Space Gym';
    const line = withDays(base, days);
    const back = readDays(line);
    const ok = JSON.stringify(back.days) === JSON.stringify(days) && back.from === 'said' && !line.includes(',');
    if (!ok) check(`${script} ${JSON.stringify(days)} → "${line}"`, false, JSON.stringify(back));
    else roundTrips += 1;
    if (stripDaysPhrase(line) !== base) check(`strip "${line}"`, false, stripDaysPhrase(line));
  }
}
check(`all 254 round trips read back exactly`, roundTrips === 254, `${roundTrips}/254`);
check('"changes weekly" reads back as varies, both scripts',
  readDays(withDays('קיקבוקס 20:30', 'varies')).from === 'varies' && readDays(withDays('climbing 19:00', 'varies')).from === 'varies');
check('a second answer replaces the first phrase, never stacks',
  withDays(withDays('קיקבוקס 20:30', [2]), [1, 3]) === `קיקבוקס 20:30 ${daysPhrase([1, 3], 'he')}`);

console.log('The row keeps its key when she answers\n');
const before = parseRoutineNotes('קיקבוקס 20:30-21:30 יגאל אלון 94')[0];
const after = parseRoutineNotes(withDays('קיקבוקס 20:30-21:30 יגאל אלון 94', [2]))[0];
check('unsaid before', before.daysFrom === 'unsaid', String(before.daysFrom));
check('said after', after.daysFrom === 'said' && JSON.stringify(after.weekdays) === '[2]', JSON.stringify(after));
check('same title and address', JSON.stringify(routineTitle(before)) === JSON.stringify(routineTitle(after)),
  `${JSON.stringify(routineTitle(before))} vs ${JSON.stringify(routineTitle(after))}`);
const tue = routineRowsFor([after], '2026-10-06', []);
const wed = routineRowsFor([after], '2026-10-07', []);
check('a Tuesday-only row is on Tuesday and not on Wednesday', tue.length === 1 && wed.length === 0);
check('the key a "Not today" was stored under is unchanged',
  tue[0]?.key === routineRowsFor([before], '2026-10-06', [])[0]?.key);
const varies = parseRoutineNotes(withDays('קיקבוקס 20:30-21:30', 'varies'));
check('a routine whose days vary is not a row', routineRowsFor(varies, '2026-10-06', []).length === 0);

console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
