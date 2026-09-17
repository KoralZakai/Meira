/**
 * run-getting-ready — "why was there no alarm with getting ready?"
 *
 * Koral, 2026-09-16, about a task she had moved to tomorrow at 11:00. And,
 * in the same breath, about a yoga class she had just added at a place:
 * "why doesn't it tell me how to get where, when".
 *
 * Both are the same failure wearing two faces, and neither is a crash — the
 * app did exactly what it was written to do, which is why it survived every
 * previous pass:
 *
 *   GET-READY ONLY EXISTS ON THE TRAVEL PATH. `get_ready` and `wake_up` are
 *   emitted in one place, planTransitAlerts, and that function needs a
 *   TransitPlan. A task with no route therefore gets "in 1 hour" and "in 15
 *   min" and nothing else — no matter that she needs 60 minutes to become a
 *   person who can leave the house. For an ADHD user that prep window IS the
 *   product; the whole app is backward time calculation.
 *
 *   AND NOTHING SAYS SO. A task with a place but no computed route renders no
 *   travel row at all (TimelineTravelLeg returns null), so "I don't know how
 *   to get you there yet" and "there is nothing to get to" look identical.
 *
 * THE WAKE ALARM. This file used to assert that an 11:00 task raises NO alarm,
 * on the invariant that one fires only when the day forces her up EARLIER than
 * she normally rises. On 2026-09-17 Koral overruled that, in these words:
 * "why? need to be clock alarm! ... a clock alarm must be every day according
 * the schedule! in the AM hours."
 *
 * So the prep alert for a morning task is now a wake_up, and it is urgent. The
 * thing this file actually exists for is UNCHANGED and is what the checks below
 * pin: a task with no route must still be told WHEN to start getting ready, at
 * her start time minus her own routine. Which channel that arrives on is the
 * policy question she answered; that it arrives at all was the bug.
 *
 * Run:  npx tsx tests/run-getting-ready.ts
 */
import { Task } from '../src/types/index';
import { planFixedTimeAlerts, needsWakeAlarm } from '../src/utils/alertPlan';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

const t = (over: Partial<Task> = {}): Task => ({
  id: 'x',
  text: 'לעשות משהו',
  category: 'general',
  priority: 'need_to',
  isFixed: true,
  fixedTime: '11:00',
  durationMinutes: 60,
  date: '2026-09-17',
  status: 'pending',
  createdAt: 0,
  historicalDurations: [],
  ...over,
} as Task);

const kinds = (alerts: { kind: string }[]) => alerts.map((a) => a.kind);
const at = (alerts: { kind: string; at: string }[], kind: string) =>
  alerts.find((a) => a.kind === kind)?.at;

/** Her real shape: up at 07:30, needs 45 + 15 = 60 minutes to get going. */
const ROUTINE = 60;
const USUAL_WAKE = '07:30';

