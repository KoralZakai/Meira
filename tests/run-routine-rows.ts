/**
 * run-routine-rows — her routines on the day they fall, as rows (6.10, pick A).
 *
 *   npx tsx tests/run-routine-rows.ts
 */
import { parseRoutineNotes, habitsFromHistory } from '../src/utils/routines';
import { routineRowsFor, routineTitle } from '../src/utils/routineRows';
import type { Task } from '../src/types/index';

let checks = 0;
let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `  — ${detail}`}`);
}

const TUE = '2026-10-06';
const notes = parseRoutineNotes('קיקבוקס 20:30-21:30 יגאל אלון 94\nגם Mon/Wed 18:00\nמקלחת בוקר, קפה\nלאסוף את הילדים 16:00');
const task = (text: string, extra: Partial<Task> = {}): Task => ({
  id: `t-${text}`, text, category: 'gym', priority: 'need_to', isFixed: true, fixedTime: '20:30',
  durationMinutes: 60, date: TUE, status: 'pending', createdAt: 1, historicalDurations: [], ...extra,
} as Task);

console.log('\nRoutine rows — her week on the day it falls\n');

const rows = routineRowsFor(notes, TUE, []);
check('kickboxing (said, with an hour) is a row on Tuesday', rows.some((r) => r.title === 'קיקבוקס' && r.start === '20:30'),
  JSON.stringify(rows.map((r) => r.title)));
check('...titled without the hours, with its address kept apart',
  rows[0]?.title === 'קיקבוקס' && rows[0]?.address === 'יגאל אלון 94', JSON.stringify(rows[0]));
check('...ending when it says', rows[0]?.end === '21:30', String(rows[0]?.end));
check('a Mon/Wed routine is not on a Tuesday', !rows.some((r) => r.start === '18:00'));
check('a routine with no hour is not a row', rows.every((r) => Boolean(r.start)));
check('an obligation (pickup) is not a row — it is cut from free time instead',
  !rows.some((r) => /לאסוף/.test(r.title)));

check('already a task that day → no row', routineRowsFor(notes, TUE, [task('קיקבוקס')]).length === 0);
check('"Not today" hides it for that date', routineRowsFor(notes, TUE, [], { skipped: [rows[0].key] }).length === 0);
// Skips are kept per date by the screen (routineSkips[dateKey]); next Tuesday's list is empty.
check('...and only that date: next Tuesday it is back', routineRowsFor(notes, '2026-10-13', [], { skipped: [] }).length === 1);
check('today, after it ended → no row', routineRowsFor(notes, TUE, [], { now: '21:40' }).length === 0);
check('today, while it is on → still a row', routineRowsFor(notes, TUE, [], { now: '21:00' }).length === 1);

const history = habitsFromHistory([0, 7, 14].map((d) => task('פגישת צוות', {
  id: `h${d}`, date: `2026-09-${String(8 + d).padStart(2, '0')}`, fixedTime: '10:00', status: 'complete',
})));
check('a pattern guessed from history is never a row (only what she said)',
  routineRowsFor(history, TUE, []).length === 0, JSON.stringify(history.map((h) => h.text)));
check('the same line said twice (phone + chat) is one row',
  routineRowsFor([...notes, ...notes], TUE, []).length === 1);
check('a title never comes out empty', routineTitle({ ...notes[0], text: '20:30-21:30' }).title.length > 0);

console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
