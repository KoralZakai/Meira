/**
 * run-voice-plan — "say it, and see your day", the parts that are arithmetic.
 *
 *   "I must work today on Meira for the hackathon, also study for the next
 *    interview in Ceva (the second interview)."
 *
 * The study task has to be tied to the Ceva interview she already has, so the
 * planner ends it before she leaves. And whatever went wrong on the way — the
 * calendar not checked, no location, a task that did not fit — has to be said,
 * in both languages, never folded into "done".
 *
 *   npx tsx tests/run-voice-plan.ts
 */
import { Task } from '../src/types/index';
import {
  distinctiveWords, linkPrepTasks, describePlan, spokenLine, VoicePlanReport,
} from '../src/utils/voicePlan';

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); } else { fail += 1; console.error(`  ✗ ${label}`); }
};
const section = (s: string) => console.log(`\n${s}`);

const TODAY = '2026-09-27';
const task = (p: Partial<Task> & { id: string; text: string }): Task => ({
  category: 'general', priority: 'need_to', isFixed: false, durationMinutes: 30,
  date: TODAY, status: 'pending', createdAt: 0, historicalDurations: [], ...p,
} as Task);

const CEVA = task({
  id: 'gcal-ceva-2', text: 'Ceva — second interview', category: 'interview',
  isFixed: true, fixedTime: '14:30', date: '2026-09-29',
});
const OTHER = task({
  id: 'gcal-acme', text: 'Interview at Acme Robotics', category: 'interview',
  isFixed: true, fixedTime: '10:00', date: '2026-09-28',
});
const PAST_CEVA = task({
  id: 'gcal-ceva-1', text: 'Ceva — phone interview', category: 'interview',
  isFixed: true, fixedTime: '11:00', date: '2026-09-20',
});
const WORK = task({ id: 'n-work', text: 'Work on the Meira app for the hackathon', category: 'work', priority: 'must' });

section('1. "study for the next interview in Ceva" is tied to the Ceva interview');
{
  const prep = task({ id: 'n-prep', text: 'Study for the next interview in Ceva' });
  const links = linkPrepTasks([WORK, prep], [OTHER, CEVA, PAST_CEVA, WORK, prep], TODAY);
  ok(links.length === 1, `one link (${links.length})`);
  ok(links[0]?.eventId === 'gcal-ceva-2', `to the UPCOMING Ceva interview, not Acme, not the past one (${links[0]?.eventId})`);
  ok(links[0]?.patch.deadline === '2026-09-29' && links[0]?.patch.deadlineTime === '14:30',
    'and it carries the interview as its deadline');
  ok(!links.some((l) => l.taskId === 'n-work'), 'the work task is not preparation for anything');
}

section('2. the same in Hebrew — a preposition glued to the name');
{
  const heLatin = task({ id: 'h1', text: 'ללמוד לראיון הבא בCeva' });
  const heEvent = task({ id: 'gcal-he', text: 'ראיון עבודה בסיוה', category: 'interview',
    isFixed: true, fixedTime: '09:30', date: '2026-09-30' });
  const heHebrew = task({ id: 'h2', text: 'להתכונן לראיון בסיוה' });
  const a = linkPrepTasks([heLatin], [CEVA, OTHER], TODAY);
  const b = linkPrepTasks([heHebrew], [heEvent, OTHER], TODAY);
  ok(a[0]?.eventId === 'gcal-ceva-2', `"בCeva" matches "Ceva" (${a[0]?.eventId})`);
  ok(b[0]?.eventId === 'gcal-he', `"בסיוה" matches "בסיוה" after the prefix (${b[0]?.eventId})`);
  ok(distinctiveWords('ללמוד לראיון הבא').length === 0, 'generic Hebrew words carry no identity');
}

section('3. never guess between two interviews');
{
  const vague = task({ id: 'v', text: 'Prepare for the interview' });
  ok(linkPrepTasks([vague], [CEVA, OTHER], TODAY).length === 0, 'two interviews coming → no link');
  ok(linkPrepTasks([vague], [CEVA], TODAY)[0]?.eventId === 'gcal-ceva-2', 'exactly one → linked');
  const done = task({ ...CEVA, id: 'done-ceva', status: 'complete' } as any);
  ok(linkPrepTasks([vague], [done], TODAY).length === 0, 'a completed interview is not something to prepare for');
}

