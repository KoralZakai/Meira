/**
 * run-yield-to-fixed — her evening, exactly as the app got it wrong.
 *
 * Koral, 2026-09-17: "see how the prepare for call is overlapping yoga. i
 * expected that the preparation time would get shorter, a time to get ready
 * will appear, travel time by bike will appear and calculate ahead the time
 * and tasks to get the yoga done."
 *
 * The screenshot: "Prepare for: Your phone interview with Ceva" 18:18–20:18,
 * yoga at Charles Clore 19:00–20:00, and underneath, in yellow, "You can take
 * the call on the way".
 *
 * Run:  npx tsx tests/run-yield-to-fixed.ts
 */
import { Task } from '../src/types/index';
import {
  yieldToFixed, protectedWindowFor, isAnchored, describeYield,
  OUTING_PREP_MINUTES, MIN_USEFUL_BLOCK_MINUTES, ASSUMED_TRAVEL_MINUTES,
} from '../src/utils/yieldToFixed';

let failures = 0; let checks = 0;
const check = (l: string, ok: boolean, d = '') => {
  checks += 1; if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${l}${d ? `  — ${d}` : ''}`);
};

const task = (over: Partial<Task>): Task => ({
  id: 'x', text: 'x', category: 'general', priority: 'need_to', isFixed: false,
  durationMinutes: 30, date: '2026-09-17', status: 'pending',
  createdAt: 0, historicalDurations: [], ...over,
} as Task);

// Her real evening.
const CLORE = {
  address: '11א, Kaufmann Street, Tel Aviv', displayName: 'צ׳ארלס קלור',
  lat: 32.0632, lng: 34.7606, confirmed: true,
};
const yoga = task({
  id: 'yoga', text: 'יוגה בצ׳ארלס קלור', category: 'hobby_class', isFixed: true,
  fixedTime: '19:00', durationMinutes: 60,
  location: { ...CLORE, leaveHomeBy: '18:40', travelMinutes: 20 } as any,
});
const prep = task({
  id: 'prep', text: 'Prepare for: Your phone interview with Ceva',
  category: 'course', priority: 'must', scheduledTime: '18:18', durationMinutes: 120,
});

function main() {
  console.log('\nYielding to a fixed appointment — the evening she photographed\n');

  console.log('1. What the class actually owns');
  const w = protectedWindowFor(yoga, null)!;
  check('the window exists', Boolean(w));
  check('travel comes from her stored route, not an assumption',
    w.travelMinutes === 20 && w.travelAssumed === false);
  check('she leaves at the route\'s own leave time', w.leaveAt === '18:40', w.leaveAt);
  check(`getting ready starts ${OUTING_PREP_MINUTES} min before that`,
    w.readyAt === '18:30', w.readyAt);
  check('the protected block runs to the end of the class', w.endAt === '20:00', w.endAt);
  check('a get-ready window is SHORT — it is changing a shirt, not a morning routine',
    w.prepMinutes === OUTING_PREP_MINUTES && w.prepMinutes < 30);

  console.log('\n2. An unrouted place still owns a window — it is stated, not hidden');
  const unrouted = protectedWindowFor(task({
    id: 'u', isFixed: true, fixedTime: '19:00', durationMinutes: 60, location: CLORE as any,
  }), null)!;
  check('the journey is assumed rather than skipped', unrouted.travelAssumed === true);
  check(`...at ${ASSUMED_TRAVEL_MINUTES} minutes`, unrouted.travelMinutes === ASSUMED_TRAVEL_MINUTES);
  check('so the block is still protected and nothing is planned through it',
    unrouted.readyAt === '18:35', unrouted.readyAt);

  console.log('\n3. THE BUG: the prep block covered the departure');
  const plans = yieldToFixed([yoga, prep], { dayEnd: '23:00' });
  check('the prep block is not left where it was', plans.length === 1, `${plans.length} plan(s)`);
  const p = plans[0];
  check('it is the PREP that yields, never the class', p.taskId === 'prep');
  check('...because of the yoga', p.blockedBy === 'yoga');
  check('18:18 to 18:30 is 12 minutes — not worth starting, so it MOVES',
    p.action === 'move', p.action);
  check('it lands after the class, not before it',
    p.to!.start === '20:00', p.to?.start);
  check('and it keeps its full two hours', p.minutes === 120);
  check('it fits inside the evening', p.to!.end === '22:00', p.to?.end);

  console.log('\n4. When there IS enough time first, it shortens instead of moving');
  const early = task({ id: 'early', scheduledTime: '17:00', durationMinutes: 120 });
  const shortened = yieldToFixed([yoga, early], { dayEnd: '23:00' })[0];
  check('90 minutes of real work survives, so the block is kept',
    shortened.action === 'shorten', shortened.action);
  check('...ending exactly when she starts getting ready',
    shortened.to!.end === '18:30', shortened.to?.end);
  check('and it says what that cost', shortened.lostMinutes === 30, String(shortened.lostMinutes));
  check(`the floor is ${MIN_USEFUL_BLOCK_MINUTES} min — below it, moving beats a stub`,
    yieldToFixed([yoga, task({ id: 'stub', scheduledTime: '18:10', durationMinutes: 90 })],
      { dayEnd: '23:00' })[0].action === 'move');

  console.log('\n5. What must NOT move');
  check('a fixed appointment is anchored', isAnchored(yoga));
  check('a scheduled work block is not', !isAnchored(prep));
  check('two fixed appointments are left alone — that is a clash, not a reflow',
    yieldToFixed([yoga, task({
      id: 'other', isFixed: true, fixedTime: '19:30', durationMinutes: 30,
      location: { address: 'somewhere else', lat: 32.1, lng: 34.8, confirmed: true } as any,
    })], {}).length === 0);
  check('work that ends before she gets ready is untouched',
    yieldToFixed([yoga, task({ id: 'ok', scheduledTime: '16:00', durationMinutes: 60 })], {}).length === 0);
  check('work that starts after the class is untouched',
    yieldToFixed([yoga, task({ id: 'later', scheduledTime: '20:30', durationMinutes: 60 })], {}).length === 0);
  check('a completed block is nobody\'s problem',
    yieldToFixed([yoga, { ...prep, status: 'complete' } as Task], {}).length === 0);

  console.log('\n6. A day with no room left says so');
  const noRoom = yieldToFixed([yoga, task({ id: 'big', scheduledTime: '18:18', durationMinutes: 240 })],
    { dayEnd: '21:00' })[0];
  check('it does not pretend four hours fit before 21:00', noRoom.action === 'no-room', noRoom.action);
  check('...and it is honest in Hebrew',
    describeYield(noRoom, 'יוגה', true).includes('אין לזה מקום'));

  console.log('\n7. It says what it did');
  check('shortening explains itself in Hebrew',
    describeYield(shortened, 'יוגה', true).includes('קוצר'));
  check('moving names the new hour',
    describeYield(p, 'יוגה', true).includes('20:00'));
  check('...and in English', describeYield(p, 'yoga', false).includes('comes first'));

  console.log(`\n${failures ? '✗' : '✓'} ${checks - failures}/${checks} checks passed\n`);
  process.exit(failures ? 1 : 0);
};

main();
