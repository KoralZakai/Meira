/**
 * run-leave-row — "there is no leave-home row before 14:30".
 *
 * Koral, the night before the interview. The address was on the card and the
 * row that says when to walk out was not, and nothing on the screen said why.
 *
 * THE BUG
 *
 * `TimelineTravelLeg` already knows how to explain every way a journey can be
 * missing: a place with no hour, no route by that vehicle, not planned yet —
 * each with the action that fixes it (`travelRowState` + `describeTravelRow`).
 *
 * But `DayTimeline` mounted it behind `taskHasJourney`, which is true only
 * once a route ALREADY EXISTS (`leaveHomeBy || transitPlan`). So the component
 * that explains the absence was rendered only when there was no absence, and a
 * task with a real address and no route drew nothing at all — the same nothing
 * whether the route had failed, was pending, or had never been attempted.
 *
 * These checks pin the predicate itself, because that is the bug: which tasks
 * get a row, not what the row says once it is there.
 *
 * Run:  npx tsx tests/run-leave-row.ts
 */
import { travelRowState, describeTravelRow } from '../src/utils/travelRowState';
import { taskHasJourney } from '../src/utils/dayPlanning';
import type { Task, TaskLocation } from '../src/types/index';
import { readFileSync } from 'fs';
import { join } from 'path';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

const base = {
  id: 'gcal-ceva', text: 'Your in-person interview with Ceva',
  date: '2026-09-23', category: 'interview', priority: 'must',
  status: 'pending', isFixed: true, durationMinutes: 90,
  createdAt: 0, historicalDurations: [],
} as unknown as Task;

console.log('\nWhich tasks get a travel row\n');

// The exact shape of the interview the night before: address, hour, no route.
const unrouted: Task = { ...base, fixedTime: '14:30', location: "7 HaPnina Street, Ra'anana" as any };
check('the unrouted interview has NO journey yet', !taskHasJourney(unrouted));
check('...but it is not "none" — it has somewhere to go',
  travelRowState(unrouted) !== 'none', travelRowState(unrouted));
check('...so under the OLD predicate it drew nothing',
  taskHasJourney(unrouted) === false, 'taskHasJourney → false');
check('...and under the NEW predicate it draws a row',
  travelRowState(unrouted) !== 'none', `state = ${travelRowState(unrouted)}`);

const line = describeTravelRow(travelRowState(unrouted), true);
check('the row has words for her', Boolean(line?.text), line?.text ?? '(none)');
check('and an action that fixes it', Boolean(line?.action), line?.action ?? '(none)');

// A routed task must still draw exactly as before.
const routed: Task = {
  ...base,
  fixedTime: '14:30',
  location: {
    address: "7 HaPnina Street, Ra'anana", lat: 32.18, lng: 34.87,
    confirmed: false, leaveHomeBy: '13:38', wakeUpBy: '12:43', travelMinutes: 52,
  } as TaskLocation,
};
check('a routed task still has a journey', taskHasJourney(routed));
check('a routed task is state "route" — the happy path is untouched',
  travelRowState(routed) === 'route', travelRowState(routed));

// Silence is still correct where there is genuinely nowhere to go.
const nowhere: Task = { ...base, fixedTime: '14:30', location: undefined };
check('a task with no place draws nothing', travelRowState(nowhere) === 'none');
check('and describeTravelRow says nothing for it',
  describeTravelRow('none', true) === null);

// A place with no hour can never be routed — say that, do not stay silent.
const noHour: Task = { ...base, fixedTime: undefined, scheduledTime: undefined,
  location: "7 HaPnina Street, Ra'anana" as any };
check('a place with no hour is "no-time", not silence',
  travelRowState(noHour) === 'no-time', travelRowState(noHour));
check('and it says so in both languages',
  Boolean(describeTravelRow('no-time', true)?.text)
  && Boolean(describeTravelRow('no-time', false)?.text));

// The wiring itself: the predicate in DayTimeline is the thing that was wrong.
console.log('\nThe timeline actually uses it\n');
const src = readFileSync(join(__dirname, '..', 'src', 'components', 'DayTimeline.tsx'), 'utf8');
check('DayTimeline filters on travelRowState, not taskHasJourney',
  src.includes("travelRowState(b.task) !== 'none'"), 'the render predicate');
check('taskHasJourney is no longer the gate there',
  !src.includes('group.filter((b) => taskHasJourney(b.task))'));

console.log(`\n${failures ? '❌' : '✅'} ${checks - failures}/${checks} checks passed\n`);
if (failures) process.exit(1);
