/**
 * run-task-end — a task that runs to midnight is not "earlier today" in the morning (21.10).
 * Run:  npx tsx tests/run-task-end.ts
 */
import { endedBy, endMinutesOf } from '../src/utils/taskEnd';

let failures = 0; let checks = 0;
const check = (l: string, ok: boolean, d = '') => { checks += 1; if (!ok) failures += 1; console.log(`  ${ok ? '✓' : '✗'} ${l}${d ? ` — ${d}` : ''}`); };

const camp = { fixedTime: '21:00', durationMinutes: 180 };
check('21:00 + 3h ends at minute 1440, not 0', endMinutesOf(camp) === 1440);
check('"מפגש קמפ" 21:00–00:00 has NOT ended at 08:36', !endedBy(camp, '08:36'));
check('…nor at 23:59', !endedBy(camp, '23:59'));
check('a morning task has ended by noon', endedBy({ fixedTime: '10:30', durationMinutes: 60 }, '12:00'));
check('a task ends exactly at its end', endedBy({ fixedTime: '10:30', durationMinutes: 60 }, '11:30'));
check('scheduledTime counts when there is no fixedTime', !endedBy({ scheduledTime: '20:00', durationMinutes: 120 }, '09:00'));
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
