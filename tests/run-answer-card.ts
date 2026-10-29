/**
 * The answer card's words, order and links (utils/answerCard).
 *
 * 7.10: "how do I get home from here?" must show every way — on foot, which
 * bus from where and when, a taxi with Gett — fastest first; "which beach is
 * fastest by car?" the winner with drive + parking + walk. The payloads below
 * are place_ranker's shape, the beach numbers are the live answer of 7.10.
 */
import {
  LookupAnswer, asLookupAnswer, cardHeading, cardOptions, gettLink, legDetail, mapsLink,
  placeLink, primaryLabel, travelModeOf, wazeLink,
} from '../src/utils/answerCard';

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); } else { fail += 1; console.error(`  ✗ ${label}`); }
};
const section = (s: string) => console.log(`\n${s}`);

const HOME: LookupAnswer = {
  ok: true, kind: 'route', to_home: true, origin_used: 'here',
  origin: { name: 'Space Gym', lat: 32.07, lng: 34.79 },
  destination: { name: 'home', address: 'Home St 1', lat: 32.06, lng: 34.8 },
  results: [{
    name: 'home', best: { mode: 'taxi', total_min: 14 },
    by_mode: {
      walk: { mode: 'walk', total_min: 38, ride_min: 38 },
      bus: { mode: 'bus', total_min: 22, line: '18', from_stop: 'דרך השלום', board_at: '17:42',
        arrive_at: '17:59', walk_to_stop_min: 5 },
      taxi: { mode: 'taxi', total_min: 14, ride_min: 9, wait_min: 5, wait_is_estimate: true },
    },
  }],
};

const BEACH: LookupAnswer = {
  ok: true, kind: 'places', query: 'חוף ים', origin_used: 'home',
  results: [
    { name: 'חוף עליה', lat: 32.05, lng: 34.75, best: { mode: 'car', total_min: 35, ride_min: 25, park_min: 10 } },
    { name: 'טיילת חוף תל אביב', lat: 32.08, lng: 34.76,
      best: { mode: 'car', total_min: 36, ride_min: 30, park_min: 5, walk_from_parking_min: 1 } },
  ],
};

section('route home: every way, fastest first');
{
  const opts = cardOptions(HOME, true);
  ok(opts.map((o) => o.mode).join(',') === 'taxi,bus,walk', 'taxi 14 · bus 22 · walk 38');
  ok(opts[1].title === 'אוטובוס קו 18', 'the bus row names its line');
  ok(opts[1].detail === '5 דק׳ הליכה לדרך השלום · יוצא 17:42 · הגעה 17:59', 'where, when, and arrival');
  ok(opts[0].detail === '~5 המתנה + 9 נסיעה', 'a taxi says its wait is an estimate, and no price');
  ok(!opts.some((o) => /₪|\$/.test(o.detail)), 'no price anywhere');
  ok(primaryLabel(HOME, opts[1], true) === 'יוצאת עכשיו · אוטובוס קו 18', 'main button follows the chosen row');
  ok(cardHeading(HOME, true).title === 'הביתה · יוצאת עכשיו', 'heading');
  ok(cardHeading(HOME, true).sub.includes('בדקתי 3 דרכים'), 'says how much was checked');
  ok(travelModeOf('taxi') === 'car', 'a taxi trip is routed as a car');
}

section('the beach: the winner, then the next');
{
  const opts = cardOptions(BEACH, true);
  ok(opts[0].title === 'חוף עליה' && opts[0].minutes === 35, 'winner first');
  ok(opts[0].detail === '25 נסיעה · ~10 חניה', 'drive + parking (estimate)');
  ok(opts[1].detail === '30 נסיעה · ~5 חניה · 1 הליכה', 'drive + parking + walk');
  ok(primaryLabel(BEACH, opts[0], true) === 'נווטי לחוף עליה', 'places: the main button navigates');
  ok(cardHeading(BEACH, true).sub.startsWith('מהבית'), 'from home, as she asked');
}

section('bike or bus: the other way shows beside the best');
{
  const both: LookupAnswer = { ...BEACH, results: [{ ...BEACH.results[0],
    best: { mode: 'bike', total_min: 17, ride_min: 15, lock_min: 2 },
    by_mode: { bike: { mode: 'bike', total_min: 17, ride_min: 15, lock_min: 2 },
      bus: { mode: 'bus', total_min: 31 } } }] };
  ok(cardOptions(both, true)[0].detail === '15 רכיבה · 2 נעילה · אוטובוס 31', 'bus minutes on the row');
}

section('links');
{
  ok(wazeLink(32.05, 34.75) === 'https://waze.com/ul?ll=32.05,34.75&navigate=yes', 'Waze');
  ok(mapsLink({ lat: 32.06, lng: 34.8 }, 'bus', { lat: 32.07, lng: 34.79 })
    === 'https://www.google.com/maps/dir/?api=1&origin=32.07,34.79&destination=32.06,34.8&travelmode=transit',
  'Google Maps, by bus');
  const g = gettLink({ lat: 32.06, lng: 34.8 }, 'הבית');
  ok(g.startsWith('gett://order?pickup=my_location&dropoff_latitude=32.06&dropoff_longitude=34.8'),
    'Gett: pickup here, drop-off filled in');
  ok(g.includes('dropoffpoi_name_optional=%D7%94%D7%91%D7%99%D7%AA'), 'the name is URL-encoded');
  ok(placeLink({ lat: 32.05, lng: 34.75, title: 'חוף עליה', placeId: 'abc' })
    === 'https://www.google.com/maps/search/?api=1&query=32.05,34.75&query_place_id=abc',
  'a place opens its own page on Google Maps');
  const beachRow = cardOptions({ ...BEACH, results: [{ ...BEACH.results[0], place_id: 'xyz' }] }, true)[0];
  ok(beachRow.placeId === 'xyz', 'every place row carries its id for the map');
}

section('a payload the card cannot draw is not drawn');
{
  ok(asLookupAnswer(null) === null, 'null');
  ok(asLookupAnswer({ ok: false, reason: 'need_origin' }) === null, 'a failed lookup');
  ok(asLookupAnswer({ ok: true, kind: 'places', results: [] }) === null, 'nothing found');
  ok(asLookupAnswer({ ok: true, kind: 'route', results: [{ name: 'x' }] }) === null, 'a row with no minutes');
  ok(asLookupAnswer(BEACH) === BEACH, 'a real answer');
  ok(legDetail({ mode: 'bike', total_min: 18, ride_min: 16, lock_min: 2 }, false) === '16 ride · 2 lock', 'English');
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
