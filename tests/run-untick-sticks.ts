/**
 * run-untick-sticks — an edit the cloud rejected must not be undone by it.
 *
 * Reported: "tasks are marked as done for no reason; I tried to remove the
 * mark and it returns to done."
 *
 * The chain, from the device log:
 *   1. untick  -> local write succeeds, status 'pending'
 *   2. push    -> Postgres rejects the row (tasks_priority_check)
 *   3. catch   -> console.warn, and nothing else
 *   4. read    -> getAllTasks is cloud-first, cloud still says 'complete'
 *   5. render  -> the tick is back, and the app looks like it refuses to be
 *                 corrected.
 *
 * Run: npx tsx tests/run-untick-sticks.ts
 */
const store = new Map<string, string>();
const memoryAsyncStorage = {
  async getItem(k: string) { return store.has(k) ? store.get(k)! : null; },
  async setItem(k: string, v: string) { store.set(k, v); },
  async removeItem(k: string) { store.delete(k); },
  async multiRemove(ks: string[]) { ks.forEach((k) => store.delete(k)); },
  async getAllKeys() { return [...store.keys()]; },
};

/** The cloud: holds rows, and REFUSES the one with a bad priority. */
const cloudRows = new Map<string, any>();
let rejectId: string | null = null;
let pushGate: Promise<void> | null = null;

const Module = require('module');
const origLoad = Module._load;
Module._load = function patched(request: string, ...rest: any[]) {
  if (request === '@react-native-async-storage/async-storage') {
    return { __esModule: true, default: memoryAsyncStorage };
  }
  if (request === './supabaseClient' || request.endsWith('/supabaseClient')) {
    return { __esModule: true, isSupabaseConfigured: true, supabase: null };
  }
  if (request === './SupabaseAuthService' || request.endsWith('/SupabaseAuthService')) {
    return { __esModule: true, getUserId: async () => 'user-1', getSession: async () => ({}) };
  }
  if (request === './NotificationService' || request.endsWith('/NotificationService')) {
    return { __esModule: true, armTaskAlerts: async () => {}, cancelTaskNotifications: async () => {} };
  }
  if (request === './supabaseRepo' || request.endsWith('/supabaseRepo')) {
    return {
      __esModule: true,
      fetchTasks: async () => [...cloudRows.values()],
      upsertTask: async (_u: string, t: any) => {
        if (pushGate) await pushGate;              // hold the push mid-flight
        if (t.id === rejectId) {
          throw new Error('new row for relation "tasks" violates check constraint "tasks_priority_check"');
        }
        cloudRows.set(t.id, { ...t });
      },
      upsertTasks: async () => {}, syncAllTasks: async () => {}, deleteTaskRow: async () => {},
      // Not decoration. Without it every run printed
      //   [TaskStorage] cloud fetchSettings failed: repo.fetchSettings is not a function
      // which was carried for two days as a production bug to chase. The real
      // module has had fetchSettings all along; only this stub lacked it. A
      // test's own missing mock must not read as a defect in the code.
      fetchSettings: async () => null,
    };
  }
  return origLoad.call(this, request, ...rest);
};

const TaskStorage = require('../src/services/TaskStorage');

