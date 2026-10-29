/**
 * run-day-edit — editing the day in place (canvas v4, 27.10).
 *
 *  1. After she switches a trip's mode, the day says what ELSE moved (dayDiff).
 *  2. A task dragged from the tray lands inside a free window, snapped to 5
 *     minutes, never past the window's end — and a task too long for it says so (dropSlot).
 *
 * Run:  npx tsx tests/run-day-edit.ts
 */
import { snapshotDay, diffDay, knockOnIds } from '../src/utils/dayDiff';
import { zoneAt, timeInWindow } from '../src/utils/dropSlot';
import type { Task } from '../src/types/index';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}
const task = (o: Partial<Task>): Task => ({
  id: 'x', text: 'x', category: 'meeting', priority: 'must', isFixed: true, durationMinutes: 60,
  date: '2026-10-29', status: 'pending', createdAt: 0, historicalDurations: [], ...o,
} as Task);
const at = (address: string, leaveHomeBy: string, arriveAt?: string) => ({
  address, lat: 1, lng: 1, confirmed: true, leaveHomeBy,
  ...(arriveAt ? { transitPlan: { arriveAt } as any } : {}),
});

console.log('1. what else moved after a mode switch (29.10: bus → train to Herzliya)');
const before = [
  task({ id: 'pickup', text: 'לאסוף מהחבר', fixedTime: '18:50', durationMinutes: 15, location: at('סוקולוב 10', '18:06', '18:49') }),
  task({ id: 'gym', text: 'אימון', fixedTime: '20:00', location: at('ז׳בוטינסקי 85', '19:14', '19:35') }),
  task({ id: 'home', text: 'הביתה', fixedTime: '21:58', location: at('הבית', '21:00', '21:58') }),
];
const snap = snapshotDay(before);
const after = [
  task({ ...before[0], fixedTime: '19:05', location: at('סוקולוב 10', '18:09', '19:05') }),
  task({ ...before[1], location: at('ז׳בוטינסקי 85', '19:25', '19:43') }),
  before[2],
];
const changes = diffDay(snap, after);
check('the edited trip\'s own times are listed', changes.some((c) => c.id === 'pickup' && c.field === 'leave' && c.to === '18:09'));
check('the gym\'s leave time moved and is named', changes.some((c) => c.id === 'gym' && c.field === 'leave' && c.from === '19:14' && c.to === '19:25'));
check('nothing is said about what did not move', !changes.some((c) => c.id === 'home'));
check('knock-on = the others, not the one she edited', JSON.stringify(knockOnIds(changes, 'pickup')) === '["gym"]');
check('a task added meanwhile is not a "change"', diffDay(snap, [...after, task({ id: 'new', fixedTime: '22:00' })]).every((c) => c.id !== 'new'));

console.log('2. dropping a tray task into a free window');
const zones = [
  { id: 'a', y: 300, height: 60, start: '18:49', end: '19:14' },
  { id: 'b', y: 500, height: 80, start: '11:00', end: '15:00' },
];
check('the zone under the finger is found', zoneAt(320, zones)?.id === 'a');
check('outside every zone → none', zoneAt(400, zones) === null);
const top = timeInWindow(zones[1], 0, 120);
check('top of 11:00–15:00 → 11:00', top.ok && top.time === '11:00', JSON.stringify(top));
const mid = timeInWindow(zones[1], 0.5, 120);
check('middle → 12:00 (room 120 min, half way)', mid.ok && mid.time === '12:00', JSON.stringify(mid));
const bottom = timeInWindow(zones[1], 1, 120);
check('bottom never spills past the end → 13:00', bottom.ok && bottom.time === '13:00', JSON.stringify(bottom));
const snapped = timeInWindow({ start: '18:49', end: '19:14' }, 0.1, 15);
check('snapped to 5 minutes and still inside', snapped.ok && snapped.time === '18:50', JSON.stringify(snapped));
const tooLong = timeInWindow({ start: '18:49', end: '19:14' }, 0.5, 60);
check('a task longer than the window says so', !tooLong.ok && tooLong.reason === 'too_long');

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) process.exit(1);
