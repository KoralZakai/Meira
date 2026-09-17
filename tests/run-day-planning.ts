/**
 * run-day-planning — assert-based check for utils/dayPlanning:
 * day conflict detection (overlap / not enough travel time) and the
 * email-vs-calendar match that stops Lumi asking "are you going?" about an
 * appointment the user already has scheduled.
 *
 * Run: npx tsx tests/run-day-planning.ts
 */
import assert from 'node:assert';
import { dayWarnings, sortTimed, alreadyScheduled } from '../src/utils/dayPlanning';
import { Task } from '../src/types/index';

const task = (over: Partial<Task>): Task => ({
  id: Math.random().toString(36).slice(2),
  text: 'task',
  date: '2026-08-06',
  status: 'pending',
  durationMinutes: 60,
  createdAt: 0,
  historicalDurations: [],
  ...over,
} as Task);

const at = (time: string, text: string, over: Partial<Task> = {}) =>
  task({ fixedTime: time, text, ...over });

// ── overlap ──────────────────────────────────────────────────────────────────
const overlapping = sortTimed([
  at('10:00', 'Interview', { durationMinutes: 90 }),
  at('11:00', 'Dentist'),
]);
assert.strictEqual(overlapping.length, 2);
assert.strictEqual(overlapping[0].text, 'Interview', 'sorted by clock');
const overlapWarn = dayWarnings(overlapping, false);
assert.strictEqual(overlapWarn.length, 1);
assert.ok(overlapWarn[0].includes('Overlap'), overlapWarn[0]);

// ── travel doesn't fit in the gap ────────────────────────────────────────────
const tight = sortTimed([
  at('09:00', 'Work', { durationMinutes: 60 }),
  at('10:15', 'Gym', {
    location: { address: 'Space Gym', lat: 0, lng: 0, confirmed: true, travelMinutes: 45 },
  }),
]);
const tightWarn = dayWarnings(tight, false);
assert.strictEqual(tightWarn.length, 1, 'a 15-min gap cannot absorb a 45-min ride');
assert.ok(tightWarn[0].includes('Too tight'), tightWarn[0]);

// Same pair with enough room → silent.
const roomy = sortTimed([
  at('09:00', 'Work', { durationMinutes: 60 }),
  at('11:00', 'Gym', {
    location: { address: 'Space Gym', lat: 0, lng: 0, confirmed: true, travelMinutes: 45 },
  }),
]);
assert.deepStrictEqual(dayWarnings(roomy, false), [], 'a 60-min gap fits a 45-min ride');

// Hebrew wording is produced, not the English one.
assert.ok(dayWarnings(tight, true)[0].includes('קצר'), 'hebrew warning');

// ── email vs calendar ────────────────────────────────────────────────────────
const calendar = [
  at('14:00', 'Dentist Dr. Cohen', { date: '2026-08-07' }),
  at('09:00', 'Standup', { date: '2026-08-06' }),
];

assert.ok(
  alreadyScheduled(calendar, { title: 'Appointment confirmation', date: '2026-08-07', time: '14:15' }),
  'same day, 15 min apart → already scheduled');
assert.ok(
  alreadyScheduled(calendar, { title: 'Your dentist appointment with Dr. Cohen', date: '2026-08-07' }),
  'no time, but the title matches the calendar entry');
assert.ok(
  !alreadyScheduled(calendar, { title: 'Job interview at Nvidia', date: '2026-08-07', time: '09:00' }),
  'different appointment, same week → still worth asking about');
assert.ok(
  !alreadyScheduled(calendar, { title: 'Dentist Dr. Cohen', date: '2026-08-09' }),
  'right title, wrong day → not the same event');

console.log('✅ day planning: conflicts flagged, calendar duplicates filtered');

// ── travel chain (the expandable road plan on each task row) ─────────────────
import { buildWayThere, buildWayHome, toChainProfile } from '../src/utils/buildTravelChain';
import { TransitPlan, UserProfile } from '../src/types/index';

