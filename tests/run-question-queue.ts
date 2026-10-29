/**
 * run-question-queue — WHEN one of Meira's questions may pop up (6.10, her
 * pick: one at a time, at most 2 a day, never in the hour before leaving,
 * "Not now" = tomorrow; asked at once right after she saves the routine).
 *
 *   npx tsx tests/run-question-queue.ts
 */
import {
  EMPTY_ASK_STATE, LIMITS, afterAnswer, afterShown, afterSnooze, mayInterrupt, minutesToNextDeparture, pickNext, unanswered,
} from '../src/utils/questionQueue';
import type { MeiraQuestion } from '../src/questions/types';
import type { Task } from '../src/types/index';

let checks = 0;
let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `  — ${detail}`}`);
}

const q = (subject: string): MeiraQuestion => ({
  key: `routineDays:${subject}`, kind: 'routineDays', subject, title: subject,
  ask: { en: 'Every day, or on certain days?', he: 'כל יום, או בימים מסוימים?' },
  context: { line: subject, origin: ['box'] },
});
const kick = q('קיקבוקס|20:30');
const yoga = q('יוגה|07:00');
const TODAY = '2026-10-07';
const NOON = new Date('2026-10-07T12:00:00').getTime();
const base = { now: NOON, today: TODAY, shownThisOpen: false };

console.log('\nWhen a question may pop up\n');
check('a fresh question pops up', pickNext([kick], EMPTY_ASK_STATE, base) === kick);
check('nothing to ask → nothing pops up', pickNext([], EMPTY_ASK_STATE, base) === null);
check('one popup per app open', pickNext([kick], EMPTY_ASK_STATE, { ...base, shownThisOpen: true }) === null);
check('never over another sheet', pickNext([kick], EMPTY_ASK_STATE, { ...base, sheetOpen: true }) === null);
check(`not within ${LIMITS.departureQuietMin} min of leaving`,
  pickNext([kick], EMPTY_ASK_STATE, { ...base, minutesToDeparture: 40 }) === null);
check('…but fine two hours before', pickNext([kick], EMPTY_ASK_STATE, { ...base, minutesToDeparture: 120 }) === kick);

const once = afterShown(EMPTY_ASK_STATE, base);
check('not again within 3 hours', pickNext([yoga], once, { ...base, now: NOON + 2 * 3600_000 }) === null);
check('again after 3 hours', pickNext([yoga], once, { ...base, now: NOON + 3 * 3600_000 + 1 }) === yoga);
const twice = afterShown(once, { now: NOON + 4 * 3600_000, today: TODAY });
check(`at most ${LIMITS.perDay} a day`, pickNext([yoga], twice, { ...base, now: NOON + 8 * 3600_000 }) === null);
check('…and a new day starts the count again',
  pickNext([yoga], twice, { now: NOON + 24 * 3600_000, today: '2026-10-08', shownThisOpen: false }) === yoga);

const snoozed = afterSnooze(EMPTY_ASK_STATE, kick.key, NOON);
check('"Not now" hides it until tomorrow', pickNext([kick], snoozed, { ...base, now: NOON + 23 * 3600_000 }) === null);
check('…and it is back the next day', pickNext([kick], snoozed, { ...base, now: NOON + 25 * 3600_000 }) === kick);
let thrice = EMPTY_ASK_STATE;
for (let i = 0; i < LIMITS.maxSnoozes; i += 1) thrice = afterSnooze(thrice, kick.key, NOON);
check('after three "Not now" it never pops up again',
  pickNext([kick], thrice, { ...base, now: NOON + 30 * 86400_000 }) === null);
check('…but it is still waiting — the row chip and You count it', unanswered([kick], thrice).length === 1);

check('the closed-app nudge asks the same: fine when fresh, not while put off, not after three "Not now", not once answered',
  mayInterrupt(kick, EMPTY_ASK_STATE, NOON) && !mayInterrupt(kick, snoozed, NOON + 3600_000)
  && mayInterrupt(kick, snoozed, NOON + 25 * 3600_000) && !mayInterrupt(kick, thrice, NOON + 30 * 86400_000)
  && !mayInterrupt(kick, afterAnswer(EMPTY_ASK_STATE, kick.key, NOON), NOON));

const answered = afterAnswer(snoozed, kick.key, NOON);
check('an answered question is never asked again',
  pickNext([kick], answered, { ...base, now: NOON + 40 * 86400_000, justSaved: true }) === null);
check('…and is not counted as waiting', unanswered([kick], answered).length === 0);

check('right after she saves it, it is asked at once — past the open, the day and the gap',
  pickNext([kick], twice, { ...base, shownThisOpen: true, justSaved: true, minutesToDeparture: 30 }) === kick);

console.log('\nThe next departure\n');
const task = (leave: string, extra: Partial<Task> = {}): Task => ({
  id: leave, text: leave, category: 'meeting', priority: 'must', isFixed: true, durationMinutes: 30,
  date: TODAY, status: 'pending', createdAt: 1, historicalDurations: [],
  location: { address: 'x', lat: 1, lng: 1, confirmed: true, leaveHomeBy: leave }, ...extra,
} as Task);
check('minutes until the next leave-home', minutesToNextDeparture([task('13:30'), task('12:45')], TODAY, '12:00') === 45);
check('a departure that has passed does not count', minutesToNextDeparture([task('11:30')], TODAY, '12:00') === null);
check('a done task does not count',
  minutesToNextDeparture([task('12:30', { status: 'complete' })], TODAY, '12:00') === null);
check("tomorrow's departure does not count",
  minutesToNextDeparture([task('12:30', { date: '2026-10-08' })], TODAY, '12:00') === null);

console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
