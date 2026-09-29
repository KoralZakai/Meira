/**
 * run-routine-task — "קיקבוקס" is already in her week.
 *
 * Koral, 2026-09-28: "I added 'קיקבוקס'. I expected Meira to know where it
 * is — Yigal Alon 94, Tel Aviv. It has a time, 20:30-21:30 — it's in my
 * routines!" It was saved as "קיקבוקס ב 8 וחצי" with no hour and no place.
 *
 * Same cases as server/tests/test_kickbox_routine.py: the phone (+ screen) and
 * the server (chat) must read one routine the same way.
 *
 * Run:  npx tsx tests/run-routine-task.ts
 */
import { routineForTask, sameHourOfDay, addressInRoutine, nameBeforeAddress } from '../src/utils/routines';
import { parseTimeExpression } from '../src/utils/timeParser';

let failures = 0; let checks = 0;
const check = (label: string, ok: boolean, detail = '') => {
  checks += 1; if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
};
const quiet = <T>(fn: () => T): T => {
  const log = console.log; console.log = () => {};
  try { return fn(); } finally { console.log = log; }
};

const ROUTINES = 'kids 16:00 every day; קיקבוקס 20:30-21:30 ביגאל אלון 94';

console.log('\nRoutine → task\n');

console.log('1. The hour, as she says it');
const t1 = quiet(() => parseTimeExpression('קיקבוקס ב 8 וחצי', '2026-09-28'));
check('"ב 8 וחצי" is 08:30, not 08:00', t1.fixedTime === '08:30', JSON.stringify(t1.fixedTime));
const t2 = quiet(() => parseTimeExpression('ב 8 וחצי בערב', '2026-09-28'));
check('"ב 8 וחצי בערב" is 20:30', t2.fixedTime === '20:30', JSON.stringify(t2.fixedTime));
const t3 = quiet(() => parseTimeExpression('פגישה ברבע ל-9 בבוקר', '2026-09-28'));
check('"ברבע ל-9" is 08:45', t3.fixedTime === '08:45', JSON.stringify(t3.fixedTime));
const t4 = quiet(() => parseTimeExpression('לקנות חלב ברחוב 8', '2026-09-28'));
check('"רחוב 8" is not an hour', !t4.fixedTime, JSON.stringify(t4.fixedTime));

console.log('\n2. Her routines');
const r = routineForTask('קיקבוקס ב 8 וחצי', ROUTINES, '2026-09-28');
check('exact match', r?.match === 'exact', JSON.stringify(r));
check('hour 20:30, 60 min', r?.time === '20:30' && r?.minutes === 60);
check('address יגאל אלון 94 (preposition peeled)', r?.address === 'יגאל אלון 94', String(r?.address));
check('"8:30" names the 20:30 class', sameHourOfDay('08:30', r?.time));
check('"18:00" does not', !sameHourOfDay('18:00', r?.time));

const en = routineForTask('קיקבוקס', 'Kickbox Mon/Wed 20:30-21:30 at Yigal Alon 94, Tel Aviv', '2026-09-28');
check('English routine, Hebrew task', en?.match === 'exact' && en?.address === 'Yigal Alon 94, Tel Aviv',
  JSON.stringify(en));

const tue = routineForTask('קיקבוקס', 'קיקבוקס ימי שני 20:30-21:30 יגאל אלון 94', '2026-09-29');
check('not on a day it does not run: address, not hour',
  tue?.timeApplies === false && tue?.address === 'יגאל אלון 94', JSON.stringify(tue));

const yoga = routineForTask('יוגה', ROUTINES, '2026-09-28');
check('another class at the same gym: address only',
  yoga?.match === 'concept' && !yoga.timeApplies && yoga.address === 'יגאל אלון 94', JSON.stringify(yoga));

const split = routineForTask('קיקבוקס', 'חדר כושר - יגאל אלון 94\nקיקבוקס 20:30 עד 21:30', '2026-09-28');
check('hour from the class line, address from the gym line',
  split?.time === '20:30' && split?.address === 'יגאל אלון 94', JSON.stringify(split));

check('unrelated task matches nothing', routineForTask('רופא שיניים', ROUTINES, '2026-09-28') === null);
check('a house number needs a street', addressInRoutine('kids 16:00 every day') === null);

console.log('\n3. A name is not a street (2026-09-28: "Gym יגאל אלון 94")');
for (const line of ['Space Gym, יגאל אלון 94', 'Space Gym יגאל אלון 94']) {
  const street = addressInRoutine(line);
  check(`"${line}" → street יגאל אלון 94`, street === 'יגאל אלון 94', String(street));
  check(`"${line}" → name Space Gym`, nameBeforeAddress(line, street || '') === 'Space Gym');
}
const gym = routineForTask('אימון', 'Space Gym - Yigal Alon 94, Tel Aviv', '2026-09-28');
check('a workout gets the gym\'s address AND its name',
  gym?.address === 'Yigal Alon 94, Tel Aviv' && gym?.name === 'Space Gym', JSON.stringify(gym));
check('the class itself is not a place name', !r?.name, JSON.stringify(r));

console.log('\n4. Her day, as she says it');
const day = quiet(() => parseTimeExpression('אימון ב 6 בערב עד 8 בערב', '2026-09-28'));
check('"ב 6 בערב עד 8 בערב" is 18:00 for 120 min',
  day.fixedTime === '18:00' && day.durationMinutes === 120, JSON.stringify(day));
const six = quiet(() => parseTimeExpression('אימון ב6 עד 7', '2026-09-28'));
check('"ב6 עד 7" is 18:00–19:00', six.fixedTime === '18:00' && six.durationMinutes === 60, JSON.stringify(six));
const night = quiet(() => parseTimeExpression('פגישה ב-1 בלילה', '2026-09-28'));
check('"1 בלילה" is 01:00, not 13:00', night.fixedTime === '01:00', JSON.stringify(night.fixedTime));
const team = quiet(() => parseTimeExpression('team meeting at 3', '2026-09-28'));
check('"team" does not say a.m.', team.fixedTime === '15:00', JSON.stringify(team.fixedTime));
const count = quiet(() => parseTimeExpression('יוגה 2-3 שעות', '2026-09-28'));
check('"2-3 שעות" is a length, not a clock', !count.fixedTime, JSON.stringify(count.fixedTime));

console.log(`\n${failures ? '✗' : '✓'} ${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
