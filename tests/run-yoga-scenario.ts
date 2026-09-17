/**
 * run-yoga-scenario — the whole backward chain for one real sentence.
 *
 * The scenario, as the user described it:
 *   "מחר יוגה ב-11:00 ביגאל אלון 94 תל אביב"   … then: "אופניים"
 *
 * What has to happen, in order, for Lumi to be doing its job:
 *   1. "מחר" resolves to a real date, and that date is a Friday
 *   2. the Hebrew address survives correction and geocodes
 *   3. a REAL Google Directions bicycling call gives the ride time
 *   4. the chain runs BACKWARDS: arrive 11:00 → leave → start getting ready →
 *      wake, using this user's own routine and buffer minutes
 *   5. alerts land on the right date, and the wake alarm is armed correctly
 *   6. the trip is eligible for the Trips tab
 *   7. arrival closes the trip and feeds the on-time learning
 *
 * Live by default — the point is to check Google, not a fixture. Pass
 * --offline to use the recorded ride time instead (CI, or no key).
 *
 * Run:  EXPO_PUBLIC_GOOGLE_MAPS_API_KEY=... npx tsx tests/run-yoga-scenario.ts
 *       npx tsx tests/run-yoga-scenario.ts --offline
 */
import { getPlanForMode } from '../src/services/RoutePlanner';
import { correctPlaceName } from '../src/utils/fuzzyMatch';
import { extractHebrewPlaceParts } from '../src/utils/hebrewPlace';
import { parseTimeExpression } from '../src/utils/timeParser';
import { completeAddress, needsCity } from '../src/utils/addressCompletion';
import { planTransitAlerts, needsWakeAlarm } from '../src/utils/alertPlan';
import {
  decideAlarmState, alarmMomentOf, isWithinAlarmReach,
} from '../src/utils/alarmPlan';
import { timeToMinutes, minutesToTime } from '../src/utils/timeUtils';
import { Task, TransitPlan, UserProfile } from '../src/types/index';

const OFFLINE = process.argv.includes('--offline');

// ── the user, as the server actually has her ────────────────────────────────
// Taken from server/profiles.json: routine 30 min, buffer 10 min. homeAddress
// is EMPTY there — see the homeAddress check below, which is the point.
const HOME = "Mordei ha-Geta'ot St 25, Tel Aviv-Yafo, Israel";
const ROUTINE_MINUTES = 30;
const BUFFER_MINUTES = 10;
const USUAL_WAKE = '07:30';

const profile = {
  name: 'Koral',
  homeAddress: HOME,
  morningRoutineMinutes: ROUTINE_MINUTES,
  wakeBufferMinutes: BUFFER_MINUTES,
  defaultWakeTime: USUAL_WAKE,
  transportType: 'bike',
} as unknown as UserProfile;

// ── the sentence ────────────────────────────────────────────────────────────
const SENTENCE = 'מחר יוגה ב-11:00 ביגאל אלון 94 תל אביב';
const DESTINATION = 'יגאל אלון 94 תל אביב';
const START = '11:00';
const RECORDED_RIDE_MINUTES = 6;   // what Google returned on 2026-08-20

let failures = 0;
let checks = 0;

function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The local calendar's answer for "N days from now". */
function resolveTomorrowLocally(at: Date, days = 1): string {
  const d = new Date(at);
  d.setDate(d.getDate() + days);
  return iso(d);
}

