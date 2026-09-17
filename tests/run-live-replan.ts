/**
 * run-live-replan — the three reasons to recompute a route, and the four
 * reasons not to.
 *
 * The user's own words are the spec:
 *
 *   "if location changed — show current location — and check the next task to
 *    occur; if location has changed and it's not the requested next location,
 *    recalculate the travel route to the next location. If user is late also
 *    need to recalculate (update time of bus, trains, driving...)"
 *
 * So: moved off the origin, departure missed, arriving late — each on its own
 * is enough. And the ways to get it wrong, all of which have shipped before in
 * this app:
 *
 *   re-planning a journey to a building she is standing in   (already-there)
 *   re-planning from a position we do not have               (no-fix)
 *   re-planning on GPS jitter while she sits still           (on-plan)
 *   spending a Google call every tick while she is late      (cooling-down)
 *
 * Run:  npx tsx tests/run-live-replan.ts
 */
import {
  decideLiveReplan, describeReplanReason, REPLAN_COOLDOWN_MS,
} from '../src/utils/liveReplanDecision';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

// Real coordinates, so the distances mean something.
const HOME = { lat: 32.0614, lng: 34.7715 };        // Mordei ha-Geta'ot, TLV
const NEXT_DOOR = { lat: 32.0615, lng: 34.7716 };   // ~14 m — GPS jitter
const YOGA = { lat: 32.0713, lng: 34.7942 };        // Yigal Alon 94, ~2.3 km
const HAIFA = { lat: 32.7940, lng: 34.9896 };

const at = (hhmm: string): Date => {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d;
};

/** The ordinary case: a planned trip to the yoga studio, leave 09:40, be there 10:00. */
const TRIP = {
  destination: YOGA,
  plannedFrom: HOME,
  leaveHomeBy: '09:40',
  arriveAt: '09:58',
  appointment: '10:00',
};

function main() {
  console.log('\nLive re-plan decision\n');

  console.log('1. Nothing to do is the common case');
  check('sitting at home, well before the leave time',
    !decideLiveReplan({ current: HOME, trip: TRIP, home: HOME, now: at('09:00') }).replan);
  check('...and it says so',
    decideLiveReplan({ current: HOME, trip: TRIP, home: HOME, now: at('09:00') }).reason === 'on-plan');
  check('a 14 m GPS wobble is not "she moved"',
    !decideLiveReplan({ current: NEXT_DOOR, trip: TRIP, home: HOME, now: at('09:00') }).replan,
    `${decideLiveReplan({ current: NEXT_DOOR, trip: TRIP, home: HOME, now: at('09:00') }).metres} m`);

  console.log('\n2. Moved off the origin — the route on screen is wrong by that much');
  const moved = decideLiveReplan({ current: HAIFA, trip: TRIP, home: HOME, now: at('09:00') });
  check('across the country re-plans', moved.replan);
  check('...for the right reason', moved.reason === 'moved-off-origin');
  check('...and reports the distance', (moved.metres ?? 0) > 75000, `${moved.metres} m`);

  // The plan usually has no stamped origin until something re-plans it once.
  // Home is then the honest fallback — every route in this app is planned from
  // it — and without that fallback a woman on her sofa re-planned every tick.
  const noStamp = { ...TRIP, plannedFrom: null };
  check('an unstamped plan falls back to home, and home means no drift',
    !decideLiveReplan({ current: HOME, trip: noStamp, home: HOME, now: at('09:00') }).replan);
  check('an unstamped plan still detects a real move',
    decideLiveReplan({ current: HAIFA, trip: noStamp, home: HOME, now: at('09:00') }).replan);
  check('no origin at all, and no clock trigger: say nothing rather than guess',
    !decideLiveReplan({ current: HAIFA, trip: noStamp, home: null, now: at('09:00') }).replan);

  console.log('\n3. Late — she did not move, and that is the problem');
  const missed = decideLiveReplan({ current: HOME, trip: TRIP, home: HOME, now: at('09:52') });
  check('still at home twelve minutes after the leave time', missed.replan);
  check('...for the right reason', missed.reason === 'departure-missed');
  check('one minute BEFORE the leave time does not fire',
    !decideLiveReplan({ current: HOME, trip: TRIP, home: HOME, now: at('09:39') }).replan);

  // This one needs nothing to change: the plan can be late the moment it is built.
  const doomed = { ...TRIP, leaveHomeBy: '09:55', arriveAt: '10:14' };
  const late = decideLiveReplan({ current: HOME, trip: doomed, home: HOME, now: at('09:20') });
  check('a plan that already lands after the appointment re-plans', late.replan);
  check('...for the right reason', late.reason === 'arriving-late');
  check('landing exactly on time does not',
    !decideLiveReplan({
      current: HOME, home: HOME, now: at('09:20'),
      trip: { ...TRIP, leaveHomeBy: '09:55', arriveAt: '10:00' },
    }).replan);

  console.log('\n4. The refusals');
  check('no fix: a guess is worse than the current plan',
    decideLiveReplan({ current: null, trip: TRIP, home: HOME, now: at('09:52') }).reason === 'no-fix');
  check('a NaN fix is no fix',
    decideLiveReplan({
      current: { lat: NaN, lng: NaN }, trip: TRIP, home: HOME, now: at('09:52'),
    }).reason === 'no-fix');
  check('no trip: nothing to re-plan',
    decideLiveReplan({ current: HAIFA, trip: null, home: HOME, now: at('09:52') }).reason === 'no-trip');

  // The bug presence.ts exists to stop: a live travel card to a building she
  // is inside. Late AND moved are both true here, and both must lose.
  const there = decideLiveReplan({ current: YOGA, trip: TRIP, home: HOME, now: at('09:52') });
  check('standing at the destination never re-plans', !there.replan);
  check('...and says she is already there', there.reason === 'already-there');

  console.log('\n5. The cooldown, so being late does not cost a call a tick');
  const now = at('09:52');
  const justDid = decideLiveReplan({
    current: HOME, trip: TRIP, home: HOME, now,
    lastReplanAt: now.getTime() - 60 * 1000,
  });
  check('a re-plan one minute ago holds this one back', !justDid.replan);
  check('...and is distinguishable from "on plan"', justDid.reason === 'cooling-down');
  check('past the cooldown it fires again',
    decideLiveReplan({
      current: HOME, trip: TRIP, home: HOME, now,
      lastReplanAt: now.getTime() - REPLAN_COOLDOWN_MS - 1000,
    }).replan);
  check('the cooldown never invents work: on-plan stays on-plan',
    decideLiveReplan({
      current: HOME, trip: TRIP, home: HOME, now: at('09:00'), lastReplanAt: Date.now(),
    }).reason === 'on-plan');

  console.log('\n6. Every re-plan can say why, in her language');
  check('Hebrew for a move', describeReplanReason('moved-off-origin', true).includes('זזת'));
  check('Hebrew for a missed departure', describeReplanReason('departure-missed', true).length > 0);
  check('Hebrew for a late arrival', describeReplanReason('arriving-late', true).length > 0);
  check('English too', describeReplanReason('moved-off-origin', false).length > 0);
  check('a non-reason has no line', describeReplanReason('on-plan', true) === '');

  console.log(`\n${failures ? '✗' : '✓'} ${checks - failures}/${checks} checks passed\n`);
  process.exit(failures ? 1 : 0);
}

main();
