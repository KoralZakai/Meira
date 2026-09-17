/**
 * run-travel-row — a located task must never be silent about its journey.
 *
 * Koral, 2026-09-16: "I just added a yoga class in some place — why doesn't it
 * tell me how to get there, when?"
 *
 * The travel row opened with `if (!loc?.leaveHomeBy && !plan) return null`, so
 * a task with a place and no route drew nothing at all. Three quite different
 * situations produced that same blank space, and only one of them was
 * temporary:
 *
 *   a place with no hour   — can NEVER be routed. A leave time is the arrival
 *                            minus the journey; with no arrival there is
 *                            nothing to subtract from, so the chain skips it
 *                            forever and says nothing forever.
 *   a route not yet built  — will fix itself on the next sweep, or on a tap.
 *   no route for this mode — Google had nothing; try a different vehicle.
 *
 * The happy path must not move: a task with a real plan still renders the
 * journey exactly as before. These tests pin that first.
 *
 * Run:  npx tsx tests/run-travel-row.ts
 */
import { Task } from '../src/types/index';
import { travelRowState, describeTravelRow } from '../src/utils/travelRowState';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

const t = (over: Partial<Task> = {}): Task => ({
  id: 'y', text: 'שיעור יוגה', category: 'hobby_class', priority: 'need_to',
  isFixed: true, durationMinutes: 60, date: '2026-09-17', status: 'pending',
  createdAt: 0, historicalDurations: [], ...over,
} as Task);

const PLACE = { address: 'יגאל אלון 94, תל אביב', lat: 32.07, lng: 34.79, confirmed: true };

function main() {
  console.log('\nTravel row — never a blank space where a journey should be\n');

  console.log('1. The happy path is untouched');
  check('a task with a transit plan still renders its route',
    travelRowState(t({
      fixedTime: '18:00',
      location: { ...PLACE, transitPlan: { leaveHomeAt: '17:10' } } as any,
    })) === 'route');
  check('a leave time alone is enough to call it a route',
    travelRowState(t({ fixedTime: '18:00', location: { ...PLACE, leaveHomeBy: '17:10' } as any })) === 'route');

  console.log('\n2. The reported bug: a place, no hour');
  const noTime = t({ location: PLACE as any });
  check('it is recognised as "no time", not as "nothing to show"',
    travelRowState(noTime) === 'no-time', travelRowState(noTime));
  check('...and it says what to do about it',
    Boolean(describeTravelRow('no-time', true)?.action));
  check('...in Hebrew', describeTravelRow('no-time', true)!.text.includes('שעה'));
  check('...and in English', describeTravelRow('no-time', false)!.text.includes('no time'));
  // The shape she actually gets from typing "yoga at Yigal Alon" with no hour:
  // location stored as a bare string.
  check('a bare address string counts as a place',
    travelRowState(t({ location: 'יגאל אלון 94' as any })) === 'no-time');

  console.log('\n3. A route that has simply not been computed yet');
  check('place + hour + no plan = pending, and it is actionable',
    travelRowState(t({ fixedTime: '18:00', location: PLACE as any })) === 'pending');
  check('...offers to work it out now',
    describeTravelRow('pending', true)?.action === 'חשבי עכשיו');
  check('a scheduled time counts as an hour, same as a fixed one',
    travelRowState(t({ scheduledTime: '18:00', location: PLACE as any })) === 'pending');

  console.log('\n4. Google genuinely had nothing');
  check('an unroutable mode is its own state',
    travelRowState(t({
      fixedTime: '18:00',
      location: { ...PLACE, noRouteForMode: 'train' } as any,
    })) === 'unroutable');
  check('...and suggests changing mode',
    Boolean(describeTravelRow('unroutable', true)?.action));

  console.log('\n5. Silence is still right when there is nowhere to go');
  check('no location at all renders nothing',
    travelRowState(t({ fixedTime: '18:00' })) === 'none');
  check('an empty location string is not a place',
    travelRowState(t({ fixedTime: '18:00', location: '' as any })) === 'none');
  check('...and "none" has no line to draw', describeTravelRow('none', true) === null);
  check('a routed task has no explanatory line either',
    describeTravelRow('route', true) === null);

  console.log(`\n${failures ? '✗' : '✓'} ${checks - failures}/${checks} checks passed\n`);
  process.exit(failures ? 1 : 0);
}

main();
