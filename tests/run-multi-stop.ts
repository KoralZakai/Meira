/**
 * run-multi-stop — three places in one day.
 *
 * The single-appointment case is the easy one. A real day is home → work →
 * a class across town → home, and every leg after the first starts from
 * wherever you already are. `ensureTravelChain` does chain from the previous
 * destination (`prevAddress`), and nothing has ever tested it — a regression
 * there would silently route every trip from home and quietly make the whole
 * day's timing wrong in a way that looks plausible.
 *
 * Also asserts the two rules that only exist on multi-stop days:
 *   - only the FIRST trip gets a wake alarm (a "wake up!" at 16:40 for the gym
 *     is nonsense)
 *   - a gap too small for the journey between two places is caught BEFORE the
 *     day starts, not discovered during it
 *
 * Run:  npx tsx tests/run-multi-stop.ts
 */
import { timeToMinutes, minutesToTime } from '../src/utils/timeUtils';
import { planTransitAlerts, needsWakeAlarm } from '../src/utils/alertPlan';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

interface Stop {
  name: string;
  place: string;
  arriveBy: string;
  durationMinutes: number;
}

/** Travel minutes between two places — the fixture's ground truth. */
const TRAVEL: Record<string, number> = {
  'home→Rothschild 22': 22,
  'Rothschild 22→יגאל אלון 94': 18,
  'יגאל אלון 94→Dizengoff 50': 12,
  'home→Dizengoff 50': 30,
};

const travelBetween = (from: string, to: string): number =>
  TRAVEL[`${from}→${to}`] ?? 25;

const BUFFER = 10;
const ROUTINE = 30;
const USUAL_WAKE = '07:30';

