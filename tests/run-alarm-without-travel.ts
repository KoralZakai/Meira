/**
 * run-alarm-without-travel — a morning commitment rings the phone even when
 * there is no journey to it.
 *
 * Reported: "the alarm clock isn't getting on when there is a reminder in the
 * morning — it seems reasonable that alarm should be on but it didn't."
 *
 * The cause was upstream of the alarm code. plannedAlarmTime read exactly two
 * things: an `alarmAt` field that NOTHING in the app ever writes, and
 * `location.wakeUpBy` — which only exists once a route has been computed, and
 * only when `location` is an object. So:
 *
 *   - a 06:30 commitment at home (a call, a delivery) had no wake time at all;
 *   - a task whose location is still a bare address string hit the same wall,
 *     because a string has no wakeUpBy.
 *
 * In both cases decideAlarmState returned 'not_needed', AlarmPlanner skipped
 * the task, and the phone stayed silent. Only routed trips could ever ring.
 *
 * Run:  npx tsx tests/run-alarm-without-travel.ts
 */
import {
  plannedAlarmTime, decideAlarmState, wakeChipFor, wakeInputs, getReadyTimeFor,
  alarmMomentOf, isWithinAlarmReach,
} from '../src/utils/alarmPlan';
import { Task, UserProfile } from '../src/types/index';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const tomorrow = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return iso(d); })();

const task = (extra: Partial<Task> = {}): Task => ({
  id: 't1', text: 'שיחה עם רופא', category: 'call', priority: 'must',
  isFixed: true, fixedTime: '06:30', durationMinutes: 30, date: tomorrow,
  status: 'pending', createdAt: Date.now(), historicalDurations: [],
  ...extra,
} as Task);

// 45 min routine + 15 min buffer, the documented defaults.
const ROUTINE = 60;