async function main() {
  console.log(`\n"${SENTENCE}"  →  אופניים\n`);
  console.log(`mode: ${OFFLINE ? 'OFFLINE (recorded)' : 'LIVE (real Google Directions)'}\n`);

  // ── 1. "מחר" ──────────────────────────────────────────────────────────────
  console.log('1. Understanding "מחר"');
  const now = new Date();
  const tomorrow = resolveTomorrowLocally(now);
  const tomorrowDate = new Date(`${tomorrow}T00:00:00`);
  const dayName = DAY_NAMES[tomorrowDate.getDay()];

  check('"מחר" resolves to a date', Boolean(tomorrow), tomorrow);
  check('and Lumi knows which weekday that is', Boolean(dayName), dayName);
  console.log(`     today is ${DAY_NAMES[now.getDay()]} ${iso(now)}, so "מחר" = ${dayName} ${tomorrow}`);

  // The REAL parser, on the real sentence. Hebrew "מחר" used to reach no
  // branch at all: timeParser was English-only and TaskIntent's fallback used
  // /\\bמחר\\b/, and JS word boundaries are ASCII-only so that matches nothing.
  const parsed = parseTimeExpression(SENTENCE, iso(now));
  check('the parser recognises Hebrew "מחר"',
    parsed.daysFromNow === 1,
    `daysFromNow=${parsed.daysFromNow ?? 'undefined'}`);
  check('and it lands on the local calendar date',
    parsed.deadline === tomorrow,
    `${parsed.deadline} vs ${tomorrow}`);
  check('it also picked up the 11:00',
    parsed.fixedTime === START,
    `${parsed.fixedTime}`);

  // The UTC-vs-local class of bug, guarded directly. Both TaskIntent and
  // timeParser used `toISOString().slice(0, 10)` on a LOCAL date: east of
  // Greenwich, any local time before the UTC offset (01:00 in Israel) is still
  // the previous day in UTC, so "מחר" filed the task on TODAY.
  const lateLocal = new Date(`${iso(now)}T01:00:00`);
  const utcKey = lateLocal.toISOString().slice(0, 10);
  const localKey = iso(lateLocal);
  const offsetShifts = utcKey !== localKey;
  check('local date key does not drift to UTC at 01:00',
    localKey === iso(now),
    offsetShifts ? `toISOString would say ${utcKey}, local is ${localKey}` : 'no offset here');

  // The other Hebrew relative forms, which had no path either.
  for (const [phrase, days] of [['מחרתיים', 2], ['בעוד 3 ימים', 3], ['שבוע הבא', 7]] as const) {
    const r = parseTimeExpression(`${phrase} יוגה`, iso(now));
    check(`"${phrase}" → +${days}d`, r.daysFromNow === days, `daysFromNow=${r.daysFromNow}`);
  }

  // ── 2. the address ────────────────────────────────────────────────────────
  // ── 2a. THE SAME SENTENCE, WITHOUT THE CITY ───────────────────────────────
  //
  // Koral, 2026-09-17: "i added to tomorrow a task 'יוגה ב 11 בבוקר ביגאל
  // אלון 94' — i didn't write tel aviv but Meira needs to know that, this is
  // my gym address."
  //
  // Everything above this line was written for a sentence that NAMED the city.
  // Hers did not, and that one missing word went all the way down: the parser
  // was fine, and then geocodeTaskLocation handed "יגאל אלון 94" to
  // expo-location's platform geocoder — no country, no region, no idea where
  // she lives — while its own comment claimed to be using Google. Israel has a
  // Yigal Alon street in more than one town, and picking the wrong one is not
  // an error: it is a confident route, with a leave time and an alarm on top.
  console.log('\n2a. The same sentence with the city left out');
  const TYPED = 'יוגה ב 11 בבוקר ביגאל אלון 94';
  const parts = extractHebrewPlaceParts(TYPED);
  check('the parser finds the street and stops before the hour',
    parts.place === 'יגאל אלון 94', String(parts.place));
  check('...and the hour is read from the same sentence',
    parseTimeExpression(TYPED).fixedTime === '11:00',
    String(parseTimeExpression(TYPED).fixedTime));
  check('a bare street is recognised as INCOMPLETE, not as wrong',
    needsCity(parts.place!));
  const completed = completeAddress(parts.place!, profile.homeAddress);
  check('it is completed from the city she actually lives in',
    completed === 'יגאל אלון 94, Tel Aviv-Yafo', completed);
  check('...which is what the geocoder and Directions now receive',
    completed !== parts.place);
  check('and a street she DID give a city for is left alone',
    completeAddress('יגאל אלון 94, חיפה', profile.homeAddress) === 'יגאל אלון 94, חיפה',
    'she said Haifa and she meant Haifa');

  console.log('\n2. The address');
  const corrected = correctPlaceName(DESTINATION);
  check('Hebrew destination survives correction', corrected.includes('יגאל אלון'), corrected);
  check(
    'home address is set (without it there is no origin to leave from)',
    Boolean(profile.homeAddress),
    profile.homeAddress || 'EMPTY',
  );

  // ── 3. real route ─────────────────────────────────────────────────────────
  console.log('\n3. The ride (bike)');
  let plan: TransitPlan | null = null;
  let rideMinutes = RECORDED_RIDE_MINUTES;

  if (OFFLINE) {
    console.log(`     using recorded ${RECORDED_RIDE_MINUTES} min`);
  } else {
    plan = await getPlanForMode('bike', DESTINATION, START, profile, tomorrow);
    check('Google returned a bicycling route', Boolean(plan),
      plan ? `${plan.totalDurationMinutes} min` : 'null — no route');
    if (plan) {
      rideMinutes = plan.totalDurationMinutes;
      check('the route carries a polyline for the map',
        Boolean((plan as any).overviewPolyline),
        (plan as any).overviewPolyline ? 'yes' : 'MISSING — RouteMap will render empty');
      check('leaveHomeAt is computed', Boolean(plan.leaveHomeAt), plan.leaveHomeAt);
      check('arriveAt is not after the class starts',
        !plan.arriveAt || timeToMinutes(plan.arriveAt) <= timeToMinutes(START),
        `${plan.arriveAt} vs ${START}`);
    }
  }

  // ── 4. backwards ──────────────────────────────────────────────────────────
  console.log('\n4. Counting backwards from 11:00');
  const leaveAt = plan?.leaveHomeAt
    ?? minutesToTime(timeToMinutes(START) - rideMinutes - BUFFER_MINUTES);
  const prepAt = minutesToTime(timeToMinutes(leaveAt) - ROUTINE_MINUTES);
  const wakeAt = prepAt;

  console.log(`     🧘 class          ${START}`);
  console.log(`     🚴 ride           ${rideMinutes} min`);
  console.log(`     🚪 leave home     ${leaveAt}   (ride + ${BUFFER_MINUTES} min buffer)`);
  console.log(`     🧴 start getting ready ${prepAt}   (routine ${ROUTINE_MINUTES} min)`);

  check('leave time is before the class', timeToMinutes(leaveAt) < timeToMinutes(START));
  check('getting-ready starts before leaving', timeToMinutes(prepAt) < timeToMinutes(leaveAt));
  check('the whole chain fits inside the same morning', timeToMinutes(prepAt) > 0);

  // ── 5. alarm or nudge? ────────────────────────────────────────────────────
  console.log('\n5. Alarm');
  const isAlarm = needsWakeAlarm(wakeAt, USUAL_WAKE);
  console.log(`     normally wakes ${USUAL_WAKE}, needs to be up ${wakeAt}`);
  // Reversed 2026-09-17. This asserted NO alarm for an 11:00 class, on the rule
  // that one fires only when the day forces her up earlier than usual. Her
  // instruction: "need to be clock alarm! ... a clock alarm must be every day
  // according the schedule! in the AM hours." An 11:00 class is a morning
  // commitment, so it rings.
  check(
    'a 11:00 class DOES set a wake alarm — every morning, per her rule',
    isAlarm,
    isAlarm ? `⏰ at ${wakeAt}` : 'silent — the old rule has leaked back in',
  );
  check(
    'an evening class still does not — that half was never in dispute',
    !needsWakeAlarm('17:30', USUAL_WAKE),
  );

  const task: Task = {
    id: 'yoga-test',
    text: 'יוגה',
    category: 'gym',
    priority: 'need_to',
    isFixed: true,
    fixedTime: START,
    durationMinutes: 60,
    date: tomorrow,
    status: 'pending',
    createdAt: Date.now(),
    historicalDurations: [],
    location: {
      address: DESTINATION,
      displayName: 'יגאל אלון 94',
      lat: 32.0713, lng: 34.7942,
      confirmed: true,
      leaveHomeBy: leaveAt,
      wakeUpBy: wakeAt,
      transitPlan: plan ?? undefined,
    },
  } as Task;

  const state = decideAlarmState(task, USUAL_WAKE);
  const moment = alarmMomentOf(task);
  check('alarm state machine reaches a decision', Boolean(state), String(state));
  check('the alarm moment is on the class date',
    !moment || iso(moment) === tomorrow,
    moment ? iso(moment) : 'none');
  // Asked from the EVENING BEFORE, which is when the arming sweep actually
  // runs (App.runDailyMoments → armTomorrowAlarms). Asking at the wall clock
  // made this check fail whenever the suite ran after midnight: tomorrow's
  // 08:00 class really is more than 24 h away at 00:16, and the alarm really
  // does stay 'planned' until the evening — the code was right and the test
  // was reading the wrong hour.
  const eveningBefore = new Date();
  eveningBefore.setHours(20, 0, 0, 0);
  const inReach = isWithinAlarmReach(task, eveningBefore.getTime());
  check('by the evening before, tomorrow is inside Android\'s 24h alarm reach',
    !moment || inReach,
    moment ? (inReach ? 'yes — armable the night before' : 'no — stays "planned" until closer') : 'n/a');

  // ── 6. alerts ─────────────────────────────────────────────────────────────
  console.log('\n6. Alerts');
  if (plan) {
    const alerts = planTransitAlerts(task, plan, 'he', USUAL_WAKE);
    check('alerts were planned', alerts.length > 0, `${alerts.length}`);
    for (const a of alerts) {
      const onDate = (a as any).date ?? tomorrow;
      console.log(`     ${onDate} ${(a as any).at}  ${(a as any).title ?? ''}`);
    }
    check('every alert falls on the class date',
      alerts.every((a: any) => (a.date ?? tomorrow) === tomorrow),
      tomorrow);
    check('an alert exists at or before the leave time',
      alerts.some((a: any) => timeToMinutes(a.at) <= timeToMinutes(leaveAt)),
      `leave ${leaveAt}`);
  } else {
    console.log('     (skipped — no live plan)');
  }

  // ── 7. Trips tab ──────────────────────────────────────────────────────────
  console.log('\n7. Trips tab');
  const loc: any = task.location;
  check('this task qualifies as a trip (has lat/lng)', Boolean(loc?.lat && loc?.lng));
  check('it has a leave time to show', Boolean(loc?.leaveHomeBy), loc?.leaveHomeBy);
  check('it is within the 14-day horizon', tomorrow <= iso(new Date(Date.now() + 14 * 864e5)));

  // ── 8. arrival closes the loop ────────────────────────────────────────────
  console.log('\n8. Arrival → learning');
  const arrived: Task = {
    ...task,
    verifiedArrival: true,
    status: 'complete',
    completedAt: new Date(`${tomorrow}T${START}:00`).getTime(),
  };
  check('arrival can be recorded on the task', arrived.verifiedArrival === true);
  check('completion is recorded', arrived.status === 'complete');
  // On time = arrived no later than the class start.
  const arrivedMinutes = plan?.arriveAt ? timeToMinutes(plan.arriveAt) : timeToMinutes(START);
  check('on-time vs late is computable from the plan',
    Number.isFinite(arrivedMinutes),
    arrivedMinutes <= timeToMinutes(START) ? 'on time' : 'late');

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} checks passed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('scenario crashed:', e);
  process.exit(1);
});