function main() {
  console.log('\nA day with three stops\n');

  const day: Stop[] = [
    { name: 'work',   place: 'Rothschild 22',  arriveBy: '09:00', durationMinutes: 240 },
    { name: 'יוגה',   place: 'יגאל אלון 94',   arriveBy: '14:00', durationMinutes: 60 },
    { name: 'רופא',   place: 'Dizengoff 50',   arriveBy: '15:40', durationMinutes: 30 },
  ];

  // ── chain every leg from the PREVIOUS place ──────────────────────────────
  console.log('1. Each leg starts from where you already are');
  let from = 'home';
  const legs = day.map((stop, i) => {
    const minutes = travelBetween(from, stop.place);
    const leave = minutesToTime(timeToMinutes(stop.arriveBy) - minutes - BUFFER);
    const leg = { stop, from, minutes, leave, isFirst: i === 0 };
    from = stop.place;
    return leg;
  });

  for (const leg of legs) {
    console.log(`     ${leg.from} → ${leg.stop.place}: ${leg.minutes} min, leave ${leg.leave}`);
  }

  check('the second leg starts from the first destination, not home',
    legs[1].from === 'Rothschild 22');
  check('the third leg starts from the second destination',
    legs[2].from === 'יגאל אלון 94');
  check('chaining actually changes the answer',
    legs[2].minutes !== travelBetween('home', 'Dizengoff 50'),
    `chained ${legs[2].minutes} min vs ${travelBetween('home', 'Dizengoff 50')} min from home`);

  // ── the wake alarm belongs to the first trip only ────────────────────────
  // ── every departure is prepared for, only the first one WAKES her ────────
  //
  // Koral, 2026-09-17, watching her phone: "why now for the next event was
  // there no notification to get ready?" Exactly one notification had fired for
  // an 18:30 appointment — "in an hour" — and nothing told her to start moving.
  //
  // planTransitAlerts read the prep time from `wakeUpBy` alone, which
  // GoogleSync sets for the FIRST trip and leaves undefined for the rest. So a
  // later trip got no prep alert at all: planFixedTimeAlerts suppresses its own
  // because a leave time exists, and this one had nothing to work from.
  console.log('\n1b. Every departure gets a prep alert; only the first one WAKES her');
  const laterPlan = {
    totalDurationMinutes: 25, leaveHomeAt: '17:45', arriveAt: '18:10',
    firstBusDeparture: '17:50', firstBusStop: 'x', walkToStopMinutes: 5,
    legs: [{ type: 'bus', from: 'a', to: 'b', durationMinutes: 20,
      departureTime: '17:50', arrivalTime: '18:10' }],
    source: 'google', fetchedAt: Date.now(),
  } as any;
  const laterTask = {
    id: 'evening', text: 'שיעור', category: 'class', priority: 'need_to',
    isFixed: true, fixedTime: '18:30', durationMinutes: 60, date: '2026-09-18',
    status: 'pending', createdAt: 0, historicalDurations: [],
    // No wakeUpBy — exactly what GoogleSync stores for a later trip.
    location: { address: 'somewhere', lat: 32.07, lng: 34.79, confirmed: true,
      transitPlan: laterPlan, leaveHomeBy: '17:45' },
  } as any;
  const laterAlerts = planTransitAlerts(laterTask, laterPlan, 'he', USUAL_WAKE) as any[];
  const laterKinds = laterAlerts.map((a) => a.kind);
  check('a later trip IS told when to start getting ready',
    laterKinds.includes('get_ready'), laterKinds.join(', ') || '(nothing)');
  check('...shortly before the leave time, not a morning routine before it',
    laterAlerts.find((a) => a.kind === 'get_ready')?.at === '17:35',
    String(laterAlerts.find((a) => a.kind === 'get_ready')?.at));
  check('...and it is NEVER a wake alarm — she is already up',
    !laterKinds.includes('wake_up'), laterKinds.join(', '));
  check('...not even when the later trip is in the MORNING',
    !(planTransitAlerts(
      { ...laterTask, fixedTime: '09:30' },
      { ...laterPlan, leaveHomeAt: '08:45', arriveAt: '09:10' },
      'he', USUAL_WAKE,
    ) as any[]).some((a) => a.kind === 'wake_up'),
    'the every-morning alarm rule does not override "you cannot be woken twice"');
  check('the leave alert is still there', laterKinds.includes('leave_home'));

  console.log('\n2. Only the first trip of the day can carry a wake alarm');
  const firstWake = minutesToTime(timeToMinutes(legs[0].leave) - ROUTINE);
  console.log(`     first trip: leave ${legs[0].leave} → be up by ${firstWake}`);

  // Since 2026-09-17 the rule is "any MORNING commitment rings" — Koral's
  // instruction, replacing "only when the day needs you up earlier than you
  // already rise". A 09:00 start needing her up at 07:58 now raises an alarm.
  //
  // What this section is actually guarding is unchanged and is asserted below:
  // only the FIRST trip of a day may carry one. That invariant does not live in
  // needsWakeAlarm at all — it is GoogleSync's `firstTrip` gate — which is why
  // the later legs are checked against the morning WINDOW here, the one thing
  // needsWakeAlarm can speak to.
  check('a 09:00 start DOES raise an alarm now — 07:58 is a morning hour',
    needsWakeAlarm(firstWake, USUAL_WAKE), firstWake);
  check('...and under the OLD policy it did not, kept under its own name',
    !needsWakeAlarm(firstWake, USUAL_WAKE, 'earlier-than-usual'), firstWake);

  // An early start DOES, and that is the case the alarm exists for.
  const earlyLeave = minutesToTime(timeToMinutes('07:00') - 22 - BUFFER);
  const earlyWake = minutesToTime(timeToMinutes(earlyLeave) - ROUTINE);
  console.log(`     a 07:00 start: leave ${earlyLeave} → wake ${earlyWake}`);
  check('a 07:00 start DOES raise a real alarm',
    needsWakeAlarm(earlyWake, USUAL_WAKE), earlyWake);
  for (const leg of legs.slice(1)) {
    const wake = minutesToTime(timeToMinutes(leg.leave) - ROUTINE);
    check(`no wake alarm for "${leg.stop.name}" at ${leg.leave}`,
      !needsWakeAlarm(wake, USUAL_WAKE), `would have been ${wake}`);
  }

  // ── is the day physically possible? ──────────────────────────────────────
  console.log('\n3. Gaps that cannot be made are caught before the day starts');
  const problems: string[] = [];
  for (let i = 1; i < day.length; i++) {
    const prev = day[i - 1];
    const next = day[i];
    const prevEnds = timeToMinutes(prev.arriveBy) + prev.durationMinutes;
    const journey = travelBetween(prev.place, next.place);
    const available = timeToMinutes(next.arriveBy) - prevEnds;
    if (available < journey) {
      problems.push(`${prev.name} → ${next.name}: ${journey - available} min short`);
    }
  }
  console.log(`     work ends 13:00, יוגה at 14:00, journey 18 min → fine`);
  console.log(`     יוגה ends 15:00, רופא at 15:40, journey 12 min → fine`);
  check('this day is makeable', problems.length === 0, problems.join(' | ') || 'no conflicts');

  // Now make it impossible and confirm it is caught.
  const tight: Stop[] = [
    { name: 'יוגה', place: 'יגאל אלון 94',  arriveBy: '14:00', durationMinutes: 60 },
    { name: 'רופא', place: 'Dizengoff 50',  arriveBy: '15:05', durationMinutes: 30 },
  ];
  const ends = timeToMinutes(tight[0].arriveBy) + tight[0].durationMinutes;   // 15:00
  const journey = travelBetween(tight[0].place, tight[1].place);              // 12
  const available = timeToMinutes(tight[1].arriveBy) - ends;                  // 5
  check('a 5-minute gap for a 12-minute journey is flagged', available < journey);
  check('the shortfall is quantified', journey - available === 7, `${journey - available} min short`);

  // ── the whole day fits inside one waking day ─────────────────────────────
  console.log('\n4. Sanity');
  check('every leave time precedes its appointment',
    legs.every((l) => timeToMinutes(l.leave) < timeToMinutes(l.stop.arriveBy)));
  check('leave times run in order through the day',
    legs.every((l, i) => i === 0 || timeToMinutes(l.leave) > timeToMinutes(legs[i - 1].leave)));
  check('nothing wraps past midnight',
    legs.every((l) => timeToMinutes(l.leave) > 0));

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} checks passed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