function main() {
  console.log('\nAlarm without travel\n');

  // ── 1. the reported bug ─────────────────────────────────────────────────
  console.log('1. A morning commitment with no journey');
  check('used to have no wake time at all',
    plannedAlarmTime(task()) === undefined,
    'no alarmAt, no route — this is what stayed silent');
  check('now wakes her a routine before it',
    plannedAlarmTime(task(), ROUTINE) === '05:30',
    String(plannedAlarmTime(task(), ROUTINE)));
  check('...and is actually planned, not skipped',
    decideAlarmState(task(), '07:30', ROUTINE) === 'planned',
    decideAlarmState(task(), '07:30', ROUTINE));

  // ── 2. a bare string location is the WhatsApp case ──────────────────────
  console.log('\n2. A task whose location is still an address string');
  const stringLoc = task({ location: 'יגאל אלון 94' as any });
  check('a string carries no wake time',
    plannedAlarmTime(stringLoc) === undefined);
  check('the fallback still rings it',
    decideAlarmState(stringLoc, '07:30', ROUTINE) === 'planned');

  // ── 3. a real route still wins ──────────────────────────────────────────
  console.log('\n3. A computed route is still the better answer');
  const routed = task({
    fixedTime: '11:00',
    location: { address: 'יגאל אלון 94', lat: 0, lng: 0, confirmed: true, wakeUpBy: '05:55' } as any,
  });
  check('the route\'s own wake time is used, not the routine guess',
    plannedAlarmTime(routed, ROUTINE) === '05:55',
    String(plannedAlarmTime(routed, ROUTINE)));
  check('an explicit alarmAt outranks everything',
    plannedAlarmTime(task({ alarmAt: '04:15' } as any), ROUTINE) === '04:15');

  // ── 4. it must not start ringing for ordinary days ──────────────────────
  console.log('\n4. Nothing new rings that should not');
  check('a 14:00 task raises no alarm',
    decideAlarmState(task({ fixedTime: '14:00' }), '07:30', ROUTINE) === 'not_needed');
  // Reversed 2026-09-17 on Koral's instruction: "a clock alarm must be every
  // day according the schedule! in the AM hours." A 09:00 task needs her up at
  // 08:00, which is a morning hour, so it rings. The 14:00 check above is the
  // half that did NOT change, and it is what keeps this section honest — the
  // new rule is bounded by the morning window, not unbounded.
  check('a 09:00 task DOES ring — 08:00 is a morning hour',
    decideAlarmState(task({ fixedTime: '09:00' }), '07:30', ROUTINE) === 'planned',
    `wake would be ${plannedAlarmTime(task({ fixedTime: '09:00' }), ROUTINE)}`);
  check('a task with no time never rings',
    decideAlarmState(task({ fixedTime: undefined }), '07:30', ROUTINE) === 'not_needed');

  // ── 5. no routine means no invented alarm ───────────────────────────────
  console.log('\n5. An unknown routine is never guessed');
  // A wake time invented from a default routine is a real alarm at a wrong hour.
  check('without a routine length the fallback is skipped',
    plannedAlarmTime(task()) === undefined);
  check('a zero routine is treated as unknown, not as "wake at the task time"',
    plannedAlarmTime(task(), 0) === undefined);

  // ── 6. what the CARDS draw ──────────────────────────────────────────────
  // The alarm rang and the card stayed blank. plannedAlarmTime has three
  // sources; NextUpCard, TravelChainCard and TodaySchedule each hand-rolled
  // their own two-source copy (`alarmAt || location.wakeUpBy`), so the routine
  // fallback — the source that covers an un-routed task, i.e. most of tomorrow
  // — rang the phone and rendered nothing.
  console.log('\n6. The chip the cards draw agrees with the alarm that rings');
  const profile = {
    morningRoutineMinutes: 45, wakeBufferMinutes: 15, defaultWakeTime: '07:30',
  } as UserProfile;
  const inputs = wakeInputs(profile);

  check('wakeInputs adds the buffer to the routine, not just the routine',
    inputs.routineMinutes === 60, String(inputs.routineMinutes));

  // THE REPORTED BUG: tomorrow, no route computed yet, nothing to draw.
  check('an un-routed 06:30 task now draws a wake chip',
    wakeChipFor(task(), inputs)?.at === '05:30',
    JSON.stringify(wakeChipFor(task(), inputs)));
  check('...and the card would have shown nothing without a profile',
    wakeChipFor(task()) === null,
    'the exact hole: no routine → no fallback → blank card');

  // An explicit request must be visible, not only audible.
  check('"wake me at 7" is drawn even with no route at all',
    wakeChipFor(task({ alarmAt: '07:00' } as any), inputs)?.at === '07:00');

  // A bare address string is the WhatsApp case.
  check('a string location still draws a chip',
    wakeChipFor(task({ location: 'יגאל אלון 94' as any }), inputs)?.at === '05:30');

  // An armed alarm must never be drawn as absent.
  check('an armed alarm is drawn even if the rule would now say otherwise',
    wakeChipFor(task({ fixedTime: '14:00', alarmState: 'armed' } as any), inputs)?.at === '13:00');

  // Muted vs not-needed — one name, two facts.
  const muted = task({ alarmAt: '05:00', alarmState: 'not_needed' } as any);
  check('an alarm she turned OFF stays visible, muted',
    wakeChipFor(muted, inputs)?.muted === true,
    'hiding it removes the only control that turns it back on');
  check('a 14:00 task draws no chip at all',
    wakeChipFor(task({ fixedTime: '14:00' }), inputs) === null);
  check('...and is not mislabelled as a muted alarm',
    wakeChipFor(task({ fixedTime: '14:00', alarmState: 'not_needed' } as any), inputs) === null);

  // The wake/get-ready invariant survives: an afternoon route is never "wake up".
  const afternoon = task({
    fixedTime: '14:00',
    location: { address: 'x', lat: 0, lng: 0, confirmed: true, wakeUpBy: '13:00' } as any,
  });
  check('an afternoon route is a GET-READY time, never a wake alarm',
    wakeChipFor(afternoon, inputs) === null && getReadyTimeFor(afternoon, inputs) === '13:00',
    String(getReadyTimeFor(afternoon, inputs)));
  check('a real morning wake time is NOT downgraded to get-ready',
    getReadyTimeFor(task(), inputs) === undefined);

  // ── 2026-09-17: "check the alarm clock (today it didn't work)" ─────────
  //
  // The fix above was real and it was only half the journey. markAlarmStates
  // passes the routine length to decideAlarmState and correctly writes
  // 'planned'. AlarmPlanner.armDueAlarms then called
  //
  //     const when = alarmMomentOf(task);          // <- no routine
  //     ...
  //     const at = plannedAlarmTime(task, routineMinutes);   // <- routine
  //
  // — the same routine it had already computed, passed on the second line and
  // forgotten on the first. Without it, plannedAlarmTime falls through to its
  // third source and returns undefined, `when` is null, and the loop does
  // `continue`. So a task marked 'planned' BY THE ROUTINE FALLBACK could never
  // be armed: no crash, no log, no alarm. Exactly the tasks this file exists
  // for were the ones that stayed silent.
  console.log('\n  The routine fallback must survive into arming');
  const earlyStart = task({ fixedTime: '08:00', date: '2099-01-02' } as any);
  const routineOnly = wakeInputs({
    morningRoutineMinutes: 45, wakeBufferMinutes: 15, defaultWakeTime: '07:30',
  } as UserProfile);
  check('an 08:00 commitment with no route is PLANNED',
    decideAlarmState(earlyStart, routineOnly.usualWakeTime, routineOnly.routineMinutes) === 'planned');
  check('...and its wake moment exists when the routine is passed',
    alarmMomentOf(earlyStart, Date.parse('2099-01-01T12:00:00Z'), routineOnly.routineMinutes) !== null);
  check('...but is NULL without it — this is what dropped the alarm',
    alarmMomentOf(earlyStart, Date.parse('2099-01-01T12:00:00Z')) === null,
    'the argument AlarmPlanner forgot');
  check('reach is computed from the same routine, or it disagrees with itself',
    isWithinAlarmReach(earlyStart, Date.parse('2099-01-01T23:00:00Z'), routineOnly.routineMinutes) === true);
  check('a task with an explicit alarmAt never needed the routine anyway',
    alarmMomentOf(task({ alarmAt: '06:00', date: '2099-01-02' } as any),
      Date.parse('2099-01-01T12:00:00Z')) !== null);

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} checks passed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
