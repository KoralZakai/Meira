/**
 * run-wake-request — "תעירי אותי ב-7" has to end in a ringing phone.
 *
 * The reported failure: an interview planned for tomorrow, a train picked, and
 * the request "תעירי אותי מוקדם ב 7 בבוקר שאקום ללמוד" — and no alarm. Two
 * causes, both pinned here:
 *
 *   1. Task.alarmAt is the FIRST thing the alarm planner looks at, and nothing
 *      in the app or on the server had ever written it. The hour she asked for
 *      was thrown away at the door.
 *   2. Even with an hour, decideAlarmState ran it past needsWakeAlarm, which
 *      deliberately stays quiet when the wake time is later than the hour she
 *      usually gets up. A 07:00 request from someone who usually rises at 06:45
 *      was answered with silence — correct for a route-derived time, wrong for
 *      one she typed herself.
 *
 * Since then the route-derived half changed too: DEFAULT_WAKE_ALARM_POLICY is
 * 'every-morning', so a morning wake time rings whether or not it beats her
 * usual hour. `alarmAt` still short-circuits ahead of it, which is what (2)
 * above is about, and that distinction is still the point of this file.
 *
 * Run: npx tsx tests/run-wake-request.ts
 */
import assert from 'node:assert';
import { parseWakeRequest } from '../src/utils/wakeRequest';
import { decideAlarmState, plannedAlarmTime, isWithinAlarmReach } from '../src/utils/alarmPlan';
import { Task } from '../src/types/index';

const task = (over: Partial<Task>): Task => ({
  id: 'x', text: 'ראיון עבודה ב-uVision', category: 'interview', priority: 'must',
  isFixed: true, fixedTime: '13:00', durationMinutes: 90, date: '2026-09-01',
  status: 'pending', createdAt: 0, historicalDurations: [],
  ...over,
} as Task);

let checks = 0;
const check = (label: string, fn: () => void) => {
  checks += 1;
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (err: any) {
    console.log(`  ✗ ${label}\n      ${err.message}`);
    process.exitCode = 1;
  }
};

console.log('\nWake requests\n');

console.log('1. Reading the ask');
check('the reported sentence, verbatim', () => {
  assert.equal(parseWakeRequest('תעירי אותי מוקדם ב 7 בבוקר שאקום ללמוד!!'), '07:00');
});
check('an exact hour', () => {
  assert.equal(parseWakeRequest('תעיר אותי בשעה 06:30'), '06:30');
});
check('English', () => {
  assert.equal(parseWakeRequest('wake me up at 6:30am'), '06:30');
  assert.equal(parseWakeRequest('wake me at 7'), '07:00');
});
check('the ASK wins over the appointment in the same sentence', () => {
  assert.equal(parseWakeRequest('wake me at 7, the interview is at 13:00'), '07:00');
  assert.equal(parseWakeRequest('תעירי אותי ב-7, הראיון ב-13:00'), '07:00');
});
check('an evening hour is not turned into a morning one', () => {
  assert.equal(parseWakeRequest('wake me at 7 tonight'), '19:00');
});
check('a sentence that is not asking to be woken', () => {
  assert.equal(parseWakeRequest('ראיון עבודה ב-13:00'), null);
  assert.equal(parseWakeRequest('buy a new alarm clock'), null);
});

console.log('\n2. Turning it into an alarm');
check('an explicit hour is the one that rings', () => {
  assert.equal(plannedAlarmTime(task({ alarmAt: '07:00' })), '07:00');
});
check('…even when the route would have her up later', () => {
  const t = task({
    alarmAt: '07:00',
    location: { address: 'Kfar Vitkin', lat: 32.3, lng: 34.8, confirmed: true, wakeUpBy: '09:04' } as any,
  });
  assert.equal(plannedAlarmTime(t), '07:00', 'the request beats the route');
});
check('…and even when she is normally up before it (the silent morning)', () => {
  const t = task({ alarmAt: '07:00' });
  assert.equal(decideAlarmState(t, '06:45'), 'planned',
    'an hour she asked for is not weighed against her usual wake time');
});
// This check used to assert the opposite — that a 09:04 route wake with a
// 07:00 usual hour was 'not_needed', because she would be up anyway. That was
// the 'earlier-than-usual' policy, and it was deliberately retired: under
// DEFAULT_WAKE_ALARM_POLICY = 'every-morning' a morning commitment rings every
// morning, per her rule (alertPlan.needsWakeAlarm short-circuits before the
// usual-hour comparison). The old expectation outlived the change by a week
// because test:all never ran this file — see the note on the orphaned suites
// in package.json.
check('a morning route wake rings even when she is normally up earlier', () => {
  const t = task({
    location: { address: 'x', lat: 1, lng: 1, confirmed: true, wakeUpBy: '09:04' } as any,
  });
  assert.equal(decideAlarmState(t, '07:00'), 'planned',
    'every-morning: a 09:04 start is still a morning she is woken for');
});
// The "she is already up" path did NOT disappear with the policy — it moved to
// the clock. Past LATEST_WAKE_HOUR nobody is being woken up, whatever her
// usual hour is, and that is the half worth guarding.
check('an afternoon wake time is still nobody being woken', () => {
  const t = task({
    fixedTime: '19:00',
    location: { address: 'x', lat: 1, lng: 1, confirmed: true, wakeUpBy: '16:40' } as any,
  });
  assert.equal(decideAlarmState(t, '07:00'), 'not_needed', 'a 16:40 gym is not a wake-up');
});
check('no wake time at all needs no alarm', () => {
  assert.equal(decideAlarmState(task({ fixedTime: undefined })), 'not_needed');
});

console.log('\n3. The day before');
check("tomorrow morning's alarm is reachable today", () => {
  // 07:00 tomorrow, asked at 20:00 today — 11 hours out, inside the 24 h reach.
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const date = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;
  const t = task({ date, alarmAt: '07:00' });
  const evening = new Date();
  evening.setHours(20, 0, 0, 0);
  assert.equal(isWithinAlarmReach(t, evening.getTime()), true);
});
check('a week out is NOT reachable yet (it waits, planned)', () => {
  const far = new Date();
  far.setDate(far.getDate() + 7);
  const date = `${far.getFullYear()}-${String(far.getMonth() + 1).padStart(2, '0')}-${String(far.getDate()).padStart(2, '0')}`;
  assert.equal(isWithinAlarmReach(task({ date, alarmAt: '07:00' })), false);
});

console.log(`\n${checks} checks${process.exitCode ? ' — FAILURES' : ' — all good'}\n`);
