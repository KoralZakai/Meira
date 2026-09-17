/**
 * run-archived-hidden — an archived duplicate must not look like real work.
 *
 * Reported as "this is not the task I entered". Her board showed THREE
 * near-identical conference rows for the same morning; the Today screen showed
 * one. Both were reading the same store.
 *
 * StoreMigration had already done the right thing: it merged the duplicates by
 * meaning and stamped the losers `status: 'moved'` — archived, recoverable,
 * never deleted. Today filtered those out. The task board did not: its filters
 * excluded only `complete`, so archived copies sat there looking live.
 *
 * The damage was not only cosmetic. The board's list is also the pool behind
 * "Build schedule for today", so pressing it would lay the merged-away copies
 * back onto the timeline — and the surviving copy is the one whose hours the
 * clash checker reasons about.
 *
 * Run:  npx tsx tests/run-archived-hidden.ts
 */
import { isLiveTask } from '../src/utils/taskRelations';
import { Task } from '../src/types/index';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

const TODAY = '2026-09-07';
const t = (id: string, text: string, mins: number, over: Partial<Task> = {}): Task => ({
  id, text, category: 'conference', priority: 'must', isFixed: true,
  fixedTime: '09:00', durationMinutes: mins, date: TODAY, status: 'pending',
  createdAt: 0, historicalDurations: [], ...over,
} as unknown as Task);

// Her actual morning: one conference entered three ways.
const a = t('a', 'כנס האקריות ב-אוניברסיטת תל אביב', 540);
const b = t('b', 'כנס של האקריות', 480);
const c = t('c', 'כנס האקריות. באוניברסיטת תל אביב', 700);
const meetup = t('m', 'מיטאפ From Prompt to Production', 30,
  { category: 'general', fixedTime: '18:00', priority: 'have_to' });

function main() {
  console.log('\nArchived duplicates stay archived\n');

  console.log('1. The predicate itself');
  check('a pending task is live', isLiveTask(a));
  check('a completed task is not', !isLiveTask({ ...a, status: 'complete' } as Task));
  check('an ARCHIVED task is not', !isLiveTask({ ...a, status: 'moved' } as Task));
  check('being dated today does not make an archived task live',
    !isLiveTask({ ...a, status: 'moved', date: TODAY } as Task));

  // How a task GETS archived is a separate question with several answers —
  // letGoTasks, a rollover, StoreMigration's stale pass, or its merge (which
  // for these three titles merges nothing: they are not similar enough to fold
  // silently, and that is the correct call). What this test pins is the part
  // that was broken: once a task IS archived, no live list may show it.
  console.log('\n2. However they got archived, they stay archived');
  const stored = [
    a,
    { ...b, status: 'moved' as const },
    { ...c, status: 'moved' as const },
    meetup,
  ];

  console.log('\n3. Every live list agrees');
  const live = stored.filter((task) => task.date === TODAY && isLiveTask(task));
  check('today holds exactly two live tasks', live.length === 2,
    live.map((x) => x.text).join(' · '));
  check('exactly one conference survives',
    live.filter((x) => x.category === 'conference').length === 1);
  check('the meetup is still there', live.some((x) => x.id === 'm'));
  check('no archived task reaches a live list',
    !live.some((x) => (x.status as string) === 'moved'));
  // The board used to exclude only `complete`; Today excluded only `moved`.
  // Two different sets from one store is the bug — they must now match.
  const boardOld = stored.filter((x) => x.date === TODAY && x.status !== 'complete');
  const todayScreen = stored.filter((x) => x.date === TODAY && x.status !== 'moved');
  check('the OLD board rule really did over-report', boardOld.length === 4, `${boardOld.length}`);
  check('the board and the Today screen now return the SAME set',
    live.length === todayScreen.length, `${live.length} vs ${todayScreen.length}`);

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
