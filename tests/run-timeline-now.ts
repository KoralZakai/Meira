/**
 * run-timeline-now — the moment on the timeline.
 * Run: npx tsx tests/run-timeline-now.ts
 */
import { nowInBlock, describeRemaining } from '../src/utils/timelineNow';
import { isRailOnly, isBusOnly } from '../src/services/RoutePlanner';

let failures = 0; let checks = 0;
const check = (l: string, ok: boolean, d = '') => {
  checks += 1; if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${l}${d ? `  — ${d}` : ''}`);
};

const leg = (type: string) => ({
  type, from: 'a', to: 'b', durationMinutes: 10,
  departureTime: '08:00', arrivalTime: '08:10',
});
const plan = (...types: string[]) => ({ legs: types.map(leg) }) as any;

function main() {
  console.log('\nTimeline "now"\n');

  console.log('1. Inside a long block');
  const mid = nowInBlock('13:30', '09:00', '18:00');
  check('a 09:00-18:00 conference is active at 13:30', mid.active);
  check('and half-way through', Math.round(mid.progress * 100) === 50, `${Math.round(mid.progress * 100)}%`);
  check('with the right time left', mid.minutesLeft === 270, `${mid.minutesLeft}m`);
  check('reads as "4h 30m left"', describeRemaining(mid.minutesLeft, false) === '4h 30m left');

  console.log('\n2. Edges');
  check('the start minute is inside', nowInBlock('09:00', '09:00', '18:00').active);
  check('the end minute is NOT', !nowInBlock('18:00', '09:00', '18:00').active);
  check('before it, inactive', !nowInBlock('08:59', '09:00', '18:00').active);
  check('a zero-length block is never active', !nowInBlock('09:00', '09:00', '09:00').active);
  check('missing now decides nothing', !nowInBlock(undefined, '09:00', '18:00').active);

  console.log('\n3. Train mode is strict');
  check('walk + train + walk is rail', isRailOnly(plan('walk', 'train', 'walk')));
  check('train + subway is rail', isRailOnly(plan('train', 'subway')));
  check('a bus hiding in the middle is NOT rail', !isRailOnly(plan('walk', 'train', 'bus')));
  check('a pure bus route is not rail', !isRailOnly(plan('walk', 'bus')));
  check('walking only is neither', !isRailOnly(plan('walk')) && !isBusOnly(plan('walk')));
  check('bus-only is bus', isBusOnly(plan('walk', 'bus', 'walk')));

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks\n`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
