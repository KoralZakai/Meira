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
  alarmMomentOf, isWithinAlarmReach, dayWakeOwner, earliestWakeOf, wakeAlarmsToArm, wakeAlarmWhy, alarmsNotYetSet, wakeAlarmKey,
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

  // ── A morning has ONE beginning ─────────────────────────────────────────
  //
  // Koral, 2026-09-22: "when adding a task before another task the clock alarm
  // should change to an earlier". decideAlarmState judges one task, and
  // markAlarmStates applied it to each task on its own — so a day with an
  // 08:00 class and a 10:00 appointment planned TWO alarms, 07:20 and 09:20,
  // and the phone rang twice. Adding something earlier than everything else
  // did not move the morning; it added another ring to it.
  console.log('\n5. One alarm per day, owned by whatever starts first');

  const day = '2099-03-04';
  const at8 = task({ id: 'class', fixedTime: '08:00', date: day });
  const at10 = task({ id: 'appt', fixedTime: '10:00', date: day });

  check('each task on its own still wants a wake-up',
    decideAlarmState(at8, undefined, ROUTINE) === 'planned'
    && decideAlarmState(at10, undefined, ROUTINE) === 'planned');
  const owner = dayWakeOwner([at8, at10], { routineMinutes: ROUTINE });
  check('but the day has one owner, and it is the earlier task',
    owner?.taskId === 'class', String(owner?.taskId));
  check('at the hour that task needs', owner?.at === '07:00', String(owner?.at));

  // THE ASK: something earlier arrives, and the morning moves.
  const at6 = task({ id: 'study', fixedTime: '06:30', date: day });
  const moved = dayWakeOwner([at8, at10, at6], { routineMinutes: ROUTINE });
  check('adding an earlier task moves the alarm to it',
    moved?.taskId === 'study' && moved?.at === '05:30', `${moved?.taskId} @ ${moved?.at}`);
  check('earliestWakeOf says the same thing in one value',
    earliestWakeOf([at8, at10, at6], { routineMinutes: ROUTINE }) === '05:30');

  // The superseded tasks draw NOTHING, not a 🔕 — she did not turn them off.
  const earliest = earliestWakeOf([at8, at10, at6], { routineMinutes: ROUTINE });
  check('the owner still draws its ⏰',
    wakeChipFor(at6, { routineMinutes: ROUTINE }, { dayEarliestWake: earliest })?.at === '05:30');
  check('a superseded task draws no chip at all',
    wakeChipFor(at10, { routineMinutes: ROUTINE }, { dayEarliestWake: earliest }) === null);
  check('and is not drawn as muted, which would read as "you turned this off"',
    wakeChipFor(at10, { routineMinutes: ROUTINE }, { dayEarliestWake: earliest })?.muted !== true);
  check('without the day in hand, nothing changes for existing callers',
    wakeChipFor(at10, { routineMinutes: ROUTINE })?.at === '09:00',
    String(wakeChipFor(at10, { routineMinutes: ROUTINE })?.at));

  // Days do not borrow each other's mornings.
  const otherDay = task({ id: 'far', fixedTime: '05:00', date: '2099-03-05' });
  check('a task on ANOTHER day cannot own this one',
    dayWakeOwner([at8, at10].filter((t) => t.date === day), { routineMinutes: ROUTINE })
      ?.taskId === 'class',
    'grouping is the caller\'s job, and it is done by date');
  check('...and that other day has its own owner',
    dayWakeOwner([otherDay], { routineMinutes: ROUTINE })?.taskId === 'far');

  // A completed or afternoon-only day raises no alarm at all.
  check('a done task does not own a morning',
    dayWakeOwner([{ ...at6, status: 'complete' } as Task, at8], { routineMinutes: ROUTINE })
      ?.taskId === 'class');
  check('an afternoon-only day has no owner',
    dayWakeOwner([task({ id: 'pm', fixedTime: '16:00', date: day })],
      { routineMinutes: ROUTINE }) === null);

  // Stable across syncs: two tasks needing the SAME hour must not swap owners,
  // or the alarm is re-armed every fifteen minutes.
  const twinA = task({ id: 'aaa', fixedTime: '08:00', date: day });
  const twinB = task({ id: 'bbb', fixedTime: '08:00', date: day });
  check('a tie is broken deterministically',
    dayWakeOwner([twinA, twinB], { routineMinutes: ROUTINE })?.taskId
    === dayWakeOwner([twinB, twinA], { routineMinutes: ROUTINE })?.taskId,
    'order in, same owner out');

  // 2026-09-28, the night before the Amazon phone interview: "I need an alarm
  // clock". The morning-study block said "up early" at 09:00 and her profile
  // has no routine length, so nothing was planned at all.
  const study = task({ id: 'prep-0d-amz', fixedTime: '09:00', date: day }) as Task & { prepForTaskId?: string };
  study.prepForTaskId = 'amz';
  check('the interview-morning block wakes her with no routine on file',
    plannedAlarmTime(study) === '08:30', String(plannedAlarmTime(study)));
  check('...and owns that morning over the later interview',
    dayWakeOwner([study, task({ id: 'amz', fixedTime: '11:00', date: day })], { usualWakeTime: '09:00' })
      ?.taskId === 'prep-0d-amz');
  check('any other task still gets no guessed alarm',
    plannedAlarmTime(task({ id: 'plain', fixedTime: '09:00', date: day })) === undefined);

  // 3.10 — "I added a task for tomorrow at 8:40, why no alarm?" Picked from a
  // free window, so it carries scheduledTime and no fixedTime.
  const picked = task({ id: 'picked', isFixed: false, fixedTime: undefined, scheduledTime: '08:40' });
  check('a picked hour (scheduledTime only) wakes her a routine before it',
    plannedAlarmTime(picked, 35) === '08:05', String(plannedAlarmTime(picked, 35)));
  check('...and owns the morning over the afternoon interview trip',
    dayWakeOwner([picked, task({ id: 'ceva', fixedTime: '15:30',
      location: { address: 'Ra\'anana', lat: 32.18, lng: 34.87, confirmed: true, wakeUpBy: '13:34' } })],
    { routineMinutes: 35 })?.taskId === 'picked');

  // 20.10 — "I added 'שיחה עם דותן ב9 וחצי', the ⏰ was on the card and I had
  // to set it by hand." A just-saved task has no alarmState; the save must arm it.
  {
    const dotan = task({ id: 'dotan', text: 'שיחה עם דותן', fixedTime: '09:30', category: 'call' } as Partial<Task>);
    const later = task({ id: 'gym', text: 'אימון', fixedTime: '20:00' } as Partial<Task>);
    const fresh = { ...dotan, alarmState: undefined } as Task;
    const arm = wakeAlarmsToArm([fresh, later], [tomorrow], { routineMinutes: 45 });
    check('a just-saved morning task is the one to arm, planned',
      arm.length === 1 && arm[0].id === 'dotan' && arm[0].alarmState === 'planned',
      JSON.stringify(arm.map((t) => [t.id, t.alarmState])));
    check('...at its start less her routine', plannedAlarmTime(arm[0], 45) === '08:45',
      String(plannedAlarmTime(arm[0], 45)));
    check('an alarm she turned off stays off',
      wakeAlarmsToArm([{ ...dotan, alarmState: 'not_needed' } as Task], [tomorrow], { routineMinutes: 45 }).length === 0);
    check('an armed one is not set twice',
      wakeAlarmsToArm([{ ...dotan, alarmState: 'armed' } as Task], [tomorrow], { routineMinutes: 45 }).length === 0);
    const he = wakeAlarmWhy(arm[0], '08:45', 45, 'he');
    check('it says when and why, in Hebrew', he.title.includes('08:45') && he.body.includes('45 דק׳ להתארגנות'), he.body);
    const en = wakeAlarmWhy({ ...arm[0], alarmAt: '08:00' } as Task, '08:00', 45, 'en');
    check('...and an asked-for hour says so, in English', en.body.includes('as you asked'), en.body);
    // 20.10 on her phone: alarmState is lost on the cloud read, so every save
    // re-armed the same alarm and announced it again, every ~4 s.
    const lostState = { ...arm[0], alarmState: undefined } as Task;
    const again = wakeAlarmsToArm([lostState], [tomorrow], { routineMinutes: 45 });
    check('an alarm already in Clock is not set again even when its state was lost',
      alarmsNotYetSet(again, new Set([wakeAlarmKey(tomorrow, '08:45')]), 45).length === 0);
    check('...but a NEW hour that morning is', alarmsNotYetSet(again, new Set([wakeAlarmKey(tomorrow, '08:00')]), 45).length === 1);
    check('a day outside the window is not touched',
      wakeAlarmsToArm([fresh], ['2099-01-01'], { routineMinutes: 45 }).length === 0);
  }

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} checks passed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
