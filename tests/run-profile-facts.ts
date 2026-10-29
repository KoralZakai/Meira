/**
 * run-profile-facts — "what Meira knows": a missing fact says it is missing, never blank.
 *
 * Run:  npx tsx tests/run-profile-facts.ts
 */
import { knownCount, profileFacts } from '../src/utils/profileFacts';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}
const get = (facts: ReturnType<typeof profileFacts>, key: string) => facts.find((f) => f.key === key);

const empty = profileFacts(null, true);
check('no profile → home is missing AND needed', get(empty, 'home')?.value === null && get(empty, 'home')?.needed === true);
check('…a blank address is missing too', get(profileFacts({ homeAddress: '   ' }, true), 'home')?.value === null);
check('…car unknown is null, not "no car"', get(empty, 'car')?.value === null);
check('…nothing known', knownCount(empty).known === 0, JSON.stringify(knownCount(empty)));

const full = profileFacts({
  homeAddress: 'הרצל 5, תל אביב', workAddress: 'רעננה', transportMode: 'transit', hasCar: false,
  earliestWakeTime: '06:30', sleepTime: '23:30', totalMorningRoutineMinutes: 40, departDelayMinutes: 4,
}, true);
check('home shown as she saved it', get(full, 'home')?.value === 'הרצל 5, תל אביב');
check('transport in Hebrew with the bus icon', get(full, 'transport')?.value === 'תחבורה ציבורית' && get(full, 'transport')?.icon === 'bus');
check('hasCar:false says "no car"', get(full, 'car')?.value === 'אין רכב');
check('routine in minutes, Hebrew', get(full, 'routine')?.value === '40 דק׳');
check('learned lateness tagged learned', get(full, 'delay')?.source === 'learned');
check('all of hers known, learned not counted', JSON.stringify(knownCount(full)) === JSON.stringify({ known: 7, total: 7 }));
check('no learned row without a number', !get(profileFacts({ departDelayMinutes: 0 }, false), 'delay'));
check('English labels', get(profileFacts({ transportMode: 'car' }, false), 'transport')?.value === 'Car');
check('a junk time is not shown as known', get(profileFacts({ sleepTime: 'late' as any }, false), 'sleep')?.value === null);

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) process.exit(1);
