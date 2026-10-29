/**
 * run-trip-timeline — the timeline names where she leaves FROM and where she arrives, readably.
 *
 * Run:  npx tsx tests/run-trip-timeline.ts
 */
import { originText, shortPlace } from '../src/utils/tripPlaces';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}
check('a house number is never the whole place', shortPlace('1, Diezengoff Street, Tel Aviv') === 'Diezengoff Street 1', shortPlace('1, Diezengoff Street, Tel Aviv'));
check('a named place keeps its name', shortPlace('Space Gym, Tel Aviv') === 'Space Gym');
check('origin Home → הבית', originText('Home', true) === 'הבית');
check('no origin → home', originText(undefined, false) === 'home');
check('a live fix is "where you are", not numbers', originText('32.0712,34.7801', true) === 'המקום שבו את');
check('a named origin stays', originText('Kaplan Building, Tel Aviv', false) === 'Kaplan Building');
console.log(`\n${checks - failures}/${checks} passed`);
if (failures) process.exit(1);
