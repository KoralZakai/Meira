/**
 * 13.10, Koral: "optimize all the content you have so it does not repeat —
 * update what you already have, export it clearly, no reduplications." These
 * are her real lines from You → Routines (both stores), 11.10.
 */
import { consolidateRoutineLines } from '../src/utils/routineConsolidate';

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); } else { fail += 1; console.error(`  ✗ ${label}  ${detail}`); }
};

const HERS = [
  'אימון · יום ראשון, שני ושלישי · 20:00 · עיגול אלון 94, תל אביב',
  'אימון · יום ראשון, שלישי · 20:00 · עיגל אלון 94, תל אביב',
  'יוגה ב 11 ימי שישי',
  'להתאמן · ימי ראשון עד שלישי · 20:00 · בעיגאל אלון, בחדר הכושר של ספייס',
  'אימון בערב · יום ראשון, יום שני, יום שלישי · 20:00',
  'אימון בוקר · יום שישי · 11:00',
  'אימון · יום ראשון, שני, שלישי, יום שישי · 20:00 או 11:00 · יגאל אלון 94',
  'work out · Sundays, Monday and Tuesdays · 20:00 · עיגל אלון 96',
  'אימון · יום ראשון, שני, שלישי, יום שישי · 20:00 או 11:00 · יגאל אלון 94 · באופניים, שלישי · 20:00 · עיגל אלון 94, אימונים · יום שישי · 11:00 · יגאל אלון 94, להתאמן · יום ראשון, שני, שלישי בערב ובנוסף יום שישי ב-11 בבוקר · 20:00 · עיגל אלון, 94, תל אביב · bicycle, תל אביב · באופניים',
  'אימונים מיום ראשון עד יום שלישי בשמונה בערב ובימי שישי ב-11 בבוקר. כל השיעורים מתקיימים ביגאל אלון 94 בתל אביב',
  'אימונים · מיום ראשון עד יום שלישי וימי שישי · בשמונה בערב וב-11 בבוקר · יגאל אלון 94 בתל אביב · bicycle',
  'אני מתאמנת כל יום ראשון, שני, שלישי בשמונה בערב ובימי שישי ב-11 בבוקר',
  'I work out on Sundays, Monday and Tuesdays on 8pm. I train at עיגל אלון 96.',
  'work out · Sundays, Monday and Tuesdays · 20:00 · עיגל אלון 96 · באופניים',
  'I hate early mornings',
].join('\n');

const out = consolidateRoutineLines(HERS);
console.log(out.lines.map((l) => `     ${l}`).join('\n'));
const evening = out.lines.filter((l) => /20:00/.test(l) && !/11:00/.test(l));
const friday = out.lines.filter((l) => /11/.test(l) && /שישי/.test(l));
ok(out.lines.length <= 4, `15 lines → at most four (got ${out.lines.length})`);
ok(evening.length === 1, 'ONE Sunday–Tuesday 20:00 workout', JSON.stringify(evening));
ok(/שני/.test(evening[0] ?? ''), 'with Monday — the days she said most, not the newest line', evening[0]);
ok(friday.length === 1, 'ONE Friday 11:00 workout', JSON.stringify(friday));
ok(out.lines.every((l) => !/עיגל|עיגול|עיגאל/.test(l)), 'Yigal Alon spelled as she means it everywhere');
ok([...evening, ...friday].every((l) => /יגאל אלון 94/.test(l)), 'both at her gym, Yigal Alon 94 — the address she gave most', JSON.stringify([...evening, ...friday]));
ok(out.lines.includes('I hate early mornings'), 'a note that is not a routine is kept as it is');
ok(consolidateRoutineLines(out.lines.join('\n')).merged === 0, 'running it again changes nothing');
ok(consolidateRoutineLines('פילאטיס · א׳\nאימון · ראשון · 20:30').lines.length === 2, 'Pilates and the evening workout stay two');

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
