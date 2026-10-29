/**
 * run-transfer-ranking — changes between vehicles are judged by the time they really take (21.10, Koral).
 * Run:  npx tsx tests/run-transfer-ranking.ts
 */
import { parseTransitAlternatives, transferWaits, transitScore } from '../src/utils/transitParse';
import type { TransitPlan } from '../src/types/index';

let failures = 0; let checks = 0;
const check = (l: string, ok: boolean, d = '') => { checks += 1; if (!ok) failures += 1; console.log(`  ${ok ? '✓' : '✗'} ${l}${d ? ` — ${d}` : ''}`); };

const leg = (type: string, dep: string, arr: string, mins: number) =>
  ({ type, from: 'a', to: 'b', departureTime: dep, arrivalTime: arr, durationMinutes: mins } as any);
const plan = (total: number, legs: any[], leave = '09:00', arrive = '10:00'): TransitPlan => ({
  totalDurationMinutes: total, leaveHomeAt: leave, arriveAt: arrive, firstBusDeparture: leave, firstBusStop: 'x',
  walkToStopMinutes: 3, legs, source: 'google', fetchedAt: 0,
} as any);

const tidy = plan(35, [leg('walk', '09:00', '09:03', 3), leg('train', '09:03', '09:20', 17), leg('walk', '09:20', '09:23', 3), leg('bus', '09:25', '09:35', 10)]);
check('wait at a change = next departure − arrival − the walk between', transferWaits(tidy)[0] === 2, JSON.stringify(transferWaits(tidy)));
const slow = plan(58, [leg('train', '09:00', '09:17', 17), leg('bus', '09:40', '09:58', 18)]);
check('a 23-minute wait at a change is read as 23', transferWaits(slow)[0] === 23, JSON.stringify(transferWaits(slow)));
const impossible = plan(30, [leg('train', '09:00', '09:17', 17), leg('bus', '09:15', '09:30', 15)]);
check('a connection that leaves before the train arrives is negative', transferWaits(impossible)[0] < 0);
check('a direct ride has no changes', transferWaits(plan(40, [leg('bus', '09:00', '09:40', 40)])).length === 0);

check('a tidy change costs little, a long wait costs a lot, an impossible one is a wall',
  transitScore(tidy) < transitScore(slow) && transitScore(slow) < transitScore(impossible), `${transitScore(tidy)} / ${transitScore(slow)} / ${transitScore(impossible)}`);

const direct60 = plan(60, [leg('bus', '09:00', '10:00', 60)]);
const ranked = parseTransitAlternatives({ routes: [] }, '', 'x');   // sanity: no throw on empty
check('no routes: empty, no throw', ranked.length === 0);
const sorted = [direct60, slow, tidy].sort((a, b) => transitScore(a) - transitScore(b));
check('a tidy 35-minute train-and-bus beats a 60-minute direct bus', sorted[0] === tidy);
check('a train-and-bus with a 23-minute wait at the change does NOT beat a 60-minute direct', transitScore(slow) > transitScore(direct60));
const direct35 = plan(35, [leg('bus', '09:00', '09:35', 35)]);
check('at equal time, one ride still beats two', transitScore(direct35) < transitScore(tidy));
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
