/**
 * 16.10, Koral: "when the user arrives at the place he needs to be at, sign
 * the meeting as done, complete ✓". markArrivals knew she had arrived and the
 * task stayed an open circle among "11 unfinished".
 */
import { readFileSync } from 'fs';
import { arrivalDoneLine, completesOnArrival } from '../src/utils/arrivalDone';

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); } else { fail += 1; console.error(`  ✗ ${label}`); }
};
const read = (p: string) => readFileSync(p, 'utf8');

const gym = { status: 'pending' as const, location: { address: 'יגאל אלון 76', lat: 32.0656, lng: 34.793 } };
ok(completesOnArrival(gym), 'an open task with a place completes when she gets there');
ok(!completesOnArrival({ ...gym, status: 'complete' as const }), 'a done one is left alone');
ok(!completesOnArrival({ status: 'pending' as const }), 'no place, nothing to arrive at');
ok(!completesOnArrival({ status: 'pending' as const, location: { address: 'x', lat: 0, lng: 0 } }), '0,0 is not a place (Null Island)');
ok(!completesOnArrival({ status: 'pending' as const, location: 'יגאל אלון 76' }), 'a bare string has no coordinates to arrive at');

const he = arrivalDoneLine('אימון', true);
ok(he.title === '✓ הגעת' && he.body.startsWith('אימון — סימנתי כבוצע'), 'Hebrew: says it and how to undo');
ok(arrivalDoneLine('Gym', false).body.includes('Tap the ✓'), 'English too');

// Wiring, read from the source (the device modules cannot load in node).
const live = read('src/services/LiveRoute.ts');
ok(/completesOnArrival\(task\)[\s\S]{0,200}markTaskComplete\(task\.id, true, \{ byArrival: true \}\)/.test(live),
  'markArrivals completes the task, by arrival');
ok(/sendImmediate\(line\.title, line\.body/.test(live), 'and says so');
const store = read('src/services/TaskStorage.ts');
ok(/opts\.byArrival \? undefined : derivedDurationMinutes/.test(store),
  'no duration is learned from a tick at the door');
ok(/completedBy: complete && opts\.byArrival \? 'arrival'/.test(store), 'the tick remembers it came from arriving');
const bg = read('src/services/CalendarAutoSync.ts');
ok(/backgroundArrivals\(settings\?\.language\)/.test(bg), 'it also runs with the app closed (background task)');
ok(/markArrivals\(dayTasks, \{ current: point, language \}\)/.test(read('src/screens/TodaySchedule.tsx')),
  'and on Today, in her language');

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
