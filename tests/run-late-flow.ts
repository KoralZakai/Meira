/**
 * run-late-flow — late for a trip: where the route starts, and what "New time" offers (21.10, Koral).
 * Source-level pins: the services import react-native and cannot run in node.
 * Run:  npx tsx tests/run-late-flow.ts
 */
import { readFileSync } from 'node:fs';

let failures = 0; let checks = 0;
const check = (l: string, ok: boolean) => { checks += 1; if (!ok) failures += 1; console.log(`  ${ok ? '✓' : '✗'} ${l}`); };
const src = (p: string) => readFileSync(p, 'utf8');
const live = src('src/services/LiveRoute.ts');
const late = src('src/services/RunningLate.ts');

check('"leave now" can start from where she IS (opts.from overrides the profile home)',
  /from\?: \{ lat: number; lng: number \} \| null;/.test(live) && /opts\.from \? profileFromPoint\(homeProfile, opts\.from\) : homeProfile/.test(live));
check('a started appointment + a fix: depart-now FROM HERE, never an arrive-by plan to a deadline behind her',
  /startMin <= nowD\.getHours\(\) \* 60 \+ nowD\.getMinutes\(\)[\s\S]{0,120}replanFromNextDeparture\(trip, storedProfile, \{ \.\.\.opts, from: current \}\)/.test(live));
check('the plan records where it was planned from', /startLat: opts\.from\.lat, startLng: opts\.from\.lng/.test(live));
check('"New time" opens THREE plain choices: route me now · move it · set the time later',
  /Route me now, from where I am/.test(late) && /Move it — to when\?/.test(late) && /Set the time later/.test(late)
  && /לחשב מעכשיו, מהמקום שבו אני/.test(late) && /לדחות — למתי\?/.test(late) && /לתזמן אחר כך/.test(late));
// 28.10 (Koral): "later" goes into the 🔔, so she remembers to set the new date.
check('"set the time later" lands in the bell, to set a date', /In your 🔔/.test(late) && /keepOpen\(task, he\)/.test(late)
  && /followUpOf: task\.id/.test(late) && /export async function setNewDate/.test(late));
check('"later" pressed twice adds ONE note, never a second (28.10)', /One note per task/.test(late) && /followUpOf === task\.id/.test(late));
check('a postponed task leaves the day at once — it waits on the bell (28.10)',
  /t\.status !== 'missed'\)\);/.test(src('src/screens/TodaySchedule.tsx')));
check('"Move it" lets her pick a DATE and an HOUR (two system dialogs), not only tomorrow',
  /DateTimePickerAndroid\.open\(\{[\s\S]{0,200}mode: 'date'/.test(late) && /mode: 'time'/.test(late) && /Another date and hour/.test(late) && /תאריך ושעה אחרים/.test(late));
check('the new hour is saved BEFORE the move, which re-arms alerts from what is stored',
  /updateTaskFields\(task\.id, \{ fixedTime: hhmm[\s\S]{0,160}moveTasksToDate\(\[task\.id\], ymd\(at\)\)/.test(late));
check('an answer to "you\'re late" makes Today redraw (the dialogs resolve after the function returned)',
  /export function onLateAnswered/.test(late) && /lateChanged\(\);\s*Alert\.alert\(he \? '🚶/.test(late) && /onLateAnswered\(\(\) => \{ loadRef\.current/.test(src('src/screens/TodaySchedule.tsx')));
check('no position: it says so and why — never routes from home in silence',
  /I can't see where you are/.test(late) && /אין לי את המיקום שלך/.test(late));
check('a failed route says the reason', /Reason: \$\{r\.reason\}/.test(late));
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
