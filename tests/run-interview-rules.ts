/**
 * run-interview-rules — the three rules Koral asked for, on the real interview.
 *
 *   1. An interview must be RECOGNISED as one. The calendar import used to run
 *      `category: e.meetingUrl ? 'zoom' : 'meeting'` and never look at the
 *      title, so "Your in-person interview with Ceva" arrived as a generic
 *      45-minute `meeting` and nothing keyed to `interview` ever fired.
 *
 *   2. "מאירה מחייבת!!! ללמוד יומיים לפני" — an interview on the calendar
 *      creates study blocks two days before and one day before, as `must`,
 *      automatically, and creates them exactly once however often we sync.
 *
 *   3. "נסיעה ברכבת!! ... ואם אין לשם רכבת אז אוטובוס" — rail first, bus
 *      underneath, and never a late train over a bus that arrives in time.
 *      getPlanForMode('train') answers null when there is no rail route, and
 *      asking it once turned that into no plan at all: no route, no leave
 *      time, no alarm, silently.
 *
 * Run:  npx tsx tests/run-interview-rules.ts
 */
import { inferFromText, categoryForCalendarEvent } from '../src/utils/categorize';
import {
  prepTasksFor, missingPrepTasks, daysBefore, isInterview, subjectOf,
  morningPrepWindow, departureTimeOf, GET_READY_BUFFER_MIN, EARLIEST_PREP_START,
  isPrepBlock, isNestedPrep, runawayPrepIds,
} from '../src/utils/interviewPrep';
import { plannedAlarmTime } from '../src/utils/alarmPlan';
import {
  modeLadder, planWithFallback, bestPlanInTime, fallbackNote, arrivesInTime,
  pickByPreference, rankPlans, arrivalBufferFor, marginNote, slackMinutes, missesTargetBy,
  MUST_ARRIVAL_BUFFER_MIN,
} from '../src/utils/transitFallback';
import type { Task, TransitPlan } from '../src/types/index';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

const TITLE = 'Your in-person interview with Ceva';
const DATE = '2026-09-23';
const TODAY = '2026-09-22';

// ───────────────────────────────────────────────────────────────────────────
console.log('\n1. An interview is recognised as an interview\n');

const label = categoryForCalendarEvent(TITLE, false);
check('the Ceva event is an interview, not a meeting',
  label.category === 'interview', label.category);
check('it is a MUST — it floats to the top of the day',
  label.priority === 'must', label.priority);
check('90 minutes, not the 45-minute meeting default',
  label.durationMinutes === 90, `${label.durationMinutes} min`);

check('Hebrew works identically', inferFromText('ראיון עבודה במיקרוסופט').category === 'interview');
check('"interview" beats "meeting" when both appear — order matters',
  inferFromText('meeting: interview with Ceva').category === 'interview');
check('an interview held over video is STILL an interview',
  categoryForCalendarEvent('Interview with Ceva', true).category === 'interview',
  categoryForCalendarEvent('Interview with Ceva', true).category);
check('an unlabelled event with a real video link is a zoom',
  categoryForCalendarEvent('Weekly sync-up', true).category === 'zoom');
check('a generic match with NO video link keeps its own label',
  categoryForCalendarEvent('Call Dana', false).category === 'call'
  && categoryForCalendarEvent('Call Dana', false).durationMinutes === 15,
  categoryForCalendarEvent('Call Dana', false).category);
check('the same title WITH a video link becomes a zoom',
  categoryForCalendarEvent('Call Dana', true).category === 'zoom');
check('an unlabelled event with no link stays a meeting',
  categoryForCalendarEvent('Coffee with Dana', false).category === 'meeting');
check('urgency in the words still overrides',
  inferFromText('דחוף לקנות חלב').priority === 'must');

// ───────────────────────────────────────────────────────────────────────────
console.log('\n2. Two days before, Meira REQUIRES preparation\n');

