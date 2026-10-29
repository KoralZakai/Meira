/**
 * run-history-coach — her opt-in history, phone side (Feature 2, 20.10).
 *
 * Part A: the task-list diff → events (utils/historyEvents): every move is its own
 * event with the server's dedupKey, a tick and a miss once, an arrival with its real
 * minutes, a new task is not history.
 * Part B: when Meira says it (utils/historyCoach): Sunday ≥ 20:00 once a week,
 * Wednesday ≥ 13:00 only when behind, the 3rd move — firm, both languages.
 *
 * Run:  npx tsx tests/run-history-coach.ts
 */
import { diffEvents, studyEvent } from '../src/utils/historyEvents';
import {
  dueMoment, streakPush, sundaySummary, wednesdayNudge, weekOf,
} from '../src/utils/historyCoach';
import { myWeekView } from '../src/utils/myWeekView';
import type { Task } from '../src/types/index';
import type { HistoryWeek } from '../src/services/LumiServer';

let failed = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? '✓' : '✗'} ${name}`);
  if (!cond) failed += 1;
}

function task(id: string, extra: Partial<Task> = {}): Task {
  return {
    id, text: `task ${id}`, category: 'gym', priority: 'must', isFixed: false, durationMinutes: 60,
    date: '2026-10-20', status: 'pending', createdAt: 0, historicalDurations: [], ...extra,
  } as Task;
}

// ── A: the diff ──
const now = new Date(2026, 9, 20, 18, 0).getTime();
const before = [task('a'), task('b'), task('c'), task('d', { lastDepartureDetectedAt: now - 42 * 60_000 })];
const after = [
  task('a', { date: '2026-10-21', movedFromDate: '2026-10-20' }),
  task('b', { status: 'complete', actualDurationMinutes: 55 }),
  task('c', { status: 'missed' }),
  task('d', { verifiedArrival: true, lastDepartureDetectedAt: now - 42 * 60_000 }),
  task('new'),
];
const evs = diffEvents(before, after, now);
const byKind = (k: string) => evs.filter((e) => e.kind === k);
check('a move is an event on the day it left, with the server dedupKey',
  byKind('moved')[0]?.dedupKey === 'moved:a:2026-10-20:2026-10-21' && byKind('moved')[0]?.day === '2026-10-20');
check('a tick carries its real minutes', byKind('completed')[0]?.minutes === 55
  && byKind('completed')[0]?.dedupKey === 'completed:b:2026-10-20');
check('a miss is logged', byKind('missed').length === 1);
check('an arrival logs the real trip minutes', byKind('trip')[0]?.minutes === 42);
check('a new task is not history', !evs.some((e) => e.taskId === 'new'));
check('nothing changed = nothing logged', diffEvents(after, after, now).length === 0);
check('a second tick of a done task is not a second completion',
  diffEvents([task('b', { status: 'complete' })], [task('b', { status: 'complete' })], now).length === 0);
const absurd = diffEvents([task('x', { lastDepartureDetectedAt: now - 9 * 3600_000 })],
  [task('x', { verifiedArrival: true, lastDepartureDetectedAt: now - 9 * 3600_000 })], now);
check('a 9-hour "trip" is not a trip', absurd.length === 0);

const s = { id: 's1', title: 'מבחן', startedAtMs: now - 50 * 60_000, endsAtMs: now + 10 * 60_000, taskId: 't9' };
check('a running study session counts minutes so far, one key per session',
  studyEvent(s, now)?.minutes === 50 && studyEvent(s, now)?.dedupKey === 'study:s1');
check('a session past its end counts only to its end', studyEvent(s, now + 3600_000)?.minutes === 60);

// ── B: when ──
const sun2000 = new Date(2026, 9, 25, 20, 5);   // Sunday
const sun1900 = new Date(2026, 9, 25, 19, 0);
const wed1300 = new Date(2026, 9, 21, 13, 30);  // Wednesday
const thu0900 = new Date(2026, 9, 22, 9, 0);
const tue = new Date(2026, 9, 20, 18, 0);
check('Sunday 20:05 → the summary', dueMoment(sun2000, {}) === 'sunday');
check('Sunday 19:00 → not yet', dueMoment(sun1900, {}) === null);
check('Sunday, already sent this week → quiet', dueMoment(sun2000, { sunday: weekOf(sun2000) }) === null);
check('Wednesday 13:30 → the nudge check', dueMoment(wed1300, {}) === 'wednesday');
check('Thursday morning catches a missed Wednesday', dueMoment(thu0900, {}) === 'wednesday');
check('Tuesday → nothing', dueMoment(tue, {}) === null);
check('the week starts on Sunday', weekOf(wed1300) === '2026-10-18');

// ── B: the words ──
const stats = {
  from: '2026-10-18', to: '2026-10-24', workouts: 1, learning_minutes: 95, road_minutes: 130,
  road_estimated: true, reschedules: 4, most_moved: [], completed: 9, missed: 2, completion_rate: 0.82,
};
const week: HistoryWeek = { ok: true, optedIn: true, current: stats, targets: { workouts: 3 },
  line: 'אימונים: 1/3 השבוע. משבצים את הבא עכשיו?' };
const sumHe = sundaySummary(week, true);
const sumEn = sundaySummary(week, false);
check('Sunday summary has the numbers (he)', !!sumHe && sumHe.body.includes('1 אימונים')
  && sumHe.body.includes('1 ש׳ 35 דק׳ למידה') && sumHe.body.includes('~2 ש׳ 10 דק׳ בדרכים') && sumHe.body.includes('4 דחיות'));
check("Sunday summary names this week's goal and asks to book", !!sumHe && sumHe.body.includes('השבוע: 3 אימונים'));
check('Sunday summary in English', !!sumEn && sumEn.body.includes('1 workouts') && sumEn.body.includes('Book the first one?'));
check('a failed report sends no summary', sundaySummary({ ok: false, optedIn: true, reason: 'x' }, true) === null);
check('Wednesday: behind → the firm line', wednesdayNudge(week, true)?.body === week.line);
check('Wednesday: on track → quiet',
  wednesdayNudge({ ...week, current: { ...stats, workouts: 3 } }, true) === null);
check('Wednesday: no goal → quiet', wednesdayNudge({ ...week, targets: {} }, true) === null);
const st = streakPush({ text: 'לשלוח דוח', moves: 3 }, true);
check('3rd move: firm, three ways out', st.title.includes('3') && st.body.includes('עכשיו, בקטן, או מוותרים'));
check('3rd move in English', streakPush({ text: 'report', moves: 3 }, false).body.includes('now, smaller, or drop it'));

// ── C: the My week card (option A) ──
const prevStats = { ...stats, workouts: 2, learning_minutes: 190, road_minutes: 245, reschedules: 1, road_estimated: false };
const ok = myWeekView({ ok: true, data: { ...week, previous: prevStats, current: { ...stats, to: '2026-10-20' } } }, true);
check('card: four tiles, goal in the workout tile, last week under each',
  ok.state === 'ok' && ok.tiles.length === 4 && ok.tiles[0].value === '1/3' && ok.tiles[0].before === 'שעבר: 2'
  && ok.tiles[1].value === '1:35' && ok.tiles[2].value === '~2:10' && ok.tiles[3].value === '4');
check('card: title carries the dates', ok.state === 'ok' && ok.title === 'השבוע שלי · 18.10–20.10');
check('card: the firm line', ok.state === 'ok' && ok.line === week.line);
const off = myWeekView({ ok: true, data: { ok: false, optedIn: false, reason: 'not_opted_in' } }, false);
check('card off: says where to turn it on', off.state === 'off' && off.text.includes('Menu → More'));
const failedView = myWeekView({ ok: false, reason: 'slow: no answer in 25 s' }, true);
check('card failed: says so with the reason, not zeros', failedView.state === 'failed' && failedView.text.includes('slow'));
const serverFailed = myWeekView({ ok: true, data: { ok: false, optedIn: true, reason: 'http_500' } }, false);
check('card: a server-side failure is a failure, not off', serverFailed.state === 'failed');

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nall history-coach rules hold');
