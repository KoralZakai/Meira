/**
 * run-alert-coverage — the phone alerts on its own, with the backend asleep.
 *
 * `min_machines_running = 0` means the Fly backend sleeps, so the server-side
 * WhatsApp/push reminder loop is not running. Everything must come from local
 * expo-notifications scheduled on the device. That only holds if the app agrees
 * on WHICH tasks need alerts — and every gate in the app used to ask
 * `if (task.fixedTime)`, which is one of four independent reasons.
 *
 * Run:  npx tsx tests/run-alert-coverage.ts
 */
import { taskNeedsAlerts, planTransitAlerts, planFixedTimeAlerts } from '../src/utils/alertPlan';
import { Task, TransitPlan } from '../src/types/index';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

const today = new Date().toISOString().slice(0, 10);
const task = (extra: Partial<Task> = {}): Task => ({
  id: 't', text: 'thing', category: 'general', priority: 'need_to', isFixed: false,
  durationMinutes: 30, date: today, status: 'pending',
  createdAt: Date.now(), historicalDurations: [],
  ...extra,
} as Task);

const plan: TransitPlan = {
  totalDurationMinutes: 42, leaveHomeAt: '08:05', arriveAt: '08:47',
  firstBusDeparture: '08:15', firstBusStop: 'ארלוזורוב', walkToStopMinutes: 8,
  legs: [
    { type: 'walk', from: 'home', to: 'ארלוזורוב', durationMinutes: 8, departureTime: '08:05', arrivalTime: '08:13' },
    { type: 'bus', from: 'ארלוזורוב', to: 'יגאל אלון', durationMinutes: 30, departureTime: '08:15', arrivalTime: '08:45', lineNumber: '251' },
  ],
  source: 'google', fetchedAt: Date.now(),
};

function main() {
  console.log('\nAlert coverage (backend asleep)\n');

  console.log('1. Every reason a task needs an alert');
  check('a fixed time', taskNeedsAlerts(task({ fixedTime: '16:00' })));
  check('a deadline, with no clock time',
    taskNeedsAlerts(task({ deadline: today })));
  check('an explicit alarm',
    taskNeedsAlerts(task({ alarmAt: '07:00' } as Partial<Task>)));
  check('a ROUTE, with no appointment hour — the one that was dropped',
    taskNeedsAlerts(task({
      location: { address: 'יגאל אלון 94', lat: 32, lng: 34, confirmed: true,
        leaveHomeBy: '08:05', wakeUpBy: '07:10', transitPlan: plan } as any,
    })));
  check('a bare errand needs nothing', !taskNeedsAlerts(task()));
  check('a location with no times needs nothing',
    !taskNeedsAlerts(task({
      location: { address: 'somewhere', lat: 32, lng: 34, confirmed: false } as any,
    })));
  check('the old gate really did drop the route-only trip',
    !task({ location: { leaveHomeBy: '08:05' } as any }).fixedTime);

  console.log('\n2. A route-only trip still gets its travel alerts');
  const routeOnly = task({
    location: { address: 'יגאל אלון 94', lat: 32, lng: 34, confirmed: true,
      leaveHomeBy: '08:05', wakeUpBy: '07:10', transitPlan: plan } as any,
  });
  const alerts = planTransitAlerts(routeOnly, plan, 'he', '09:00');
  const kinds = alerts.map((a) => a.kind);
  check('a get-up / get-ready alert', kinds.includes('wake_up') || kinds.includes('get_ready'), kinds.join(','));
  check('a leave-home alert', kinds.includes('leave_home'));
  check('two "still at home?" nags',
    kinds.filter((k) => k === 'leave_nag').length === 2);
  check('every alert carries the task id, so it can be cancelled',
    alerts.every((a) => a.taskId === routeOnly.id));
  check('the leave alert opens the LeaveNow screen',
    alerts.find((a) => a.kind === 'leave_home')?.screen === 'LeaveNow');
  check('leave + nags share the "I left ✓" category',
    alerts.filter((a) => a.category === 'leave-check').length === 3);
  check('no lead-time alerts invented without a fixed hour',
    planFixedTimeAlerts(routeOnly, 'he').length === 0);

  console.log('\n3. A fixed-time task keeps everything it had');
  const meeting = task({ fixedTime: '16:00', category: 'call', durationMinutes: 15 });
  check('lead alerts are still planned',
    planFixedTimeAlerts(meeting, 'he').length > 0,
    String(planFixedTimeAlerts(meeting, 'he').length));

  console.log(failures === 0
    ? `\n✅ ${checks}/${checks} checks passed\n`
    : `\n❌ ${failures} of ${checks} checks failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
