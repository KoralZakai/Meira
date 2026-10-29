/**
 * run-waiting-list — the 🔔 on Today lists clashes, unclosed past tasks and missing places, in that order.
 *
 * Run:  npx tsx tests/run-waiting-list.ts
 */
import { isLiveTask } from '../src/utils/taskRelations';
import { waitingList } from '../src/utils/waitingList';
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
  date: '2026-10-29', status: 'pending', createdAt: 0, historicalDurations: [], ...o,
} as Task);

const iv = task({ id: 'iv', text: 'ריאיון', fixedTime: '16:00' });
const yosi = task({ id: 'yosi', text: 'Yosi', fixedTime: '16:30' });
const meeting = task({ id: 'm', text: 'פגישה', fixedTime: '17:00' });
const online = task({ id: 'z', text: 'זום', fixedTime: '10:30' });
const doneNoPlace = task({ id: 'd', text: 'done', fixedTime: '09:00', status: 'complete' });
const gym = task({ id: 'gym', text: 'אימון', date: '2026-10-28', fixedTime: '20:00' });

const list = waitingList({
  problems: [{ kind: 'spatial', key: 'iv×yosi', a: iv, b: yosi, overlapMinutes: 30 } as any],
  overdue: [gym],
  today: [iv, yosi, meeting, online, doneNoPlace],
  needsPlace: (t) => t.id === 'm' || t.id === 'd',
});
check('the clash comes first, with both names', list[0]?.kind === 'clash' && list[0].title === 'ריאיון × Yosi', JSON.stringify(list[0]));
check('then yesterday\'s unclosed task, with its date', list[1]?.kind === 'unclosed' && list[1].when === '2026-10-28');
check('then today\'s task with no place', list[2]?.kind === 'place' && list[2].taskId === 'm');
check('an online task is not asked for a place', !list.some((i) => i.taskId === 'z'));
check('a done task is not listed', !list.some((i) => i.taskId === 'd'));
check('three items — the count on the bell', list.length === 3, String(list.length));
check('nothing waiting → an empty list (the bell shows no badge)', waitingList({ problems: [], overdue: [], today: [], needsPlace: () => false }).length === 0);

// 28.10: what the calendar changed, and "set a new time" follow-ups, live on the bell.
const follow = task({ id: 'f', text: 'לקבוע מועד חדש: ראיון בגוגל', date: '2026-10-27' });
const withBell = waitingList({
  problems: [], overdue: [follow], today: [follow], needsPlace: () => true,
  changes: [{ key: 'change:x', title: 'Koral : Yosi בוטל', taskId: 'x' }],
  followUps: [follow, task({ id: 'done-f', text: 'Set a new time: dentist', status: 'complete' })],
});
check('a change is on the bell, first', withBell[0]?.kind === 'change' && withBell[0].taskId === 'x');
check('a follow-up is on the bell, named by the task it is about', withBell[1]?.kind === 'followup' && withBell[1].title === 'ראיון בגוגל');
check('…said once — not also as "not closed" or "missing a place"', withBell.length === 2, JSON.stringify(withBell.map((i) => i.kind)));

// 28.10: today's tasks with no hour ask "when?" on the bell.
const hw = task({ id: 'hw', text: 'לבצע תרגיל בית', fixedTime: undefined as any });
const iherb = task({ id: 'ih', text: 'לסיים הזמנה מ-iherb', fixedTime: undefined as any });
const timed = task({ id: 'tm', text: 'פגישה', fixedTime: '17:00' });
const un = waitingList({ problems: [], overdue: [], today: [], needsPlace: () => false,
  unscheduled: [hw, iherb, timed, task({ id: 'fu', text: 'לקבוע מועד חדש: ריאיון', fixedTime: undefined as any })] });
check('tasks without an hour are on the bell, asked "when?"', un.filter((i) => i.kind === 'unscheduled').map((i) => i.taskId).join(',') === 'hw,ih',
  JSON.stringify(un.map((i) => `${i.kind}:${i.taskId}`)));
check('…a follow-up is not asked twice', !un.some((i) => i.taskId === 'fu'));

// 28.10: 'Set a new time: X' is a note on the bell, never a task in the lists.
check('a "waiting for a new date" note is not a live task', !isLiveTask(task({ text: 'Set a new time: ריאיון' }))
  && !isLiveTask(task({ text: 'לקבוע מועד חדש: ריאיון' })) && isLiveTask(task({ text: 'ריאיון' })));

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) process.exit(1);
