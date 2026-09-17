/**
 * run-future-task — book an interview 12 days out, and prove the whole plan
 * survives, alerts on the right days, and the alarm actually gets armed.
 *
 * The scenario the user asked to see: it is 19.8, the interview is on 31.8.
 * By the evening of 30.8 they want one message that already contains the whole
 * morning — "tomorrow, interview at X, alarm at Y, leave at Z, because W" — and
 * the physical alarm set, even though on 19.8 Android could not accept it
 * (ACTION_SET_ALARM has no date and refuses anything past 24 h).
 *
 * Exercises the real modules: utils/alertPlan (alert times + wording),
 * utils/leadTime (how early), services/AlarmPlanner (the alarm state machine).
 * Offline and deterministic — travel time comes from the fixture.
 *
 * Run:  npx tsx tests/run-future-task.ts
 */
import { planTransitAlerts, planFixedTimeAlerts, PlannedAlert } from '../src/utils/alertPlan';
import { calculateWakeTime, timeToMinutes, minutesToTime } from '../src/utils/timeUtils';
import {
  decideAlarmState, alarmMomentOf, isWithinAlarmReach, plannedAlarmTime,
} from '../src/utils/alarmPlan';
import { Task, TransitPlan, UserProfile } from '../src/types/index';

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// ── the situation ────────────────────────────────────────────────────────────
const DAYS_OUT = 12;                       // "today is 19.8, interview is 31.8"
const START = '10:00';
// Long enough to force her up EARLIER than she normally rises (07:30) — that is
// what makes it a real wake-from-sleep alarm rather than a get-ready nudge, and
// it is the case the alarm state machine exists for.
const TRAVEL_MINUTES = 105;
const EARLY_ARRIVAL = 30;                  // interviews aim to be there 30 min early

const today = new Date();
const interviewDate = new Date(today);
interviewDate.setDate(interviewDate.getDate() + DAYS_OUT);
const DATE = iso(interviewDate);

const profile = {
  name: 'Koral', language: 'he', theme: 'light', transportType: 'bus',
  morningRoutineMinutes: 45, wakeBufferMinutes: 15,
  homeAddress: 'רמת גן', homeLat: 32.08, homeLng: 34.81,
  defaultWakeTime: '07:30', sleepTime: '23:30',
  googleConnected: true, createdAt: Date.now(),
} as UserProfile;

const arriveBy = minutesToTime(timeToMinutes(START) - EARLY_ARRIVAL);
const { wakeBy, leaveHomeBy } = calculateWakeTime(
  arriveBy, TRAVEL_MINUTES, profile.morningRoutineMinutes, profile.wakeBufferMinutes,
);

const plan: TransitPlan = {
  totalDurationMinutes: TRAVEL_MINUTES,
  leaveHomeAt: leaveHomeBy,
  arriveAt: arriveBy,
  firstBusDeparture: minutesToTime(timeToMinutes(leaveHomeBy) + 7),
  firstBusStop: 'ארלוזורוב',
  walkToStopMinutes: 7,
  legs: [
    { type: 'walk', from: 'בית', to: 'ארלוזורוב', durationMinutes: 7,
      departureTime: leaveHomeBy, arrivalTime: minutesToTime(timeToMinutes(leaveHomeBy) + 7) },
    { type: 'bus', from: 'ארלוזורוב', to: 'מגדלי אמזון', durationMinutes: TRAVEL_MINUTES - 7,
      departureTime: minutesToTime(timeToMinutes(leaveHomeBy) + 7), arrivalTime: arriveBy,
      lineNumber: 'קו 251' },
  ],
  source: 'google',
  fetchedAt: Date.now(),
};

const task: Task = {
  id: 'interview-31-8',
  text: 'ראיון עבודה',
  category: 'interview',
  priority: 'must',
  isFixed: true,
  fixedTime: START,
  durationMinutes: 60,
  date: DATE,
  status: 'pending',
  createdAt: Date.now(),
  historicalDurations: [],
  location: {
    address: 'מגדלי אמזון, תל אביב', displayName: 'מגדלי אמזון',
    lat: 32.07, lng: 34.79,
    travelMinutes: TRAVEL_MINUTES, wakeUpBy: wakeBy, leaveHomeBy: plan.leaveHomeAt,
    confirmed: true, transitPlan: plan,
  },
};

