/**
 * run-delete-sticks — a deleted task must STAY deleted, across the next sync.
 *
 * Reported 2026-08-31: "after delete i still see them".
 *
 * A delete does two things: it removes the row, and it writes a TOMBSTONE id
 * so a later pull from the server cannot re-insert what the user just threw
 * away. The tombstone was only written when the task's source was whatsapp /
 * gcal / gmail / calendar — on the assumption that a 'manual' task exists
 * nowhere else and so cannot come back.
 *
 * It does exist elsewhere: manual tasks are mirrored to the server (that is
 * what makes them visible on WhatsApp at all). So the delete emptied the local
 * list, the next pull found the id absent, and put it straight back. She
 * deletes a task, watches it return, and stops trusting the list — which is
 * worse than the task never having been deletable.
 *
 * Real TaskStorage over an in-memory AsyncStorage (same harness as
 * run-no-auto-rollover) — no device needed.
 *
 * Run: npx tsx tests/run-delete-sticks.ts
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

import type { Task } from '../src/types/index';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const TaskStorage = require('../src/services/TaskStorage');

const TASKS_KEY = 'lumi.tasks.v1';
const TODAY = '2026-08-31';

let pass = 0, fail = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? '✓' : '✗'} ${label}` + (ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};

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

const seed = async (tasks: Task[]) => {
  store.clear();
  store.set(TASKS_KEY, JSON.stringify(tasks));
};
const texts = async () => (await TaskStorage.getAllTasks()).map((t: Task) => t.text).sort();

(async () => {
  console.log('\n1. Her case: a MANUAL task, deleted, then a sync');
  const gym = task({ text: 'אימון בחדר כושר', source: 'manual', category: 'gym' });
  await seed([gym]);
  eq('starts present', await texts(), ['אימון בחדר כושר']);
  await TaskStorage.deleteTask(gym.id);
  eq('gone after delete', await texts(), []);
  // exactly what the next pull delivers — the server still holds the row
  await TaskStorage.mergeExternalTasks([{ ...gym, source: 'whatsapp' }]);
  eq('STILL gone after the sync', await texts(), []);

  console.log('\n2. An external task keeps working as before');
  const wa = task({ text: 'from whatsapp', source: 'whatsapp' });
  await seed([wa]);
  await TaskStorage.deleteTask(wa.id);
  await TaskStorage.mergeExternalTasks([wa]);
  eq('stays deleted', await texts(), []);

  console.log('\n3. Bulk delete tombstones every id');
  const a = task({ text: 'a', source: 'manual' });
  const b = task({ text: 'b', source: 'manual' });
  await seed([a, b]);
  await TaskStorage.deleteTasks([a.id, b.id]);
  eq('both gone', await texts(), []);
  await TaskStorage.mergeExternalTasks([{ ...a, source: 'whatsapp' }, { ...b, source: 'whatsapp' }]);
  eq('both STILL gone', await texts(), []);

  console.log('\n4. A task never deleted must still arrive');
  await seed([]);
  await TaskStorage.mergeExternalTasks([task({ id: 'srv-1', text: 'new from server', source: 'whatsapp' })]);
  eq('sync still works', await texts(), ['new from server']);

  console.log('\n5. Deleting one must not tombstone its neighbour');
  const keep = task({ text: 'keep me', source: 'manual' });
  const drop = task({ text: 'drop me', source: 'manual' });
  await seed([keep, drop]);
  await TaskStorage.deleteTask(drop.id);
  await TaskStorage.mergeExternalTasks([{ ...keep, source: 'whatsapp' }, { ...drop, source: 'whatsapp' }]);
  eq('only the deleted one stays gone', await texts(), ['keep me']);

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass}/${pass + fail} checks passed`);
  process.exit(fail === 0 ? 0 : 1);
})();
