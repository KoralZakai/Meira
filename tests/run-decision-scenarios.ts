/**
 * run-decision-scenarios — the fifteen meira-sim decisions, asked of the app.
 *
 * tests/fixtures/meira-sim/data/scenarios.json holds eight "can I insert this
 * here?" cases, three cancellations and four interview-slot reviews, answered
 * in scenarios_expected.json by the fixture's scheduler.py. Each one is put to
 * the app the way she would put it: the persona's day is imported from Google
 * for real, and the question goes to ScheduleQueryService.answerFeasibility —
 * the code behind "can I fit a 90-minute meeting in Ashdod at 10:30?" in chat.
 * Travel comes from the fixture: the minutes each golden answer was computed
 * with where the case records them, the fixture's own model otherwise.
 *
 * What is asserted is only what both sides can say:
 *   INS  the verdict at the requested time           (OK / INFEASIBLE_TRAVEL / OVERLAP / TIGHT)
 *   CAN  every slot the fixture says now fits, fits   (after the app deletes the cancelled meeting)
 *   INT  the verdict on each slot the user offered
 * and what only the fixture can say is printed beside it, not asserted: the
 * seven-day "when possible" search, cost ranking, and the interview ranking.
 * The app has no function for those — they are listed as untestable, which is
 * the finding, rather than faked here.
 *
 * answerFeasibility returns a structured verdict AND the sentence. The verdict
 * under test is the structured one; the sentence is read too, and must say the
 * same thing — that is how her screen reads it.
 *
 * Run:  npm run test:decisions
 */
import {
  bootUser, collectWarnings, googleItem, installFixtureRouting, setCalendar, taskIdOf, withClock,
} from './meira-sim-app';
import {
  FixtureMeeting, FixtureUser, RouteAsk, goldenRouteSource, hhmmToMin, loadLocations, loadMeetings,
  loadUsers, readJson, travelModelMismatches,
} from './meira-sim-fixture';

/* eslint-disable @typescript-eslint/no-var-requires */
const GoogleSync = require('../src/services/GoogleSync');
const TaskStorage = require('../src/services/TaskStorage');
const { answerFeasibility, checkBeforeSave, setPlaceHoursSource } = require('../src/services/ScheduleQueryService');
const { isRemoteTask } = require('../src/utils/meetingLink');

let checks = 0;
let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

const locations = loadLocations();
const users = loadUsers('sim');
const meetings = loadMeetings('sim');
const cases: any[] = readJson('scenarios.json');
const expected = new Map<string, any>((readJson('scenarios_expected.json') as any[]).map((e) => [e.case_id, e]));

type Verdict = 'OK' | 'TIGHT' | 'OVERLAP' | 'INFEASIBLE_TRAVEL' | 'WAKE_CONFLICT' | 'ROUTINE'
  | 'PAST' | 'CLOSED' | 'NO_WINDOW' | 'UNREAD';