const interview = {
  id: 'gcal-ceva', text: TITLE, date: DATE, category: 'interview',
  priority: 'must', status: 'pending', fixedTime: '14:30',
  durationMinutes: 90, isFixed: true, createdAt: 0, historicalDurations: [],
} as unknown as Task;

check('daysBefore does local calendar maths', daysBefore(DATE, 2) === '2026-09-21',
  daysBefore(DATE, 2));
check('it survives a month boundary', daysBefore('2026-10-01', 2) === '2026-09-29',
  daysBefore('2026-10-01', 2));
check('the interview is detected', isInterview(interview));
check('a row imported before the categoriser existed is still detected',
  isInterview({ ...interview, category: 'meeting' } as Task), 'by its words');
check('the company is pulled out for the title', subjectOf(interview) === 'Ceva',
  subjectOf(interview));

// From far enough out, both blocks exist.
const early = prepTasksFor(interview, { lang: 'he', today: '2026-09-10' });
check('three prep blocks are created', early.length === 3, `${early.length}`);
check('the first lands two days before', early[0].date === '2026-09-21', early[0].date);
check('the second lands the day before', early[1].date === '2026-09-22', early[1].date);
check('the third is the interview day itself', early[2].date === DATE, early[2].date);
check('all are MUST — she said מחייבת',
  early.every((t) => t.priority === 'must'));
check('the deep one is 90 minutes, the review 45',
  early[0].durationMinutes === 90 && early[1].durationMinutes === 45,
  `${early[0].durationMinutes}/${early[1].durationMinutes}`);
check('they name the company, so two interviews do not blur together',
  early.every((t) => t.text.includes('Ceva')), early[0].text);
check('they are categorised as study',
  early.every((t) => t.category === 'course'));
check('they link back to the interview',
  early.every((t) => (t as any).prepForTaskId === 'gcal-ceva'));

const en = prepTasksFor(interview, { lang: 'en', today: '2026-09-10' });
check('both languages produce the same shape, different words',
  en.length === 3 && en[0].text !== early[0].text && en[0].date === early[0].date);

// From TODAY, D-2 has already gone. One real block beats two impossible ones.
const late = prepTasksFor(interview, { lang: 'he', today: TODAY });
check('a prep day that has already passed is not invented',
  late.length === 2 && late[0].date === TODAY, `${late.length} on ${late[0]?.date}`);

check('the EVENING blocks are never created on or after the interview itself',
  prepTasksFor({ ...interview, date: TODAY } as Task, { lang: 'he', today: TODAY, now: '23:00' })
    .length === 0);
check('a non-interview gets no prep',
  prepTasksFor({ ...interview, text: 'Dentist', category: 'doctor' } as Task,
    { lang: 'he', today: '2026-09-10' }).length === 0);

// Idempotence — this runs every 15 minutes, forever.
const firstRun = missingPrepTasks([interview], [interview], { lang: 'he', today: '2026-09-10' });
const store = [interview, ...firstRun];
const secondRun = missingPrepTasks([interview], store, { lang: 'he', today: '2026-09-10' });
check('the first sync creates them', firstRun.length === 3);
check('every later sync creates nothing — ids are derived, not minted',
  secondRun.length === 0, `${secondRun.length}`);

// ───────────────────────────────────────────────────────────────────────────
console.log('\n2b. The morning of — up early, study, THEN leave\n');

/*
 * Koral, 2026-09-22: "on the interview day on the morning Meira suggests to
 * wake up early and learn before leaving home".
 *
 * The evening blocks sit at a fixed hour. This one cannot: it is defined by
 * the front door. It ends a get-ready buffer before `leaveHomeBy` and runs
 * backwards from there, so the hour it starts — and therefore the hour the
 * alarm rings — is a consequence of the actual journey.
 */

// The real one: Ceva, 14:30 in Ra'anana, route computed, leave home 13:18.
const routed = {
  ...interview,
  location: {
    address: '7 HaPnina Street, Ra\'anana', lat: 32.18, lng: 34.87,
    confirmed: true, leaveHomeBy: '13:18', wakeUpBy: '12:38',
  },
} as unknown as Task;

