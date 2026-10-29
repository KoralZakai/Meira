/**
 * run-cancelled-events — an invite that vanished from the calendar: detect strictly, say what it leaves (19.10).
 * Run:  npx tsx tests/run-cancelled-events.ts
 */
import { readFileSync } from 'node:fs';
import { datesAhead, describeCancel, freedWindow, isCancellable, judgeDay, MissLog, orphanPrepIds } from '../src/utils/cancelledEvents';
import { effectLine, headline, isStillOpen } from '../src/utils/changeRecord';
import type { Task } from '../src/types/index';

let failures = 0; let checks = 0;
const check = (l: string, ok: boolean) => { checks += 1; if (!ok) failures += 1; console.log(`  ${ok ? '✓' : '✗'} ${l}`); };

const TODAY = '2026-10-18'; const NOW = '09:00'; const DAY = '2026-10-20';
const t = (id: string, o: Partial<Task> = {}): Task => ({ id, text: 'Phone screen at Workday', category: 'interview', priority: 'must', isFixed: true,
  date: DAY, fixedTime: '13:00', durationMinutes: 90, status: 'pending', createdAt: 0, historicalDurations: [], source: 'calendar', ...o } as unknown as Task);
const iv = t('gcal-w');
const meeting = t('gcal-m', { text: 'Sync', category: 'meeting', fixedTime: '10:00', durationMinutes: 30 });
const evening = t('x', { text: 'ריצה', category: 'gym', fixedTime: '19:00', durationMinutes: 60, source: undefined } as any);

// ── strict detection ──
check('a calendar row, timed, ahead, pending: cancellable', isCancellable(iv, DAY, TODAY, NOW));
check('a row that came back from the cloud stamped "whatsapp" is still a calendar row (20.10: the real bug)', isCancellable(t('gcal-c', { source: 'whatsapp' } as any), DAY, TODAY, NOW));
check('a hand-made task (not gcal-) is never cancellable', !isCancellable(t('abc', { source: undefined } as any), DAY, TODAY, NOW));
check('a row she moved herself is never cancellable', !isCancellable(t('gcal-h', { movedFromDate: '2026-10-19' } as any), DAY, TODAY, NOW));
check('a done row is not', !isCancellable(t('gcal-d', { status: 'complete' }), DAY, TODAY, NOW));
check('an untimed row is not', !isCancellable(t('gcal-u', { fixedTime: undefined }), DAY, TODAY, NOW));
check('today but the hour has gone: not', !isCancellable(t('gcal-p', { date: TODAY, fixedTime: '08:00' }), TODAY, TODAY, NOW));

let r = judgeDay([iv, meeting], new Set(['gcal-m']), DAY, TODAY, NOW, {});
check('gone once: counted, NOT yet cancelled', r.cancelled.length === 0 && r.log['gcal-w']?.n === 1);
r = judgeDay([iv, meeting], new Set(['gcal-m']), DAY, TODAY, NOW, r.log);
check('gone twice in a row: cancelled, and the log forgets it', r.cancelled.map((x) => x.id).join() === 'gcal-w' && !r.log['gcal-w']);
const back = judgeDay([iv], new Set(['gcal-w']), DAY, TODAY, NOW, { 'gcal-w': { date: DAY, n: 1 } });
check('seen again between: the count is cleared', back.cancelled.length === 0 && !back.log['gcal-w']);
const movedOn = judgeDay([iv], new Set(), DAY, TODAY, NOW, { 'gcal-w': { date: '2026-10-19', n: 1 } });
check('a count from ANOTHER date starts again (a move re-dates the row)', movedOn.cancelled.length === 0 && movedOn.log['gcal-w'].n === 1);
const ids = judgeDay([iv], new Set(['w']), DAY, TODAY, NOW, {});
check('Google ids come bare ("w") — still recognised as present', ids.cancelled.length === 0 && !ids.log['gcal-w']);

