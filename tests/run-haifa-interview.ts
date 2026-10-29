/**
 * 13.10, Koral — a Rafael interview in Haifa at 13:00 ("ראיון ראשון - קורל
 * זכאי - חיפה", venue " - פארק מדעי החיים "), planned as: leave 08:58, 212
 * minutes, buses 24 → 669 → 998 → 768. Every cause, pinned:
 *
 *   1. The trip started at HOME, though the phone knew where she was.
 *   2. Home had lost its city ("מורדי הגטאות 23") and geocoded to Be'er Sheva.
 *   3. The venue was "completed" with her home's STREET — cityOf read
 *      "21, Mordei ha-Geta'ot Street, Tel Aviv-Yafo" from the wrong end — while
 *      the event's own title said Haifa.
 *   4. A train with a feeder bus and three buses tied as 'mixed', and the
 *      buses won by landing nearer the 30-minute target.
 */
import { cityOf, completeDestination } from '../src/utils/addressCompletion';
import { settleHome, trustHomeFix } from '../src/utils/homeAddress';
import { sameOrigin, startLine, tripStart } from '../src/utils/tripStart';
import { railCarries, rankPlans } from '../src/utils/transitFallback';
import { TransitPlan } from '../src/types/index';
import { vehicleLeftBehind } from '../src/utils/travelLadder';
import { roughMinutes } from '../src/services/TravelEstimator';

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); } else { fail += 1; console.error(`  ✗ ${label}`); }
};

const HOME = "21, Mordei ha-Geta'ot Street, Tel Aviv-Yafo";
const HOME_AT = { lat: 32.0805, lng: 34.7805 };
const BEER_SHEVA = { lat: 31.2457, lng: 34.7925 };

// 1 — today starts where she is
{
  const herzliya = { lat: 32.1624, lng: 34.8447 };
  const s = tripStart(herzliya, HOME_AT, HOME, true);
  ok(s.kind === 'here' && s.origin === '32.16240,34.84470', "today's first trip starts where she is");
  ok(tripStart({ lat: 32.0806, lng: 34.7806 }, HOME_AT, HOME, true).kind === 'home', 'standing at home is home (one stable origin)');
  ok(tripStart(null, HOME_AT, HOME, true).kind === 'home_unknown_here', 'no position: home, and it says it guessed');
  ok(tripStart(herzliya, HOME_AT, HOME, false).kind === 'home', 'tomorrow starts at home');
  ok(sameOrigin('32.16240,34.84470', '32.16300,34.84500'), 'a few metres of GPS wobble is not a new route');
  ok(!sameOrigin('32.16240,34.84470', '32.79400,34.98900'), 'Herzliya and Haifa are two starts');
  ok(startLine('here', 'he') === '📍 מחושב מהמקום שבו את עכשיו', 'the plan says it is from here');
}

// 2 — a home with no city keeps its city, and a jump to Be'er Sheva is not believed
{
  ok(settleHome('מורדי הגטאות 23', HOME) === 'מורדי הגטאות 23, Tel Aviv-Yafo', 'the new home keeps the old city');
  ok(trustHomeFix(BEER_SHEVA, 'מורדי הגטאות 23', HOME_AT) === HOME_AT, "Be'er Sheva for a street with no town is not believed");
  ok(trustHomeFix(BEER_SHEVA, 'מורדי הגטאות 23, באר שבע', HOME_AT) === BEER_SHEVA, 'she can move — by naming the town');
  ok(trustHomeFix({ lat: 32.0817, lng: 34.781 }, 'מורדי הגטאות 23', HOME_AT)?.lat === 32.0817, 'two doors down is fine');
}

// 3 — the venue's city: the event's own, never the home's street
{
  ok(cityOf(HOME) === 'Tel Aviv-Yafo', 'the city of an address that LEADS with its number');
  ok(cityOf('Mordey HaGeta\'ot St 23, Be\'er Sheva, Israel') === "Be'er Sheva", 'and of one that does not');
  ok(completeDestination(' - פארק מדעי החיים ', 'ראיון ראשון - קורל זכאי - חיפה', HOME) === 'פארק מדעי החיים, חיפה',
    'the venue is completed with the city the event names');
  ok(completeDestination('יגאל אלון 94', 'אימון', HOME) === 'יגאל אלון 94, Tel Aviv-Yafo', 'and with her home city when it names none');
  // Already stored that way, on the 18th: "route_failed: destination".
  ok(completeDestination("רפאל מכון  דוד, Mordei ha-Geta'ot Street", 'koral Technical Interview', HOME) === 'רפאל מכון  דוד',
    "the home street the old bug glued on comes off — and a venue name is not sent to Tel Aviv");
  ok(completeDestination("- פארק מדעי החיים, Mordei ha-Geta'ot Street", 'ראיון ראשון - קורל זכאי - חיפה', HOME) === 'פארק מדעי החיים, חיפה',
    'the stored Haifa venue heals to Haifa');
}

// 4 — the train beats the buses
{
  const leg = (type: 'walk' | 'bus' | 'train', durationMinutes: number) =>
    ({ type, from: '', to: '', durationMinutes, departureTime: '', arrivalTime: '' });
  const plan = (leaveHomeAt: string, arriveAt: string, legs: any[]): TransitPlan => ({
    totalDurationMinutes: 0, leaveHomeAt, arriveAt, firstBusDeparture: '', firstBusStop: '',
    walkToStopMinutes: 0, legs, source: 'google', fetchedAt: 0,
  });
  // From Tel Aviv, as Google answers it (plan_journey, 13.10).
  const train = plan('10:34', '12:37', [leg('walk', 5), leg('bus', 8), leg('walk', 4), leg('train', 55), leg('walk', 13), leg('bus', 8), leg('walk', 8)]);
  const buses = plan('10:15', '12:30', [leg('walk', 6), leg('bus', 8), leg('walk', 7), leg('bus', 68), leg('walk', 3), leg('bus', 24), leg('walk', 3)]);
  ok(railCarries(train) && !railCarries(buses), 'a feeder bus does not make a train journey a bus journey');
  const best = rankPlans([buses, train], '13:00', { minBufferMinutes: 30 })[0];
  ok(best === train, 'the train wins, though the buses land nearer "30 minutes early"');
  const late = plan('11:40', '13:05', [leg('walk', 5), leg('train', 55), leg('walk', 13)]);
  ok(rankPlans([late, buses], '13:00', { minBufferMinutes: 30 })[0] === buses, 'but never a train that makes her late');
}

// 5 — the times she is shown hold up
{
  // "it said 10-15 minutes and it took 40": a 3 km city bus is walk + wait + ride + walk.
  const bus = roughMinutes({ lat: 32.08, lng: 34.78 }, { lat: 32.105, lng: 34.79 }, 'bus') ?? 0;
  ok(bus >= 25, `a 3 km bus trip is not "13 minutes" (${bus})`);
  ok(roughMinutes({ lat: 32.08, lng: 34.78 }, { lat: 32.0805, lng: 34.7805 }, 'bus') === 0, 'next door is still no trip');
  // "5 minutes by bike" in Haifa, after arriving by train.
  ok(vehicleLeftBehind('train'), 'after a train, her bike is not with her');
  ok(!vehicleLeftBehind('bike'), 'after riding there, it is');
  ok(!vehicleLeftBehind(undefined), 'at the start of the day it is');
  ok(!vehicleLeftBehind('train', 'bike'), 'her own choice on the card wins');
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