check('the departure is read from the route', departureTimeOf(routed) === '13:18',
  String(departureTimeOf(routed)));

const win = morningPrepWindow(routed, 90);
check('there is a window', win !== null);
check(`it ends ${GET_READY_BUFFER_MIN} min before she leaves`, win?.endsAt === '12:48', win?.endsAt);
check('and runs the full 90 minutes back from there', win?.start === '11:18' && win?.minutes === 90,
  `${win?.start} · ${win?.minutes} min`);

const withRoute = prepTasksFor(routed, { lang: 'he', today: TODAY });
const morning = withRoute.find((t) => t.date === DATE);
check('a block lands on the interview day itself', Boolean(morning), morning?.date);
check('at the hour the window opens', morning?.scheduledTime === '11:18', morning?.scheduledTime);
check('it is FIXED — it ends when she has to start getting ready',
  morning?.isFixed === true && morning?.fixedTime === '11:18', morning?.fixedTime);
check('and it is study, like the others', morning?.category === 'course' && morning?.priority === 'must');

// THE POINT OF THE WHOLE THING: the morning now starts earlier.
// plannedAlarmTime's third source is `fixedTime` minus the morning routine —
// which is why the block carries one. Route alone woke her at 12:38.
check('the wake time follows it, not the route',
  plannedAlarmTime(morning as Task, 40) === '10:38',
  String(plannedAlarmTime(morning as Task, 40)));
check('which is two hours earlier than the route alone would have asked',
  plannedAlarmTime(routed, 40) === '12:38', String(plannedAlarmTime(routed, 40)));

// An interview with a PLACE but no route yet: do not guess.
const unrouted = {
  ...interview,
  location: { address: '7 HaPnina Street, Ra\'anana', lat: 0, lng: 0, confirmed: false },
} as unknown as Task;
check('a placed interview with no route yet yields no departure',
  departureTimeOf(unrouted) === undefined, String(departureTimeOf(unrouted)));
check('so no morning block is invented from the appointment hour',
  prepTasksFor(unrouted, { lang: 'he', today: TODAY }).every((t) => t.date !== DATE));

// A remote interview has no journey — its own hour is the deadline.
const remote = { ...interview, fixedTime: '09:00' } as unknown as Task;
check('a remote interview uses its own start', departureTimeOf(remote) === '09:00');
const remoteWin = morningPrepWindow(remote, 90);
check('and gets a genuine early morning', remoteWin?.start === '07:00' && remoteWin?.minutes === 90,
  `${remoteWin?.start} · ${remoteWin?.minutes}`);

// Floors and clamps.
const veryEarly = { ...interview, fixedTime: '07:00' } as unknown as Task;
const clamped = morningPrepWindow(veryEarly, 90);
check(`nothing starts before ${EARLIEST_PREP_START}`, clamped?.start === EARLIEST_PREP_START,
  clamped?.start);
check('the block shortens rather than moving the floor', clamped?.minutes === 30, `${clamped?.minutes}`);

const tooEarly = { ...interview, fixedTime: '06:20' } as unknown as Task;
check('an appointment too early to prepare for gets no block — not a 10-minute one',
  morningPrepWindow(tooEarly, 90) === null);

// On the day itself the clock matters.
check('a window already underway starts NOW, not in the past',
  morningPrepWindow(routed, 90, { now: '12:00' })?.start === '12:00',
  morningPrepWindow(routed, 90, { now: '12:00' })?.start);
check('...and keeps the 48 minutes that are left',
  morningPrepWindow(routed, 90, { now: '12:00' })?.minutes === 48,
  `${morningPrepWindow(routed, 90, { now: '12:00' })?.minutes}`);
check('a window with under half an hour left is not offered',
  morningPrepWindow(routed, 90, { now: '12:30' }) === null);
check('the clock only applies to the interview DAY',
  prepTasksFor(routed, { lang: 'he', today: TODAY, now: '23:50' })
    .some((t) => t.date === DATE), 'tonight 23:50 does not cancel tomorrow morning');

