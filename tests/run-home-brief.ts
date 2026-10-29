/**
 * run-home-brief — the line under "how can I help?" says now, next and when to leave.
 *
 * Run:  npx tsx tests/run-home-brief.ts
 */
import { homeBrief, briefLine } from '../src/utils/homeBrief';
import type { Task } from '../src/types/index';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}
const task = (o: Partial<Task>): Task => ({
  id: 'x', text: 'x', category: 'meeting', priority: 'must', isFixed: true, durationMinutes: 60,
  date: '2026-10-28', status: 'pending', createdAt: 0, historicalDurations: [], ...o,
} as Task);

const day = [
  task({ id: 'cb', text: 'Community Builder', fixedTime: '10:30', durationMinutes: 15 }),
  task({ id: 'iv', text: 'ריאיון', fixedTime: '16:00',
    location: { address: 'דיזנגוף 1', lat: 1, lng: 1, confirmed: true, leaveHomeBy: '15:19' } }),
  task({ id: 'done', text: 'done', fixedTime: '09:00', status: 'complete' }),
  task({ id: 'nohour', text: 'no hour', fixedTime: undefined, isFixed: false }),
];

const at1036 = homeBrief(day, 636);
check('10:36 — now is Community Builder', at1036.now?.id === 'cb');
check('10:36 — next is the interview', at1036.next?.id === 'iv');
check('the leave time comes from the route', at1036.leaveAt === '15:19');
check('the Hebrew line says now, next and leave',
  briefLine(at1036, true) === 'עכשיו — Community Builder. הבא — ריאיון ב־16:00, צאי ב־15:19.', briefLine(at1036, true));
check('the English line too', briefLine(at1036, false).includes('leave at 15:19'));
check('done and hour-less tasks are not counted', at1036.left === 2, String(at1036.left));

const at1200 = homeBrief(day, 720);
check('12:00 — nothing now, next is the interview', !at1200.now && at1200.next?.id === 'iv');
const late = homeBrief(day, 1200);
check('20:00 — an honest empty line', briefLine(late, true) === 'אין עוד משהו בשעה קבועה היום.');

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) process.exit(1);