// ── what it leaves ──
const prep = t('prep-1d-gcal-w', { text: 'Prep for the Workday interview', category: 'course', date: '2026-10-19', fixedTime: '19:00' });
const study = t('s1', { text: 'Study for the Workday interview', category: 'course', date: '2026-10-19', fixedTime: '20:00', prepForTaskId: 'gcal-w', source: undefined } as any);
const done = t('prep-2d-gcal-w', { status: 'complete', date: '2026-10-18', fixedTime: '19:00' });
const all = [iv, meeting, evening, prep, study, done];
check('orphans: the derived prep and the one she booked from the card — not a done one', orphanPrepIds(iv, all, TODAY).sort().join() === 'prep-1d-gcal-w,s1');
const fw = freedWindow(iv, all, TODAY, NOW)!;
check('the freed window opens after the 10:00 call and runs to the run', !!fw && fw.start <= '13:00' && fw.end > '13:00' && fw.minutes >= 90);
const rec = describeCancel(iv, all, TODAY, NOW)!;
check('the record: cancelled, dated, keyed once', rec.kind === 'cancelled' && rec.key === 'change:gcal-w:cancelled' && rec.before.date === DAY);
check('HE says cancelled + window + two preps', headline(rec, 'he').endsWith('בוטל') && effectLine(rec, 'he').includes('פנוי') && effectLine(rec, 'he').includes('2 הכנות'));
check('EN says it too', headline(rec, 'en').includes('was cancelled') && effectLine(rec, 'en').includes('Free') && effectLine(rec, 'en').includes('2 prep blocks'));
check('a card for a cancelled event stays open until its day passes', isStillOpen(rec, DAY) && !isStillOpen(rec, '2026-10-21'));
check('no window line when the day has no free stretch', !effectLine(describeCancel(t('gcal-z', { fixedTime: '08:00', durationMinutes: 840 }), [t('gcal-z', { fixedTime: '08:00', durationMinutes: 840 })].concat([t('q', { fixedTime: '08:00', durationMinutes: 840, source: undefined } as any)]), TODAY, NOW)!, 'en').includes('Free'));
check('a past event has no card', describeCancel(t('gcal-o', { date: '2026-10-10' }), [], TODAY, NOW) === null);

// ── wired where the trigger is (rule 7) ──
const sync = readFileSync('src/services/GoogleSync.ts', 'utf8');
check('GoogleSync judges a day only after Google answered for every account', sync.includes('judgeDay(') && sync.indexOf('judgeDay(') > sync.indexOf('let failed = false'));
check('it is not run when a fetch failed', sync.includes('if (!failed) await noteCancellationsFor('));
check('a changed set of accounts resets the count (a disconnected account is not a cancellation)', sync.includes('ACCOUNTS_KEY'));

// ── the card and the removal ──
const card = readFileSync('src/components/ChangeCards.tsx', 'utf8');
check('nothing is removed without her yes (chips ask first)', card.includes('removeIt') && card.includes('keepIt') && card.includes('Remove it from your day?'));
check('a cancelled card draws no arrow to a new time', card.includes("r.kind === 'cancelled' ? null"));
check('after removal the freed window is offered to fill, and an empty offer closes the card quietly', card.includes('fillOfferFor(') && card.includes('nothing()'));
const svc = readFileSync('src/services/ChangeSuggestService.ts', 'utf8');
check('removal cancels the alerts BEFORE the rows go', svc.indexOf('cancelTaskNotifications(t)') < svc.indexOf('deleteTasks(ids)'));
check('removal says what it removed, from the count that really went', svc.includes('const extra = removed - 1'));
check('a failed removal is a failure line, not a ✓', svc.includes("ok: false, line: he ? 'לא הצלחתי להסיר"));
check('a fill that did not save is not claimed', svc.includes("לא הצלחתי להוסיף 🙈"));
check('no travel question here either', !/how will you get|איך תגיעי/i.test(svc + card));