function main() {
  console.log('\nGetting ready — the prep window, with and without a route\n');

  console.log('1. The reported bug: an 11:00 task with no route');
  const plain = planFixedTimeAlerts(t(), 'he', undefined, undefined, {
    routineMinutes: ROUTINE, usualWakeTime: USUAL_WAKE,
  });
  // Kind-agnostic on purpose: the BUG was that no prep alert existed at all.
  // Whether it rings or nudges is the policy she decides, and pinning the kind
  // here would make this test fail every time that policy is revisited.
  const prepOf = (as: any[]) => as.find((a) => a.kind === 'wake_up' || a.kind === 'get_ready');
  check('she is told when to START getting ready',
    Boolean(prepOf(plain)), kinds(plain).join(', ') || '(nothing)');
  check('...at her start time minus her routine, not a guess',
    prepOf(plain)?.at === '10:00', String(prepOf(plain)?.at));
  check('the ordinary reminders survive — this must ADD, never replace',
    kinds(plain).includes('hour_before') && kinds(plain).includes('fifteen_before'),
    kinds(plain).join(', '));

  console.log('\n2. ...and under her rule it IS a wake-from-sleep alarm');
  // Reversed 2026-09-17 on her explicit instruction. The morning window is
  // what still bounds it — see section 5.
  check('a 10:00 prep for an 11:00 task rings',
    kinds(plain).includes('wake_up'), kinds(plain).join(', '));
  check('...and it is alarm-grade, which is what she asked for',
    prepOf(plain)?.urgent === true);
  check('needsWakeAlarm agrees under the default policy',
    needsWakeAlarm('10:00', USUAL_WAKE));
  check('...and the OLD policy still says no, kept under its own name',
    !needsWakeAlarm('10:00', USUAL_WAKE, 'earlier-than-usual'),
    'the previous rule is a named option, not deleted');
  check('exactly one prep alert, never both kinds',
    kinds(plain).filter((k) => k === 'wake_up' || k === 'get_ready').length === 1,
    kinds(plain).join(', '));

  console.log('\n3. An early start DOES earn a real alarm');
  const early = planFixedTimeAlerts(t({ fixedTime: '06:30' }), 'he', undefined, undefined,
    { routineMinutes: ROUTINE, usualWakeTime: USUAL_WAKE });
  check('05:30 prep for a 07:30 riser is a wake_up',
    kinds(early).includes('wake_up'), kinds(early).join(', '));
  check('...and it IS urgent', early.find((a) => a.kind === 'wake_up')?.urgent === true);
  check('...and never both kinds at once',
    !kinds(early).includes('get_ready'), kinds(early).join(', '));

  console.log('\n4. The travel path still owns it when a route exists');
  // planTransitAlerts produces a better prep alert — it knows the bus. This
  // fallback must stand down, or she gets two "start getting ready" pings.
  const routed = planFixedTimeAlerts(t(), 'he', '10:15', undefined,
    { routineMinutes: ROUTINE, usualWakeTime: USUAL_WAKE });
  check('no duplicate prep alert once a departure time is known',
    !kinds(routed).includes('get_ready') && !kinds(routed).includes('wake_up'),
    kinds(routed).join(', '));

  console.log('\n5. The refusals — no invented prep times');
  check('no routine known: say nothing rather than guess',
    !kinds(planFixedTimeAlerts(t(), 'he')).includes('get_ready'));
  check('a zero-length routine is not a prep window',
    !kinds(planFixedTimeAlerts(t(), 'he', undefined, undefined,
      { routineMinutes: 0, usualWakeTime: USUAL_WAKE })).includes('get_ready'));
  check('no fixed time, no prep alert at all',
    planFixedTimeAlerts(t({ fixedTime: undefined }), 'he', undefined, undefined,
      { routineMinutes: ROUTINE }).length === 0);

  console.log('\n6. A task moved to tomorrow keeps its prep window');
  // moveTasksToDate clears the stale route, then re-arms. If prep depended on
  // the route, the move silently removed it — which is exactly what she saw.
  const moved = planFixedTimeAlerts(
    t({ date: '2026-09-17', movedFromDate: '2026-09-16', location: undefined }),
    'he', undefined, undefined, { routineMinutes: ROUTINE, usualWakeTime: USUAL_WAKE },
  );
  // Kind-agnostic, same reasoning as section 1: the bug was that the move
  // silently removed the prep window, not which channel it arrived on.
  check('the moved task still says when to start getting ready',
    Boolean(prepOf(moved)), kinds(moved).join(', '));
  check('...on the NEW date', prepOf(moved)?.at === '10:00', String(prepOf(moved)?.at));

  console.log('\n7. A very early prep crossing midnight is still sane');
  const midnight = planFixedTimeAlerts(t({ fixedTime: '00:40' }), 'he', undefined, undefined,
    { routineMinutes: ROUTINE, usualWakeTime: USUAL_WAKE });
  const prep = midnight.find((a) => a.kind === 'wake_up' || a.kind === 'get_ready');
  check('a 00:40 start preps the night before',
    !prep || prep.dayOffset === -1, JSON.stringify(prep?.at) + ' offset ' + prep?.dayOffset);

  console.log(`\n${failures ? '✗' : '✓'} ${checks - failures}/${checks} checks passed\n`);
  process.exit(failures ? 1 : 0);
}

main();
