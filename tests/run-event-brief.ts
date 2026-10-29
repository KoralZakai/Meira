/**
 * run-event-brief — every calendar event gets a brief the day before (18.10, Koral).
 * Which tasks are picked: calendar-sourced, tomorrow or the rest of today, not
 * done, not interviews (those have their own path), capped, in clock order.
 *
 * Run:  npx tsx tests/run-event-brief.ts
 */
import { pickEventsToBrief, MAX_EVENT_BRIEFS } from '../src/utils/interviewBrief';
import type { Task } from '../src/types/index';

let failures = 0; let checks = 0;
const check = (l: string, ok: boolean) => { checks += 1; if (!ok) failures += 1; console.log(`  ${ok ? '✓' : '✗'} ${l}`); };

const T = (over: Partial<Task> & { id: string }): Task => ({
  text: 'Sync', category: 'meeting', priority: 'have_to', isFixed: true, fixedTime: '10:00', durationMinutes: 45,
  date: '2026-10-19', status: 'pending', createdAt: 1, historicalDurations: [], ...over,
} as Task);

const today = '2026-10-18', tomorrow = '2026-10-19';
const picked = (all: Task[], now = '18:00') => pickEventsToBrief(all, today, tomorrow, now).map((t) => t.id);

check('a calendar meeting tomorrow is briefed', picked([T({ id: 'gcal-1' })]).join() === 'gcal-1');
check('a self-typed task is not', picked([T({ id: 'x1', text: 'gym', category: 'gym' })]).length === 0);
check('an event with a calendarEventId counts whatever its id', picked([T({ id: 'u1', calendarEventId: 'e' })]).length === 1);
check('an interview has its own path', picked([T({ id: 'gcal-2', category: 'interview', text: 'ראיון עבודה' })]).length === 0);
check('a finished one is not briefed', picked([T({ id: 'gcal-3', status: 'complete' })]).length === 0);
check('the day after tomorrow waits', picked([T({ id: 'gcal-4', date: '2026-10-20' })]).length === 0);
check('today: only what has not started', picked([T({ id: 'gcal-5', date: today, fixedTime: '09:00' }), T({ id: 'gcal-6', date: today, fixedTime: '19:00' })]).join() === 'gcal-6');
check('clock order, today first', picked([T({ id: 'gcal-8', fixedTime: '15:00' }), T({ id: 'gcal-7', fixedTime: '09:00' }), T({ id: 'gcal-9', date: today, fixedTime: '20:00' })]).join() === 'gcal-9,gcal-7,gcal-8');
check(`at most ${MAX_EVENT_BRIEFS}`, picked(Array.from({ length: 10 }, (_, i) => T({ id: `gcal-${i}x` }))).length === MAX_EVENT_BRIEFS);

if (failures) { console.error(`\nFAIL — ${checks - failures}/${checks}`); process.exit(1); }
console.log(`\n✅ ${checks}/${checks} checks passed`);
