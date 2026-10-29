/**
 * run-device-calendar-google — the phone reads every Google account's main
 * calendar except the one Google itself is already read by API (6.10).
 *
 *   npx tsx tests/run-device-calendar-google.ts
 */
import { readByGoogleApi } from '../src/utils/googleCalendarSkip';

let checks = 0;
let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `  — ${detail}`}`);
}

const privatePrimary = { accountType: 'com.google', account: 'private@gmail.com', isPrimary: true };
const workPrimary = { accountType: 'com.google', account: 'work@company.com', isPrimary: true };
const privateBirthdays = { accountType: 'com.google', account: 'private@gmail.com', isPrimary: false };
const samsung = { accountType: 'com.osp.app.signin', account: 'Samsung account', isPrimary: true };

console.log('\nPhone calendars vs Google read by API\n');

const linked = { connected: true, email: 'Private@Gmail.com' };
check('the connected account\'s main calendar is skipped (Google reads it)',
  readByGoogleApi(privatePrimary, linked) === 'yes');
check('THE BUG: the other Gmail\'s main calendar is read from the phone',
  readByGoogleApi(workPrimary, linked) === 'no', readByGoogleApi(workPrimary, linked));
check('a secondary calendar of the connected account is read from the phone',
  readByGoogleApi(privateBirthdays, linked) === 'no');
check('a non-Google calendar is never skipped', readByGoogleApi(samsung, linked) === 'no');
check('no Google connection → nothing skipped',
  readByGoogleApi(privatePrimary, { connected: false }) === 'no' && readByGoogleApi(workPrimary, { connected: false }) === 'no');
check('connected but which account unknown → skipped as before, and SAID to be unsure',
  readByGoogleApi(workPrimary, { connected: true }) === 'unsure');

console.log('\nSeveral Google accounts connected directly\n');
const both = { connected: true, emails: ['private@gmail.com', 'work@company.com'] };
check('both connected for their calendars → both main calendars come by API, not twice',
  readByGoogleApi(privatePrimary, both) === 'yes' && readByGoogleApi(workPrimary, both) === 'yes');
const mailOnlyWork = { connected: true, emails: ['private@gmail.com'] };
check('work connected for its MAIL only → its calendar is still read from the phone',
  readByGoogleApi(workPrimary, mailOnlyWork) === 'no');
check('one account not identified yet → its maybe-calendar is skipped AND said to be unsure',
  readByGoogleApi(workPrimary, { connected: true, emails: ['private@gmail.com'], unknown: true }) === 'unsure');

console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
