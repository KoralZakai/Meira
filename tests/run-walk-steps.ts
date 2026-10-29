/**
 * 13.10, Koral: "the plan is missing the walking times from place to place —
 * from where I am now to the train, when EXACTLY the train leaves, how long
 * the walk is to the next place". The card dropped every walking leg.
 */
import { journeySteps, routeChips, walkRideWalkLine } from '../src/utils/rideLine';
import { Task, TransitLeg } from '../src/types/index';

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); } else { fail += 1; console.error(`  ✗ ${label}`); }
};
const leg = (type: any, durationMinutes: number, departureTime: string, arrivalTime: string, extra: Partial<TransitLeg> = {}): TransitLeg =>
  ({ type, from: '', to: '', durationMinutes, departureTime, arrivalTime, ...extra } as TransitLeg);

// Tel Aviv → Haifa, as Google answers it: walk, bus, walk, train, walk.
const legs = [
  leg('walk', 4, '10:25', '10:29'),
  leg('walk', 1, '10:29', '10:30'),
  leg('bus', 8, '10:31', '10:39', { lineNumber: '10', stopName: 'ארלוזורוב', to: 'ת״א סבידור' }),
  leg('walk', 4, '10:39', '10:43'),
  leg('train', 55, '10:48', '11:43', { stopName: 'ת״א סבידור', to: 'חיפה חוף הכרמל' }),
  leg('walk', 0.4, '11:43', '11:43'),
  leg('walk', 13, '11:43', '11:56'),
];

const steps = journeySteps(legs, 'פארק מדעי החיים', '10:24');
ok(steps.length === 5, `walk · bus · walk · train · walk (${steps.length})`);
const [w1, , w2, train, w3] = steps as any[];
ok(w1.kind === 'walk' && w1.minutes === 5 && w1.role === 'to-stop' && w1.to === 'ארלוזורוב' && w1.at === '10:24' && w1.reach === '10:29',
  'from where she is: 5 min walk from OUR leave time (10:24, not Google\'s 10:25) — at the stop 10:29 (two walks are one)');
ok(w2.kind === 'walk' && w2.role === 'transfer' && w2.minutes === 4 && w2.to === 'ת״א סבידור', 'the change: 4 min walk to the station');
ok(w2.at === '10:39' && w2.reach === '10:43', 'the change starts when the bus arrives, and says when she is at the platform');
ok(train.kind === 'ride' && train.leg.departureTime === '10:48', 'the train, with its exact minute');
ok(w3.kind === 'walk' && w3.role === 'to-place' && w3.minutes === 13 && w3.to === 'פארק מדעי החיים',
  'and 13 min walk to the place (a 0.4-min crumb is folded in, not its own step)');
ok(w3.at === '11:43' && w3.reach === '11:56', 'the last walk ends at the arrival');
ok(journeySteps([leg('walk', 20, '10:00', '10:20')], 'x').length === 0, 'a walk-only trip has no transit steps (the card shows the walk mode)');

const task = { text: 'ראיון', location: { address: 'x', lat: 0, lng: 0, confirmed: true, transitPlan: { legs } } } as unknown as Task;
const line = walkRideWalkLine(task, true);
ok(line === '🚶 5 דק׳ ← 🚌 קו 10 · 10:31 ← 🚆 10:48 ← 🚶 13 דק׳ · מ־ארלוזורוב', `the closed card says it too (right-to-left: ←): ${line}`);
const lineEn = walkRideWalkLine(task, false);
ok(lineEn.includes(' → ') && !lineEn.includes('←'), `and in English the steps still run →: ${lineEn}`);

// 18.10, Koral: "buses to today's event were really unclear — missed the bus line!"
// Nahariya → Rafael: bus 22 one stop, change, bus 272. The closed card was one
// sentence cut at two lines — "🚌 12:28 line 22 → 🚌 12:35 lin…" — so the number
// of the SECOND bus was the part that was cut, and the stop never showed.
const nahariya = [
  leg('walk', 12, '12:12', '12:24'),
  leg('bus', 1, '12:28', '12:29', { lineNumber: '22', stopName: 'הרצל/המייסדים', to: 'ת. מרכזית נהריה/הורדה' }),
  leg('walk', 1, '12:29', '12:30'),
  leg('bus', 21, '12:35', '12:56', { lineNumber: '272', stopName: 'ת. מרכזית נהריה/רציפים', to: 'דרך עכו חיפה/רפא״ל' }),
  leg('walk', 4, '12:56', '13:00'),
];
const nTask = { text: 'ראיון', location: { address: 'x', lat: 0, lng: 0, confirmed: true, transitPlan: { legs: nahariya, leaveHomeAt: '12:12' } } } as unknown as Task;
const { chips, from } = routeChips(nTask, false);
ok(chips.filter((c) => c.kind === 'ride').map((c) => c.line).join(',') === '22,272', 'both bus numbers are steps of their own, whole');
ok(chips.filter((c) => c.kind === 'ride').map((c) => c.time).join(',') === '12:28,12:35', 'each with the minute it leaves');
ok(chips[0].kind === 'walk' && chips[chips.length - 1].kind === 'walk', 'walk first, walk last');
ok(from === 'from הרצל/המייסדים', `the stop the FIRST bus leaves from is named: ${from}`);
const enLine = walkRideWalkLine(nTask, false);
ok(enLine.indexOf('line 22') < enLine.indexOf('12:28') && enLine.indexOf('line 272') < enLine.indexOf('12:35'),
  `the line number comes before its minute (it is what she matches to the bus): ${enLine}`);
ok(routeChips({ text: 'x', location: { address: 'x', lat: 0, lng: 0, confirmed: true } } as unknown as Task, false).chips.length === 0, 'no timetable → no chips, no invented route');

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
