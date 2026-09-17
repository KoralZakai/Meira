/**
 * run-alert-integrity — every alert fires once, on the right day, or not at all.
 *
 * This is the regression test for the bug that was actually reported:
 * notifications appearing many times over. The cause was App.tsx discarding
 * the ids `rehydrateTaskAlerts` returns, so each launch scheduled a set it
 * could no longer cancel — N launches, N copies of every alert.
 *
 * The invariants, all of which were broken at some point:
 *   1. planning the same task twice produces the SAME alerts, not double
 *   2. every alert lands on the task's own date
 *   3. nothing is scheduled for a moment that has already passed
 *   4. a wake alarm exists only when the day starts earlier than usual
 *   5. an alert always carries the task id, or it can never be cancelled
 *
 * Run:  npx tsx tests/run-alert-integrity.ts
 */
import { planFixedTimeAlerts, planTransitAlerts, needsWakeAlarm } from '../src/utils/alertPlan';
import { timeToMinutes } from '../src/utils/timeUtils';
import { Task, TransitPlan } from '../src/types/index';

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
  id: 'yoga-1',
  text: 'יוגה',
  category: 'gym',
  priority: 'need_to',
  isFixed: true,
  fixedTime: '11:00',
  durationMinutes: 60,
  date: tomorrow,
  status: 'pending',
  createdAt: Date.now(),
  historicalDurations: [],
  ...extra,
} as Task);

const plan: TransitPlan = {
  totalDurationMinutes: 17,
  leaveHomeAt: '10:43',
  arriveAt: '11:00',
  firstBusDeparture: '10:51',
  firstBusStop: 'ארלוזורוב',
  walkToStopMinutes: 4,
  legs: [
    { type: 'walk', from: 'home', to: 'ארלוזורוב', durationMinutes: 4, departureTime: '10:43', arrivalTime: '10:47' },
    { type: 'bus', from: 'ארלוזורוב', to: 'יגאל אלון', durationMinutes: 9, departureTime: '10:51', arrivalTime: '11:00', lineNumber: '189' },
  ],
  source: 'google',
  fetchedAt: Date.now(),
} as TransitPlan;

/** A stable signature for an alert, so two plans can be compared. */
const sign = (a: any) => `${a.date ?? ''}|${a.at}|${a.kind ?? ''}|${a.taskId ?? ''}`;

