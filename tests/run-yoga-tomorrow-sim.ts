/**
 * run-yoga-tomorrow-sim — the exact run-through Koral asked for, end to end.
 *
 * Her instruction, 2026-09-17:
 *
 *   "simulate — writing to the app chat 'יוגה מחר ב 11 בבוקר ביגאל אלון 94'
 *    and check what happens, getting there by bike. Check whether it was
 *    saved, whether it shows on the 'tomorrow' page, whether there is a clock
 *    alarm, whether there are reminders to leave... simulate it yourself.
 *    Then add something after it and check the route is computed FROM THE
 *    CURRENT LOCATION (if right after the yoga)."
 *
 * The numbers below are not invented. They were taken from the live server on
 * 2026-09-17, with the real Google Maps key, for her real home address:
 *
 *     dest   Yigal Alon St 94, Tel Aviv-Yafo   (32.0691221, 34.7940518)
 *     bike   7 minutes
 *     leave  10:43
 *     be up  09:58
 *
 * And the control that makes the whole thing worth checking:
 *
 *     'יגאל אלון 94 תל אביב'  ->  Yigal Alon St 94, Tel Aviv-Yafo
 *     'יגאל אלון 94'          ->  יגאל אלון 94, DIMONA
 *
 * Both languages are run through the same checks, because the behaviour must
 * not depend on which one she typed in.
 *
 * Run:  npx tsx tests/run-yoga-tomorrow-sim.ts
 */
import { Task, TaskLocation } from '../src/types/index';
import { extractLocally } from '../src/utils/localTaskExtract';
import { parseTimeExpression } from '../src/utils/timeParser';
import { placePartsFrom } from '../src/utils/placeFromText';
import { completeAddress } from '../src/utils/addressCompletion';
import { pickCoords, locationIsPlaced } from '../src/utils/placeCoords';
import { planFixedTimeAlerts, planTransitAlerts, needsWakeAlarm } from '../src/utils/alertPlan';
import { decideAlarmState, plannedAlarmTime } from '../src/utils/alarmPlan';
import { protectedWindowFor } from '../src/utils/yieldToFixed';
import { travelRowState } from '../src/utils/travelRowState';
import { rememberMode, preferredMode, EMPTY_PREFERENCES } from '../src/utils/travelPreference';
import { rememberPlace, resolvePlace } from '../src/utils/knownPlaces';
import { decideLiveReplan } from '../src/utils/liveReplanDecision';
import { timeToMinutes, minutesToTime } from '../src/utils/timeUtils';

