/**
 * run-task-requirements — "derive everything the task needs in order to happen".
 *
 * Koral's standing rule. Two parts of it are deterministic and she said so:
 * if there is a location, plan the journey; if it is a meeting or an interview,
 * study beforehand.
 *
 * The thing being tested is the QUESTION, not any one answer: before this,
 * nothing in the app could say whether a task was ready to be done. An
 * interview with a route and an interview without one looked identical to code
 * that never asked — which is why the same class of bug kept coming back.
 *
 * Run:  npx tsx tests/run-task-requirements.ts
 */
import {
  requirementsFor, missingRequirements, isReady, nextGap, describeGap,
} from '../src/utils/taskRequirements';
import type { Task, TaskLocation } from '../src/types/index';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

const TODAY = '2026-09-22';
const ctx = { today: TODAY };
const kinds = (t: Task, c = ctx) => requirementsFor(t, c).map((r) => r.kind);
const met = (t: Task, k: string, c = ctx) =>
  requirementsFor(t, c).find((r) => r.kind === k)?.met;

const ceva = {
  id: 'gcal-ceva', text: 'Your in-person interview with Ceva',
  date: '2026-09-23', category: 'interview', priority: 'must',
  status: 'pending', isFixed: true, fixedTime: '14:30', durationMinutes: 90,
  location: "7 HaPnina Street, Ra'anana" as any,
  attendees: ['koralzakai1@gmail.com'],
  createdAt: 0, historicalDurations: [],
} as unknown as Task;

console.log('\nThe interview, the night before\n');

check('it needs a route, because it has an address',
  kinds(ceva).includes('route'));
check('and the route is NOT met — this is what she was looking at',
  met(ceva, 'route') === false);
check('it needs a leave-home time, separately from the route',
  kinds(ceva).includes('prep_window'), 'the row that was missing on Wednesday');
check('it needs study before, because it is an interview',
  kinds(ceva).includes('study'));
check('it needs to know who it is with', kinds(ceva).includes('who'));
check('the hour is already there', met(ceva, 'time') === true);
check('the place is already there', met(ceva, 'place') === true);
check('so it is NOT ready', !isReady(ceva, ctx));

const gap = nextGap(ceva, ctx);
check('the one thing to fix first is the route', gap?.kind === 'route', gap?.kind);
check('and it says WHY the rule fired',
  /address/.test(gap?.because ?? ''), gap?.because);
check('it is something Lumi does itself, not a question for her',
  gap?.automatic === true);
check('and it has words in both languages',
  Boolean(describeGap(gap!, 'he')) && Boolean(describeGap(gap!, 'en')),
  describeGap(gap!, 'he'));

console.log('\nOnce everything is derived\n');

const ready: Task = {
  ...ceva,
  location: {
    address: "7 HaPnina Street, Ra'anana", lat: 32.18, lng: 34.87, confirmed: false,
    leaveHomeBy: '13:38', wakeUpBy: '12:43', travelMinutes: 52,
    transitPlan: {
      totalDurationMinutes: 52, leaveHomeAt: '13:38', arriveAt: '14:30',
      firstBusDeparture: '13:46', firstBusStop: 'Arlozorov', walkToStopMinutes: 8,
      legs: [], source: 'google', fetchedAt: 0,
    },
  } as TaskLocation,
  notificationIds: ['n1'],
};
const withPrep = { ...ready };
const store = [
  withPrep,
  { id: 'prep-2d-gcal-ceva' } as Task,
  { id: 'prep-1d-gcal-ceva' } as Task,
];
check('the route is met', met(ready, 'route', { today: TODAY }) === true);
check('the leave time is met', met(ready, 'prep_window', { today: TODAY }) === true);
check('the reminder is met', met(ready, 'reminder', { today: TODAY }) === true);
check('study counts as met once the blocks exist',
  met(withPrep, 'study', { today: TODAY, existing: store }) === true);
check('and THEN it is ready', isReady(withPrep, { today: TODAY, existing: store }));
check('with nothing left to fix',
  nextGap(withPrep, { today: TODAY, existing: store }) === null);

console.log('\nThe rules are rules, not guesses\n');

// If there is a location → plan a journey. Her words.
const gym = { ...ceva, id: 'g', category: 'gym', text: 'Gym',
  location: 'Space Gym' as any } as unknown as Task;
check('a gym with an address needs a route too', kinds(gym).includes('route'));
check('but no study — it is not an interview', !kinds(gym).includes('study'));

// A video call needs no address, and must never be asked for one.
const zoom = { ...ceva, id: 'z', category: 'zoom', text: 'Weekly sync',
  location: undefined, meetingUrl: 'https://zoom.us/j/9' } as unknown as Task;
check('a video call is not asked for a place', !kinds(zoom).includes('place'));
check('and gets no route — nowhere to travel to', !kinds(zoom).includes('route'));
check('but it still needs to know who it is with', kinds(zoom).includes('who'));

// An interview held over video is still prepared for.
const remoteInterview = { ...zoom, id: 'ri', category: 'interview',
  text: 'Interview with Ceva' } as unknown as Task;
check('a remote interview is still studied for',
  kinds(remoteInterview).includes('study'));
check('and still has no journey', !kinds(remoteInterview).includes('route'));

// A place with no hour can never be routed — say so rather than silently fail.
const noHour = { ...ceva, id: 'nh', fixedTime: undefined,
  scheduledTime: undefined } as unknown as Task;
check('a place with no hour reports the HOUR as the blocker, not the route',
  nextGap(noHour, ctx)?.kind === 'time', nextGap(noHour, ctx)?.kind);
check('and that one is hers to fix, not Lumi\'s',
  nextGap(noHour, ctx)?.automatic === false);

console.log('\nWhat needs nothing\n');
check('a completed task needs nothing',
  requirementsFor({ ...ceva, status: 'complete' } as Task, ctx).length === 0);
check('a task in the past needs nothing — a requirement on it is a reproach',
  requirementsFor({ ...ceva, date: '2026-09-17' } as Task, ctx).length === 0);

console.log(`\n${failures ? '❌' : '✅'} ${checks - failures}/${checks} checks passed\n`);
if (failures) process.exit(1);