/** The verdict her screen shows, read off the sentence the app chose. */
function verdictOf(text: string): { verdict: Verdict; alternative?: string } {
  const alternative = text.match(/ (\d\d:\d\d) works\./)?.[1];
  if (/^(Yes|Probably) — /.test(text)) return { verdict: 'OK' };
  if (/^Yes, but it's tight — /.test(text)) return { verdict: 'TIGHT' };
  if (/it's already \d\d:\d\d|has already passed/.test(text)) return { verdict: 'PAST', alternative };
  if (/clashes with/.test(text)) return { verdict: 'OVERLAP', alternative };
  if (/won't make it|wouldn't get from/.test(text)) return { verdict: 'INFEASIBLE_TRAVEL', alternative };
  if (/you'd have to be up at/.test(text)) return { verdict: 'WAKE_CONFLICT', alternative };
  if (/that's your/.test(text)) return { verdict: 'ROUTINE', alternative };
  if (/is closed (then|that day)|permanently closed/.test(text)) return { verdict: 'CLOSED', alternative };
  if (/^No \d+-min window/.test(text)) return { verdict: 'NO_WINDOW' };
  return { verdict: 'UNREAD', alternative };
}

/** The same reading for the Hebrew sentence. Behaviour must not depend on the language. */
function verdictOfHe(text: string): Verdict {
  if (/^(כן|כנראה) — /.test(text)) return 'OK';
  if (/^כן, אבל צפוף — /.test(text)) return 'TIGHT';
  if (/השעה כבר|כבר עבר/.test(text)) return 'PAST';
  if (/מתנגש עם/.test(text)) return 'OVERLAP';
  if (/לא מספיקים|לא תגיעי/.test(text)) return 'INFEASIBLE_TRAVEL';
  if (/צריך לקום ב-/.test(text)) return 'WAKE_CONFLICT';
  if (/זה נופל על/.test(text)) return 'ROUTINE';
  if (/סגור אז|סגור באותו יום|נסגר לצמיתות/.test(text)) return 'CLOSED';
  if (/אין חלון של/.test(text)) return 'NO_WINDOW';
  return 'UNREAD';
}

/** Every answer's sentence must say what its verdict says. */
const sentenceSplits: string[] = [];
/** No answer may name a video call as the place she travels from. */
const callOrigins: string[] = [];

/** Every question is asked in both languages; a Hebrew answer that lands elsewhere is kept here. */
const parity: string[] = [];
let parityAsked = 0;
/** Hours the app offered as an alternative, and any it then refused. */
let offeredAsked = 0;
const offeredRefused: string[] = [];
/** The structured verdict of the last English answer askBoth received. */
let lastVerdict: Verdict = 'UNREAD';

const placeOf = (id?: number | string | null) => (id === null || id === undefined ? 'online' : String(id));
const dayOf = (userId: string, date: string, drop?: string) =>
  meetings.filter((m) => m.userId === userId && m.date === date && m.id !== drop);

/**
 * The physical places either side of a slot: where she comes from and where
 * she goes next ('home' at either end of the day). Online meetings do not
 * move her, exactly as the fixture's rule says.
 */
function neighbours(day: FixtureMeeting[], start: string, minutes: number): { prev: string; next: string } {
  const s = hhmmToMin(start); const e = s + minutes;
  const phys = day.filter((m) => m.locationId).sort((a, b) => a.startLocal.localeCompare(b.startLocal));
  const before = phys.filter((m) => hhmmToMin(m.endLocal) <= s).pop();
  const after = phys.find((m) => hhmmToMin(m.startLocal) >= e);
  return { prev: before?.locationId ?? 'home', next: after?.locationId ?? 'home' };
}

/** Golden travel for one case, keyed the way goldenRouteSource looks it up. */
function caseTravel(user: FixtureUser, date: string, place: string, options: Array<{ start: string; minutes: number; day?: string; travel_in?: number; travel_out?: number; blocking?: any[] }>, drop?: string) {
  const golden = new Map<string, number>();
  for (const o of options) {
    const d = o.day ?? date;
    for (const b of o.blocking ?? []) golden.set(`${user.id}|${d}|${b.from_id}|${b.to_id}`, b.travel_min);
    const { prev, next } = neighbours(dayOf(user.id, d, drop), o.start, o.minutes);
    if (o.travel_in !== undefined && place !== 'online') golden.set(`${user.id}|${d}|${prev}|${place}`, o.travel_in);
    if (o.travel_out !== undefined && place !== 'online') golden.set(`${user.id}|${d}|${place}|${next}`, o.travel_out);
  }
  return golden;
}

async function openDay(user: FixtureUser, dates: string[], golden: Map<string, number>, offGolden: RouteAsk[]) {
  await bootUser(user);
  installFixtureRouting(user, locations, goldenRouteSource(user, locations, golden, offGolden), meetings);
  setCalendar(meetings.filter((m) => m.userId === user.id).map((m) => googleItem(m, locations)));
  await collectWarnings(async () => {
    for (const d of dates) await GoogleSync.syncCalendarForDate(d, 'en');
  });
}

async function askFull(
  date: string, start: string | undefined, minutes: number, place: string, what: string,
  lang: 'en' | 'he' = 'en',
): Promise<{ text: string; verdict: Verdict; steps: any[] }> {
  const r = await collectWarnings<{ text: string; verdict: Verdict; steps: any[] }>(() => answerFeasibility({
    kind: 'feasibility', date, minutes, startTime: start, what,
    place: place === 'online' ? undefined : locations.get(place)!.address,
  }, lang));
  const { text, verdict } = r.value;
  const read = lang === 'he' ? verdictOfHe(text) : verdictOf(text).verdict;
  if (read !== verdict) sentenceSplits.push(`${lang} ${date} ${start ?? '—'} ${what}: verdict ${verdict}, sentence reads ${read} ("${text}")`);
  // "44 min from "Design review (Zoom)"" measured from home is the bug; any
  // origin the sentence names must be somewhere she can physically be.
  const named = text.match(/min from "([^"]+)"/)?.[1] ?? text.match(/ דק׳ מ"([^"]+)"/)?.[1];
  if (named) {
    const day = await TaskStorage.getTasksForDate(date);
    const t = day.find((x: any) => x.text === named);
    if (t && isRemoteTask(t)) callOrigins.push(`${date} ${start}: "${text}"`);
  }
  return r.value;
}

async function ask(
  date: string, start: string | undefined, minutes: number, place: string, what: string,
  lang: 'en' | 'he' = 'en',
) {
  return (await askFull(date, start, minutes, place, what, lang)).text;
}

/** Ask in English (the verdict under test) and in Hebrew (which must agree). */
async function askBoth(
  label: string, date: string, start: string | undefined, minutes: number, place: string, what: string,
) {
  const en = await askFull(date, start, minutes, place, what);
  const he = await askFull(date, start, minutes, place, what, 'he');
  // An hour the app offers instead must itself be a yes. Offering a time it
  // would then refuse is the worst kind of help.
  const offered = en.text.match(/ (\d\d:\d\d) works\./)?.[1];
  if (offered && start) {
    offeredAsked += 1;
    const again = await askFull(date, offered, minutes, place, what);
    if (again.verdict !== 'OK' && again.verdict !== 'TIGHT') {
      offeredRefused.push(`${label}: offered ${offered}, then "${again.text}"`);
    }
  }
  parityAsked += 1;
  if (he.verdict !== en.verdict) parity.push(`${label}: EN ${en.verdict}, HE ${he.verdict} ("${he.text}")`);
  lastVerdict = en.verdict;
  return en.text;
}

async function inserts() {
  console.log('\nINS — "does it fit right here?"\n');
  for (const c of cases.filter((k) => k.kind === 'insert')) {
    const e = expected.get(c.case_id);
    const user = users.get(String(c.user_id))!;
    const place = placeOf(c.proposal.location_id);
    const start = c.proposal.desired_start_local;
    const minutes = c.proposal.duration_min;
    const offGolden: RouteAsk[] = [];
    const golden = caseTravel(user, c.date, place, [{
      start, minutes, blocking: e.blocking,
      travel_in: e.accepted_slot?.travel_in, travel_out: e.accepted_slot?.travel_out,
    }]);
    await openDay(user, [c.date], golden, offGolden);
    const text = await askBoth(c.case_id, c.date, start, minutes, place, c.proposal.title);
    const verdict = lastVerdict;
    const { alternative } = verdictOf(text);
    const firstAlt = e.alternatives?.[0];
    check(`${c.case_id} ${c.proposal.title} ${c.date} ${start}: fixture ${e.status}, app ${verdict}`,
      verdict === e.status,
      `app: "${text}"`
        + (firstAlt ? ` · fixture's first alternative ${firstAlt.day} ${firstAlt.start_local}` : '')
        + (alternative ? ` · app's alternative ${c.date} ${alternative}` : '')
        + (offGolden.length ? ` · ${offGolden.length} travel question(s) off-golden` : ''));
    // Adding it (28.10): the same judgement must stop the save exactly when it does not fit,
    // and offer the same checked alternative.
    const gate = (await collectWarnings<any>(() => checkBeforeSave({
      text: c.proposal.title, date: c.date, fixedTime: start, durationMinutes: minutes,
      place: place === 'online' ? undefined : locations.get(place)!.address,
    }, 'en'))).value;
    const shouldStop = !(e.status === 'OK' || e.status === 'TIGHT');
    check(`${c.case_id} adding it ${shouldStop ? 'is stopped' : 'goes through'}`,
      gate.stop === shouldStop && !gate.error && (!shouldStop || gate.alt === alternative),
      `stop=${gate.stop} alt=${gate.alt ?? '—'} (asked: ${alternative ?? '—'})${gate.error ? ` error ${gate.error}` : ''}`);
  }
}

async function cancels() {
  console.log('\nCAN — "that meeting is off: what fits now?"\n');
  for (const c of cases.filter((k) => k.kind === 'cancel')) {
    const e = expected.get(c.case_id);
    const user = users.get(String(c.user_id))!;
    const dropId = String(c.cancel_meeting_id);
    for (const [i, cand] of c.candidates.entries()) {
      const fit = e.now_fits[i];
      if (!fit) continue;
      const place = placeOf(cand.location_id);
      const offGolden: RouteAsk[] = [];
      const golden = caseTravel(user, c.date, place, [{
        start: fit.start_local, minutes: cand.duration_min, travel_in: fit.travel_in, travel_out: fit.travel_out,
      }], dropId);
      await openDay(user, [c.date], golden, offGolden);
      // The cancellation, through the app.
      await collectWarnings(() => TaskStorage.deleteTask(taskIdOf({ dataset: 'sim', id: dropId })));
      const text = await askBoth(`${c.case_id} ${cand.title}`, c.date, fit.start_local, cand.duration_min, place, cand.title);
      const own = await ask(c.date, undefined, cand.duration_min, place, cand.title);
      const verdict = lastVerdict;
      check(`${c.case_id} after "${c.cancel_title}" is dropped, ${cand.title} at ${fit.start_local} fits`,
        verdict === 'OK' || verdict === 'TIGHT', `app ${verdict}: "${text}" · asked with no hour, the app offers: "${own}"`);
    }
    console.log(`    fixture: freed ${e.freed_from}–${e.freed_to} (${e.freed_minutes} min), `
      + `${e.conflicts_resolved} conflict(s) resolved — the app has no wake-conflict to resolve`);
  }
}

async function interviews() {
  console.log('\nINT — "the recruiter offered three slots"\n');
  for (const c of cases.filter((k) => k.kind === 'interview')) {
    const e = expected.get(c.case_id);
    const user = users.get(String(c.user_id))!;
    const place = placeOf(c.proposal.location_id);
    for (const [i, slot] of c.offered_slots.entries()) {
      const reviewed = e.reviewed[i];
      const offGolden: RouteAsk[] = [];
      const golden = caseTravel(user, slot.date, place, [{
        start: slot.start_local, minutes: c.proposal.duration_min, day: slot.date,
        blocking: reviewed.blocking, travel_in: reviewed.travel_in, travel_out: reviewed.travel_out,
      }]);
      await openDay(user, [slot.date], golden, offGolden);
      const text = await askBoth(`${c.case_id} ${slot.date}`, slot.date, slot.start_local, c.proposal.duration_min, place, c.proposal.title);
      const verdict = lastVerdict;
      check(`${c.case_id} ${c.proposal.title} offered ${slot.date} ${slot.start_local}: fixture ${reviewed.status}, app ${verdict}`,
        verdict === reviewed.status, `app: "${text}"`);
    }
    console.log(`    fixture ranks: ${e.recommended.map((r: any) => `${r.day} ${r.start_local} (${r.source === 'user_offered' ? 'offered' : 'Meira'}, cost ${r.cost})`).join(' > ')}`);
    console.log('    app ranks: — no function answers "which of these three?" (untestable: no seam)');
  }
}

/**
 * The three things the fixture says it does not model — opening hours, "now",
 * movability — asked of the app directly. The fixture's own answers show why
 * they matter: INS-02's first alternative is a port survey at 19:30, and
 * INT-02's top pick is the day BEFORE the request.
 */
async function unmodeled() {
  console.log('\nWhat the fixture does not model — asked of the app directly\n');
  const shani = users.get('102')!;
  const noa = users.get('103')!;

  // Opening hours. Shani's evening on 14/10 is empty; a clinic at 19:30.
  // Asked that MORNING: the scenario is about opening hours, and on a real
  // clock after 14/10 every answer was "already passed" (15.10).
  await withClock('2026-10-14T09:00:00+03:00', async () => {
  await openDay(shani, ['2026-10-14'], new Map(), []);
  const dentist = await ask('2026-10-14', '19:30', 45, '41', 'Dentist — Dizengoff Center');
  check('a dentist at 19:30 is not confirmed while the app knows nothing of the clinic\'s hours',
    !/^Yes — /.test(dentist), `app: "${dentist}"`);
  // With hours known. The fixture has none, so this one is a declared test
  // input: the clinic is open 08:00–19:00. Through the app's own seam.
  setPlaceHoursSource(async (_p: string, _d: string, start: string, end: string) => (
    start >= '08:00' && end <= '19:00'
      ? { known: true, open: true, opens: '08:00', closes: '19:00', name: 'Dizengoff Center clinic' }
      : { known: true, open: false, opens: '08:00', closes: '19:00', why: 'closes_earlier', name: 'Dizengoff Center clinic' }));
  try {
    const closed = await askFull('2026-10-14', '19:30', 45, '41', 'Dentist — Dizengoff Center');
    check('…and when the clinic is known to close at 19:00, 19:30 is refused as CLOSED, with an hour inside opening time',
      closed.verdict === 'CLOSED' && /(\d\d:\d\d) works/.test(closed.text)
        && (closed.text.match(/(\d\d:\d\d) works/)![1] < '19:00'),
      `app ${closed.verdict}: "${closed.text}"`);
    // The hour the app itself offered instead.
    const offered = closed.text.match(/(\d\d:\d\d) works/)?.[1] ?? '15:15';
    const open = await askFull('2026-10-14', offered, 45, '41', 'Dentist — Dizengoff Center');
    check(`…while ${offered}, the hour it offered instead, is a plain yes with the closing hour said`,
      open.verdict === 'OK' && /Open till 19:00/.test(open.text), `app ${open.verdict}: "${open.text}"`);
    const closedHe = await askFull('2026-10-14', '19:30', 45, '41', 'Dentist — Dizengoff Center', 'he');
    check('…and the Hebrew answer refuses it the same way', closedHe.verdict === 'CLOSED', `app ${closedHe.verdict}: "${closedHe.text}"`);
  } finally {
    setPlaceHoursSource(null);
  }
  });

  // "Now". Noa's Monday, asked at 15:00 that same day.
  await openDay(noa, ['2026-10-12'], new Map(), []);
  await withClock('2026-10-12T15:00:00+03:00', async () => {
    const past = await askFull('2026-10-12', '07:00', 45, '14', 'Library session — TAU');
    check('at 15:00, a 07:00 slot the same day is not confirmed — it has already gone',
      past.verdict === 'PAST' && !/^Yes — /.test(past.text), `app ${past.verdict}: "${past.text}"`);
    const pastAlt = past.text.match(/(\d\d:\d\d) works/)?.[1];
    check('…and the hour it offers instead is after 15:00', !pastAlt || pastAlt >= '15:00', `app: "${past.text}"`);
    const pastHe = await askFull('2026-10-12', '07:00', 45, '14', 'Library session — TAU', 'he');
    check('…in Hebrew too', pastHe.verdict === 'PAST', `app ${pastHe.verdict}: "${pastHe.text}"`);
    const open = await ask('2026-10-12', undefined, 45, '14', 'Library session — TAU');
    const offered = open.match(/(\d\d:\d\d)–/)?.[1];
    check('asked with no hour at 15:00, nothing earlier than now is offered',
      Boolean(offered) && offered! >= '15:00', `app: "${open}"`);
  });
}

async function main() {
  console.log('\nrun-decision-scenarios — the fixture\'s 15 decisions, asked of the real app\n');
  // Off-golden travel questions are answered by the port of the fixture's own
  // model; it has to BE that model, or a verdict could move for the wrong reason.
  const drift = travelModelMismatches(users, locations, meetings);
  check('the ported travel model reproduces all 128 raw predictions the simulator recorded',
    drift.length === 0, drift.slice(0, 3).join(' | ') || 'exact');
  // The fixture's month now includes the days the suite runs on: judged from
  // inside it, 6.10 08:30 was "already gone" at 11:41 and three verdicts
  // flipped to PAST (6.10). Judge from a fixed moment — one the gate passed at.
  await withClock('2026-10-04T13:00:00+03:00', async () => {
    await inserts();
    await cancels();
    await interviews();
  });
  console.log('');
  check(`every Hebrew answer reaches the same verdict as the English one (${parityAsked} questions)`,
    parity.length === 0, parity.slice(0, 4).join(' | ') || 'same verdict in both languages');
  await unmodeled();
  check('every sentence says what its verdict says (both languages)', sentenceSplits.length === 0,
    sentenceSplits.slice(0, 3).join(' | ') || 'consistent');
  check(`every hour offered instead is accepted when asked (${offeredAsked} offered)`, offeredRefused.length === 0,
    offeredRefused.slice(0, 3).join(' | ') || 'all accepted');
  check('no answer names a video call as the place she travels from', callOrigins.length === 0,
    callOrigins.slice(0, 3).join(' | ') || 'every origin named is a physical place');
  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error('❌ run-decision-scenarios crashed:', e);
  process.exit(1);
});