// An AFTERNOON appointment still gets its block — "learn as much as you can
// before" is not a morning-only rule — but it must not call itself morning.
const afternoon = {
  ...interview, fixedTime: '18:00',
  location: { address: 'Herzliya', lat: 32.16, lng: 34.84, confirmed: true, leaveHomeBy: '16:00' },
} as unknown as Task;
check('an afternoon interview still gets a study block',
  morningPrepWindow(afternoon, 90)?.start === '14:00', morningPrepWindow(afternoon, 90)?.start);

// Both languages, and the title tells the truth about which one it is.
for (const lang of ['he', 'en'] as const) {
  const m = prepTasksFor(routed, { lang, today: TODAY }).find((t) => t.date === DATE)!;
  const pm = prepTasksFor(afternoon, { lang, today: TODAY }).find((t) => t.date === DATE)!;
  check(`[${lang}] an 11:18 start IS the morning, and says so`,
    /morning|בוקר/i.test(m.text), m.text);
  check(`[${lang}] a 14:00 start does not claim to be`, !/morning|בוקר/i.test(pm.text), pm.text);
  check(`[${lang}] both name the company`, m.text.includes('Ceva') && pm.text.includes('Ceva'));
}

// Idempotent with three, the same as with two. From TODAY the D-2 day has
// gone, so the first sync creates the review and the morning.
const r1 = missingPrepTasks([routed], [routed], { lang: 'he', today: TODAY });
const r2 = missingPrepTasks([routed], [routed, ...r1], { lang: 'he', today: TODAY });
check('the two blocks still possible are created', r1.length === 2, `${r1.length}`);
check('and none on every sync after', r2.length === 0, `${r2.length}`);

// ───────────────────────────────────────────────────────────────────────────
console.log('\n2c. Preparation is not a thing to prepare for\n');

/*
 * Found on her phone, 2026-09-22, as "🎯 Morning study for Morning study for
 * Morning study for …", four hours wide, five new ones per sync.
 *
 * isInterview reads the task's WORDS, and the D-2 block's own title is "Prep
 * for the Ceva interview — company, role, questions". It contains "interview".
 * So the rule matched its own output. That had always been true and had always
 * been invisible, because a block dated D-2 generates D-4 and D-3, both in the
 * past, both thrown away by `date < today`. The morning block lands on the
 * SAME day — never in the past — so the recursion stopped terminating.
 *
 * CLAUDE.md rule 8: before adding a second reader of a field, ask what the
 * first one now sees. Here the first and second reader are the same function.
 */
const prepOfCeva = prepTasksFor(interview, { lang: 'en', today: '2026-09-10' });
const deepBlock = prepOfCeva[0];

check('the D-2 block really does contain the word that started this',
  /interview/i.test(deepBlock.text), deepBlock.text);
check('it is recognised as a prep block', isPrepBlock(deepBlock), deepBlock.id);
check('and is therefore NOT an interview, whatever its words say',
  !isInterview(deepBlock));
check('so it generates nothing', prepTasksFor(deepBlock, { lang: 'en', today: '2026-09-10' })
  .length === 0);
check('the morning block is refused too — it is the one that never expired',
  !isInterview(prepOfCeva[2]) && prepTasksFor(prepOfCeva[2], { lang: 'en', today: TODAY })
    .length === 0);

// The recursion is idempotent-proof now: feeding the whole store back in adds
// nothing, however many times it runs.
let fedBack: Task[] = [interview];
for (let i = 0; i < 5; i++) {
  fedBack = [...fedBack, ...missingPrepTasks(fedBack, fedBack, { lang: 'en', today: '2026-09-10' })];
}
check('five syncs produce three blocks, not fifteen', fedBack.length === 4, `${fedBack.length - 1}`);

