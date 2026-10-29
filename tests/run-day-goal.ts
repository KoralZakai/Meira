/**
 * run-day-goal — the morning goal card's rules (Koral's pick B, 19.10).
 * Run: npx tsx tests/run-day-goal.ts
 */
import { goalCandidates, goalState } from '../src/utils/dayGoal';
import { Task } from '../src/types/index';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}
const D = '2026-10-21';
const t = (id: string, extra: Partial<Task> = {}): Task => ({
  id, text: id, category: 'general', priority: 'need_to', isFixed: false, durationMinutes: 30,
  date: D, status: 'pending', createdAt: 0, historicalDurations: [], ...extra,
} as Task);
const tasks = [t('bank'), t('ראיון בטלפון', { priority: 'must', isFixed: true, fixedTime: '10:30' }),
  t('gym', { priority: 'have_to', fixedTime: '20:00', isFixed: true }), t('done', { status: 'complete' }),
  t('call', { priority: 'must', fixedTime: '09:30', isFixed: true }), t('other-day', { date: '2026-10-22', priority: 'must' })];

const c = goalCandidates(tasks, D);
check('three candidates', c.length === 3);
check('the interview first', c[0].id === 'ראיון בטלפון', c.map((x) => x.id).join(','));
check('never a done task or another day', !c.some((x) => x.id === 'done' || x.id === 'other-day'));
check('unset with no goal', goalState(null, tasks, D) === 'unset');
check('yesterday\'s goal is unset today', goalState({ date: '2026-10-20', text: 'x' }, tasks, D) === 'unset');
check('a task goal is open while the task is', goalState({ date: D, text: 'gym', taskId: 'gym' }, tasks, D) === 'open');
check('…and done when the task is', goalState({ date: D, text: 'done', taskId: 'done' }, tasks, D) === 'done');
check('her own words: done by hand', goalState({ date: D, text: 'לנוח', done: true }, tasks, D) === 'done');

console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
