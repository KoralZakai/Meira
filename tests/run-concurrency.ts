/**
 * run-concurrency — prove that concurrent task writes stop losing each other.
 *
 * The bug this guards: every mutator in TaskStorage was read-modify-write over
 * the WHOLE task array with no locking, and `getAllTasks` wrote on every READ.
 * TodaySchedule fired five mutators at once (calendar sync, travel chain,
 * travel-ahead, Gmail, goals), so whichever finished last silently overwrote
 * the rest. That single race is why a computed transitPlan vanished moments
 * after being saved, why the same calendar event could be inserted twice, and
 * why imported tasks went missing.
 *
 * These checks fail against the pre-lock code and pass after it. They exercise
 * the real TaskStorage against an in-memory AsyncStorage — no device needed.
 *
 * Run:  npx tsx tests/run-concurrency.ts
 */

// ── in-memory AsyncStorage, installed before TaskStorage is imported ────────
const store = new Map<string, string>();
const memoryAsyncStorage = {
  async getItem(k: string) { return store.has(k) ? store.get(k)! : null; },
  async setItem(k: string, v: string) {
    // A real AsyncStorage write is async and interleaves. Yielding here is what
    // makes the lost-update window reproducible rather than luck-dependent.
    await new Promise((r) => setTimeout(r, 1));
    store.set(k, v);
  },
  async removeItem(k: string) { store.delete(k); },
  async multiRemove(ks: string[]) { ks.forEach((k) => store.delete(k)); },
  async getAllKeys() { return [...store.keys()]; },
};

const Module = require('module');
const origResolve = Module._resolveFilename;
const origLoad = Module._load;
Module._load = function patched(request: string, ...rest: any[]) {
  if (request === '@react-native-async-storage/async-storage' || request.endsWith('/EncryptedStorage')) {
    return { __esModule: true, default: memoryAsyncStorage };
  }
  // Supabase client pulls in react-native internals we do not need here.
  if (request === './supabaseClient' || request.endsWith('/supabaseClient')) {
    return { __esModule: true, isSupabaseConfigured: false, supabase: null };
  }
  if (request === './SupabaseAuthService' || request.endsWith('/SupabaseAuthService')) {
    return { __esModule: true, getUserId: async () => null };
  }
  return origLoad.call(this, request, ...rest);
};
void origResolve;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const TaskStorage = require('../src/services/TaskStorage');
import type { Task } from '../src/types/index';

const TASKS_KEY = 'lumi.tasks.v1';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

const makeTask = (id: string, text: string, date = '2026-08-21'): Task => ({
  id,
  text,
  category: 'general',
  priority: 'need_to',
  isFixed: false,
  durationMinutes: 30,
  date,
  status: 'pending',
  createdAt: Date.now(),
  historicalDurations: [],
} as Task);

async function seed(tasks: Task[]) {
  store.clear();
  store.set(TASKS_KEY, JSON.stringify(tasks));
}

async function readBack(): Promise<Task[]> {
  return JSON.parse(store.get(TASKS_KEY) || '[]');
}

