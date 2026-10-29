/**
 * run-same-name — "סגית" is "Sagit" (1.10: one call, two cards at 20:30).
 * The same fixture is read by server/tests/test_same_name.py, so the phone and
 * Meira agree on what counts as one person.
 *
 * Run:  npx tsx tests/run-same-name.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { sharesAName } from '../src/utils/nameSkeleton';
import { isSameMeeting, collapseSameMeetings } from '../src/utils/calendarEventTask';

const cases: Array<{ a: string; b: string; same: boolean }> =
  JSON.parse(readFileSync(join(__dirname, 'fixtures/same-name.json'), 'utf8'));
let bad = 0;
for (const c of cases) {
  const got = sharesAName(c.a, c.b);
  if (got !== c.same) bad += 1;
  console.log(`  ${got === c.same ? '✓' : '✗'} "${c.a}" ~ "${c.b}" → ${got}`);
}
// …and only ever at the same minute: the same names an hour apart are two things.
const at = (text: string, fixedTime: string) => ({ text, fixedTime, date: '2026-10-01' });
const pairs: Array<[boolean, boolean]> = [
  [isSameMeeting(at('שיחה עם סגית', '20:30'), at('Sagit/Koral- intro', '20:30')), true],
  [isSameMeeting(at('שיחה עם סגית', '20:30'), at('Sagit/Koral- intro', '21:30')), false],
];
const mine = { id: 'm1', text: 'שיחה עם סגית', date: '2026-10-01', fixedTime: '20:30', durationMinutes: 15 };
const google = { id: 'gcal-x', text: 'Sagit/Koral- intro', date: '2026-10-01', fixedTime: '20:30', durationMinutes: 60, source: 'calendar', meetingUrl: 'https://meet.google.com/abc' };
const [one, ...rest] = collapseSameMeetings([google, mine] as any[]);
pairs.push([rest.length === 0 && one.id === 'm1' && one.durationMinutes === 60 && one.meetingUrl === google.meetingUrl, true]);
for (const [got, want] of pairs) { if (got !== want) bad += 1; console.log(`  ${got === want ? '✓' : '✗'} same minute only → ${got}`); }
console.log(`\n${bad ? '❌' : '✅'} ${cases.length + pairs.length - bad}/${cases.length + pairs.length} checks passed\n`);
process.exit(bad ? 1 : 0);