const chainProfile = toChainProfile({
  name: 'x', transportMode: 'transit', totalMorningRoutineMinutes: 40,
}) as UserProfile;
assert.strictEqual(chainProfile.transportType, 'bus', 'transit → bus');
assert.strictEqual(chainProfile.morningRoutineMinutes, 40, 'stored routine minutes are read');
assert.strictEqual(chainProfile.wakeBufferMinutes, 15, 'buffer defaults when not stored');

const plan: TransitPlan = {
  totalDurationMinutes: 45,
  leaveHomeAt: '07:55', arriveAt: '08:45',
  firstBusDeparture: '08:06', firstBusStop: 'Arlozerov', walkToStopMinutes: 6,
  legs: [
    { type: 'walk', from: 'Home', to: 'Arlozerov', durationMinutes: 6, departureTime: '08:00', arrivalTime: '08:06' },
    { type: 'bus', from: 'Arlozerov', to: 'Central', durationMinutes: 15, departureTime: '08:06', arrivalTime: '08:21', lineNumber: '251' },
    { type: 'bus', from: 'Central', to: 'Igal Alon', durationMinutes: 17, departureTime: '08:25', arrivalTime: '08:42', lineNumber: '18' },
  ],
  source: 'google', fetchedAt: Date.now(),
};

const away = task({
  text: 'Interview', fixedTime: '09:00',
  location: { address: 'Igal Alon 94', lat: 0, lng: 0, confirmed: true, transitPlan: plan, travelMinutes: 45 },
});

const there = buildWayThere(away, 'bus', chainProfile, true);
// wake + get ready + leave + 3 legs + arrive = 7
assert.strictEqual(there.length, 7, 'first-of-day chain has wake and get-ready rows');
assert.strictEqual(there[0].icon, '⏰');
assert.strictEqual(there[2].time, '07:55', 'leave row uses the plan, not an estimate');
assert.deepStrictEqual(
  there.slice(3, 6).map((s) => s.time), ['08:00', '08:06', '08:25'],
  'every real leg is a row, at its own departure time');
assert.ok(there[there.length - 1].labelEn.includes('Arrive'), 'chain ends at arrival');

const later = buildWayThere(away, 'bus', chainProfile, false);
// A later trip loses the WAKE row and the morning routine — "⏰ Wake up!" at
// 16:40 for the gym is nonsense, and 45 minutes of showering before a bike
// ride is nonsense large enough to teach her to ignore the row.
//
// It does NOT lose getting ready altogether. Koral, 2026-09-17, about a 19:00
// yoga class: "a time to get ready will appear, travel time by bike will
// appear". There was a leave row with nothing before it, so the chain read as
// though she teleported from her desk onto the bike. A later trip now carries
// ONE short outing-prep row instead of the two morning ones.
assert.strictEqual(later.length, there.length - 1,
  'later trips swap the two morning rows for one short get-ready row');
assert.ok(!later.some((s) => s.icon === '⏰'),
  'a later trip must NEVER carry a wake alarm row');
assert.ok(!later.some((s) => s.noteEn?.includes('routine')),
  'and never the morning routine length');
assert.strictEqual(later[0].icon, '🧭', 'it opens with getting ready to go');
assert.ok(timeToMinutesLocal(later[1].time) - timeToMinutesLocal(later[0].time) <= 15,
  'getting ready to go out is minutes, not the best part of an hour');

// Times never go backwards.
const mins = there.map((s) => timeToMinutesLocal(s.time));
for (let i = 1; i < mins.length; i++) {
  assert.ok(mins[i] >= mins[i - 1], `chain step ${i} goes back in time`);
}
function timeToMinutesLocal(hhmm: string) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// Way home: an at-home task right after an away one.
const atHome = task({ text: 'Zoom', fixedTime: '11:00', category: 'zoom' });
const home = buildWayHome(atHome, away, 'bus', chainProfile);
assert.ok(home.length >= 4, 'way-home chain built');
assert.ok(home[0].labelEn.includes('Interview'), 'starts when the previous task ends');
assert.strictEqual(home[home.length - 1].time, '11:00', 'ends when the at-home task starts');

console.log('✅ travel chain: real legs kept, wake rows only for the first trip, way-home chained');
