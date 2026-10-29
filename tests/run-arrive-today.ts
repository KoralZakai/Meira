/**
 * run-arrive-today — a task of TOMORROW cannot be arrived at tonight (20.10).
 * She was at home at 21:02; tomorrow's 21:00 task at her home address, and two
 * more, were marked arrived and one completed, because the check compared the
 * clock with the task's hour and never its date.
 *
 * Run:  npx tsx tests/run-arrive-today.ts
 */
import { canArriveToday } from '../src/utils/presence';

let failures = 0; let checks = 0;
const check = (l: string, ok: boolean) => { checks += 1; if (!ok) failures += 1; console.log(`  ${ok ? '✓' : '✗'} ${l}`); };

const night = new Date(2026, 9, 20, 21, 2);          // Tue 20.10, 21:02
check('a task of today can be arrived at', canArriveToday({ date: '2026-10-20' }, night));
check("tomorrow's 21:00 task cannot be arrived at tonight", !canArriveToday({ date: '2026-10-21' }, night));
check("yesterday's cannot either", !canArriveToday({ date: '2026-10-19' }, night));
check('an undated task is left to the existing checks', canArriveToday({}, night));
const justAfterMidnight = new Date(2026, 9, 21, 0, 5);
check('after midnight it is today, and yesterday is not', canArriveToday({ date: '2026-10-21' }, justAfterMidnight) && !canArriveToday({ date: '2026-10-20' }, justAfterMidnight));

if (failures) { console.error(`\nFAIL — ${checks - failures}/${checks}`); process.exit(1); }
console.log(`\n✅ ${checks}/${checks} checks passed`);
