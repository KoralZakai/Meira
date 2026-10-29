/**
 * run-no-auto-rollover — yesterday stays yesterday until she says otherwise.
 *
 * The bug: every app open ran rolloverOverdueTasksToToday (through
 * ensureDailyRollover → useTasks → LumiProvider, which wraps the whole app).
 * It copied every pending task dated before today onto TODAY under a new id
 * and stamped the original 'moved'. So last night's show reappeared this
 * morning as if it were still ahead of her — and since getOverdueTasks only
 * looks at PENDING rows, the "did you go?" card had nothing left to ask about.
 * Two failures from one function: a task that time-travels, and a question
 * that never gets asked.
 *
 * These checks fail against the old code and pass now:
 *   1. nothing auto-moves between days,
 *   2. an unfinished past task is still pending, and still visible as overdue,
 *   3. the repair pass undoes an already-rolled pair, once,
 *   4. it leaves alone what the USER moved or let go of.
 *
 * Real TaskStorage over an in-memory AsyncStorage (same harness as
 * run-concurrency) — no device needed.
 *
 * Run: npx tsx tests/run-no-auto-rollover.ts
 */
const store = new Map<string, string>();
const memoryAsyncStorage = {
  async getItem(k: string) { return store.has(k) ? store.get(k)! : null; },
  async setItem(k: string, v: string) { store.set(k, v); },
  async removeItem(k: string) { store.delete(k); },
  async multiRemove(ks: string[]) { ks.forEach((k) => store.delete(k)); },
  async getAllKeys() { return [...store.keys()]; },
};

const Module = require('module');
const origLoad = Module._load;
Module._load = function patched(request: string, ...rest: any[]) {
  if (request === '@react-native-async-storage/async-storage' || request.endsWith('/EncryptedStorage')) {
    return { __esModule: true, default: memoryAsyncStorage };
  }
  if (request === './supabaseClient' || request.endsWith('/supabaseClient')) {
    return { __esModule: true, isSupabaseConfigured: false, supabase: null };
  }
  if (request === './SupabaseAuthService' || request.endsWith('/SupabaseAuthService')) {
    return { __esModule: true, getUserId: async () => null, getSession: async () => null };
  }
  if (request === './NotificationService' || request.endsWith('/NotificationService')) {
    return { __esModule: true, armTaskAlerts: async () => {}, cancelTaskNotifications: async () => {} };
  }
  return origLoad.call(this, request, ...rest);
};

import assert from 'node:assert';
import type { Task } from '../src/types/index';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const TaskStorage = require('../src/services/TaskStorage');

const TASKS_KEY = 'lumi.tasks.v1';
const REPAIRED_KEY = 'lumi.rolloverRepaired.v1';
const TODAY = '2026-08-31';
const YESTERDAY = '2026-08-30';

const task = (over: Partial<Task>): Task => ({
  id: Math.random().toString(36).slice(2),
  text: 'task',
  category: 'general',
  priority: 'need_to',
  isFixed: false,
  durationMinutes: 60,
  date: TODAY,
  status: 'pending',
  createdAt: 1_000,
  historicalDurations: [],
  ...over,
} as Task);

const seed = (tasks: Task[]) => {
  store.clear();
  store.set(TASKS_KEY, JSON.stringify(tasks));
};
const readBack = (): Task[] => JSON.parse(store.get(TASKS_KEY) || '[]');

let checks = 0;
const check = (label: string, ok: boolean, detail = '') => {
  checks += 1;
  if (!ok) process.exitCode = 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
};

async function main() {
  console.log('\nNothing moves days on its own\n');

  console.log('1. The auto-rollover is gone');
  check('rolloverOverdueTasksToToday no longer exists',
    typeof TaskStorage.rolloverOverdueTasksToToday === 'undefined');
  check('ensureDailyRollover no longer exists',
    typeof TaskStorage.ensureDailyRollover === 'undefined');

  console.log("\n2. Last night's show stays on last night");
  const show = task({
    id: 'show', text: 'הופעה בערב עם אורטל של ברי סחרוף',
    date: YESTERDAY, fixedTime: '21:00', isFixed: true,
  });
  seed([show]);
  await TaskStorage.repairAutoRolledTasks(TODAY);
  let rows = readBack();
  check('it is still dated yesterday', rows[0].date === YESTERDAY, rows[0].date);
  check('it is still pending', rows[0].status === 'pending', rows[0].status);
  const overdue: Task[] = await TaskStorage.getOverdueTasks(TODAY);
  check('and the "did you go?" card can see it',
    overdue.length === 1 && overdue[0].id === 'show', `${overdue.length} overdue`);

  console.log('\n3. A pair the old rollover already forked is put back');
  seed([
    { ...show, status: 'moved' as any },
    { ...show, id: 'clone', date: TODAY, status: 'pending', createdAt: 2_000 },
  ]);
  const repaired = await TaskStorage.repairAutoRolledTasks(TODAY);
  rows = readBack();
  check('the copy on today is gone', repaired === 1 && !rows.some((t) => t.id === 'clone'),
    rows.map((t) => `${t.id}:${t.date}:${t.status}`).join(' | '));
  check('the original is pending again on its own date',
    rows.length === 1 && rows[0].id === 'show' && rows[0].date === YESTERDAY && rows[0].status === 'pending');
  check('the repair marked itself done', store.get(REPAIRED_KEY) === '1');

  console.log('\n4. It runs once, and never touches a deliberate move');
  // Same shape as a rolled pair, but the flag is already set: a second pass
  // must do nothing at all.
  seed([
    { ...show, status: 'moved' as any },
    { ...show, id: 'clone2', date: TODAY, status: 'pending', createdAt: 2_000 },
  ]);
  store.set(REPAIRED_KEY, '1');
  const again = await TaskStorage.repairAutoRolledTasks(TODAY);
  check('a second run changes nothing', again === 0 && readBack().length === 2);

  // A task SHE moved carries movedFromDate — the repair must not undo her.
  store.delete(REPAIRED_KEY);
  seed([
    { ...show, status: 'moved' as any },
    { ...show, id: 'byhand', date: TODAY, status: 'pending', createdAt: 2_000, movedFromDate: YESTERDAY },
  ]);
  const handMoved = await TaskStorage.repairAutoRolledTasks(TODAY);
  check('a task the user moved by hand is left alone',
    handMoved === 0 && readBack().some((t) => t.id === 'byhand'));

  // "Let it go" also writes status 'moved' — with no twin on today, there is
  // nothing to pair it with, so it must survive untouched.
  store.delete(REPAIRED_KEY);
  seed([{ ...show, status: 'moved' as any }]);
  const letGo = await TaskStorage.repairAutoRolledTasks(TODAY);
  check('a let-go task stays let go',
    letGo === 0 && readBack()[0].status === 'moved');

  console.log(`\n${checks} checks${process.exitCode ? ' — FAILURES' : ' — all good'}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