// Cleaning up what already reached her store. The words cannot settle it —
// every one of these was minted as `prep-<n>d-<parent>`, so a nested one is a
// prep id whose PARENT is a prep id.
const nested = { ...deepBlock, id: 'prep-0d-prep-2d-gcal-ceva' } as Task;
check('a prep of a prep is identifiable by its id alone', isNestedPrep(nested), nested.id);
check('...at any depth', isNestedPrep({ ...nested, id: 'prep-0d-prep-0d-prep-1d-gcal-x' } as Task));
check('a legitimate prep block is NOT swept up with them',
  !isNestedPrep(deepBlock) && !isNestedPrep(prepOfCeva[2]), deepBlock.id);
check('and neither is anything else she owns',
  !isNestedPrep(interview) && !isNestedPrep({ ...interview, id: 'manual-123' } as Task));
check('a task merely CALLED prep is not one',
  !isPrepBlock({ ...interview, id: 'gcal-prep-talk', text: 'prep meeting' } as Task));

// THE SECOND SOURCE, found on her phone after the first fix shipped.
//
// The log still said "created 5 interview prep block(s)", and named them:
// "Prepare for: Your in-person in…", "Prepare for: להתכונן לראיון מח…",
// "Final review for להתכונן לראיו…". GapFillService offers "Prepare for: <the
// interview>" in a free window; accepting one calls addTask, which mints a
// RANDOM id — so no prep- id, no prepForTaskId, and a title carrying the word
// "interview" because the title is the interview's.
const gapFillPrep = {
  id: 'r4nd0m', text: 'Prepare for: Your in-person interview with Ceva',
  date: DATE, category: 'course', priority: 'must', status: 'pending',
  isFixed: false, durationMinutes: 120, createdAt: 0, historicalDurations: [],
} as unknown as Task;
const gapFillPrepHe = { ...gapFillPrep, id: 'r4nd0m2', text: 'להתכונן ל: ראיון בCeva' } as Task;

check('a GapFill prep block is recognised by its words, having no id to go on',
  isPrepBlock(gapFillPrep), gapFillPrep.text);
check('...in Hebrew too', isPrepBlock(gapFillPrepHe), gapFillPrepHe.text);
check('so it is not an interview either', !isInterview(gapFillPrep) && !isInterview(gapFillPrepHe));
check('and generates nothing',
  prepTasksFor(gapFillPrep, { lang: 'en', today: TODAY }).length === 0
  && prepTasksFor(gapFillPrepHe, { lang: 'he', today: TODAY }).length === 0);

// Cleanup has to reach the ones ALREADY built on top of a GapFill block. Their
// id is `prep-1d-r4nd0m` — a prep id whose parent is random, so isNestedPrep
// cannot see it. Only looking the parent up can.
const ontoGapFill = {
  ...deepBlock, id: 'prep-1d-r4nd0m', prepForTaskId: 'r4nd0m',
  text: 'Final review for Prepare for: Your in-person interview with Ceva',
} as unknown as Task;
check('it is not nested by id', !isNestedPrep(ontoGapFill), ontoGapFill.id);
const store2 = [interview, gapFillPrep, ontoGapFill, deepBlock, nested];
const sweep = runawayPrepIds(store2);
check('but the sweep finds it by looking its parent up',
  sweep.includes('prep-1d-r4nd0m'), sweep.join(', '));
check('along with the depth-nested ones', sweep.includes('prep-0d-prep-2d-gcal-ceva'));
check('the interview itself is never swept', !sweep.includes('gcal-ceva'));
check('nor a legitimate prep block', !sweep.includes(deepBlock.id));
check('nor the GapFill block she accepted herself — that one is hers',
  !sweep.includes('r4nd0m'), 'only what THIS file minted on top of it');

// ───────────────────────────────────────────────────────────────────────────
console.log('\n3. By train — and by bus when there is no train\n');

