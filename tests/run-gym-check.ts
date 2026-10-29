/**
 * 13.10, Koral: "I am not sure! check where Space Gym is, or Meira should
 * search and check where the gym is!" Her lines said 94 and 96; Space's own
 * site lists one Yigal Alon branch — 76.
 */
import { gymOf, gymQuery, settleGym } from '../src/utils/gymCheck';

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); } else { fail += 1; console.error(`  ✗ ${label}`); }
};

const lines = [
  'אימון בימי ראשון שני שלישי ב-20:00 · Space Gym, יגאל אלון 94, תל אביב',
  'אימון ביום שישי ב-11:00 · יגאל אלון 96, תל אביב',
  'עבודה מהבית',
];
const g = gymOf(lines)!;
ok(Boolean(g) && g.brand === 'Space' && g.street === 'יגאל אלון' && g.number === '94', 'reads the gym: Space, יגאל אלון 94');
ok(gymQuery(g) === 'Space יגאל אלון תל אביב', `asks the map by name and street, not the doubted number (${gymQuery(g)})`);

const SPACE = { name: 'Space Fix', address: 'יגאל אלון 76, תל אביב-יפו, ישראל' };
const v = settleGym(lines, g, [SPACE, { name: 'מגדלי אלון', address: 'יגאל אלון 94, תל אביב-יפו' }]);
ok(v.changed && v.found === 'יגאל אלון 76', 'the map says 76');
ok(v.lines[0].includes('יגאל אלון 76') && v.lines[1].includes('יגאל אלון 76'), 'both 94 and 96 become 76');
ok(v.lines[2] === 'עבודה מהבית', 'a line that is not a workout is untouched');

ok(settleGym(lines, g, [{ name: 'Space', address: 'יגאל אלון 94, תל אביב' }]).reason === 'matches', 'already right → nothing to change');
ok(settleGym(lines, g, [{ name: 'Space', address: 'אבן גבירול 62, תל אביב' }]).reason === 'not-found', 'another street is not her gym');
ok(settleGym(lines, g, [{ name: 'Holmes Place', address: 'יגאל אלון 70, תל אביב' }]).reason === 'not-found', 'another brand is not her gym');
const noBrand = gymOf(['אימון ב-20:00 ביגאל אלון 94'])!;
ok(settleGym(['אימון ב-20:00 ביגאל אלון 94'], noBrand,
  [{ name: 'Space Fix', address: 'יגאל אלון 76, תל אביב' }, { name: 'Holmes Place', address: 'יגאל אלון 80, תל אביב' }]).reason === 'ambiguous',
  'two gyms on her street with no name said → ask her, never guess');

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
