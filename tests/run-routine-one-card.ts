/**
 * 11.10, Koral's "Tomorrow": the same workout, told to Meira over three days
 * by voice, chat and typing, was FIVE cards at 20:00 — "אימון", "אימון בערב ·
 * יום ראשון…", "אימון או", "work out and" — and Yigal Alon, heard as
 * "עיגל / עיגול / עיגאל אלון", was never her gym. These are her real lines.
 */
import { parseRoutineNotes, sameRoutine } from '../src/utils/routines';
import { routineRowsFor } from '../src/utils/routineRows';
import { correctPlaceName } from '../src/utils/fuzzyMatch';

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); } else { fail += 1; console.error(`  ✗ ${label}`); }
};

const HER_LINES = [
  'אימון · יום ראשון, שני ושלישי · 20:00 · עיגול אלון 94, תל אביב',
  'אימון · יום ראשון, שלישי · 20:00 · עיגל אלון 94, תל אביב',
  'יוגה ב 11 ימי שישי',
  'להתאמן · ימי ראשון עד שלישי · 20:00 · בעיגאל אלון, בחדר הכושר של ספייס',
  'אימון בערב · יום ראשון, יום שני, יום שלישי · 20:00',
  'אימון בוקר · יום שישי · 11:00',
  'אימון · יום ראשון, שני, שלישי, יום שישי · 20:00 או 11:00 · יגאל אלון 94',
  'work out · Sundays, Monday and Tuesdays · 20:00 · עיגל אלון 96',
  'אימונים מיום ראשון עד יום שלישי בשמונה בערב ובימי שישי ב-11 בבוקר. כל השיעורים מתקיימים ביגאל אלון 94 בתל אביב',
  'אני מתאמנת כל יום ראשון, שני, שלישי בשמונה בערב ובימי שישי ב-11 בבוקר',
  'I work out on Sundays, Monday and Tuesdays on 8pm. I train at עיגל אלון 96.',
  'work out · Sundays, Monday and Tuesdays · 20:00 · עיגל אלון 96 · באופניים',
].join('\n');

const routines = parseRoutineNotes(HER_LINES);
const monday = routineRowsFor(routines, '2026-10-12', []);
const evening = monday.filter((r) => r.start === '20:00');
ok(evening.length === 1, `Monday 20:00: ONE workout card (was ${evening.length})`);
ok(/יגאל אלון 9[46]/.test(evening[0]?.address ?? ''), `and it is at Yigal Alon (${evening[0]?.address})`);
ok(evening[0]?.title === 'אימון', `the card says what it is, not the tail of a sentence (${evening[0]?.title})`);
ok(!monday.some((r) => /עיגל|עיגול|עיגאל/.test(`${r.title} ${r.address ?? ''}`)), 'no misheard spelling reaches the card');

const friday = routineRowsFor(routines, '2026-10-16', []).filter((r) => r.start === '11:00');
ok(friday.length === 1, `Friday 11:00: one card (was ${friday.length})`);

ok(correctPlaceName('אימון בעיגל אלון 96') === 'אימון ביגאל אלון 96', 'the glued ב survives the correction');
ok(correctPlaceName('Yigal Alon Street') === 'Yigal Alon Street', "Google's own spelling is left alone");

const r = (text: string) => parseRoutineNotes(text)[0];
ok(sameRoutine(r('יוגה · שישי · 11:00'), r('אימון בוקר · שישי · 11:00')), 'two workouts on the same day and hour are one');
ok(!sameRoutine(r('אימון · שני · 20:00'), r('אימון · שני · 07:00')), 'a morning and an evening workout are two');
ok(!sameRoutine(r('אימון · שני · 20:00'), r('חוג ציור · שני · 20:00')), 'a workout and a painting class are two');
ok(!sameRoutine(r('פילאטיס · א׳'), r('אימון · ראשון · 20:30')), 'Pilates on Sunday is not the Sunday-evening workout');
ok(!sameRoutine(r('יוגה · שישי · 11:00'), r('פילאטיס · שישי · 11:00')), 'yoga and Pilates are two');

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
