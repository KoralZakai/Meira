/**
 * run-day-ring — the 24-hour ring on Focus draws the day she actually has.
 *
 * Pins the geometry (00:00 at the top, clockwise), that a trip out gets its own
 * arc before the event, that an overlap is drawn BESIDE the event it overlaps
 * (inner lane) instead of on top of it, and that a task with no hour is not
 * drawn somewhere it is not.
 *
 * Run:  npx tsx tests/run-day-ring.ts
 */
import { arcPath, pointAt, ringArcs, RING, TRIP_COLOR } from '../src/utils/dayRing';
import type { Task } from '../src/types/index';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}
const close = (a: number, b: number) => Math.abs(a - b) < 0.2;

console.log('geometry');
const [tx, ty] = pointAt(0);
check('00:00 is at the top', close(tx, RING.c) && close(ty, RING.c - RING.r), `${tx},${ty}`);
const [rx, ry] = pointAt(360);
check('06:00 is on the right', close(rx, RING.c + RING.r) && close(ry, RING.c));
check('a short arc uses the small-arc flag', / 0 0 1 /.test(arcPath(600, 660)));
check('an arc over 12 hours uses the large-arc flag', / 0 1 1 /.test(arcPath(300, 1200)));
check('a zero-length arc draws nothing', arcPath(600, 600) === '');

const task = (o: Partial<Task>): Task => ({
  id: 'x', text: 'x', category: 'meeting', priority: 'must', isFixed: true, durationMinutes: 60,
  date: '2026-10-28', status: 'pending', createdAt: 0, historicalDurations: [], ...o,
} as Task);

console.log('the day on the ring (28.10)');
const day = [
  task({ id: 'cb', category: 'zoom', fixedTime: '10:30', durationMinutes: 15 }),
  task({ id: 'iv', category: 'interview', fixedTime: '16:00', durationMinutes: 60,
    location: { address: 'דיזנגוף 1, באר יעקב', lat: 31.9, lng: 34.8, confirmed: true, leaveHomeBy: '15:19' } }),
  task({ id: 'yosi', fixedTime: '16:30', durationMinutes: 90 }),
  task({ id: 'nohour', isFixed: false, fixedTime: undefined }),
];
const colorOf = () => '#118AB2';
const arcs = ringArcs(day, colorOf);
check('the interview has a trip arc before it', arcs.some((a) => a.id === 'iv:trip' && a.color === TRIP_COLOR));
check('Yosi overlaps the interview → inner lane', arcs.find((a) => a.id === 'yosi')?.lane === 1);
check('the interview stays on the main ring', arcs.find((a) => a.id === 'iv')?.lane === 0);
check('a task with no hour is not drawn', !arcs.some((a) => a.id === 'nohour'));
check('back-to-back is not an overlap', ringArcs([
  task({ id: 'a', fixedTime: '09:00', durationMinutes: 60 }), task({ id: 'b', fixedTime: '10:00' }),
], colorOf).every((a) => a.lane === 0));

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) process.exit(1);