let failures = 0; let checks = 0;
const check = (l: string, ok: boolean, d = '') => {
  checks += 1; if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${l}${d ? `  — ${d}` : ''}`);
};

async function main() {
  console.log('\nUnticking sticks\n');

  const task = {
    id: 't1', text: 'לדבר עם אלה', category: 'general', priority: '',
    isFixed: false, durationMinutes: 30, date: '2026-09-08',
    status: 'complete', completedAt: Date.now(), createdAt: 0, historicalDurations: [],
  };
  store.set('lumi.tasks.v1', JSON.stringify([task]));
  cloudRows.set('t1', { ...task });

  console.log('1. The cloud refuses this row');
  rejectId = 't1';
  await TaskStorage.markTaskComplete('t1', false);

  const local = JSON.parse(store.get('lumi.tasks.v1')!);
  check('the local copy IS unticked', local[0].status === 'pending', local[0].status);
  check('the cloud still holds the old, ticked row',
    cloudRows.get('t1').status === 'complete');

  console.log('\n2. …and the next read must not undo her');
  const after = await TaskStorage.getAllTasks();
  check('reading back gives PENDING, not the stale cloud row',
    after.find((t: any) => t.id === 't1')?.status === 'pending',
    after.find((t: any) => t.id === 't1')?.status);

  console.log('\n3. Once the cloud accepts it, normal service resumes');
  rejectId = null;
  await TaskStorage.markTaskComplete('t1', false);
  check('the push lands', cloudRows.get('t1').status === 'pending');
  // Cloud now diverges deliberately; a successful push cleared the local-ahead
  // flag, so the cloud is authoritative again.
  cloudRows.set('t1', { ...cloudRows.get('t1'), text: 'renamed in the cloud' });
  const fresh = await TaskStorage.getAllTasks();
  check('the cloud is trusted again after a successful push',
    fresh.find((t: any) => t.id === 't1')?.text === 'renamed in the cloud',
    fresh.find((t: any) => t.id === 't1')?.text);

  console.log('\n4. …and a restart must not undo her either');
  // purgeDuplicateTasks runs on every app load. It reads the CLOUD to decide
  // what to delete — correct — but used to write that cloud list back over
  // local storage, which replaced every local task with the server's version.
  // A duplicate anywhere in the store was enough to trigger it.
  // Both rows start ticked, as they would after the duplicate was created and
  // one of them completed. Then she unticks the real one — through the same
  // call the UI makes, so the correction is stamped.
  store.set('lumi.tasks.v1', JSON.stringify([
    { ...task, status: 'complete', completedAt: Date.now() - 60_000 },
    { ...task, id: 'dupe', text: 'לדבר עם אלה', status: 'complete', completedAt: Date.now() - 60_000 },
  ]));
  rejectId = null;
  await TaskStorage.markTaskComplete('t1', false);
  cloudRows.set('t1', { ...task, status: 'complete' });      // cloud is stale
  cloudRows.set('dupe', { ...task, id: 'dupe' });            // and has a duplicate

  await TaskStorage.purgeDuplicateTasks();
  const onDisk = JSON.parse(store.get('lumi.tasks.v1')!);
  const t1 = onDisk.find((t: any) => t.id === 't1');
  const survivor = onDisk.find((t: any) => t.status === 'pending');
  check('the untick SURVIVES the load-time purge, duplicate or not',
    Boolean(survivor), JSON.stringify(onDisk.map((t: any) => `${t.id}:${t.status}`)));
  // Both rows survive now: a finished twin and an unfinished one are a
  // question, not a duplicate. What must never happen is the unfinished one
  // disappearing behind a tick.
  check('the unfinished row is still there', Boolean(survivor));

  console.log('\n5. A tick she never made must not appear');
  const { dedupeTasks } = TaskStorage;
  const base = { text: 'לדבר עם אלה', date: '2026-09-08', category: 'general',
                 durationMinutes: 30, historicalDurations: [] };
  // An old completion and a task created AFTER it: the tick cannot be about
  // the newer row, so the newer row's own state stands.
  const mixed = dedupeTasks([
    { ...base, id: 'done', status: 'complete', completedAt: 9000, createdAt: 900 },
    { ...base, id: 'open', status: 'pending', createdAt: 5000 },
  ] as any).kept;
  check('a finished twin never absorbs an unfinished row',
    mixed.some((t: any) => t.status === 'pending'),
    mixed.map((t: any) => `${t.id}:${t.status}`).join(' · '));
  check('…and both survive for her to decide between', mixed.length === 2, `${mixed.length}`);

  // Same-status duplicates DO still collapse — that is real clutter.
  const twoDone = dedupeTasks([
    { ...base, id: 'd1', status: 'complete', completedAt: 111, createdAt: 1 },
    { ...base, id: 'd2', status: 'complete', completedAt: 222, createdAt: 1 },
  ] as any).kept;
  check('two finished copies still collapse to one', twoDone.length === 1, `${twoDone.length}`);

  console.log('\n6. A refresh that lands WHILE the push is in flight');
  // The bug that survived four fixes. The local write succeeds instantly; the
  // push takes a network round-trip. Anything that reads in between used to
  // get the server's old row back, so the tick reappeared half a second after
  // she cleared it — with nothing having failed.
  store.set('lumi.tasks.v1', JSON.stringify([
    { ...task, id: 'race', status: 'complete', completedAt: Date.now() - 60_000 },
  ]));
  cloudRows.set('race', { ...task, id: 'race', status: 'complete' });
  rejectId = null;

  let releasePush: () => void = () => {};
  pushGate = new Promise<void>((resolve) => { releasePush = resolve; });

  const untick = TaskStorage.markTaskComplete('race', false);   // do NOT await
  await new Promise((r) => setTimeout(r, 30));                  // push is stuck
  const midFlight = await TaskStorage.getAllTasks();
  check('a read DURING the push sees the untick, not the stale cloud row',
    midFlight.find((t: any) => t.id === 'race')?.status === 'pending',
    midFlight.find((t: any) => t.id === 'race')?.status);

  releasePush();
  await untick;
  pushGate = null;
  check('and the server ends up with it too',
    cloudRows.get('race').status === 'pending', cloudRows.get('race').status);

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks\n`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