// ── the phone's own calendars and Outlook (same rule, their own prefix) ──
const dev = t('dcal-1', { text: 'Dentist checkup' } as any); const out = t('ocal-1', { text: 'Quarterly budget review' } as any);
check('a dcal- row is judged only as dcal-', isCancellable(dev, DAY, TODAY, NOW, 'dcal-') && !isCancellable(dev, DAY, TODAY, NOW, 'gcal-') && !isCancellable(dev, DAY, TODAY, NOW, 'ocal-'));
let d1 = judgeDay([dev, out, iv], new Set(), DAY, TODAY, NOW, {}, 'dcal-');
d1 = judgeDay([dev, out, iv], new Set(), DAY, TODAY, NOW, d1.log, 'dcal-');
check("one calendar's absence never cancels another calendar's rows", d1.cancelled.map((x) => x.id).join() === 'dcal-1');
check('a bare id from the phone calendar counts as present', judgeDay([dev], new Set(['1']), DAY, TODAY, NOW, { 'dcal-1': { date: DAY, n: 1 } }, 'dcal-').cancelled.length === 0);
check('the range a month-read covers: today and N more days', datesAhead('2026-10-30', 3).join() === '2026-10-30,2026-10-31,2026-11-01,2026-11-02');
const devSvc = readFileSync('src/services/DeviceCalendarSync.ts', 'utf8');
check('phone calendars: judged only after a successful read, before the early return', devSvc.includes("noteCancellationsFor('dcal-'") && devSvc.indexOf("noteCancellationsFor('dcal-'") < devSvc.indexOf("importCalendarTasks(tasks, lang, 'device')"));
const olSvc = readFileSync('src/services/OutlookService.ts', 'utf8');
check('Outlook: only when no account failed', /if \(!firstError\) \{\s*await noteCancellationsFor\('ocal-'/.test(olSvc));
check('a changed set of calendars restarts the count, per calendar', sync.includes('${ACCOUNTS_KEY}:${prefix}') && sync.includes('${MISS_KEY}:${prefix}'));

// ── 20.10 on the phone: the live interview was "cancelled" while its twin (another id) was there ──
const twinNew = t('gcal-NEW', { text: 'Your Phone Screen at Workday for JR-0104334 Senior Applied AI Engineer (Open)', source: undefined } as any);
const twinOld = t('gcal-OLD', { text: 'Your Phone Screen at Workday for JR-0104334 Senior Applied AI Engineer (Paradox)' });
let tw = judgeDay([twinOld], new Set(['gcal-NEW']), DAY, TODAY, NOW, {}, 'gcal-', [twinNew]);
tw = judgeDay([twinOld], new Set(['gcal-NEW']), DAY, TODAY, NOW, tw.log, 'gcal-', [twinNew]);
check('the same meeting under a new id returned by Google is NOT cancelled', tw.cancelled.length === 0);
let tw2 = judgeDay([twinOld, twinNew], new Set(), DAY, TODAY, NOW, {});
tw2 = judgeDay([twinOld, twinNew], new Set(), DAY, TODAY, NOW, tw2.log);
check('…nor when its twin is another row she holds', tw2.cancelled.length === 0);
let real = judgeDay([twinOld], new Set(), DAY, TODAY, NOW, {}, 'gcal-', []);
real = judgeDay([twinOld], new Set(), DAY, TODAY, NOW, real.log, 'gcal-', []);
check('a meeting with no twin anywhere is still cancelled', real.cancelled.length === 1);

// ── 21.10 on the phone: the study block booked from the card was left behind ──
const ttl = describeCancel(iv, [iv], TODAY, NOW)!.title;   // what the card calls it
const study2 = t('s2', { text: `Study for ${ttl.replace(/^./, (c) => c.toLowerCase())}`, category: 'course', date: '2026-10-19', fixedTime: '20:00', source: undefined } as any);   // prepForTaskId lost in the round trip
const rec2 = describeCancel(iv, [iv, study2], TODAY, NOW)!;
check('a study block whose link was lost is still found by the words the card wrote', rec2.orphanIds?.join() === 's2');
const stranger = t('s3', { text: 'Study for the Dentist', category: 'course', date: '2026-10-19', source: undefined } as any);
check('a study block for something else is never taken', describeCancel(iv, [iv, stranger], TODAY, NOW)!.orphanIds?.length === 0);

if (failures) { console.error(`\nFAIL — ${checks - failures}/${checks}`); process.exit(1); }
console.log(`\n✅ ${checks}/${checks} checks passed`);
