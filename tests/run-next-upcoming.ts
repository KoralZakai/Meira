/**
 * run-next-upcoming — the gold "next important" pill picks the first timed
 * task that has not started, across days.
 *
 * At 20:49 on 28.9 two things were running (20:30) and tomorrow had a 09:00
 * and an 11:00 — the pill must name tomorrow 09:00, never a running task and
 * never a done or moved one.
 *
 * Run:  npx tsx tests/run-next-upcoming.ts
 */
import { pickNextUpcoming } from '../src/utils/dayPlanning';
import { Task } from '../src/types/index';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

const task = (id: string, date: string, fixedTime?: string, extra: Partial<Task> = {}): Task => ({
  id, text: id, category: 'general', priority: 'need_to', isFixed: !!fixedTime,
  fixedTime, durationMinutes: 60, date, status: 'pending',
  createdAt: 0, historicalDurations: [],
  ...extra,
} as Task);

const now = new Date(2026, 8, 28, 20, 49).getTime();
const today = '2026-09-28';

const day = [
  task('gym', today, '18:00'),
  task('karaoke', today, '20:30'),
  task('hackathon', today, '20:30'),
  task('study', '2026-09-29', undefined, { scheduledTime: '09:00' }),
  task('interview', '2026-09-29', '11:00'),
  task('idea', '2026-09-29'),
];
check('tomorrow 09:00 wins over running and later tasks',
  pickNextUpcoming(day, now, today)?.id === 'study');

check('a done task is skipped',
  pickNextUpcoming([task('a', '2026-09-29', '09:00', { status: 'complete' }), task('b', '2026-09-29', '10:00')], now, today)?.id === 'b');
check('a moved task is skipped',
  pickNextUpcoming([task('a', '2026-09-29', '09:00', { status: 'moved' }), task('b', '2026-09-29', '10:00')], now, today)?.id === 'b');
check('later today beats tomorrow',
  pickNextUpcoming([task('late', today, '21:30'), task('tmr', '2026-09-29', '07:00')], now, today)?.id === 'late');
check('past days never qualify',
  pickNextUpcoming([task('old', '2026-09-27', '23:00')], now, today) === null);
check('outside the 7-day window is null',
  pickNextUpcoming([task('far', '2026-10-06', '09:00')], now, today) === null);
check('the 7th day (today + 6) still counts, across a month end',
  pickNextUpcoming([task('edge', '2026-10-04', '09:00')], now, today)?.id === 'edge');
check('nothing timed → null',
  pickNextUpcoming([task('x', today)], now, today) === null);

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) process.exit(1);
