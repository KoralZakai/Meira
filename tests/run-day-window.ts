/**
 * run-day-window — a task later today is never hidden by the day list's cap.
 *
 * The reported bug: a phone call added for 16:00 was saved, Lumi could answer
 * that it existed, and it was nowhere on the schedule screen. The cap took the
 * first six tasks in CLOCK order, so on a busy day every visible card was
 * already over by mid-afternoon and everything still to come was collapsed
 * behind "Show all N tasks".
 *
 * Run:  npx tsx tests/run-day-window.ts
 */
import { visibleDayIds, isBehind, VISIBLE_AHEAD_LIMIT } from '../src/utils/dayWindow';
import { Task } from '../src/types/index';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

const today = new Date().toISOString().slice(0, 10);
const task = (id: string, fixedTime?: string, extra: Partial<Task> = {}): Task => ({
  id, text: id, category: 'general', priority: 'need_to', isFixed: !!fixedTime,
  fixedTime, durationMinutes: 60, date: today, status: 'pending',
  createdAt: Date.now(), historicalDurations: [],
  ...extra,
} as Task);

function main() {
  console.log('\nDay window\n');

  // ── 1. the reported bug ─────────────────────────────────────────────────
  console.log('1. The 16:00 phone call, on a busy day');
  const day = [
    task('a', '07:00', { status: 'complete' }),
    task('b', '08:00', { status: 'complete' }),
    task('c', '09:00', { status: 'complete' }),
    task('d', '10:00', { status: 'complete' }),
    task('conference', '11:00', { category: 'conference', durationMinutes: 300 }),
    task('e', '13:00', { status: 'complete' }),
    task('call', '16:00', { category: 'call', durationMinutes: 15 }),
  ];
  const at1430 = visibleDayIds(day, '14:30');
  check('the 16:00 call is on screen', at1430.has('call'));
  check('…and so is the conference she is still in', at1430.has('conference'));
  check('the finished morning is trimmed', !at1430.has('a') && !at1430.has('b'),
    [...at1430].join(','));
  check('the most recent finished ones stay for context',
    at1430.has('d') && at1430.has('e'));

  // The old rule, for contrast: first six in clock order.
  const oldRule = new Set(day.slice(0, 6).map((t) => t.id));
  check('the old six-in-clock-order rule really did hide it', !oldRule.has('call'));

  // ── 2. what counts as behind ────────────────────────────────────────────
  console.log('\n2. Behind means finished, not merely started');
  check('a task still running is not behind',
    !isBehind(task('x', '14:00', { durationMinutes: 120 }), '14:30'));
  check('a task whose slot ended is behind',
    isBehind(task('x', '12:00', { durationMinutes: 30 }), '14:30'));
  check('a completed task is behind whatever the clock says',
    isBehind(task('x', '23:00', { status: 'complete' }), '14:30'));
  check('a task with no hour is never behind',
    !isBehind(task('x'), '23:00'));

  // ── 3. the cap still caps ───────────────────────────────────────────────
  console.log('\n3. A genuinely enormous day is still capped');
  const many = Array.from({ length: 20 }, (_, i) =>
    task(`t${i}`, `${String(6 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`,
      { durationMinutes: 25 }));
  const capped = visibleDayIds(many, '05:00');
  check(`at most ${VISIBLE_AHEAD_LIMIT} upcoming are drawn`,
    capped.size === VISIBLE_AHEAD_LIMIT, String(capped.size));
  check('and they are the SOONEST ones', capped.has('t0') && !capped.has('t19'));

  // ── 4. an empty / all-future day ────────────────────────────────────────
  console.log('\n4. Edges');
  check('nothing in, nothing out', visibleDayIds([], '09:00').size === 0);
  const allAhead = [task('p', '18:00'), task('q', '20:00')];
  check('a day that has not started shows all of it',
    visibleDayIds(allAhead, '09:00').size === 2);
  check('a slot running past midnight has not already happened',
    !isBehind(task('x', '23:30', { durationMinutes: 60 }), '23:45'));
  const allDone = [task('r', '08:00', { status: 'complete' }),
                   task('s', '09:00', { status: 'complete' }),
                   task('t', '10:00', { status: 'complete' })];
  check('a finished day still shows its tail, not a blank screen',
    visibleDayIds(allDone, '23:00').size === 2);

  console.log(failures === 0
    ? `\n✅ ${checks}/${checks} checks passed\n`
    : `\n❌ ${failures} of ${checks} checks failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