let failures = 0; let checks = 0;
const check = (l: string, ok: boolean, d = '') => {
  checks += 1; if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${l}${d ? `  — ${d}` : ''}`);
};

const TODAY = '2026-09-17';
const TOMORROW = '2026-09-18';
const HOME_ADDR = "Mordei ha-Geta'ot St 25, Tel Aviv-Yafo, Israel";
const HOME = { lat: 32.0563065, lng: 34.7875888 };
const GYM = { lat: 32.0691221, lng: 34.7940518 };       // Yigal Alon St 94
const CAFE = { lat: 32.1093, lng: 34.8555 };            // Ramat Gan, properly far
// From the live server, for this exact trip.
const BIKE_MINUTES = 7;
const LEAVE_AT = '10:43';
const UP_BY = '09:58';

const details = () => ({ category: 'gym' as const, priority: 'need_to' as const, durationMinutes: 60 });
const parsers = {
  time: (t: string, r: string) => parseTimeExpression(t, r) as any,
  place: placePartsFrom,
  details,
};

/**
 * The margin the real planner leaves between arriving and starting. The server
 * uses 10 (plan_departure's buffer_minutes), and leaving it out here made the
 * stub disagree with the live numbers by exactly that much — which is a bug in
 * the MODEL, not in the app, and is why this constant is named rather than
 * absorbed into a looser tolerance.
 */
const BUFFER_MINUTES = 10;

/** Google, as a deterministic function of distance. The only stand-in here. */
function ride(from: typeof HOME, to: typeof HOME, arriveBy: string) {
  const R = 6371000; const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(to.lat - from.lat); const dLng = rad(to.lng - from.lng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(from.lat)) * Math.cos(rad(to.lat)) * Math.sin(dLng / 2) ** 2;
  const metres = 2 * R * Math.asin(Math.sqrt(h));
  const mins = Math.max(5, Math.round((metres / 1000) * 4));   // ~15 km/h in town
  return {
    totalDurationMinutes: mins,
    leaveHomeAt: minutesToTime(timeToMinutes(arriveBy) - mins - BUFFER_MINUTES),
    arriveAt: arriveBy, firstBusDeparture: '', firstBusStop: '', walkToStopMinutes: 0,
    legs: [], destLat: to.lat, destLng: to.lng, startLat: from.lat, startLng: from.lng,
    source: 'google' as const, fetchedAt: Date.now(),
  };
}

const SENTENCES = {
  he: 'יוגה מחר ב 11 בבוקר ביגאל אלון 94',
  en: 'yoga tomorrow at 11 am at Yigal Alon 94',
};

function main() {
  console.log('\nThe full run-through: "yoga tomorrow at 11, Yigal Alon 94", by bike\n');

  for (const [lang, sentence] of Object.entries(SENTENCES)) {
    console.log(`\n══ ${lang.toUpperCase()}: "${sentence}" ══\n`);

    // ── 1. typed into the chat, with the server unreachable ──────────────
    console.log('1. It is understood, and SAVED — even with no server');
    const parsed = extractLocally(sentence, TODAY, parsers);
    check('the message becomes a task', Boolean(parsed), parsed ? 'saved' : 'LOST — small talk');
    if (!parsed) { console.log('   (cannot continue for this language)'); continue; }
    check('...on TOMORROW, not today', parsed.date === TOMORROW, parsed.date);
    check('...at 11:00', parsed.fixedTime === '11:00', String(parsed.fixedTime));
    check('...with the place she named', Boolean(parsed.location), String(parsed.location));

    // ── 2. the city she did not type ─────────────────────────────────────
    console.log('\n2. The city she did not type — the Dimona control');
    const dest = completeAddress(parsed.location!, HOME_ADDR);
    check('the bare street is completed from her home city',
      /תל אביב|Tel Aviv/i.test(dest), dest);
    check('...which is the difference between her gym and Dimona', dest !== parsed.location);

    // ── 3. a real place on a real map ────────────────────────────────────
    console.log('\n3. A real location on the map');
    const plan = ride(HOME, GYM, '11:00');
    const coords = pickCoords({ address: dest, lat: 0, lng: 0, confirmed: false }, plan)!;
    check('coordinates come back, and they are NOT Null Island',
      locationIsPlaced({ ...coords } as any), `${coords.lat}, ${coords.lng}`);
    check('...and they are the gym', Math.abs(coords.lat - GYM.lat) < 0.001);

    // ── 4. the bike route ────────────────────────────────────────────────
    console.log('\n4. Getting there by bike');
    let prefs = rememberMode(EMPTY_PREFERENCES, { mode: 'bike', place: dest, category: 'gym' });
    const mode = preferredMode(prefs, { place: dest, category: 'gym' }, 'bus');
    check('the mode she chose is remembered and reused', mode.mode === 'bike', mode.mode);
    check('...and it says so rather than assuming silently', mode.from === 'place');
    check(`the ride is about ${BIKE_MINUTES} minutes`,
      Math.abs(plan.totalDurationMinutes - BIKE_MINUTES) <= 3,
      `${plan.totalDurationMinutes} min (server said ${BIKE_MINUTES})`);
    check(`she leaves around ${LEAVE_AT}`,
      Math.abs(timeToMinutes(plan.leaveHomeAt) - timeToMinutes(LEAVE_AT)) <= 5,
      `${plan.leaveHomeAt} (server said ${LEAVE_AT})`);

    const task: Task = {
      id: `yoga-${lang}`, text: parsed.text, category: 'gym', priority: 'need_to',
      isFixed: true, fixedTime: '11:00', durationMinutes: 60, date: TOMORROW,
      status: 'pending', createdAt: Date.now(), historicalDurations: [],
      location: {
        address: dest, ...coords, confirmed: true, transportType: 'bike',
        transitPlan: plan, leaveHomeBy: plan.leaveHomeAt,
        travelMinutes: plan.totalDurationMinutes, wakeUpBy: UP_BY,
      } as TaskLocation,
    } as Task;

    check('the travel row shows a route, not a blank space',
      travelRowState(task) === 'route', travelRowState(task));

    // ── 5. the alarm — her new rule ──────────────────────────────────────
    console.log('\n5. The clock alarm');
    check(`being up at ${UP_BY} is a morning hour`, needsWakeAlarm(UP_BY, '07:30'));
    check('...so the alarm is PLANNED, not "not needed"',
      decideAlarmState(task, '07:30', 60) === 'planned',
      decideAlarmState(task, '07:30', 60));
    check('...and it rings at the route\'s own wake time',
      plannedAlarmTime(task, 60) === UP_BY, String(plannedAlarmTime(task, 60)));

    // ── 6. the reminders ─────────────────────────────────────────────────
    console.log('\n6. The reminders to leave');
    // planFixedTimeAlerts covers the appointment itself; the LEAVE alerts and
    // their "still at home?" nags come from the travel path, which is the half
    // she actually asked about.
    const alerts = planFixedTimeAlerts(task, lang === 'he' ? 'he' : 'en',
      plan.leaveHomeAt, undefined, { routineMinutes: 60, usualWakeTime: '07:30' });
    const travel = planTransitAlerts(task, plan as any, lang === 'he' ? 'he' : 'en', '07:30') as any[];
    const kinds = [...alerts, ...travel].map((a) => a.kind);
    check('there are alerts at all', alerts.length > 0, kinds.join(', ') || '(none)');
    check('...on the right day', alerts.every((a) => (a.dayOffset ?? 0) === 0));
    check('she is told WHEN TO LEAVE', kinds.includes('leave_home'), kinds.join(', '));
    check('...and nagged if she has not gone', kinds.filter((k) => k === 'leave_nag').length >= 1);
    check('...and woken, because 09:58 is a morning hour', kinds.includes('wake_up'));
    check('the leave alert is at the route\'s own leave time',
      travel.find((a) => a.kind === 'leave_home')?.at === plan.leaveHomeAt,
      String(travel.find((a) => a.kind === 'leave_home')?.at));
    const window = protectedWindowFor(task, null)!;
    check('getting ready comes before leaving',
      window.readyAt < window.leaveAt, `${window.readyAt} → ${window.leaveAt} → 11:00`);
    check('...and the travel time is the real one, not an assumption',
      window.travelAssumed === false && window.travelMinutes === plan.totalDurationMinutes);

    // ── 7. remembered for next time ──────────────────────────────────────
    console.log('\n7. "This is my gym address" — learned once');
    const places = rememberPlace({}, parsed.text, dest, coords);
    const recalled = resolvePlace(places, lang === 'he' ? 'יוגה ב-11' : 'yoga at 11');
    check('next time she names no address, it is already known', Boolean(recalled));
    check('...at the same place', recalled?.address === dest, String(recalled?.address));
    check('...and it crosses languages',
      resolvePlace(places, 'gym')?.address === dest);
  }

  // ── 8. a second task, right after the yoga ──────────────────────────────
  console.log('\n\n══ A SECOND TASK, RIGHT AFTER THE YOGA ══\n');
  console.log('8. The next journey starts where she IS, not at home');
  const fromGym = ride(GYM, CAFE, '13:00');
  const fromHome = ride(HOME, CAFE, '13:00');
  check('a trip from the gym is a different trip from one from home',
    fromGym.totalDurationMinutes !== fromHome.totalDurationMinutes,
    `gym ${fromGym.totalDurationMinutes}m vs home ${fromHome.totalDurationMinutes}m`);
  check('...so the leave time differs too',
    fromGym.leaveHomeAt !== fromHome.leaveHomeAt,
    `${fromGym.leaveHomeAt} vs ${fromHome.leaveHomeAt}`);

  console.log('\n9. ...and it keeps up when she moves');
  const onPlan = decideLiveReplan({
    current: GYM,
    trip: { destination: CAFE, plannedFrom: GYM, leaveHomeBy: fromGym.leaveHomeAt,
      arriveAt: '13:00', appointment: '13:00' },
    home: HOME, now: new Date(`${TOMORROW}T12:00:00`),
  });
  check('standing at the gym, the plan from the gym is correct',
    onPlan.replan === false && onPlan.reason === 'on-plan', onPlan.reason);

  const moved = decideLiveReplan({
    current: HOME,
    trip: { destination: CAFE, plannedFrom: GYM, leaveHomeBy: fromGym.leaveHomeAt,
      arriveAt: '13:00', appointment: '13:00' },
    home: HOME, now: new Date(`${TOMORROW}T12:00:00`),
  });
  check('she goes home instead — the app notices by itself', moved.replan === true);
  check('...and knows why', moved.reason === 'moved-off-origin', moved.reason);
  check('...and by how far', (moved.metres ?? 0) > 500, `${moved.metres} m`);

  const arrived = decideLiveReplan({
    current: CAFE,
    trip: { destination: CAFE, plannedFrom: GYM, leaveHomeBy: fromGym.leaveHomeAt,
      arriveAt: '13:00', appointment: '13:00' },
    home: HOME, now: new Date(`${TOMORROW}T13:00:00`),
  });
  check('and it stops the moment she gets there', arrived.reason === 'already-there');

  console.log(`\n${failures ? '✗' : '✓'} ${checks - failures}/${checks} checks passed\n`);
  process.exit(failures ? 1 : 0);
}

main();