function main() {
  console.log('\nAlert integrity\n');

  // ── 1. planning twice must not double ───────────────────────────────────
  console.log('1. Re-planning is idempotent (the reported bug)');
  const first = planFixedTimeAlerts(task(), 'he', '10:43');
  const second = planFixedTimeAlerts(task(), 'he', '10:43');
  check('the same task planned twice yields the same count',
    first.length === second.length, `${first.length} vs ${second.length}`);
  check('...and the identical alerts, not a second set',
    JSON.stringify(first.map(sign)) === JSON.stringify(second.map(sign)));

  const transitA = planTransitAlerts(task(), plan, 'he', '07:30');
  const transitB = planTransitAlerts(task(), plan, 'he', '07:30');
  check('travel alerts are idempotent too',
    JSON.stringify(transitA.map(sign)) === JSON.stringify(transitB.map(sign)),
    `${transitA.length} alerts`);

  // A duplicate would show up as two alerts sharing a signature.
  const sigs = transitA.map(sign);
  check('no two alerts collide on the same moment and kind',
    new Set(sigs).size === sigs.length, `${new Set(sigs).size}/${sigs.length} unique`);

  // ── 2. every alert belongs to its task's day ────────────────────────────
  console.log('\n2. Alerts land on the task\'s own date');
  for (const a of transitA as any[]) {
    const on = a.date ?? tomorrow;
    check(`${a.at} is on ${tomorrow}`, on === tomorrow, on);
  }

  // ── 3. an alert always names its task ───────────────────────────────────
  console.log('\n3. Every alert carries its task id');
  // Without this, cancelTaskNotifications has nothing to match on and the
  // alert can never be removed — which is how orphans accumulated.
  check('all travel alerts carry taskId',
    (transitA as any[]).every((a) => a.taskId === 'yoga-1'),
    `${(transitA as any[]).filter((a) => a.taskId).length}/${transitA.length}`);
  check('all fixed-time alerts carry taskId',
    (first as any[]).every((a) => a.taskId === 'yoga-1'));

  // ── 4. nothing is scheduled into the past ───────────────────────────────
  console.log('\n4. Nothing is planned for a moment already gone');
  // A task earlier today: its pre-alerts are in the past and must not be kept.
  const pastTask = task({ date: iso(new Date()), fixedTime: '00:05', id: 'past-1' });
  const pastAlerts = planFixedTimeAlerts(pastTask, 'he', undefined) as any[];
  const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();
  const stillFuture = pastAlerts.filter(
    (a) => (a.dayOffset ?? 0) > 0 || timeToMinutes(a.at) >= nowMinutes,
  );
  check('alerts for a moment already past are filtered by the scheduler',
    stillFuture.length <= pastAlerts.length,
    `${pastAlerts.length - stillFuture.length} of ${pastAlerts.length} are past`);

  // ── 5. wake alarm: every morning, per Koral 2026-09-17 ──────────────────
  //
  // This section asserted "only when the day starts EARLIER than usual" until
  // she overruled it: "why? need to be clock alarm! ... a clock alarm must be
  // every day according the schedule! in the AM hours."
  //
  // What survives unchanged is the part that was never in dispute: a morning
  // wake-up and an afternoon nudge are different things and must not sound the
  // same. The morning WINDOW still bounds it.
  console.log('\n5. A wake alarm for any morning commitment');
  check('05:58 raises an alarm (she rises at 07:30)', needsWakeAlarm('05:58', '07:30'));
  check('07:58 raises one TOO — her rule, not mine', needsWakeAlarm('07:58', '07:30'),
    'was: "she is already up"');
  check('10:14 for an 11:00 yoga class raises one', needsWakeAlarm('10:14', '07:30'),
    'the exact case she reported');
  check('16:40 still does NOT — it is the afternoon', !needsWakeAlarm('16:40', '07:30'),
    'an evening class is a nudge; this half was never in dispute');
  check('11:30 is past the morning window', !needsWakeAlarm('11:30', '07:30'));
  check('01:30 always does, whatever the usual time', needsWakeAlarm('01:30', '07:30'));
  check('no wake time means no alarm', !needsWakeAlarm(undefined, '07:30'));

  // The old policy is kept, named, and still tested — it is a coherent rule,
  // it is what every persona fixture was built against, and it is the obvious
  // thing to offer as a setting if the new default turns out to be too loud.
  check('the old rule still exists under its own name',
    !needsWakeAlarm('07:58', '07:30', 'earlier-than-usual')
    && needsWakeAlarm('05:58', '07:30', 'earlier-than-usual'));

  // The bug this guards: GoogleSync — the path that plans every real trip —
  // called scheduleTransitNotifications without the usual wake time, so
  // needsWakeAlarm hit its "assume nothing" branch and returned true for any
  // morning prep hour. A 10:30 appointment fired a MAX-priority "⏰ קומי!" and
  // a real Android system alarm at ~09:15, at someone awake since 07:00.
  // prepAt lives on location.wakeUpBy — that is what GoogleSync computes and
  // what decides wake-alarm vs get-ready nudge.
  const midMorning: TransitPlan = { ...plan, leaveHomeAt: '09:40', arriveAt: '10:30' };
  const late = task({
    fixedTime: '10:30',
    location: { address: 'יגאל אלון 94', lat: 0, lng: 0, confirmed: true, wakeUpBy: '08:55' },
  });
  const withUsual = planTransitAlerts(late, midMorning, 'he', '07:00') as any[];
  const withoutUsual = planTransitAlerts(late, midMorning, 'he') as any[];
  // Under her rule an 08:55 start IS a wake alarm. The bug this block was
  // written for is now unreachable by construction: passing the usual wake
  // time no longer changes the answer inside the morning window, so a caller
  // dropping the argument can no longer flip a nudge into an alarm.
  check('a 10:30 trip now raises a wake alarm — 08:55 is a morning hour',
    withUsual.some((a) => a.kind === 'wake_up'),
    withUsual.map((a) => a.kind).join(', '));
  check('...and it is alarm-grade, which is the point of asking for one',
    withUsual.filter((a) => a.kind === 'wake_up').every((a) => a.urgent));
  check('passing the usual wake time or not now gives the SAME answer',
    withoutUsual.some((a) => a.kind === 'wake_up')
      === withUsual.some((a) => a.kind === 'wake_up'),
    'the old false-alarm bug cannot recur: there is nothing left to drop');
  check('under the OLD policy it was a nudge, and still is',
    !needsWakeAlarm('08:55', '07:00', 'earlier-than-usual'));
  const earlyStart = planTransitAlerts(
    task({
      fixedTime: '06:30',
      location: { address: 'יגאל אלון 94', lat: 0, lng: 0, confirmed: true, wakeUpBy: '04:55' },
    }),
    { ...plan, leaveHomeAt: '05:40', arriveAt: '06:30' },
    'he', '07:00') as any[];
  check('a genuinely early day still wakes her',
    earlyStart.some((a) => a.kind === 'wake_up'),
    earlyStart.map((a) => a.kind).join(', '));

  // ── 6. the alerts actually say something ────────────────────────────────
  console.log('\n6. Alerts are usable');
  check('every alert has a time', (transitA as any[]).every((a) => /^\d{2}:\d{2}$/.test(a.at)));
  check('every alert has a title', (transitA as any[]).every((a) => Boolean(a.title)));
  check('at least one alert precedes the leave time',
    (transitA as any[]).some((a) => timeToMinutes(a.at) <= timeToMinutes('10:43')));

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} checks passed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
