/**
 * run-tomorrow-start — "will you leave tomorrow from where you are now?" (17.10).
 *
 * Koral: "Tomorrow I have an interview at מכון דוד but now my location is
 * different from what is already calculated — Meira needs to ask: will you
 * leave tomorrow from your current location?" She was near Nahariya, home is
 * Tel Aviv, and tomorrow's route had been worked out from home because that
 * is where a day that has not begun starts. The phone knew; Meira did not say.
 *
 * Pinned here, with fakes and NO network:
 *   - the pure decision: when to ask and, as important, WHY not (rule 1);
 *   - tripStart honours the day's start she gave, and says so in her words;
 *   - the question's words and the sheet's strings, both languages;
 *   - detection end to end with injected deps (reads nothing it need not,
 *     warns when it could not tell, fetches the place name only after a "yes");
 *   - the answer: the start saved AND read back, the forced re-plan of the
 *     first trip, "from home", failures that claim nothing (rule 3);
 *   - DayStartStore, for real, over an in-memory store;
 *   - the four triggers (rule 7) and the GoogleSync wiring, on the source;
 *   - the privacy rule: the position's NAME never reaches the cloud copy.
 *
 *   npx tsx tests/run-tomorrow-start.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';

// ── DayStartStore imports EncryptedStorage (expo-secure-store, native): give it a Map ──
const disk = new Map<string, string>();
const memory = {
  async getItem(k: string) { return disk.has(k) ? disk.get(k)! : null; },
  async setItem(k: string, v: string) { disk.set(k, v); },
};
const Module = require('module');
const origLoad = Module._load;
Module._load = function patched(request: string, ...rest: any[]) {
  if (request === './EncryptedStorage' || request.endsWith('/EncryptedStorage')) return { __esModule: true, default: memory };
  return origLoad.call(this, request, ...rest);
};

import {
  applyTripOrigin, ApplyDeps, askText, detectTripOrigin, DetectDeps, hereLabelText, keyOf, questionOf, sheetText,
} from '../src/questions/kinds/tripOrigin';
import {
  decideTripOrigin, firstLocatedTrip, FAR_FROM_HOME_M, originIsHome, tomorrowOf, hhmmOf, TomorrowStartInput,
} from '../src/utils/tomorrowStart';
import { DayStart, hePrefix, sameOrigin, SET_START_LINE_RE, startLine, tripStart } from '../src/utils/tripStart';
import { forCloud } from '../src/utils/cloudPrivacy';
import type { MeiraQuestion, TripOriginQuestionData } from '../src/questions/types';
import type { Task } from '../src/types/index';

let checks = 0;
let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `  — ${detail}`}`);
}
const ROOT = join(__dirname, '..');
const src = (p: string) => readFileSync(join(ROOT, p), 'utf8');

// ── fixtures ─────────────────────────────────────────────────────────────────
const HOME_ADDR = "Mordei ha-Geta'ot 21, Tel Aviv-Yafo";
const HOME = { lat: 32.0806, lng: 34.7806 };
const NAHARIYA = { lat: 33.0089, lng: 35.0981 };      // ~100 km north
const NEAR_HOME = { lat: 32.0905, lng: 34.7806 };     // ~1.1 km
const TODAY = '2026-10-17';
const TOMORROW = '2026-10-18';

const interview = (over: Record<string, unknown> = {}, loc: Record<string, unknown> = {}): Task => ({
  id: 't-int', text: 'ראיון מכון דוד', category: 'interview', priority: 'must', isFixed: true,
  fixedTime: '11:30', durationMinutes: 90, date: TOMORROW, status: 'pending', createdAt: 1, historicalDurations: [],
  location: {
    address: 'מכון דוד, תל אביב', lat: 32.07, lng: 34.78, confirmed: true, leaveHomeBy: '10:34',
    transitPlan: { originAddress: HOME_ADDR, leaveHomeAt: '10:34', arriveAt: '11:20', totalDurationMinutes: 46 },
    ...loc,
  },
  ...over,
} as unknown as Task);

const base = (over: Partial<TomorrowStartInput> = {}): TomorrowStartInput => ({
  tomorrow: TOMORROW, nowHHMM: '18:30', here: NAHARIYA, home: HOME, homeAddress: HOME_ADDR,
  tasks: [interview()], answered: {}, dayStart: null, ...over,
});
const reasonOf = (i: TomorrowStartInput): string => {
  const d = decideTripOrigin(i);
  return d.ask ? 'ASK' : d.reason;
};

(async () => {
  // ═════════════════════════════════════════════════════════════════════════
  console.log('\nWhen to ask (pure)\n');
  {
    const d = decideTripOrigin(base());
    check('far from home, the evening before → ask', d.ask === true, JSON.stringify(d));
    if (d.ask) {
      check('…about tomorrow, the first trip, and the hour she LEAVES',
        d.data.date === TOMORROW && d.data.taskId === 't-int' && d.data.taskTitle === 'ראיון מכון דוד'
        && d.data.leaveAt === '10:34' && d.data.time === '11:30', JSON.stringify(d.data));
      check('…carrying where she is (and no name yet)', d.data.here.lat === NAHARIYA.lat && d.data.hereLabel === '');
    }
    check(`≤ ${FAR_FROM_HOME_M} m from home → no`, reasonOf(base({ here: NEAR_HOME })) === 'near_home');
    check('at home → no', reasonOf(base({ here: HOME })) === 'near_home');
    check('already answered for that date → no',
      reasonOf(base({ answered: { [keyOf(TOMORROW)]: 1 } })) === 'answered');
    check('…but an answer for ANOTHER date does not count',
      reasonOf(base({ answered: { [keyOf('2026-10-17')]: 1 } })) === 'ASK');
    check('no tasks tomorrow → no, with a reason', reasonOf(base({ tasks: [] })) === 'no_trip');
    check('a task with no place → no',
      reasonOf(base({ tasks: [interview({}, { address: '', displayName: '' })] })) === 'no_trip');
    check('a task with a place but no hour → no',
      reasonOf(base({ tasks: [interview({ fixedTime: undefined, scheduledTime: undefined })] })) === 'no_trip');
    check('a finished task → no', reasonOf(base({ tasks: [interview({ status: 'complete' })] })) === 'no_trip');
    check('an online meeting is not a trip → no',
      reasonOf(base({ tasks: [interview({ category: 'zoom', meetingUrl: 'https://zoom.us/j/1', location: 'https://zoom.us/j/1' })] })) === 'no_trip');
    check("another day's task is ignored", reasonOf(base({ tasks: [interview({ date: TODAY })] })) === 'no_trip');
    {
      const early = interview({ id: 't-gym', text: 'אימון', fixedTime: '07:30' }, { address: 'Gym, Nahariya', leaveHomeBy: '07:00', transitPlan: { originAddress: HOME_ADDR, leaveHomeAt: '07:00' } });
      const d2 = decideTripOrigin(base({ tasks: [interview(), early] }));
      check('two trips: the EARLIER one is the one asked about', d2.ask && d2.data.taskId === 't-gym', JSON.stringify(d2));
      check('firstLocatedTrip says the same', firstLocatedTrip([interview(), early], TOMORROW)?.id === 't-gym');
    }

    console.log('\n  …and when in the day\n');
    check('16:00 is the evening before → ask', reasonOf(base({ nowHHMM: '16:00' })) === 'ASK');
    check('15:59 with a 10:34 departure → ask (leaves before noon, any time of day)', reasonOf(base({ nowHHMM: '15:59' })) === 'ASK');
    {
      const late = interview({ fixedTime: '15:00' }, { leaveHomeBy: '14:10', transitPlan: { originAddress: HOME_ADDR, leaveHomeAt: '14:10' } });
      check('an afternoon departure at 11:00 → not yet', reasonOf(base({ tasks: [late], nowHHMM: '11:00' })) === 'too_early');
      check('…at 15:59 → still not', reasonOf(base({ tasks: [late], nowHHMM: '15:59' })) === 'too_early');
      check('…at 16:00 → ask', reasonOf(base({ tasks: [late], nowHHMM: '16:00' })) === 'ASK');
    }
    check('a departure at 11:59 counts as before noon', reasonOf(base({
      tasks: [interview({}, { leaveHomeBy: '11:59', transitPlan: { originAddress: HOME_ADDR, leaveHomeAt: '11:59' } })], nowHHMM: '09:00',
    })) === 'ASK');
    check('a departure at 12:00 does not', reasonOf(base({
      tasks: [interview({ fixedTime: '13:00' }, { leaveHomeBy: '12:00', transitPlan: { originAddress: HOME_ADDR, leaveHomeAt: '12:00' } })], nowHHMM: '09:00',
    })) === 'too_early');
    check('3 a.m. is the night, not the evening before → no nudge', reasonOf(base({ nowHHMM: '03:00' })) === 'night');

    console.log('\n  …and from which start the trip was planned\n');
    check('a plan that names no origin was made from home → ask',
      reasonOf(base({ tasks: [interview({}, { transitPlan: { leaveHomeAt: '10:34' } })] })) === 'ASK');
    check('no plan at all → ask (the question says the appointment hour)', (() => {
      const d = decideTripOrigin(base({ tasks: [interview({}, { transitPlan: undefined, leaveHomeBy: undefined })], nowHHMM: '18:00' }));
      return d.ask && d.data.leaveAt === undefined && d.data.time === '11:30';
    })());
    check('a plan from a coordinates-only home → ask', reasonOf(base({
      homeAddress: '32.0806,34.7806', tasks: [interview({}, { transitPlan: { originAddress: '32.08060,34.78060', leaveHomeAt: '10:34' } })] })) === 'ASK');
    check('a plan from elsewhere (a start she already chose) → no',
      reasonOf(base({ tasks: [interview({}, { transitPlan: { originAddress: '33.00890,35.09810', leaveHomeAt: '10:34' } })] })) === 'planned_elsewhere');
    check('a start she already gave for that date → no', reasonOf(base({ dayStart: { lat: 33, lng: 35.1 } })) === 'start_set');
    check('originIsHome: text, near-coords, missing', originIsHome(HOME_ADDR, HOME_ADDR, HOME)
      && originIsHome('32.08100,34.78100', HOME_ADDR, HOME) && originIsHome(undefined, HOME_ADDR, HOME)
      && !originIsHome('33.00890,35.09810', HOME_ADDR, HOME) && !originIsHome('Haifa Central Station', HOME_ADDR, HOME));

    console.log('\n  …and when she cannot be placed (a reason, never a bare "no")\n');
    check('no position → "no_fix", not "near_home"', reasonOf(base({ here: null })) === 'no_fix');
    check('no home → "no_home"', reasonOf(base({ home: null })) === 'no_home');
    check('a 0,0 home is no home', reasonOf(base({ home: { lat: 0, lng: 0 } })) === 'no_home');
    check('a garbled clock → "no_clock"', reasonOf(base({ nowHHMM: 'soon' })) === 'no_clock');
    check('a quiet day does not report "could not tell": no trip beats no fix', reasonOf(base({ here: null, tasks: [] })) === 'no_trip');
  }

  console.log('\nDates and clock\n');
  {
    check('tomorrow of 17.10 is 18.10', tomorrowOf(new Date(2026, 9, 17, 23, 59)) === '2026-10-18');
    check('…across a month end', tomorrowOf(new Date(2026, 9, 31, 12, 0)) === '2026-11-01');
    check('…across a year end', tomorrowOf(new Date(2026, 11, 31, 12, 0)) === '2027-01-01');
    check('hhmmOf pads', hhmmOf(new Date(2026, 9, 17, 7, 5)) === '07:05');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\ntripStart honours the start she gave\n');
  {
    const said: DayStart = { lat: NAHARIYA.lat, lng: NAHARIYA.lng, label: 'Nahariya', setAt: 1 };
    const t = tripStart(null, HOME, HOME_ADDR, false, said);
    check("tomorrow: kind 'set', from her coordinates", t.kind === 'set' && t.origin === '33.00890,35.09810', JSON.stringify(t));
    check('…with the place she was shown', t.label === 'Nahariya' && t.coords?.lat === NAHARIYA.lat);
    check('tomorrow with nothing said stays home (unchanged)', tripStart(null, HOME, HOME_ADDR, false).kind === 'home');
    check('…even with a position (unchanged)', tripStart(NAHARIYA, HOME, HOME_ADDR, false).kind === 'home');
    check('a 0,0 start is "unknown", not a place', tripStart(null, HOME, HOME_ADDR, false, { lat: 0, lng: 0 }).kind === 'home');
    check('TODAY with a fix: where she IS wins over what she said',
      tripStart({ lat: 32.1624, lng: 34.8447 }, HOME, HOME_ADDR, true, said).kind === 'here');
    check('…and at home it is home', tripStart(HOME, HOME, HOME_ADDR, true, said).kind === 'home');
    check('TODAY with no fix: what she said beats guessing home', tripStart(null, HOME, HOME_ADDR, true, said).kind === 'set');
    check('TODAY with no fix and nothing said: home, and it says it guessed',
      tripStart(null, HOME, HOME_ADDR, true).kind === 'home_unknown_here');
    check('the plan made from it is the same origin on the next sweep (no re-plan loop)',
      sameOrigin(t.origin, tripStart(null, HOME, HOME_ADDR, false, { ...said, setAt: 2 }).origin));
    check('…and a plan still from HOME is stale against it (so the sweep re-plans)', !sameOrigin(HOME_ADDR, t.origin));

    check('startLine (he, with place): "מחושב מ<place> — כמו שאמרת"', startLine('set', 'he', 'נהריה') === '📍 מחושב מנהריה — כמו שאמרת', startLine('set', 'he', 'נהריה'));
    check('startLine (he, Latin place) hyphenates', startLine('set', 'he', 'Haganim St') === '📍 מחושב מ-Haganim St — כמו שאמרת');
    check('startLine (en, with place)', startLine('set', 'en', 'Haganim St') === '📍 From Haganim St, as you said');
    check('startLine without a place still says where from',
      startLine('set', 'he') === '📍 מחושב מהמקום שאמרת' && startLine('set', 'en') === '📍 Planned from where you said');
    check('every set line is recognised by the cloud filter',
      ['he', 'en'].every((l) => [undefined, 'Haganim St'].every((p) => SET_START_LINE_RE.test(startLine('set', l as any, p)))));
    check('the other start lines are not', !SET_START_LINE_RE.test(startLine('home', 'he')) && !SET_START_LINE_RE.test(startLine('here', 'en')));
    check('hePrefix', hePrefix('ל', 'ראיון') === 'לראיון' && hePrefix('ל', 'Space Gym') === 'ל-Space Gym' && hePrefix('מ', '') === 'מ');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\nThe question, in both languages\n');
  const DATA: TripOriginQuestionData = {
    date: TOMORROW, taskId: 't-int', taskTitle: 'ראיון מכון דוד', time: '11:30', leaveAt: '10:34',
    hereLabel: 'נהריה', here: NAHARIYA,
  };
  {
    const a = askText(DATA);
    check('he: "מחר ב-10:34 יוצאים ל<task>. מאיפה תצאי?"', a.he === 'מחר ב-10:34 יוצאים לראיון מכון דוד. מאיפה תצאי?', a.he);
    check('en: "Tomorrow at 10:34 you leave for <task>. Where will you leave from?"',
      a.en === 'Tomorrow at 10:34 you leave for ראיון מכון דוד. Where will you leave from?', a.en);
    check('a Latin task name in Hebrew is hyphenated, not glued',
      askText({ ...DATA, taskTitle: 'Space Gym' }).he === 'מחר ב-10:34 יוצאים ל-Space Gym. מאיפה תצאי?');
    const noPlan = askText({ ...DATA, leaveAt: undefined });
    check('with no plan yet it names the appointment hour, not an invented leave time',
      noPlan.he === 'מחר ב-11:30 יש לך ראיון מכון דוד. מאיפה תצאי?' && noPlan.en === 'Tomorrow at 11:30 you have ראיון מכון דוד. Where will you leave from?',
      JSON.stringify(noPlan));
    const s = sheetText(DATA);
    check('buttons (he): 📍 מכאן (<place>) / 🏠 מהבית / אחר כך',
      s.here.he === '📍 מכאן (נהריה)' && s.home.he === '🏠 מהבית' && s.later.he === 'אחר כך', JSON.stringify(s));
    check('buttons (en): 📍 From here (<place>) / 🏠 From home / Later',
      s.here.en === '📍 From here (נהריה)' && s.home.en === '🏠 From home' && s.later.en === 'Later');
    const blank = sheetText({ ...DATA, hereLabel: '' });
    check('no place name → "המקום שבו את עכשיו" / "where you are now"',
      blank.here.he === '📍 מכאן (המקום שבו את עכשיו)' && blank.here.en === '📍 From here (where you are now)', JSON.stringify(blank.here));
    check('hereLabelText trims', hereLabelText({ hereLabel: '  ' }, true) === 'המקום שבו את עכשיו');
    const q = questionOf(DATA);
    check("keyed 'tripOrigin:<date>', kind tripOrigin, subject the date",
      q.key === 'tripOrigin:2026-10-18' && q.kind === 'tripOrigin' && q.subject === TOMORROW, q.key);
    check('…worded in both languages (the nudge and the list read q.ask)', q.ask.he === a.he && q.ask.en === a.en && q.title === 'ראיון מכון דוד');

    const sheet = src('src/components/MeiraAskSheet.tsx');
    check('the sheet draws these very strings (sheetText), nothing re-typed', /import \{ sheetText \} from '\.\.\/questions\/kinds\/tripOrigin'/.test(sheet)
      && /tripWords\.here\.he/.test(sheet) && /tripWords\.home\.he/.test(sheet) && /tripWords\.later\.he/.test(sheet));
    const minH = (name: string) => Number(new RegExp(`${name}: \\{[^}]*minHeight: (\\d+)`).exec(sheet)?.[1] ?? 0);
    check('every button is ≥ 44dp tall', minH('tripPrimary') >= 44 && minH('tripSecondary') >= 44 && minH('tripLater') >= 44,
      `${minH('tripPrimary')}/${minH('tripSecondary')}/${minH('tripLater')}`);
    check('…and the long label cannot overflow (numberOfLines + flexShrink + centred)',
      /tripPrimaryText[^\n]*flexShrink: 1/.test(sheet) && /numberOfLines=\{2\}>\{he \? tripWords\.here\.he/.test(sheet));
    check('"Later" is the sheet\'s own snooze (onLater)', /tripLater\} onPress=\{onLater\}/.test(sheet));
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\nDetection, end to end (fakes)\n');
  const warns: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(' ')); };
  const calls = { tasks: 0, here: 0, label: 0, home: 0, dayStart: 0 };
  const deps = (over: Partial<DetectDeps> = {}, at = new Date(2026, 9, 17, 18, 30)): DetectDeps => ({
    now: () => at,
    here: async () => { calls.here += 1; return NAHARIYA; },
    home: async () => { calls.home += 1; return { coords: HOME, address: HOME_ADDR }; },
    tasksFor: async (d) => { calls.tasks += 1; return d === TOMORROW ? [interview()] : []; },
    dayStart: async () => { calls.dayStart += 1; return null; },
    labelOf: async () => { calls.label += 1; return 'נהריה'; },
    ...over,
  });
  const reset = () => { Object.keys(calls).forEach((k) => ((calls as any)[k] = 0)); warns.length = 0; };
  try {
    reset();
    const r = await detectTripOrigin(deps(), {});
    check('far from home, 18:30 → one question', r.questions.length === 1 && r.decision.ask, JSON.stringify(r.decision));
    const q = r.questions[0];
    check('…with the place name from the geocoder', q?.tripOrigin?.hereLabel === 'נהריה' && calls.label === 1);
    check('…keyed for tomorrow', q?.key === 'tripOrigin:2026-10-18');

    reset();
    const answered = await detectTripOrigin(deps(), { [keyOf(TOMORROW)]: 1 });
    check('answered → nothing is even read', answered.questions.length === 0 && calls.tasks === 0 && calls.here === 0 && calls.label === 0);

    reset();
    const near = await detectTripOrigin(deps({ here: async () => NEAR_HOME }), {});
    check('near home → no question and no reverse-geocode call', near.questions.length === 0 && calls.label === 0
      && !near.decision.ask && near.decision.reason === 'near_home');

    reset();
    const noFix = await detectTripOrigin(deps({ here: async () => null }), {});
    check('no position → no question, the reason is "no_fix"', noFix.questions.length === 0 && !noFix.decision.ask && noFix.decision.reason === 'no_fix');
    check('…and it WARNS (rule 2): she was not told only because we could not tell',
      warns.some((w) => /could not tell whether to ask — no_fix/.test(w)), warns.join(' | '));
    const before = warns.length;
    await detectTripOrigin(deps({ here: async () => null }), {});
    check('…but not on every sweep (throttled)', warns.length === before, `${warns.length - before} more`);

    reset();
    const quiet = await detectTripOrigin(deps({ tasksFor: async () => [] }), {});
    check('a day with no trip is quiet: no question, no warning', quiet.questions.length === 0 && warns.length === 0, warns.join('|'));

    reset();
    const broken = await detectTripOrigin(deps({ tasksFor: async () => { throw new Error('storage gone'); } }), {});
    check('unreadable tasks → no question, reason says so, and it warns',
      !broken.decision.ask && broken.decision.reason === 'tasks_unreadable' && warns.some((w) => /tasks_unreadable/.test(w) && /storage gone/.test(w)),
      warns.join('|'));

    reset();
    const noStore = await detectTripOrigin(deps({ dayStart: async () => { throw new Error('keystore locked'); } }), {});
    check('an unreadable day start never reads as "she said nothing" → no question, warned',
      !noStore.decision.ask && noStore.decision.reason === 'start_unreadable' && warns.some((w) => /start_unreadable/.test(w)));

    reset();
    const said = await detectTripOrigin(deps({ dayStart: async () => ({ lat: 33, lng: 35.1 }) }), {});
    check('a start she already gave → no question', said.questions.length === 0 && !said.decision.ask && said.decision.reason === 'start_set');

    reset();
    const noName = await detectTripOrigin(deps({ labelOf: async () => null }), {});
    check('no place name → still asks, with an empty label (the sheet says "where you are now") — and warns',
      noName.questions[0]?.tripOrigin?.hereLabel === '' && warns.some((w) => /no place name/.test(w)));
    const geoDown = await detectTripOrigin(deps({ labelOf: async () => { throw new Error('geocoder 503'); } }), {});
    check('a geocoder that throws does not lose the question', geoDown.questions.length === 1 && warns.some((w) => /reverse geocode failed/.test(w)));

    reset();
    const daytime = await detectTripOrigin(deps({}, new Date(2026, 9, 17, 9, 0)), {});
    check('09:00 today, leaving 10:34 tomorrow → asks already (departure before noon)', daytime.questions.length === 1);
    const lateLeave = await detectTripOrigin(deps({
      tasksFor: async () => [interview({ fixedTime: '16:00' }, { leaveHomeBy: '15:10', transitPlan: { originAddress: HOME_ADDR, leaveHomeAt: '15:10' } })],
    }, new Date(2026, 9, 17, 9, 0)), {});
    check('09:00 today, leaving 15:10 tomorrow → waits for the evening', lateLeave.questions.length === 0);

    // ═══════════════════════════════════════════════════════════════════════
    console.log('\nHer answer (fakes)\n');
    const store = new Map<string, DayStart>();
    const log: string[] = [];
    const applyDeps = (over: Partial<ApplyDeps> = {}): ApplyDeps => ({
      findTask: async (id) => (id === 't-int' ? { id, text: 'ראיון מכון דוד', date: TOMORROW } : null),
      saveStart: async (d, s) => { log.push(`save ${d}`); store.set(d, s); },
      readStart: async (d) => store.get(d) ?? null,
      clearStart: async (d) => { log.push(`clear ${d}`); return store.delete(d); },
      replan: async (d, id) => { log.push(`replan ${d} ${id}`); },
      now: () => 1234,
      ...over,
    });
    const asked: MeiraQuestion = questionOf(DATA);

    reset(); log.length = 0; store.clear();
    const here = await applyTripOrigin(asked, { choice: 'here' }, applyDeps());
    check('"from here" → ok and saved on the phone', here.result.ok && here.result.savedLocally, JSON.stringify(here.result));
    check('…the start is the position she was SHOWN, with its name', store.get(TOMORROW)?.lat === NAHARIYA.lat
      && store.get(TOMORROW)?.lng === NAHARIYA.lng && store.get(TOMORROW)?.label === 'נהריה' && store.get(TOMORROW)?.setAt === 1234);
    check("…and the first trip is re-planned, FORCED, for that date: ensureTravelChain(date, lang, { forceTaskId })",
      log.join(',') === 'save 2026-10-18,replan 2026-10-18 t-int', log.join(','));
    check('…the confirmation names the place, both languages',
      here.result.effect?.he === 'נשמר: מחר יוצאים מנהריה. מתכננת את הדרך.'
      && here.result.effect?.en === 'Saved: tomorrow starts from נהריה. Planning the way there.', JSON.stringify(here.result.effect));
    check('…nothing goes to the server (phone-only answer): no retry', here.retry === undefined);

    const wiring = src('src/questions/kinds/tripOriginDeps.ts');
    check('the real re-plan IS ensureTravelChain(date, lang, { forceTaskId: taskId, reladder: true })',
      /ensureTravelChain\(date, [^)]*\{ forceTaskId: taskId, reladder: true \}\)/.test(wiring));
    const chain = src('src/services/GoogleSync.ts');
    check('…and "reladder" stops a vehicle the LADDER chose from freezing as hers (a 4 km bus from home must not become a bus-only route from Nahariya)',
      /forced && !\(opts\.reladder && stored0\?\.transportTypeBy === 'ladder'\)/.test(chain)
      && /\|\| stored0\?\.transportTypeBy !== 'ladder'/.test(chain) && /reladder\?: boolean/.test(chain));

    log.length = 0; store.clear();
    const noLabel = await applyTripOrigin(questionOf({ ...DATA, hereLabel: '' }), { choice: 'here' }, applyDeps());
    check('no place name: the start has none and the sentence says "where you are now"',
      store.get(TOMORROW)?.label === undefined && noLabel.result.effect?.he === 'נשמר: מחר יוצאים מהמקום שבו את עכשיו. מתכננת את הדרך.',
      JSON.stringify(noLabel.result.effect));

    log.length = 0; store.clear();
    const home = await applyTripOrigin(asked, { choice: 'home' }, applyDeps());
    check('"from home" → ok, nothing saved, no re-plan (nothing changed)',
      home.result.ok && log.join(',') === 'clear 2026-10-18' && store.size === 0, log.join(','));
    check('…and says so', home.result.effect?.he === 'בסדר — מחר יוצאים מהבית.' && home.result.effect?.en === 'OK — tomorrow starts from home.');

    log.length = 0; store.set(TOMORROW, { lat: 33, lng: 35.1 });
    await applyTripOrigin(asked, { choice: 'home' }, applyDeps());
    check('"from home" after an earlier "from here" undoes it and re-plans', log.join(',') === 'clear 2026-10-18,replan 2026-10-18 t-int', log.join(','));

    log.length = 0; store.clear();
    const lost = await applyTripOrigin(asked, { choice: 'here' }, applyDeps({ saveStart: async () => { throw new Error('disk full'); } }));
    check('a save that fails claims nothing: not ok, "local", no re-plan',
      !lost.result.ok && lost.result.reason === 'local' && !lost.result.savedLocally && !log.some((l) => l.startsWith('replan')), JSON.stringify(lost.result));
    const dropped = await applyTripOrigin(asked, { choice: 'here' }, applyDeps({ saveStart: async () => {} }));
    check('a write that did not land (read back empty) is not ✓', !dropped.result.ok && dropped.result.reason === 'local');
    const gone = await applyTripOrigin(asked, { choice: 'here' }, applyDeps({ findTask: async () => null }));
    check('the task was deleted meanwhile → "task_gone", nothing saved', !gone.result.ok && gone.result.reason === 'task_gone' && store.size === 0);
    const unreadable = await applyTripOrigin(asked, { choice: 'here' }, applyDeps({ findTask: async () => { throw new Error('x'); } }));
    check('a task store that throws → "local", not "gone"', !unreadable.result.ok && unreadable.result.reason === 'local');
    reset();
    const slow = await applyTripOrigin(asked, { choice: 'here' }, applyDeps({ replan: async () => { throw new Error('Directions refused'); } }));
    await new Promise((r) => setTimeout(r, 5));
    check('a re-plan that fails does not undo the answer — it is warned about (the next sweep retries)',
      slow.result.ok && warns.some((w) => /not re-planned after the answer/.test(w)), warns.join('|'));
    const wrong = await applyTripOrigin({ ...asked, tripOrigin: undefined }, { choice: 'here' }, applyDeps());
    check('a question without its data is refused', !wrong.result.ok);
  } finally {
    console.warn = realWarn;
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\nDayStartStore (real module, in-memory disk)\n');
  {
    disk.clear();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const S = require('../src/services/DayStartStore');
    check('nothing stored → null (not an error)', (await S.getDayStart('2026-10-18')) === null);
    await S.setDayStart('2026-10-18', { lat: 33.0089, lng: 35.0981, label: ' נהריה ', setAt: 5 });
    const got = await S.getDayStart('2026-10-18');
    check('set → get round-trips, the name trimmed', got?.lat === 33.0089 && got?.lng === 35.0981 && got?.label === 'נהריה' && got?.setAt === 5, JSON.stringify(got));
    check('another date is untouched', (await S.getDayStart('2026-10-19')) === null);
    let threw = false;
    try { await S.setDayStart('2026-10-18', { lat: 0, lng: 0 }); } catch { threw = true; }
    check('0,0 is refused, loudly', threw);
    threw = false;
    try { await S.setDayStart('tomorrow', { lat: 33, lng: 35 }); } catch { threw = true; }
    check('a non-date key is refused, loudly', threw);
    check('…and neither damaged what was there', (await S.getDayStart('2026-10-18'))?.lat === 33.0089);
    check('clear → true once, then false', (await S.clearDayStart('2026-10-18')) === true && (await S.clearDayStart('2026-10-18')) === false);
    check('…and it is gone', (await S.getDayStart('2026-10-18')) === null);
    for (let d = 1; d <= 20; d++) await S.setDayStart(`2026-10-${String(d).padStart(2, '0')}`, { lat: 33, lng: 35 });
    const kept = Object.keys(JSON.parse(disk.get('lumi.dayStart.v1')!));
    check('only the newest 14 dates are kept', kept.length === 14 && kept.includes('2026-10-20') && !kept.includes('2026-10-06'), String(kept.length));
    disk.set('lumi.dayStart.v1', '{not json');
    const w = console.warn; let warned = false; console.warn = () => { warned = true; };
    const bad = await S.getDayStart('2026-10-20');
    console.warn = w;
    check('an unparseable store is warned about and reads as empty (never a throw into the planner)', bad === null && warned);
    disk.set('lumi.dayStart.v1', JSON.stringify({ '2026-10-20': { lat: 0, lng: 0 }, '2026-10-21': { lat: 33, lng: 35 }, junk: { lat: 1, lng: 1 } }));
    check('rows with no real position or no date are dropped on read',
      (await S.getDayStart('2026-10-20')) === null && (await S.getDayStart('2026-10-21'))?.lat === 33 && (await S.getDayStart('junk')) === null);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\nPrivacy: where she stood never reaches the cloud copy\n');
  {
    const task: any = {
      id: 't1', date: TOMORROW,
      location: {
        address: 'מכון דוד', lat: 32.07, lng: 34.78,
        transitPlan: { originAddress: '33.00890,35.09810', originLabel: 'Haganim St, Nahariya', leaveHomeAt: '07:10' },
        routeWhy: [startLine('set', 'he', 'Haganim St, Nahariya'), 'ישיר: רכבת'],
      },
    };
    const out: any = forCloud(task);
    check('the coordinates are dropped (as before)', out.location.transitPlan.originAddress === undefined);
    check('…and so is the NAME of the place she stood', out.location.transitPlan.originLabel === undefined);
    check('…and the "as you said" line, but not the rest of the reasoning',
      out.location.routeWhy.length === 1 && out.location.routeWhy[0] === 'ישיר: רכבת', JSON.stringify(out.location.routeWhy));
    check('the phone copy is untouched', task.location.routeWhy.length === 2 && task.location.transitPlan.originLabel === 'Haganim St, Nahariya');
    const generic: any = forCloud({ ...task, location: { ...task.location, transitPlan: { originAddress: '33.0,35.0', originLabel: 'My location now' }, routeWhy: undefined } });
    check('a generic label ("My location now") stays', generic.location.transitPlan.originLabel === 'My location now');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\nTriggers (rule 7) and wiring, on the source\n');
  {
    const qs = src('src/services/QuestionService.ts');
    const cas = src('src/services/CalendarAutoSync.ts');
    const gs = src('src/services/GoogleSync.ts');
    const reg = src('src/questions/registry.ts');
    check('registry: detects and applies the kind', /detectTripOrigin/.test(reg) && /case 'tripOrigin':/.test(reg) && /applyTripOrigin\(q, a, tripApplyDeps\)/.test(reg));
    check('1. screen visible: refresh() (maybeAsk on Today) detects it, ahead of the other kinds',
      /detectTripOrigin\(\(await loadState\(\)\)\.answered\)/.test(qs) && /questions = \[\.\.\.trip, \.\.\.afterTrip, \.\.\.places, \.\.\.detectAll\(rs\)\]/.test(qs));
    check('2a. app returns to the front (root): onAppActive → checkTripOrigin',
      /export async function onAppActive[\s\S]*?checkTripOrigin\('app-active'\)/.test(qs));
    check('2b. every foreground calendar sweep (launch / foreground / heartbeat): runCalendarSync → checkTripOrigin',
      /ensureTravelChainAhead\(language\)[\s\S]{0,900}await checkTripOrigin\(/.test(cas) && /import \{ backgroundRun as backgroundQuestions, checkTripOrigin \}/.test(cas));
    check('3. app closed: the background task runs the sweep AND backgroundRun → refresh() → the nudge notification',
      /runCalendarSync\(settings\?\.language/.test(cas) && /backgroundQuestions\(\)/.test(cas)
      && /export async function backgroundRun[\s\S]*?\(await refresh\(\)\)\.filter\(\(x\) => mayInterrupt\(/.test(qs) && /sendImmediate\(`\$\{iconOf\(q\)\} \$\{q\.title\}`/.test(qs));
    check('4. she went looking: You → Meira\'s questions lists pending(), which re-detects when stale',
      /export async function pending[\s\S]*?PENDING_STALE_MS[\s\S]*?await refresh\(\)/.test(qs) && /Questions\.pending\(\)/.test(src('src/components/you/LearnedRules.tsx')));
    check('…and the Plan-tomorrow screen, right after it lays tomorrow\'s route out from home',
      /ensureTravelChain\(tomorrow, settings\.language\)[\s\S]{0,500}checkTripOrigin\('plan-tomorrow'\)/.test(src('src/screens/PlanTomorrow.tsx')));
    check('a failed check warns with its reason, never throws', /trip-origin check failed \(\$\{reason\}\)/.test(qs));
    check('GoogleSync reads the day start for the date it plans (and warns when it cannot)',
      /getDayStart\(date\)\.catch\(\(e\) => \{\s*console\.warn\('\[GoogleSync\] the day start she gave could not be read/.test(gs));
    check('…hands it to tripStart for a day that has not begun', /tripStart\(null, profile\?\.homeLatLng, homeOrigin, false, dayStart\)/.test(gs));
    check("…and for today only when there is no fix and it is the day's first trip",
      /else if \(dayStart && firstTrip\)[\s\S]{0,300}tripStart\(null, profile\?\.homeLatLng, homeOrigin, true, dayStart\)/.test(gs));
    check("…the plan records the start it was made from (originAddress) and says so in her words (startLine with the label)",
      /originAddress: prevAddress/.test(gs) && /startLine\(thisStart, lang, thisStart === 'set' \? setStart\?\.label : undefined\)/.test(gs));
    check("…Directions is asked from the start's coordinates (homeLat/homeLng follow 'set')",
      /thisStart === 'here' \|\| thisStart === 'set' \? prevCoords\?\.lat/.test(gs));
  }

  console.log(`\n${failures ? '✗' : '✓'} ${checks - failures}/${checks} checks passed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