async function main() {
  console.log('\nConcurrent task writes\n');

  // ── 1. Two field updates on two different tasks ──────────────────────────
  // The classic lost update: both read the array, both write it back, the
  // second erases the first's change.
  console.log('1. Two updates to different tasks, at the same time');
  await seed([makeTask('a', 'task a'), makeTask('b', 'task b')]);
  await Promise.all([
    TaskStorage.updateTaskFields('a', { text: 'task a EDITED' }),
    TaskStorage.updateTaskFields('b', { text: 'task b EDITED' }),
  ]);
  let rows = await readBack();
  check('both edits survived',
    rows.find((t) => t.id === 'a')?.text === 'task a EDITED'
    && rows.find((t) => t.id === 'b')?.text === 'task b EDITED',
    rows.map((t) => t.text).join(' | '));

  // ── 2. A travel plan written while something else edits ──────────────────
  // This is the reported symptom verbatim: the route is computed, saved, and
  // is gone by the time the screen re-reads it.
  console.log('\n2. A travel plan saved while another write lands');
  await seed([makeTask('trip', 'yoga'), makeTask('other', 'groceries')]);
  await Promise.all([
    TaskStorage.updateTaskFields('trip', {
      location: { address: 'יגאל אלון 94', lat: 32.07, lng: 34.79, confirmed: true,
        leaveHomeBy: '10:43', transitPlan: { totalDurationMinutes: 7 } } as any,
    }),
    TaskStorage.updateTaskFields('other', { text: 'groceries EDITED' }),
  ]);
  rows = await readBack();
  const trip: any = rows.find((t) => t.id === 'trip');
  check('the transitPlan is still there', Boolean(trip?.location?.transitPlan),
    trip?.location?.transitPlan ? 'saved' : 'LOST — this is the reported bug');
  check('the concurrent edit also survived',
    rows.find((t) => t.id === 'other')?.text === 'groceries EDITED');

  // ── 3. The same external task merged twice at once ───────────────────────
  // Two calendar syncs overlapping both see "not present" and both insert.
  console.log('\n3. The same calendar event imported twice, concurrently');
  await seed([]);
  const event = makeTask('gcal-evt1', 'yoga class');
  await Promise.all([
    TaskStorage.mergeExternalTasks([event]),
    TaskStorage.mergeExternalTasks([event]),
  ]);
  rows = await readBack();
  check('imported exactly once', rows.filter((t) => t.id === 'gcal-evt1').length === 1,
    `${rows.filter((t) => t.id === 'gcal-evt1').length} row(s)`);

  // ── 4. Many writers at once ──────────────────────────────────────────────
  console.log('\n4. Ten writers at once');
  await seed(Array.from({ length: 10 }, (_, i) => makeTask(`t${i}`, `task ${i}`)));
  await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      TaskStorage.updateTaskFields(`t${i}`, { text: `task ${i} EDITED` })),
  );
  rows = await readBack();
  const edited = rows.filter((t) => t.text.endsWith('EDITED')).length;
  check('all ten edits survived', edited === 10, `${edited}/10`);

  // ── 5. Adds do not clobber each other ────────────────────────────────────
  console.log('\n5. Five tasks added at once');
  await seed([]);
  await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      TaskStorage.addTask({ ...makeTask('x', `added ${i}`) } as any)),
  );
  rows = await readBack();
  check('all five are present', rows.length === 5, `${rows.length}/5`);

  // ── 6. Completed duplicates are merged ───────────────────────────────────
  // dedupeTasks used to skip completed rows entirely, so finished duplicates
  // accumulated in the Done list forever.
  console.log('\n6. Duplicate completed tasks');
  const done1 = { ...makeTask('d1', 'yoga'), status: 'complete', completedAt: 111 } as Task;
  const done2 = { ...makeTask('d2', 'yoga'), status: 'complete', completedAt: 222 } as Task;
  const { kept } = TaskStorage.dedupeTasks([done1, done2]);
  check('two identical completed tasks collapse to one', kept.length === 1, `${kept.length}`);

  // Completion has to EARN the merge rather than win it by default. The two
  // mistakes are not equal: a false "done" hides work she still owes, while a
  // false "not done" costs one extra tap. So the tick stands only when it was
  // made after the open row existed — a tick that predates it cannot be about
  // it, and used to silently mark unfinished work as finished.
  // A finished row and an unfinished one are a QUESTION, not a duplicate.
  // Collapsing them is what put a tick on work that was never done — and this
  // runs inside saveAllTasks, which every Today load calls, so the result was
  // written to disk and pushed to the cloud with no action from the user.
  const pending = makeTask('p1', 'yoga');
  const doneTwin = {
    ...makeTask('d3', 'yoga'), status: 'complete',
    completedAt: (pending.createdAt ?? 0) + 60_000,
  } as Task;
  const mixed = TaskStorage.dedupeTasks([pending, doneTwin]).kept;
  check('an unfinished task is never absorbed by a finished twin',
    mixed.some((t: Task) => t.status === 'pending'),
    mixed.map((t: Task) => `${t.id}:${t.status}`).join(' · '));
  check('both survive, for the user to decide between', mixed.length === 2, `${mixed.length}`);

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} checks passed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('crashed:', e);
  process.exit(1);
});
