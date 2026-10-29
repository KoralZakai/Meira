/**
 * run-same-text — a duplicate task is never filed under its twin.
 *
 * Run:  npx tsx tests/run-same-text.ts
 */
import { sameText } from '../src/utils/sameText';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean) {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
}
check('the same Hebrew name is the same task', sameText('חופשה במדבר', 'חופשה במדבר'));
check('quotes, spaces and punctuation do not make it different', sameText('«חופשה  במדבר»', 'חופשה במדבר.'));
check('case does not make it different', sameText('Gym Day', 'gym day'));
check('a longer name is a different task (can be its part)', !sameText('לארוז לחופשה במדבר', 'חופשה במדבר'));
check('empty is not the same as a name', !sameText('', 'חופשה'));
console.log(`\n${checks - failures}/${checks} passed`);
if (failures) process.exit(1);