(async () => {

const plan = (mode: string, leave: string, arrive: string): TransitPlan => ({
  totalDurationMinutes: 50,
  leaveHomeAt: leave,
  arriveAt: arrive,
  firstBusDeparture: leave,
  firstBusStop: mode === 'train' ? 'Tel Aviv Savidor' : 'Arlozorov',
  walkToStopMinutes: 8,
  legs: [{
    type: mode as any, from: 'home', to: 'Ceva',
    durationMinutes: 40, departureTime: leave, arrivalTime: arrive,
  }],
  source: 'google',
  fetchedAt: 0,
});

// ── 3a. The margin she asked for ──────────────────────────────────────────
//
// Her two actual trains, 2026-09-22, for a 14:30 interview:
//
//   13:20 → 13:58   the quick one, 32 minutes in hand
//   13:30 → 14:16   the one Lumi chose, 14 minutes in hand
//
// rankPlans ordered by LATEST DEPARTURE — "every minute earlier is a minute
// spent waiting" — which is right for a gym class and wrong for an interview.
// "i think it's better to arrive on 14:00 or better the train which leave by
// 13:20 and arrives at 13:58 (the quicker one)".
console.log('\n3a. A must arrives with room to spare\n');

const quick = plan('train', '13:20', '13:58');
const scrape = plan('train', '13:30', '14:16');

check('the old rule really does prefer the later train',
  rankPlans([quick, scrape], '14:30')[0] === scrape, 'latest departure wins');
check('both of them do arrive in time',
  arrivesInTime(quick, '14:30') && arrivesInTime(scrape, '14:30'));
check('the difference is the margin: 32 minutes against 14',
  slackMinutes(quick, '14:30') === 32 && slackMinutes(scrape, '14:30') === 14,
  `${slackMinutes(quick, '14:30')} / ${slackMinutes(scrape, '14:30')}`);

const withRoom = rankPlans([scrape, quick], '14:30', { minBufferMinutes: 30 });
check('with a 30-minute cushion the quick one wins',
  withRoom[0] === quick, withRoom[0].arriveAt);
check('and the other is still offered, just second',
  withRoom[1] === scrape && withRoom.length === 2);

check('a must asks for the cushion', arrivalBufferFor({ priority: 'must' }) === MUST_ARRIVAL_BUFFER_MIN);
// Her ACTUAL row: the categoriser labels an interview `must`, and by the time
// it had been through the calendar import and the reconcile it was `have_to`.
// Keyed on priority alone, the one appointment she asked for this rule for
// would not have got it.
check('the Ceva interview is stored have_to, and STILL gets it',
  arrivalBufferFor({ priority: 'have_to', category: 'interview' }) === MUST_ARRIVAL_BUFFER_MIN,
  'the kind of thing it is counts too');
check('so does a doctor she cannot be late for',
  arrivalBufferFor({ priority: 'need_to', category: 'doctor' }) === MUST_ARRIVAL_BUFFER_MIN);
check('anything else keeps the old rule',
  arrivalBufferFor({ priority: 'need_to' }) === 0 && arrivalBufferFor(undefined) === 0
  && arrivalBufferFor({ priority: 'have_to', category: 'gym' }) === 0);
check('so a need-to task still gets the latest departure',
  rankPlans([quick, scrape], '14:30', { minBufferMinutes: arrivalBufferFor({ priority: 'need_to' }) })[0]
  === scrape, 'unchanged');

// Late is still worse than early, whatever the buffer says.
const late = plan('train', '13:50', '14:40');
check('a plan that misses the appointment never wins on margin',
  rankPlans([late, scrape], '14:30', { minBufferMinutes: 30 })[0] === scrape,
  'arriving in time outranks everything');
check('...even against another late one', 
  arrivesInTime(rankPlans([late], '14:30', { minBufferMinutes: 30 })[0], '14:30') === false,
  'one late plan is still a plan');

// Nothing comfortable exists: take the best of what there is, do not refuse.
const onlyTight = rankPlans([scrape], '14:30', { minBufferMinutes: 30 });
check('when nothing leaves enough room, the tight one is still chosen',
  onlyTight[0] === scrape, 'a plan beats no plan');

// COMFORT IS A NUMBER, NOT A YES/NO. The first version of this rule was a
// boolean, and it threw away the answer she actually wanted: on her real data
// the two trains have 25 and 7 minutes to spare, NEITHER clears 30, so both
// were "uncomfortable" and the latest-departure tie-break handed it to the
// 7-minute one. Twenty-five minutes is not thirty and it is not seven either.
const room25 = plan('train', '13:15', '14:05');   // 25 minutes in hand
const room7 = plan('train', '13:25', '14:23');    // 7
check('below the bar, more room simply wins',
  rankPlans([room7, room25], '14:30', { minBufferMinutes: 30 })[0] === room25,
  '25 min beats 7, though neither reaches 30');
check('...and it is still the one picked end to end',
  pickByPreference([room7, room25], '14:30', { minBufferMinutes: 30 })!.plan === room25);
check('...and says how much room it bought',
  marginNote(pickByPreference([room7, room25], '14:30', { minBufferMinutes: 30 })!, 'he')
    ?.includes('25') === true);

// ABOVE the bar they tie, so the old rule takes over and she sleeps in. The
// cushion is a floor, not an instruction to leave as early as possible.
const early = plan('train', '12:00', '13:30');    // 60 minutes in hand
const enough = plan('train', '13:00', '13:55');   // 35 — still clears 30
check('at or beyond the cushion, the later departure wins again',
  rankPlans([early, enough], '14:30', { minBufferMinutes: 30 })[0] === enough,
  'no waking her early for a margin she did not ask for');
check('and nothing is explained, because nothing unusual happened',
  marginNote(pickByPreference([early, enough], '14:30', { minBufferMinutes: 30 })!, 'en')
    === undefined);

// And she is told why the alarm moved.
const chosenQuick = pickByPreference([scrape, quick], '14:30', { minBufferMinutes: 30 })!;
check('pickByPreference agrees', chosenQuick.plan === quick, chosenQuick.plan.arriveAt);
check('it records the slack', chosenQuick.slackMinutes === 32, `${chosenQuick.slackMinutes}`);
check('it knows it beat a later departure', chosenQuick.chosenForMargin === true);
for (const lang of ['he', 'en'] as const) {
  const note = marginNote(chosenQuick, lang);
  check(`[${lang}] and says so out loud`, Boolean(note && note.includes('32')), note);
}
// THE OVER-CORRECTION, read straight off her phone at 00:32 on the morning of
// the interview. `[GoogleSync] offer` printed every route Google returned, and
// the capped-comfort rule had chosen the FIRST of these:
//
//   12:33 → 13:32   58 min spare   ← chosen, and she leaves an hour too early
//   13:09 → 13:59   31 min spare   ← the one she named
//   13:03 → 14:02   28 min spare   ← the direct train she also named
//   13:39 → 14:29    1 min spare   ← what the old rule had chosen the day before
//
// Capping made 58 and 31 tie at 30, so directness broke the tie and sent her
// out at 12:33; and 28, two minutes under the bar, could not compete at all.
// Her words the night before: "it's better to arrive on 14:00 or better the
// train which leave by 13:20". Both of the plans she named were beaten.
const dev58 = plan('train', '12:33', '13:32');
const dev31 = plan('train', '13:09', '13:59');
const dev28 = plan('train', '13:03', '14:02');
const dev1 = plan('train', '13:39', '14:29');
const devPool = [dev58, dev31, dev28, dev1];

check('the cushion is a target, not a floor — 58 minutes early is not better',
  rankPlans(devPool, '14:30', { minBufferMinutes: 30 })[0] === dev31,
  `${rankPlans(devPool, '14:30', { minBufferMinutes: 30 })[0].leaveHomeAt}`);
check('and the direct train she also named is second, not last',
  rankPlans(devPool, '14:30', { minBufferMinutes: 30 })[1] === dev28);
check('the one-minute plan is last of the four',
  rankPlans(devPool, '14:30', { minBufferMinutes: 30 })[3] === dev1);
check('missing the cushion costs more per minute than overshooting it',
  missesTargetBy(plan('train', '13:00', '14:25'), '14:30', 30) === 75
  && missesTargetBy(plan('train', '13:00', '13:35'), '14:30', 30) === 25,
  '25 short = 75, 25 over = 25');
check('landing exactly on the cushion scores zero',
  missesTargetBy(plan('train', '13:00', '14:00'), '14:30', 30) === 0);
check('no cushion asked for, no scoring at all',
  missesTargetBy(dev58, '14:30', 0) === 0 && missesTargetBy(dev1, '14:30', 0) === 0);
check('an unreadable arrival is not punished for being unreadable',
  missesTargetBy({ ...dev31, arriveAt: '' }, '14:30', 30) === 0);

const chosenPlain = pickByPreference([scrape, quick], '14:30')!;
check('no cushion asked for, no explanation offered',
  chosenPlain.plan === scrape && marginNote(chosenPlain, 'he') === undefined);
check('and a must with only one option explains nothing either',
  marginNote(pickByPreference([quick], '14:30', { minBufferMinutes: 30 })!, 'en') === undefined,
  'nothing was beaten');

console.log('');
check('a bus preference still tries rail first', modeLadder('bus')[0] === 'train',
  modeLadder('bus').join(' → '));
check('a train preference falls back to bus', modeLadder('train').join(',') === 'train,bus');
check('driving is not a ladder — no bus consolation prize',
  modeLadder('car').join(',') === 'car');
check('walking is not a ladder', modeLadder('walk').join(',') === 'walk');

// There IS a train.
const withRail = await planWithFallback('bus', async (m) =>
  (m === 'train' ? plan('train', '13:30', '14:20') : plan('bus', '13:20', '14:10')));
check('when a train exists, the train wins', withRail?.mode === 'train', withRail?.mode);
check('and nothing needs explaining', fallbackNote(withRail!, 'Ra\'anana', 'he') === undefined);

// There is NO train — the exact Ra'anana case.
const noRail = await planWithFallback('train', async (m) =>
  (m === 'train' ? null : plan('bus', '13:38', '14:25')));
check('no train → the bus is used, not nothing', noRail?.mode === 'bus', noRail?.mode);
check('the leave time survives the fallback', noRail?.plan.leaveHomeAt === '13:38');
check('it is marked as NOT what she asked for', noRail?.preferred === false);
check('and it says so, in Hebrew',
  fallbackNote(noRail!, "7 HaPnina Street, Ra'anana", 'he') === 'אין רכבת ל7 HaPnina Street — אוטובוס',
  String(fallbackNote(noRail!, "7 HaPnina Street, Ra'anana", 'he')));
check('and in English',
  /No train to 7 HaPnina Street/.test(String(fallbackNote(noRail!, "7 HaPnina Street, Ra'anana", 'en'))));

// A request for a train was never a request to be late.
check('arrivesInTime is honest about a late plan',
  !arrivesInTime(plan('train', '13:55', '14:45'), '14:30'));
const lateTrain = await bestPlanInTime('train', '14:30', async (m) =>
  (m === 'train' ? plan('train', '13:55', '14:45') : plan('bus', '13:38', '14:10')));
check('a late train yields to a bus that arrives in time',
  lateTrain?.mode === 'bus' && lateTrain?.plan.arriveAt === '14:10',
  `${lateTrain?.mode} arriving ${lateTrain?.plan.arriveAt}`);

const allLate = await bestPlanInTime('train', '14:30', async (m) =>
  (m === 'train' ? plan('train', '13:55', '14:45') : null));
check('when everything is late, a late plan still beats no plan',
  allLate?.mode === 'train', 'she is told when to leave either way');

const nothing = await bestPlanInTime('train', '14:30', async () => null);
check('no route at all is still null — never an invented journey', nothing === null);

const throwing = await bestPlanInTime('train', '14:30', async (m) => {
  if (m === 'train') throw new Error('network');
  return plan('bus', '13:38', '14:10');
});
check('one dead request does not cost her the fallback',
  throwing?.mode === 'bus', throwing?.mode);

// ───────────────────────────────────────────────────────────────────────────
console.log(`\n${failures ? '❌' : '✅'} ${checks - failures}/${checks} checks passed\n`);
if (failures) process.exit(1);
})();
