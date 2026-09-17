/**
 * run-live-route — the next trip re-plans from where she actually is.
 *
 * Every route was planned from home or the previous planned stop; her real GPS
 * position was never an input. positionDrift.ts was written and tested to
 * decide WHEN that matters, and had zero consumers — LiveRoute is the consumer.
 *
 * This pins the pure parts (which trip, from which assumed origin) without a
 * device. The Google fetch and the notification are impure and live in the
 * service; the decision that drives them is here.
 *
 * Run:  npx tsx tests/run-live-route.ts
 */
import { nextTrip, missedPlannedDeparture } from '../src/utils/liveRoutePlan';
import { assessDrift } from '../src/utils/positionDrift';
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
const today = iso(new Date());

const task = (extra: Partial<Task> = {}): Task => ({
  id: 't', text: 'x', category: 'general', priority: 'need_to',
  isFixed: true, durationMinutes: 30, date: today, status: 'pending',
  createdAt: Date.now(), historicalDurations: [],
  ...extra,
} as Task);

const at9  = new Date(); at9.setHours(9, 0, 0, 0);

function main() {
  console.log('\nLive route\n');

  // ── 1. which trip ───────────────────────────────────────────────────────
  console.log('1. Picks the next pending, located, timed trip');
  const tasks = [
    task({ id: 'past', location: { address: 'A', lat: 1, lng: 1, confirmed: true } as any, fixedTime: '08:00' }),
    task({ id: 'gym',  location: { address: 'B', lat: 1, lng: 1, confirmed: true } as any, fixedTime: '11:00' }),
    task({ id: 'later',location: { address: 'C', lat: 1, lng: 1, confirmed: true } as any, fixedTime: '18:00' }),
    task({ id: 'notime', location: { address: 'D', lat: 1, lng: 1, confirmed: true } as any }),
    task({ id: 'noplace', fixedTime: '12:00' }),
  ];
  check('the soonest still-upcoming trip', nextTrip(tasks, at9)?.id === 'gym',
    nextTrip(tasks, at9)?.id);
  check('a past trip is never chosen',
    nextTrip([tasks[0]], at9) === undefined);
  check('a task with no address is skipped',
    nextTrip([task({ id: 'z', fixedTime: '10:00' })], at9) === undefined);
  check('a task with no time is skipped',
    nextTrip([task({ id: 'z', location: { address: 'A', lat: 1, lng: 1, confirmed: true } as any })], at9) === undefined);
  check('a completed trip is skipped',
    nextTrip([task({ id: 'z', status: 'complete', location: { address: 'A', lat: 1, lng: 1, confirmed: true } as any, fixedTime: '11:00' })], at9) === undefined);

  // ── 2. when to re-plan (the drift decision) ─────────────────────────────
  console.log('\n2. Re-plans only once she has actually moved');
  const home = { lat: 32.0853, lng: 34.7818 };       // assumed origin
  const acrossTown = { lat: 32.0684, lng: 34.7940 }; // ~2 km away
  const nextDoor = { lat: 32.0855, lng: 34.7820 };   // ~25 m

  check('a real move past the threshold re-plans',
    assessDrift(home, acrossTown).shouldReplan, `${assessDrift(home, acrossTown).metres} m`);
  check('staying put does not',
    !assessDrift(home, nextDoor).shouldReplan, `${assessDrift(home, nextDoor).metres} m`);
  check('no GPS fix leaves the existing plan alone',
    !assessDrift(home, null).shouldReplan, 'a guess would be worse than the current plan');
  check('a plan with no recorded origin re-plans from the real fix',
    assessDrift(null, acrossTown).shouldReplan, 'planning from a real position beats planning from nothing');

  // ── 3. missed departure while still at home ─────────────────────────────
  console.log('\n3. Still home past the leave time → recompute the next departure');
  const at = (h: number, m: number) => { const d = new Date(); d.setHours(h, m, 0, 0); return d; };
  check('17:19 is past a 17:18 leave time',
    missedPlannedDeparture('17:18', at(17, 19)), 'the 17:30 bus is gone');
  check('17:18 exactly is not yet missed (1 min grace)',
    !missedPlannedDeparture('17:18', at(17, 18)));
  check('17:10 — still in time, no re-plan',
    !missedPlannedDeparture('17:18', at(17, 10)));
  check('no leave time means nothing to miss',
    !missedPlannedDeparture(undefined, at(17, 19)));
  check('a garbage leave time is ignored',
    !missedPlannedDeparture('soon', at(17, 19)));
  check('a leave time 13 h "behind" is tomorrow, not missed',
    !missedPlannedDeparture('06:00', at(19, 0)), 'a 06:00 flight seen at 19:00 is not a missed departure');
  check('an hour past the leave time still counts as missed',
    missedPlannedDeparture('17:18', at(18, 18)));

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} checks passed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
