/**
 * run-interview-brief — which interviews get a brief, and what the card says
 * when it cannot make one.
 *
 * 17.10, the evening before her "koral Technical Interview" at "רפאל מכון
 * דוד" (13:30): that interview was never researched, because the brief was
 * drawn only for the gold "next up" pill, and tomorrow's 13:30 is not next
 * while today still has things in it. These pin the pick, and that every way
 * of having no brief has a sentence in BOTH languages.
 *
 * Run:  npx tsx tests/run-interview-brief.ts
 */
import {
  pickInterviewForDate, pickUpcomingInterviews, prepSlotFor, addDaysKey,
  briefReasonLine, missingLine, interviewChipLabel, prepBlockChipLabel,
  MAX_INTERVIEW_BRIEFS,
} from '../src/utils/interviewBrief';
import { Task } from '../src/types/index';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

const task = (id: string, date: string, fixedTime: string | undefined, extra: Partial<Task> = {}): Task => ({
  id, text: id, category: 'general', priority: 'need_to', isFixed: !!fixedTime,
  fixedTime, durationMinutes: 60, date, status: 'pending',
  createdAt: 0, historicalDurations: [],
  ...extra,
} as Task);

const TODAY = '2026-10-17';
const TOMORROW = '2026-10-18';
const now = new Date(2026, 9, 17, 18, 30).getTime();      // Saturday evening, the night before

// Her real event: typed by her, category interview, the venue in Hebrew.
const rafael = task('gcal-rafael', TOMORROW, '13:30', {
  text: 'koral Technical Interview', category: 'interview',
  location: { address: 'רפאל מכון דוד', displayName: 'רפאל מכון דוד', lat: 0, lng: 0, confirmed: false } as any,
});

console.log('\nwhich interview');
check('tomorrow\'s first interview is picked for tomorrow',
  pickInterviewForDate([task('gym', TOMORROW, '08:00'), rafael], TOMORROW)?.id === 'gcal-rafael');
check('and never for the day before',
  pickInterviewForDate([rafael], TODAY) === null);
check('the earlier of two interviews wins',
  pickInterviewForDate([
    task('late', TOMORROW, '16:00', { category: 'interview' }),
    task('early', TOMORROW, '09:00', { category: 'interview' }),
  ], TOMORROW)?.id === 'early');
check('an interview is recognised by its words too, not only its category',
  pickInterviewForDate([task('x', TOMORROW, '10:00', { text: 'ראיון עבודה ברפאל' })], TOMORROW)?.id === 'x');
check('a done or moved interview is skipped',
  pickInterviewForDate([
    { ...rafael, status: 'complete' } as Task,
    { ...rafael, id: 'b', status: 'moved' } as Task,
  ], TOMORROW) === null);
check('our own study block is not an interview',
  pickInterviewForDate([
    task('prep-1d-gcal-rafael', TOMORROW, '19:00', { text: 'Final review for Rafael — questions to ask, what to wear, the route' }),
    task('prep-2d-gcal-rafael', TOMORROW, '19:00', { text: 'Prep for the Rafael interview — company, role, questions' }),
  ], TOMORROW) === null);
check('a gym session is not an interview', pickInterviewForDate([task('gym', TOMORROW, '18:00')], TOMORROW) === null);

console.log('\nwhich interviews are researched');
const picked = (all: Task[]) => pickUpcomingInterviews(all, now, TODAY).map((t) => t.id);
check('tomorrow\'s interview is researched tonight (it is not "next up": today has things)',
  picked([task('dinner', TODAY, '20:00'), rafael]).includes('gcal-rafael'));
check('three days out is the edge: today + 2',
  picked([task('a', addDaysKey(TODAY, 2), '10:00', { category: 'interview' })]).length === 1
  && picked([task('b', addDaysKey(TODAY, 3), '10:00', { category: 'interview' })]).length === 0);
check('an interview today whose time has gone is not researched',
  picked([task('gone', TODAY, '09:00', { category: 'interview' })]).length === 0);
check('an interview later today is',
  picked([task('later', TODAY, '21:00', { category: 'interview' })]).length === 1);
check('at most two (each costs up to six searches and a model call)',
  pickUpcomingInterviews([
    task('i1', TODAY, '19:00', { category: 'interview' }),
    task('i2', TOMORROW, '10:00', { category: 'interview' }),
    task('i3', TOMORROW, '15:00', { category: 'interview' }),
  ], now, TODAY).length === MAX_INTERVIEW_BRIEFS);
check('soonest first',
  picked([
    task('i3', TOMORROW, '15:00', { category: 'interview' }),
    task('i1', TODAY, '19:00', { category: 'interview' }),
  ])[0] === 'i1');
