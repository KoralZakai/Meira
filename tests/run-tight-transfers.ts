/**
 * run-tight-transfers — two places, no overlap, not enough time to get between.
 *
 * Koral, 29.9: a meeting at Azrieli until 14:00 and coffee in Herzliya at 14:15
 * share no minute, so nothing warned — and the ride is 30 minutes.
 *
 * Run:  npx tsx tests/run-tight-transfers.ts
 */
import { tightTransfers } from '../src/utils/overlapKind';
import { Task } from '../src/types/index';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

const at = (address: string, travelMinutes?: number) =>
  ({ address, lat: 32, lng: 34, confirmed: true, ...(travelMinutes ? { travelMinutes } : {}) }) as any;
const task = (id: string, time: string, dur: number, location?: any, extra: Partial<Task> = {}): Task => ({
  id, text: id, category: 'meeting', priority: 'must', isFixed: true, fixedTime: time,
  durationMinutes: dur, date: '2026-09-30', status: 'pending', createdAt: 0, historicalDurations: [],
  location, ...extra,
} as Task);

const azrieli = task('nebius', '13:00', 60, at('Azrieli Center, Tel Aviv', 20));
const coffee = task('dana', '14:15', 45, at('Herzliya Pituah marina', 30));
const t = tightTransfers([coffee, azrieli]);
check('Azrieli 13-14 → Herzliya 14:15 with a 30-min ride is flagged', t.length === 1);
check('…15 min gap, 30 travel, 15 late, arriving 14:30',
  t[0]?.gapMinutes === 15 && t[0]?.travelMinutes === 30 && t[0]?.lateBy === 15 && t[0]?.arriveAt === '14:30',
  JSON.stringify({ g: t[0]?.gapMinutes, tr: t[0]?.travelMinutes, l: t[0]?.lateBy, a: t[0]?.arriveAt }));
check('enough time is not flagged',
  tightTransfers([azrieli, task('dana', '14:45', 45, at('Herzliya', 30))]).length === 0);
check('an unplanned ride is never guessed',
  tightTransfers([azrieli, task('dana', '14:05', 45, at('Herzliya'))]).length === 0);
check('the same place is not a transfer',
  tightTransfers([azrieli, task('next', '14:05', 30, at('Azrieli Center, Tel Aviv', 20))]).length === 0);
check('floating work in between does not break the pair',
  tightTransfers([azrieli, task('cv', '14:00', 10), coffee]).length === 1);
check('an overlap is a clash, not a transfer',
  tightTransfers([azrieli, task('dana', '13:30', 45, at('Herzliya', 30))]).length === 0);
check('a done task moves nobody',
  tightTransfers([{ ...azrieli, status: 'complete' } as Task, coffee]).length === 0);

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) process.exit(1);
