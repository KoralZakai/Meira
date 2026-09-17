/**
 * run-conference-day — the reported day, end to end.
 *
 * "כנס האקריות באוניברסיטת תל אביב" runs 09:00–22:00. "from prompt to ai"
 * runs 18:00–21:00. Three hours of overlap, and the only thing Lumi offered
 * was "keep one" — which quietly let the other go.
 *
 * But nobody gives up a conference OR a course over this. You leave the
 * conference early, cross town, and make both. That is the answer this test
 * pins down, together with the two things that have to be true the next
 * morning: the conference is at the HEAD of the day, and the phone rings.
 *
 * Run:  npx tsx tests/run-conference-day.ts
 */
import { resolveClashes } from '../src/utils/resolveClashes';
import { plannedAlarmTime, decideAlarmState } from '../src/utils/alarmPlan';
import { flagUnmetMode } from '../src/services/RoutePlanner';
import { sortTasksByPriorityAndTime as sortTasks } from '../src/utils/timeUtils';
import { Task } from '../src/types/index';

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

/** Her morning routine, the documented default: 45 min + 15 min buffer. */
const ROUTINE = 60;
/** She is normally up at 07:30. */
const USUAL_WAKE = '07:30';

const conference = {
  id: 'conf', text: 'כנס האקריות באוניברסיטת תל אביב', category: 'conference',
  priority: 'must', isFixed: true, fixedTime: '09:00', durationMinutes: 780,
  date: tomorrow, status: 'pending', createdAt: Date.now(), historicalDurations: [],
  location: {
    address: 'Tel Aviv University', lat: 32.113, lng: 34.804, confirmed: true,
    travelMinutes: 40, wakeUpBy: '07:00', leaveHomeBy: '08:20',
  },
} as unknown as Task;

const course = {
  id: 'course', text: 'from prompt to ai', category: 'course',
  priority: 'have_to', isFixed: true, fixedTime: '18:00', durationMinutes: 180,
  date: tomorrow, status: 'pending', createdAt: Date.now(), historicalDurations: [],
  location: {
    address: 'Yigal Alon 94', lat: 32.071, lng: 34.793, confirmed: true,
    travelMinutes: 25, leaveHomeBy: '17:35',
  },
} as unknown as Task;

function main() {
  console.log('\nThe conference day\n');

  console.log('1. The conference leads the day');
  const day = sortTasks([course, conference]);
  check('כנס האקריות is first', day[0].id === 'conf', day.map((t) => t.text).join(' → '));
  check('…because it is must-priority and leaves first',
    day[0].priority === 'must' && day[1].id === 'course');

  console.log('\n2. Both survive the collision');
  const clashes = resolveClashes([conference, course], '23:00');
  check('the three-hour overlap is seen', clashes.length === 1, `${clashes.length}`);
  const opts = clashes[0]?.options ?? [];
  check('"keep one, drop the other" is NOT the only way out',
    opts.some((o) => o.kind !== 'choose'), opts.map((o) => o.kind).join(' · '));
  const keepBoth = opts.find((o) => o.kind === 'end-earlier');
  check('leaving the conference early is offered', Boolean(keepBoth), keepBoth?.labelHe);
  check('it is the CONFERENCE that gets cut', keepBoth?.taskId === 'conf');
  check('cut to 17:35 — 18:00 less the 25 min across town',
    keepBoth?.newTime === '17:35', keepBoth?.newTime);
  check('the course keeps its 18:00 start',
    !opts.some((o) => o.kind === 'end-earlier' && o.taskId === 'course'));

  console.log('\n3. The phone rings in the morning');
  const at = plannedAlarmTime(conference, ROUTINE);
  check('a wake time exists', Boolean(at), at);
  check('it is the route\'s 07:00, not a guess', at === '07:00', at);
  check('the alarm is PLANNED, not skipped',
    decideAlarmState(conference, USUAL_WAKE, ROUTINE) === 'planned',
    decideAlarmState(conference, USUAL_WAKE, ROUTINE));
  check('…because 07:00 is earlier than her usual 07:30', at! < USUAL_WAKE);

  // Cutting the conference short must not disarm the morning.
  const trimmed = { ...conference, durationMinutes: 515 } as Task;   // 09:00 → 17:35
  check('shortening it does not cancel the alarm',
    decideAlarmState(trimmed, USUAL_WAKE, ROUTINE) === 'planned');
  check('and it still leads the day',
    sortTasks([course, trimmed])[0].id === 'conf');

  console.log('\n4. The vehicle she picked is the vehicle she is told about');
  // transit_mode is a PREFERENCE, not a filter: ask Google for rail on a
  // corridor it would rather serve by bus and it returns the bus, silently.
  // That is how a selected train chip ended up above "Bus 271".
  const leg = (type: string) => ({
    type, from: 'a', to: 'b', durationMinutes: 16,
    departureTime: '08:36', arrivalTime: '08:52',
  });
  const plan = (type: string) => ({
    totalDurationMinutes: 31, leaveHomeAt: '08:18', arriveAt: '08:53',
    firstBusDeparture: '08:36', firstBusStop: 'stop', walkToStopMinutes: 14,
    legs: [leg('walk'), leg(type)], source: 'google', fetchedAt: 0,
  }) as any;

  check('asked for train, got a bus → flagged',
    flagUnmetMode(plan('bus'), 'train').unavailableMode === 'train');
  check('asked for train, got a train → not flagged',
    flagUnmetMode(plan('train'), 'train').unavailableMode === undefined);
  check('a subway counts as rail',
    flagUnmetMode(plan('subway'), 'train').unavailableMode === undefined);
  check('asked for bus, got a train → flagged',
    flagUnmetMode(plan('train'), 'bus').unavailableMode === 'bus');
  check('asked for bus, got a bus → not flagged',
    flagUnmetMode(plan('bus'), 'bus').unavailableMode === undefined);

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