check('two rows for ONE meeting are researched once, the calendar row',
  (() => {
    const twin = { ...rafael, id: 'typed-1', createdAt: 5 } as Task;
    const ids = picked([twin, rafael]);
    return ids.length === 1 && ids[0] === 'gcal-rafael';
  })());
check('two interviews at the same minute share one brief',
  picked([
    task('a', TOMORROW, '10:00', { category: 'interview', text: 'ראיון ראשון - חיפה' }),
    task('b', TOMORROW, '10:00', { category: 'interview', text: 'ראיון עבודה רפאל' }),
  ]).length === 1);
check('nothing upcoming → none', picked([task('x', TOMORROW, '10:00')]).length === 0);

console.log('\nthe study block the chip points at');
const study = task('prep-1d-gcal-rafael', TODAY, '19:00', {
  text: 'Final review for Rafael', durationMinutes: 45, scheduledTime: '19:00',
  prepForTaskId: 'gcal-rafael',
} as any);
const slot = prepSlotFor(rafael, [rafael, study], TODAY, '18:30');
check('the block already on her day is named', slot?.date === TODAY && slot.time === '19:00' && slot.minutes === 45,
  JSON.stringify(slot));
check('a block whose hour has gone is not offered',
  prepSlotFor(rafael, [rafael, study], TODAY, '19:30') === null);
check('no block → no promise', prepSlotFor(rafael, [rafael], TODAY, '18:30') === null);
check('a done block is not offered',
  prepSlotFor(rafael, [rafael, { ...study, status: 'complete' } as Task], TODAY, '18:30') === null);
check('another interview\'s block is not this one\'s',
  prepSlotFor(rafael, [rafael, { ...study, id: 'prep-1d-other', prepForTaskId: 'other' } as any], TODAY, '18:30') === null);

console.log('\nwhat the card says');
const REASONS = ['no_company', 'nothing_to_research', 'search_not_configured', 'search_failed', 'no_sources',
  'compose_failed', 'nothing_cited', 'unreachable', 'no_event', 'something_new'];
for (const r of REASONS) {
  const he = briefReasonLine(r, true);
  const en = briefReasonLine(r, false);
  check(`reason "${r}" has a sentence in both languages`,
    he.length > 8 && en.length > 8 && he !== en && /[֐-׿]/.test(he) && !/[֐-׿]/.test(en));
}
check('no company names the fix', briefReasonLine('no_company', true).includes('חסר שם חברה')
  && briefReasonLine('no_company', false).includes('no company name'));
check('search unavailable says so', briefReasonLine('search_not_configured', false).includes('unavailable'));
check('an unreachable server is not blamed on the event',
  !briefReasonLine('unreachable', true).includes('חברה') && !briefReasonLine('unreachable', false).includes('company'));
check('every empty section has its own sentence in both languages',
  (['role', 'likely_questions', 'prep'] as const).every((s) =>
    missingLine(s, true) !== missingLine(s, false) && missingLine(s, true).length > 8));
check('"no questions" is said, in her words', missingLine('likely_questions', true) === 'לא מצאתי שאלות שדווחו על הראיון הזה');

console.log('\nthe chip');
check('want to prepare + brief + the time already set aside',
  interviewChipLabel(true, { ok: true, prep: slot, today: TODAY }) === 'רוצה להתכונן? 📄 תדריך · ⏱ הכנה היום 19:00 ›');
check('tomorrow is said as tomorrow',
  interviewChipLabel(false, { ok: true, prep: { date: TOMORROW, time: '08:00', minutes: 60 }, today: TODAY })
    === 'Prepare? 📄 Brief · ⏱ prep tomorrow 08:00 ›');
check('a later day is a date', interviewChipLabel(true, { ok: true, prep: { date: '2026-10-20', time: '19:00', minutes: 45 }, today: TODAY })
  .includes('20.10'));
check('no block → the chip does not promise one',
  !interviewChipLabel(true, { ok: true, prep: null, today: TODAY }).includes('⏱'));
check('a failed brief keeps its chip and asks "why none?"',
  interviewChipLabel(true, { ok: false, today: TODAY }).includes('למה אין')
  && interviewChipLabel(false, { ok: false, today: TODAY }).includes('why none'));
check('a study block links to its interview\'s brief',
  prepBlockChipLabel(true, true) === '📄 תדריך לראיון ›' && prepBlockChipLabel(false, true) === '📄 Interview brief ›');
check('and says why none when it failed', prepBlockChipLabel(false, false).includes('why none'));
check('a chip fits a phone row (<= 46 characters)',
  [interviewChipLabel(true, { ok: true, prep: { date: TOMORROW, time: '08:00', minutes: 60 }, today: TODAY }),
    interviewChipLabel(false, { ok: true, prep: { date: TOMORROW, time: '08:00', minutes: 60 }, today: TODAY }),
    interviewChipLabel(true, { ok: false, today: TODAY })].every((l) => l.length <= 46));

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) process.exit(1);
