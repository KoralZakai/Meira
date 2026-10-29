/**
 * 11.10, Koral: "Tomorrow" showed "train Sunday Monday Tuesday" THREE times and
 * Yigal Alon was not taken as a place. The line Meira wrote —
 * "אימון בערב · ראשון, שני, שלישי · 20:00 · יגאל אלון 94" — was cut at every
 * comma: three routines, and only the last one kept the address.
 */
import { addressInRoutine, parseRoutineNotes, routinesForDate } from '../src/utils/routines';

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); } else { fail += 1; console.error(`  ✗ ${label}`); }
};

const line = 'אימון בערב · ראשון, שני, שלישי · 20:00 · יגאל אלון 94, תל אביב';
const rs = parseRoutineNotes(`פילאטיס · א׳\n${line}`);
ok(rs.length === 2, 'two lines are two routines, not four');
const gym = rs.find((r) => r.text.startsWith('אימון'))!;
ok(gym.weekdays.join(',') === '0,1,2' && gym.time === '20:00', 'Sunday to Tuesday at 20:00, in ONE routine');
ok(addressInRoutine(gym.text) === 'יגאל אלון 94, תל אביב', 'and it keeps its address');
ok(routinesForDate(rs, '2026-10-12').filter((r) => r.text.startsWith('אימון')).length === 1,
  'Monday shows the workout once');

const prose = parseRoutineNotes('gym Sunday, Monday, Tuesday 20:00, kids 16:00 every day');
ok(prose.length === 2 && prose[0].weekdays.join(',') === '0,1,2', 'her own prose: a list of days stays one routine');
ok(prose[1].text === 'kids 16:00 every day', 'and a different thing after a comma is still its own');

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