section('4. what she reads afterwards');
const base: VoicePlanReport = {
  created: [WORK], placed: [], unplaced: [], prepLinks: [],
  calendarError: null, calendarAdded: 0, location: 'here', plannerOffline: false,
};
{
  const r = { ...base, placed: [
    { id: 'n-work', text: 'Work on the Meira app for the hackathon', start: '08:15', end: '11:15', why: 'focus_morning' },
    { id: 'n-prep', text: 'Study for Ceva', start: '11:25', end: '12:55', why: 'before_deadline' },
  ] };
  const en = describePlan(r, false, '', TODAY);
  const he = describePlan(r, true, '', TODAY);
  // The outcome of what she asked for: the work block she said, and its slot.
  // "Study for Ceva" was not in this request, so it is not on this screen.
  ok(en.headline.includes('Work on the Meira app') && en.headline.includes('08:15') && !en.headline.includes('11:25'),
    `headline is her request and its slot — ${en.headline}`);
  ok(he.headline.includes('08:15'), `Hebrew too — ${he.headline}`);
  ok(en.problems.length === 0 && he.problems.length === 0, 'nothing went wrong → nothing extra to read');
  ok(spokenLine(r, false, '', TODAY) === 'Set: Work on the Meira app for the hackathon, today at 08:15.',
    `spoken: ${spokenLine(r, false, '', TODAY)}`);
}

section('5. every failure on the way is said, in both languages');
{
  const r: VoicePlanReport = {
    ...base,
    created: [WORK, task({ id: 'u', text: 'Repaint the flat', location: 'Herzl 10' as any })],
    placed: [{ id: 'n-work', text: 'Study', start: '09:00', end: '09:50', why: 'shortened', shortened_from: 180 }],
    unplaced: [{ id: 'u', text: 'Repaint the flat', why: 'no_window', need: 900, largest: 95 }],
    calendarError: 'Google refused (403) — enable the Calendar API',
    location: 'denied',
  };
  const en = describePlan(r, false, '', TODAY);
  const he = describePlan(r, true, '', TODAY);
  ok(en.problems.length === 4, `calendar + location + shortened + unplaced (${en.problems.length})`);
  ok(he.problems.length === en.problems.length, 'the Hebrew report says as much as the English one');
  ok(en.problems[0].includes('enable the Calendar API'), "Google's own words reach her");
  ok(en.problems.some((p) => p.includes('shortened to 50 min')), 'a shortened block says by how much');
  ok(en.problems.some((p) => p.includes('no free 900 min')), 'an unplaced task says why');
}

section('6. nothing saved is not "done"');
{
  const r = { ...base, created: [] };
  ok(describePlan(r, false).headline.includes("didn't catch"), 'says nothing was added');
  ok(describePlan({ ...base, plannerOffline: true }, true).problems.length === 1,
    'planner unreachable is its own line');
}

section('7. 28.9: the screen after a recording is about THAT recording');
{
  const duty = task({ id: 'm1', text: 'מילואים', category: 'work', isFixed: true, fixedTime: '08:00',
    durationMinutes: 480, date: '2026-10-08', location: 'פיקוד העורף, רמלה' as any });
  const r: VoicePlanReport = {
    ...base, created: [duty],
    unplaced: [{ id: 'study', text: 'למידה לראיון עבודה', why: 'no_window', need: 90, largest: 0 },
      { id: 'cv', text: 'לשלוח קורות חיים לצ׳קפוינט', why: 'no_window', need: 15, largest: 0 }],
  };
  const reply = "נקבע ✓\n⚠️ ב-8.10 'מילואים' (08:00–16:00) מתנגש עם 'ראיון ברפאל' ב-12:00. צריך להזיז את 'ראיון ברפאל' — לבקש מועד אחר?";
  const out = describePlan(r, true, reply, TODAY);
  ok(out.headline.includes('מילואים') && out.headline.includes('8.10') && out.headline.includes('08:00–16:00')
    && out.headline.includes('רמלה'), `what, which day, from–to, where — ${out.headline}`);
  ok(!out.problems.some((p) => p.includes('למידה') || p.includes('קורות חיים')),
    'tasks she did not mention are not on this screen');
  ok(out.problems.some((p) => p.includes('ראיון ברפאל')), 'the clash reaches the screen even though a task was saved');
  ok(out.problems.some((p) => p.includes('מסלול')), 'what follows: route / leave time / alarm');
  const unclear = describePlan({ ...base, created: [] }, true, 'באיזה תאריך המילואים?', TODAY);
  ok(unclear.problems.includes('באיזה תאריך המילואים?'), 'an unclear request shows her question');
  ok(spokenLine({ ...base, created: [] }, true, 'באיזה תאריך המילואים?') === 'באיזה תאריך המילואים?',
    'and says it out loud');
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
