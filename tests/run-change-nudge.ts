/**
 * run-change-nudge — the closed-app knock about a calendar move: quiet hours, max 2, never twice for what she saw (19.10).
 * Run:  npx tsx tests/run-change-nudge.ts
 */
import { readFileSync } from 'node:fs';
import { MAX_NUDGES_PER_CHANGE, MIN_GAP_BETWEEN_NUDGES_MS, afterNudge, decideChangeNudge, inQuietHours, NudgeLog } from '../src/utils/changeNudge';
import { describeChange, ChangeRecord } from '../src/utils/changeRecord';
import type { Task } from '../src/types/index';

let failures = 0; let checks = 0;
const check = (l: string, ok: boolean) => { checks += 1; if (!ok) failures += 1; console.log(`  ${ok ? '✓' : '✗'} ${l}`); };

const TODAY = '2026-10-18';
const mk = (id: string, date: string, from: string, over: Partial<Task> = {}): ChangeRecord => describeChange(
  { date: from, fixedTime: '13:00' },
  { id, text: 'Phone screen at Workday', category: 'interview', priority: 'must', isFixed: true, date, fixedTime: '13:00',
    durationMinutes: 60, status: 'pending', createdAt: 0, historicalDurations: [], ...over } as Task, TODAY, '09:00')!;
const A = mk('gcal-a', '2026-10-20', '2026-10-19');
const B = mk('gcal-b', '2026-10-22', '2026-10-21', { text: 'Interview at Ceva' });
const T0 = new Date(2026, 9, 18, 12, 0).getTime();
const decide = (recs: ChangeRecord[], log: NudgeLog = {}, now = T0, hhmm = '12:00') => decideChangeNudge(recs, log, now, TODAY, hhmm, 'he');

check('quiet hours: 22:00 and 07:29 are quiet, 07:30 and 21:59 are not',
  inQuietHours('22:00') && inQuietHours('03:10') && inQuietHours('07:29') && !inQuietHours('07:30') && !inQuietHours('21:59'));

const first = decide([A]);
check('a fresh, unseen move earns one knock, dated, with what it gives her',
  !!first.send && first.send.key === A.key && first.send.title.includes('הוזז') && first.send.body.includes('20.10') && first.send.body.includes('להתכונן'));
check('EN text too', decideChangeNudge([A], {}, T0, TODAY, '12:00', 'en').send!.body.includes('tap to open'));

check('at night it is HELD (not sent, not counted)', decide([A], {}, T0, '23:15').held === 'quiet' && decide([A], {}, T0, '23:15').send === null);
check('the first run after 07:30 sends it', !!decide([A], {}, T0, '07:30').send);

check('a card she has seen gets no knock', decide([{ ...A, seenAt: 1 }]).held === 'nothing');
check('a card she answered gets no knock', decide([{ ...A, ui: { stage: 'done' } }]).held === 'nothing');
check('an event whose new moment has passed gets no knock', decideChangeNudge([mk('gcal-c', '2026-10-18', '2026-10-19', { fixedTime: '14:00' })], {}, T0, TODAY, '15:00', 'he').held === 'nothing');

// at most two, the second no sooner than three hours later
let log: NudgeLog = afterNudge({}, A.key, T0, [A.key]);
check('right after a knock: held (limit)', decide([A], log, T0 + 60_000).held === 'limit');
check('three hours later: the second knock', !!decide([A], log, T0 + MIN_GAP_BETWEEN_NUDGES_MS, '15:00').send);
log = afterNudge(log, A.key, T0 + MIN_GAP_BETWEEN_NUDGES_MS, [A.key]);
check('the log counts two', log[A.key].n === MAX_NUDGES_PER_CHANGE);
check('never a third, however late', decide([A], log, T0 + 99 * 3600_000, '16:00').held === 'limit');

// one per run, soonest first, +N for the rest
const two = decide([B, A]);
check('one notification per run, the soonest event, "+1" for the other', two.send!.key === A.key && two.send!.body.includes('(+1)'));
check('after A is spent, B is next', decide([A, B], afterNudge(afterNudge({}, A.key, T0, []), A.key, T0, []), T0 + 1000).send!.key === B.key);
check('the log forgets closed cards', Object.keys(afterNudge({ gone: { n: 2, at: 1 } }, A.key, T0, [A.key])).join() === A.key);

// the wiring (rule 7): the closed-app job calls it; the card marks itself seen; the app in front is skipped
const sync = readFileSync('src/services/CalendarAutoSync.ts', 'utf8');
check('the background job calls the knock after the sync', sync.indexOf('nudgeAboutChanges(') > sync.indexOf("reason: 'background'"));
const svc = readFileSync('src/services/ChangeNudgeService.ts', 'utf8');
check('not while the app is in front', svc.includes("AppState.currentState === 'active'"));
check('a knock that failed to send is not counted', svc.indexOf('sendImmediate(') < svc.indexOf('afterNudge('));
check('opening the bell marks the changes seen', readFileSync('src/screens/TodaySchedule.tsx', 'utf8').includes('markSeen(changes.map('));
check('tapping opens Today', svc.includes("screen: 'Today'"));

if (failures) { console.error(`\nFAIL — ${checks - failures}/${checks}`); process.exit(1); }
console.log(`\n✅ ${checks}/${checks} checks passed`);
