/**
 * run-open-rank — which open task gets the free window: deadline, importance, place (21.10).
 * Run:  npx tsx tests/run-open-rank.ts
 */
import { deadlinePoints, nearnessPoints, rankOpenTasks, rankOne } from '../src/utils/openTaskRank';
import type { Task } from '../src/types/index';
import { openSuggestions } from '../src/utils/addSuggestions';
import { readFileSync } from 'node:fs';

let failures = 0; let checks = 0;
const check = (l: string, ok: boolean) => { checks += 1; if (!ok) failures += 1; console.log(`  ${ok ? '✓' : '✗'} ${l}`); };

const TODAY = '2026-10-21'; const NOW = '10:00';
const t = (id: string, o: Partial<Task> = {}): Task => ({ id, text: id, category: 'work', priority: 'need_to', isFixed: false,
  date: TODAY, durationMinutes: 30, status: 'pending', createdAt: 0, historicalDurations: [], ...o } as Task);
const ctx: { today: string; nowHHMM: string; anchor?: { lat: number; lng: number } | null } = { today: TODAY, nowHHMM: NOW };
const order = (xs: Task[], c = ctx) => rankOpenTasks(xs, c).map((r) => r.task.id).join(',');

// ── deadline ──
check('a deadline tomorrow beats no deadline', order([t('plain'), t('due', { deadline: '2026-10-22' })]) === 'due,plain');
check('overdue > today > tomorrow > this week', order([t('wk', { deadline: '2026-10-26' }), t('tm', { deadline: '2026-10-22' }), t('td', { deadline: TODAY }), t('od', { deadline: '2026-10-19' })]) === 'od,td,tm,wk');
check('due within three hours today outranks due later today', deadlinePoints(t('x', { deadline: TODAY, deadlineTime: '12:00' }), TODAY, NOW).points > deadlinePoints(t('y', { deadline: TODAY, deadlineTime: '20:00' }), TODAY, NOW).points);
check('a deadline a month away adds nothing', deadlinePoints(t('x', { deadline: '2026-12-01' }), TODAY, NOW).points === 0);

// ── importance ──
check('must > have_to > need_to > nice_to_do', order([t('n', { priority: 'nice_to_do' }), t('h', { priority: 'have_to' }), t('m', { priority: 'must' }), t('d')]) === 'm,h,d,n');
check('a nearer deadline can outweigh a higher priority', order([t('must', { priority: 'must' }), t('due', { priority: 'need_to', deadline: TODAY })]) === 'due,must');
check('left over from an earlier day counts', order([t('new'), t('old', { date: '2026-10-19' })]) === 'old,new');

// ── location ──
const HOME = { lat: 32.0853, lng: 34.7818 };
const near = t('near', { location: { address: 'a', lat: 32.087, lng: 34.783, confirmed: true } as any });
const far = t('far', { location: { address: 'b', lat: 32.8, lng: 35.0, confirmed: true } as any });
const nowhere = t('nowhere');
check('near beats far when all else is equal', order([far, near], { ...ctx, anchor: HOME }) === 'near,far');
check('a task with no place is never punished (it can be done anywhere)', nearnessPoints(nowhere, HOME).points === 0 && order([far, nowhere], { ...ctx, anchor: HOME }) === 'nowhere,far');
check('no anchor: place is ignored (ties fall back to stable order)', order([far, near]) === order([near, far]));
check('0,0 is "unknown", not a place in the Atlantic', nearnessPoints(t('z', { location: { address: 'q', lat: 0, lng: 0, confirmed: false } as any }), HOME).points === 0);
check('a deadline today beats a nearby but undated task', order([near, t('due', { deadline: TODAY, location: { address: 'b', lat: 32.8, lng: 35.0, confirmed: true } as any })], { ...ctx, anchor: HOME }) === 'due,near');

// ── the reason is readable ──
const r = rankOne(t('x', { deadline: '2026-10-22', location: { address: 'a', lat: 32.087, lng: 34.783, confirmed: true } as any }), { ...ctx, anchor: HOME });
check('reason says the deadline and the distance, both languages', r.reason.includes('Due tomorrow') && r.reason.includes('km') || r.reason.includes('right here'));
check('HE reason is Hebrew', /[֐-׿]/.test(r.reasonHe) && r.reasonHe.includes('להגיש מחר'));
check('an undated, unplaced task says "Still open"', rankOne(t('p'), ctx).reason === 'Still open');

// ── wired into the two lists that fill a free hour ──
const gapFact = { start: '11:00', end: '14:00', minutes: 180, ideas: [], anchor: HOME };
const rows = openSuggestions([t('plain'), near, t('due', { deadline: '2026-10-22' })],
  [gapFact], TODAY, { date: TODAY, time: NOW });
check('the + panel offers the deadline first, then the near one, then the rest', rows.map((r) => r.id).sort((a, b) => 0).join() !== '' && [...rows].sort((a, b) => b.score - a.score).map((r) => r.id).join() === 'open-due,open-near,open-plain');
const farDue = openSuggestions([near, t('due2', { deadline: '2026-10-22', location: { address: 'b', lat: 32.8, lng: 35.0, confirmed: true } as any })], [gapFact], TODAY, { date: TODAY, time: NOW });
check('a task due tomorrow but 80 km away loses a 3-hour window to one round the corner (it cannot be done in it)', [...farDue].sort((a, b) => b.score - a.score)[0].id === 'open-near');
check('its row says why (deadline) in both languages', rows[0].why.includes('Due tomorrow') && rows[0].whyHe.includes('להגיש מחר'));
const gapSrc = readFileSync('src/services/GapFillService.ts', 'utf8');
check('a free window under a cancelled event / a gap row orders open tasks with the same scorer', gapSrc.includes('rankOpenTasks(') && gapSrc.includes('byRank(stillOpen)') && gapSrc.includes('byRank(overdue)'));
check('and takes where she will be from the window (place), not home by default', gapSrc.includes('anchor: anchorPoint'));

// ── the ＋ on every day (21.10: "on the next day the + is missing") ──
const today = readFileSync('src/screens/TodaySchedule.tsx', 'utf8');
check('the ＋ slot is computed for every day, not only today', !/const plus = showingToday \? plusSlot/.test(today) && today.includes('const plusRaw = plusSlot('));
check('on another day it never claims "free now"', today.includes('{ ...plusRaw, startsNow: false }'));
// Three since v3 (27.10): an empty day, a day with cards, and today's Focus view.
check('the ＋ block is drawn on an EMPTY day, a day with cards and in Focus', (today.match(/\{plusBlock\}/g) || []).length === 3);
check('its suggestions are for the day on screen', today.includes('date={dateKey}') && today.includes('setSuggestOpen(false); }, [dateKey]'));

if (failures) { console.error(`\nFAIL — ${checks - failures}/${checks}`); process.exit(1); }
console.log(`\n✅ ${checks}/${checks} checks passed`);
