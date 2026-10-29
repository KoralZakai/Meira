/**
 * run-add-suggestions — "Suggested for you" under an empty Add input.
 *
 * What this guards:
 *   - the four sources each produce the row they should, from facts the app
 *     already holds (tomorrow's interview, an early wake, a free window, an
 *     open task, an errand on a planned route);
 *   - rows are ranked by how near their MOMENT is to now — lights-out is a
 *     22:00 idea, a gap that opens in ten minutes beats one at four;
 *   - a source that FAILED contributes no row at all and is reported in
 *     `skipped` with its reason — "nothing to suggest" and "the server said
 *     no" must not look alike (silent-state rule 1);
 *   - never more than five rows, never two for the same task.
 *
 * Run:  npx tsx tests/run-add-suggestions.ts
 */
import {
  rankSuggestions, tomorrowSuggestions, upcomingInterviewSuggestions, waySuggestions, openSuggestions, gapSuggestions,
  MAX_ROWS, type GapFact, type SuggestionInput, type WayFact,
} from '../src/utils/addSuggestions';
import type { Task } from '../src/types/index';

let failures = 0; let checks = 0;
const check = (label: string, ok: boolean, detail = '') => {
  checks += 1; if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
};
const eq = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  check(label, ok, ok ? '' : `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
};

const TODAY = '2026-10-17';
const TOMORROW = '2026-10-18';
let n = 0;
const mk = (over: Partial<Task>): Task => ({
  id: `t${++n}`, text: 'x', category: 'general', priority: 'need_to', isFixed: false,
  durationMinutes: 30, date: TODAY, status: 'pending', createdAt: 0, historicalDurations: [],
  ...over,
} as Task);

const interview = mk({
  id: 'int1', text: 'Interview with Rafael', category: 'interview', priority: 'must',
  date: TOMORROW, fixedTime: '13:30', durationMinutes: 90,
});
const earlyMeeting = mk({
  id: 'early1', text: 'Site visit — Intel Haifa', category: 'work', date: TOMORROW,
  fixedTime: '08:00', durationMinutes: 120,
  location: { address: 'Haifa', lat: 32.8, lng: 35, confirmed: true, leaveHomeBy: '06:50', wakeUpBy: '06:15' } as any,
});
const gap = (start: string, end: string, minutes: number, title = 'Study for the exam', over: Partial<GapFact['ideas'][0]> = {}): GapFact => ({
  start, end, minutes,
  ideas: [{ title, titleHe: 'ללמוד למבחן', reason: 'your goal', reasonHe: 'היעד שלך', icon: '📚', minutes: Math.min(minutes, 45), draftText: title, ...over }],
});
const way = (over: Partial<WayFact['candidate']> = {}): WayFact => ({
  task: { id: 'laundry', text: 'Laundry' },
  candidate: {
    name: 'Mechabes Dan', lat: 32.1, lng: 34.8, pass_at: '17:40', date: TODAY,
    off_route_m: 300, open_when_passing: true, ...over,
  },
});
const base = (time: string, over: Partial<SuggestionInput> = {}): SuggestionInput => ({
  now: { date: TODAY, time }, target: TODAY, ...over,
});

console.log('\nTomorrow');
{
  const rows = tomorrowSuggestions([interview], [], { date: TODAY, time: '18:00' });
  eq('an interview with no prep → one prep row', rows.map((r) => r.id), ['tomorrow-prep-int1']);
  eq('…it fills the input for tonight at 19:00', rows[0].action, {
    kind: 'prefill', text: 'Prep for the Rafael interview', textHe: 'הכנה לראיון בRafael', time: '19:00', date: TODAY,
  });
  check('…and says why, in both languages', /nothing planned/.test(rows[0].why) && /ראיון מחר/.test(rows[0].whyHe));
}
{
  const prep = mk({ id: 'prep-1d-int1', text: 'Final review for Rafael', date: TODAY, prepForTaskId: 'int1' } as any);
  eq('prep already planned for today → no duplicate',
    tomorrowSuggestions([interview], [prep], { date: TODAY, time: '18:00' }).length, 0);
  eq('today\'s tasks unreadable → no prep proposed at all',
    tomorrowSuggestions([interview], null, { date: TODAY, time: '18:00' }).filter((r) => r.id.includes('prep')).length, 0);
  const lateRows = tomorrowSuggestions([interview], [], { date: TODAY, time: '22:10' });
  eq('after 22:00 prep is not a suggestion', lateRows.filter((r) => r.id.includes('prep')).length, 0);
  const done = { ...interview, status: 'complete' } as Task;
  eq('a done interview is not prepared for', tomorrowSuggestions([done], [], { date: TODAY, time: '18:00' }).length, 0);
  const evening = tomorrowSuggestions([interview], [], { date: TODAY, time: '19:12' });
  eq('after 19:00 the block starts at the next 5 minutes', (evening[0].action as any).time, '19:15');
}
{
  const rows = tomorrowSuggestions([earlyMeeting], [], { date: TODAY, time: '21:00' },
    { usualWakeTime: '07:30', routineMinutes: 45 });
  const lights = rows.find((r) => r.id.startsWith('tomorrow-lights'));
  eq('a 06:15 wake → lights out 8 h before', lights?.action, { kind: 'prefill', text: 'Lights out', textHe: 'ללכת לישון', time: '22:15', date: TODAY });
  check('…naming the wake and the leave from the stored plan', /06:15/.test(lights?.why ?? '') && /06:50/.test(lights?.why ?? ''));
  const late = tomorrowSuggestions([earlyMeeting], [], { date: TODAY, time: '23:50' });
  eq('lights-out is gone once it is past', late.length, 0);
  const lateMeeting = mk({ id: 'm2', text: 'Coffee', date: TOMORROW, fixedTime: '14:00' });
  eq('a late start asks for no early night',
    tomorrowSuggestions([lateMeeting], [], { date: TODAY, time: '21:00' }, { usualWakeTime: '07:30', routineMinutes: 45 }).length, 0);
}

console.log('\nOn your way');
{
  const rows = waySuggestions([way()], { date: TODAY, time: '16:00' });
  eq('an errand on a planned route → one row', rows.length, 1);
  eq('…which puts the place and the minute she passes on the existing task', rows[0].action, {
    kind: 'place', taskId: 'laundry', date: TODAY, time: '17:40', durationMinutes: undefined,
    place: { name: 'Mechabes Dan', address: undefined, lat: 32.1, lng: 34.8 },
  });
  eq('closed when she passes → nothing', waySuggestions([way({ open_when_passing: false })], { date: TODAY, time: '16:00' }).length, 0);
  eq('already passed → nothing', waySuggestions([way()], { date: TODAY, time: '18:30' }).length, 0);
  const tomorrowWay = waySuggestions([way({ date: TOMORROW, pass_at: '08:10' })], { date: TODAY, time: '16:00' });
  check('a stop on ANOTHER day says which day (rule 4)',
    /tomorrow at 08:10/.test(tomorrowWay[0]?.why ?? '') && /מחר ב-08:10/.test(tomorrowWay[0]?.whyHe ?? ''),
    tomorrowWay[0]?.why);
  const unknown = waySuggestions([way({ open_when_passing: null })], { date: TODAY, time: '16:00' });
  check('hours unknown is a row, and says so', unknown.length === 1 && /hours unknown/.test(unknown[0].why));
}

console.log('\nFree gaps');
{
  const rows = gapSuggestions([gap('14:02', '15:30', 88)], TODAY, { date: TODAY, time: '14:00' });
  eq('a window → its best idea, at the next 5 minutes', rows[0].action,
    { kind: 'prefill', text: 'Study for the exam', time: '14:05', date: TODAY });
  const existing = gapSuggestions([gap('14:00', '15:00', 60, 'Finish the report', { taskId: 'report1', draftText: undefined })],
    TODAY, { date: TODAY, time: '13:00' });
  eq('an idea that IS an existing task moves that task', existing[0].action,
    { kind: 'schedule', taskId: 'report1', date: TODAY, time: '14:00', durationMinutes: 45 });
  eq('a window with no idea offers nothing', gapSuggestions([{ start: '14:00', end: '15:00', minutes: 60, ideas: [] }], TODAY, { date: TODAY, time: '13:00' }).length, 0);
}

console.log('\nOpen tasks');
{
  const overdue = mk({ id: 'o1', text: 'Renew passport', date: '2026-10-12', durationMinutes: 40 });
  const small = mk({ id: 'o2', text: 'Send invoice', date: TODAY, durationMinutes: 15 });
  const huge = mk({ id: 'o3', text: 'Paint flat', date: TODAY, durationMinutes: 300 });
  const rows = openSuggestions([small, overdue, huge], [gap('15:00', '16:30', 90)], TODAY, { date: TODAY, time: '14:00' });
  eq('overdue first, then the ones that fit, then the one that does not', rows.map((r) => r.id), ['open-o1', 'open-o2', 'open-o3']);
  eq('the 5-hour job is not forced into 90 minutes — it opens, to pick a time', rows[2].action, { kind: 'open', taskId: 'o3' });
  eq('a tap schedules the EXISTING task at the window', rows[0].action,
    { kind: 'schedule', taskId: 'o1', date: TODAY, time: '15:00', durationMinutes: 40 });
  // Koral, 17.10: "all the other open tasks too" — no window still means a row.
  const noWin = openSuggestions([small], [], TODAY, { date: TODAY, time: '14:00' });
  eq('no window → still a row, that opens the task', noWin.map((r) => r.action), [{ kind: 'open', taskId: 'o2' }]);
  check('…and says there is no window today', /no free window/.test(noWin[0].why) && /אין היום חלון/.test(noWin[0].whyHe));
  const prepBlock = mk({ id: 'prep-2d-int1', text: 'Prep for the Ceva interview', prepForTaskId: 'int1' } as any);
  eq('a prep block is never "left over"', openSuggestions([prepBlock], [gap('15:00', '16:30', 90)], TODAY, { date: TODAY, time: '14:00' }).length, 0);
}

console.log('\nFrom now to the next event (18.10)');
{
  // 10:31, a call at 11:00: the 29 minutes she is IN. The + must offer what FITS
  // them and add it — "the + doesn't add any task".
  const quick = mk({ id: 'q1', text: 'Send CV to Aidoc', date: '2026-10-12', durationMinutes: 15 });
  const long = mk({ id: 'q2', text: 'Lean board plan', date: TODAY, durationMinutes: 30 });
  const rows = openSuggestions([quick, long], [gap('10:31', '11:00', 29)], TODAY, { date: TODAY, time: '10:31' });
  eq('the 15-minute task fits the window → a tap puts it at 10:35', rows.find((r) => r.id === 'open-q1')?.action,
    { kind: 'schedule', taskId: 'q1', date: TODAY, time: '10:35', durationMinutes: 15 });
  eq('the 30-minute one does not (plus her 10-minute buffer) → it opens, to pick a time',
    rows.find((r) => r.id === 'open-q2')?.action, { kind: 'open', taskId: 'q2' });
  // The window is counted from the minute the list was read, with a few minutes' grace.
  const later = openSuggestions([quick], [gap('10:31', '11:00', 29)], TODAY, { date: TODAY, time: '10:34' });
  eq('3 minutes after it opened it is still offered, and still adds', later.map((r) => r.action.kind), ['schedule']);
  const gone = openSuggestions([quick], [gap('10:31', '11:00', 29)], TODAY, { date: TODAY, time: '10:45' });
  eq('a stale window (read at 10:31, now 10:45) is not offered as if it were new: the row only opens',
    gone.map((r) => r.action.kind), ['open']);
}

console.log('\nInterviews later this week (17.10)');
{
  const monday = mk({ id: 'wd', text: 'Interview with Workday', category: 'interview', date: '2026-10-19', fixedTime: '11:00' } as any);
  const rows = upcomingInterviewSuggestions([monday], [], { date: '2026-10-17', time: '19:12' });
  eq("Monday's interview, seen on Saturday → a prep row", rows.map((r) => r.id), ['upcoming-prep-wd']);
  check('…naming its day and hour', /19\.10 11:00/.test(rows[0].title) && /בעוד 2 ימים/.test(rows[0].whyHe), rows[0]?.title);
  eq('tomorrow is not doubled here', upcomingInterviewSuggestions([{ ...monday, date: '2026-10-18' } as any], [], { date: '2026-10-17', time: '19:12' }).length, 0);
  const running = mk({ id: 'prep-1d-int1', text: 'Final review', date: TODAY, fixedTime: '19:00', prepForTaskId: 'int1' } as any);
  eq("a review already under way does not hide tomorrow's prep",
    tomorrowSuggestions([interview], [running], { date: TODAY, time: '19:12' }).filter((r) => r.id.includes('prep')).length, 1);
}

console.log('\nRanking by time relevance');
{
  const input = (time: string): SuggestionInput => base(time, {
    today: { ok: true, data: [] },
    tomorrow: { ok: true, data: [interview, earlyMeeting] },
    gaps: { ok: true, data: [gap('16:00', '17:30', 90)] },
    way: { ok: true, data: [way()] },
    wake: { usualWakeTime: '07:30', routineMinutes: 45 },
  });
  const evening = rankSuggestions(input('21:00'));
  check('21:00: tomorrow\'s asks lead', evening.rows[0].source === 'tomorrow' && evening.rows[1].source === 'tomorrow',
    evening.rows.map((r) => r.id).join(', '));
  const morning = rankSuggestions(input('09:00'));
  check('09:00: tomorrow\'s asks are not the headline', morning.rows[0].source !== 'tomorrow',
    morning.rows.map((r) => r.id).join(', '));
  const afternoon = rankSuggestions({
    ...input('16:45'),
    way: { ok: true, data: [way({ pass_at: '17:10' })] },
  });
  eq('16:45: the errand she passes at 17:10 outranks everything else', afternoon.rows[0].source, 'way');
  const nearGap = rankSuggestions(base('10:00', {
    gaps: { ok: true, data: [gap('10:05', '11:00', 55, 'Near idea'), gap('16:00', '18:00', 120, 'Far idea')] },
  }));
  eq('a window opening in 5 minutes beats one at four o\'clock', nearGap.rows[0].title, 'Near idea');
}

console.log('\nA failed source contributes nothing, and says why');
{
  const r = rankSuggestions(base('19:00', {
    tomorrow: { ok: false, reason: 'storage unreadable' },
    way: { ok: false, reason: 'places_refused' },
    gaps: { ok: true, data: [gap('20:00', '21:00', 60)] },
    open: { ok: false, reason: 'boom' },
  }));
  eq('only the source that answered gives rows', r.rows.map((x) => x.source), ['gap']);
  eq('every failure is reported with its reason', r.skipped, [
    { source: 'tomorrow', reason: 'storage unreadable' },
    { source: 'way', reason: 'places_refused' },
    { source: 'open', reason: 'boom' },
  ]);
  const allDown = rankSuggestions(base('19:00', {
    tomorrow: { ok: false, reason: 'a' }, way: { ok: false, reason: 'b' },
    gaps: { ok: false, reason: 'c' }, open: { ok: false, reason: 'd' },
  }));
  eq('all four down → no rows, four reasons, no invented filler', [allDown.rows.length, allDown.skipped.length], [0, 4]);
  const noToday = rankSuggestions(base('18:00', {
    today: { ok: false, reason: 'today unreadable' },
    tomorrow: { ok: true, data: [interview] },
  }));
  eq('today unreadable → no prep proposed (it may already be there)', noToday.rows.length, 0);
  eq('…and the reason is kept', noToday.skipped, [{ source: 'tomorrow', reason: 'today unreadable' }]);
  const empty = rankSuggestions(base('12:00', { gaps: { ok: true, data: [] }, open: { ok: true, data: [] } }));
  eq('answered-and-empty is NOT a failure', [empty.rows.length, empty.skipped.length], [0, 0]);
}

console.log('\nLimits');
{
  const many = rankSuggestions(base('21:00', {
    tomorrow: { ok: true, data: [interview, earlyMeeting] },
    today: { ok: true, data: [] },
    way: { ok: true, data: [way(), { ...way(), task: { id: 'l2', text: 'Post office' } }] },
    gaps: { ok: true, data: [gap('21:05', '22:00', 55, 'A'), gap('21:10', '22:00', 50, 'B'), gap('21:15', '22:00', 45, 'C')] },
    open: { ok: true, data: [mk({ id: 'a', text: 'a', durationMinutes: 20 }), mk({ id: 'b', text: 'b', durationMinutes: 20 }), mk({ id: 'c', text: 'c', durationMinutes: 20 })] },
    wake: { usualWakeTime: '07:30', routineMinutes: 45 },
  }));
  check(`never more than ${MAX_ROWS} rows`, many.rows.length <= MAX_ROWS, String(many.rows.length));
  const per: Record<string, number> = {};
  many.rows.forEach((r) => { per[r.source] = (per[r.source] ?? 0) + 1; });
  check('…and no source floods the list', (per.open ?? 0) <= 4 && Object.entries(per).every(([k, c]) => k === 'open' || c <= 3), JSON.stringify(per));
  const same = rankSuggestions(base('14:00', {
    gaps: { ok: true, data: [gap('15:00', '16:30', 90, 'Finish the report', { taskId: 'dup', draftText: undefined })] },
    open: { ok: true, data: [mk({ id: 'dup', text: 'Finish the report', durationMinutes: 30 })] },
  }));
  eq('the same task is never offered twice', same.rows.filter((r) => 'taskId' in r.action && (r.action as any).taskId === 'dup').length, 1);
}

console.log(`\n${failures ? '✗' : '✓'} ${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
