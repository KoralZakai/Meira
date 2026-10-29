/**
 * run-move-held — a move she made survives the calendar's next import (18.10).
 * Run:  npx tsx tests/run-move-held.ts
 */
import { heldByHerMove, MOVE_HELD_FIELDS } from '../src/utils/moveHeld';

let failures = 0; let checks = 0;
const check = (l: string, ok: boolean) => { checks += 1; if (!ok) failures += 1; console.log(`  ${ok ? '✓' : '✗'} ${l}`); };

check('moved to the 20th, Google still says the 19th: her move stands',
  heldByHerMove({ date: '2026-10-20', movedFromDate: '2026-10-19' }, { date: '2026-10-19' }));
check('Google now says a NEW day: Google wins',
  !heldByHerMove({ date: '2026-10-20', movedFromDate: '2026-10-19' }, { date: '2026-10-21' }));
check('Google agrees with the move: nothing to hold',
  !heldByHerMove({ date: '2026-10-20', movedFromDate: '2026-10-19' }, { date: '2026-10-20' }));
check('never moved: Google owns the row as before',
  !heldByHerMove({ date: '2026-10-19' }, { date: '2026-10-20' }));
check('missing data holds nothing', !heldByHerMove(null, { date: 'x' }) && !heldByHerMove({ movedFromDate: 'a' }, undefined));
check('the held fields are the date and the clock', MOVE_HELD_FIELDS.includes('date') && MOVE_HELD_FIELDS.includes('fixedTime'));

if (failures) { console.error(`\nFAIL — ${checks - failures}/${checks}`); process.exit(1); }
console.log(`\n✅ ${checks}/${checks} checks passed`);