// ── report ───────────────────────────────────────────────────────────────────
const failures: string[] = [];
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${label}${ok || !detail ? '' : `\n     ${detail}`}`);
  if (!ok) failures.push(label);
};

const absMs = (a: PlannedAlert) => {
  const [y, mo, d] = DATE.split('-').map(Number);
  const [h, m] = a.at.split(':').map(Number);
  return new Date(y, mo - 1, d + (a.dayOffset ?? 0), h, m).getTime();
};
const stamp = (a: PlannedAlert) => `${iso(new Date(absMs(a)))} ${a.at}`;

console.log(`\nBooked today (${iso(today)}) — interview on ${DATE}, ${DAYS_OUT} days out\n`);
console.log('─'.repeat(74));
console.log(`  ראיון עבודה · ${START} · מגדלי אמזון`);
console.log(`  travel ${TRAVEL_MINUTES}m · aiming to arrive ${EARLY_ARRIVAL}m early (${arriveBy})`);
console.log(`  ⏰ ${wakeBy}  →  🚪 ${plan.leaveHomeAt}  →  📍 ${arriveBy}  →  starts ${START}`);
console.log('─'.repeat(74));

const alerts = [
  ...planFixedTimeAlerts(task, 'he', plan.leaveHomeAt),
  ...planTransitAlerts(task, plan, 'he', profile.defaultWakeTime),
].sort((a, b) => absMs(a) - absMs(b));

console.log('\nAlerts that will fire:\n');
for (const a of alerts) console.log(`  ${stamp(a).padEnd(18)} ${a.kind.padEnd(14)} ${a.title}`);

// ── what must hold ───────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(74) + '\n');

check(alerts.length > 0, 'the far-future task produces alerts at all');

// 1. The day-before briefing exists, lands the evening before, and CONTAINS THE PLAN.
const dayBefore = alerts.find((a) => a.kind === 'day_before');
check(!!dayBefore, 'a day-before briefing is scheduled');
if (dayBefore) {
  const evening = new Date(absMs(dayBefore));
  const expected = new Date(interviewDate); expected.setDate(expected.getDate() - 1);
  check(iso(evening) === iso(expected), 'day-before lands the evening BEFORE the interview',
    `got ${iso(evening)}, expected ${iso(expected)}`);
  console.log(`\n     "${dayBefore.title}"`);
  console.log(`     "${dayBefore.body}"\n`);
  check(dayBefore.body.includes(wakeBy), 'briefing names the WAKE time', dayBefore.body);
  check(dayBefore.body.includes(plan.leaveHomeAt), 'briefing names the LEAVE time', dayBefore.body);
  check(/כי|because/.test(dayBefore.body), 'briefing explains WHY that leave time', dayBefore.body);
  check(dayBefore.body.includes('251'), 'briefing names the actual line', dayBefore.body);
}

// 2. The morning alerts land on the interview day itself.
const wake = alerts.find((a) => a.kind === 'wake_up');
check(!!wake, `a wake-from-sleep alarm is planned (${wakeBy} is before her usual ${profile.defaultWakeTime})`);
if (wake) check(iso(new Date(absMs(wake))) === DATE, 'wake alert is on the interview day');
const leave = alerts.find((a) => a.kind === 'leave_home');
check(!!leave && iso(new Date(absMs(leave))) === DATE, 'leave-home alert is on the interview day');

// 3. Every alert is before the interview starts.
const startAbs = (() => {
  const [y, mo, d] = DATE.split('-').map(Number);
  const [h, m] = START.split(':').map(Number);
  return new Date(y, mo - 1, d, h, m).getTime();
})();
check(alerts.every((a) => absMs(a) < startAbs), 'no alert fires after the interview starts');

// 4. THE ALARM STATE MACHINE — the heart of this scenario.
console.log('');
const state = decideAlarmState(task, profile.defaultWakeTime);
check(state === 'planned', `alarm state is 'planned' while 12 days out (got '${state}')`);
check(plannedAlarmTime(task) === wakeBy, 'the planned alarm time is the computed wake time');
check(!isWithinAlarmReach(task), 'NOT armable yet — Android would ring it on the wrong day');

// …and once the morning comes within 24 h, it becomes armable.
const soon: Task = { ...task, date: iso(new Date(Date.now() + 20 * 60 * 60 * 1000)) };
const soonMoment = alarmMomentOf(soon);
check(!!soonMoment, 'alarm moment resolves for a task inside 24 h');
check(isWithinAlarmReach(soon), 'becomes armable once inside 24 h → the evening reminder arms it');

// 5. An afternoon task must never claim an alarm.
const afternoon: Task = {
  ...task, id: 'gym', text: 'אימון', category: 'gym', fixedTime: '19:00',
  location: { ...(task.location as any), wakeUpBy: '17:30' },
};
check(decideAlarmState(afternoon, profile.defaultWakeTime) === 'not_needed',
  "a 19:00 task is 'not_needed' — no wake alarm for something you're awake for");

// A MORNING task now DOES raise one, whether or not it forces an early rise.
// Koral, 2026-09-17: "a clock alarm must be every day according the schedule!
// in the AM hours." The afternoon check above is the half that is unchanged.
const easyMorning: Task = {
  ...task, id: 'easy', location: { ...(task.location as any), wakeUpBy: '08:15' },
};
check(decideAlarmState(easyMorning, profile.defaultWakeTime) === 'planned',
  "waking at 08:15 is 'planned' — a morning commitment rings, per her rule");

console.log('\n' + '─'.repeat(74));
console.log(failures.length === 0
  ? '✅ far-future task: plan saved, briefed the night before, alarm armed in time'
  : `❌ ${failures.length} failure(s): ${failures.join(' | ')}`);
console.log('─'.repeat(74));
process.exit(failures.length ? 1 : 0);
