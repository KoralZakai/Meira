/**
 * run-checkin-dedupe — the morning/afternoon/evening check-in arrives ONCE.
 *
 * Reported 2026-10-06: "what did you do so far?" three times a day. The old
 * reschedule cancelled only ids it had saved; an orphaned DAILY trigger (old
 * build, lost write, two overlapping runs) survived every reschedule.
 *
 * Run:  npx tsx tests/run-checkin-dedupe.ts
 */
import { checkInIdentifiers, ScheduledLike } from '../src/utils/alertCancellation';

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

const scheduled: ScheduledLike[] = [
  { identifier: 'a1', content: { data: { checkInType: 'afternoon' } } },
  { identifier: 'a2', content: { data: { checkInType: 'afternoon' } } }, // orphan, id never saved
  { identifier: 'm1', content: { data: { checkInType: 'morning' } } },
  { identifier: 'e1', content: { data: { checkInType: 'evening' } } },
  { identifier: 't1', content: { data: { taskId: 'yoga-1' } } },
  { identifier: 'x', content: null },
];

const ids = checkInIdentifiers(scheduled);
check('orphaned check-in is cancelled too', ids.includes('a2'));
check('all four check-ins found', ids.length === 4, ids.join(','));
check('task alerts are never touched', !ids.includes('t1'));
check('empty list → nothing', checkInIdentifiers([]).length === 0);

if (failures) { console.log(`\n✗ ${failures} failed`); process.exit(1); }
console.log('\n✓ check-in dedupe holds');
