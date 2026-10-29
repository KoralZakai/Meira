/**
 * run-tasks-read-cache — getAllTasks downloads once, and a write ends the reuse.
 *
 * 19.10: getAllTasks had ~57 callers and each downloaded every task row; one
 * Today focus made four full downloads. Now concurrent callers share one
 * download and its answer is reused for 3 s — but a write must never be hidden
 * by it (an untick that comes back is the bug this project shipped four times).
 *
 * Run: npx tsx tests/run-tasks-read-cache.ts
 */
const store = new Map<string, string>();
const memoryAsyncStorage = {
  async getItem(k: string) { return store.has(k) ? store.get(k)! : null; },
  async setItem(k: string, v: string) { store.set(k, v); },
  async removeItem(k: string) { store.delete(k); },
  async multiRemove(ks: string[]) { ks.forEach((k) => store.delete(k)); },
  async getAllKeys() { return [...store.keys()]; },
};

const cloudRows = new Map<string, any>();
let fetches = 0;
let fetchGate: Promise<void> | null = null;
let cloudDown = false;

const Module = require('module');
const origLoad = Module._load;
Module._load = function patched(request: string, ...rest: any[]) {
  if (request === '@react-native-async-storage/async-storage' || request.endsWith('/EncryptedStorage')) {
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
    const mockRepo: any = {
      __esModule: true,
      fetchTasks: async () => {
        fetches += 1;
        if (fetchGate) await fetchGate;
        if (cloudDown) throw new Error('Unable to resolve host "x.supabase.co"');
        return [...cloudRows.values()].map((r) => ({ ...r }));
      },
      upsertTask: async (_u: string, t: any) => { cloudRows.set(t.id, { ...t }); },
      upsertTaskChanges: async (_u: string, _b: any, t: any) => { cloudRows.set(t.id, { ...t }); },
      upsertTasks: async (_u: string, ts: any[]) => { ts.forEach((t) => cloudRows.set(t.id, { ...t })); },
      syncAllTasks: async () => {},
      deleteTaskRow: async (_u: string, id: string) => { cloudRows.delete(id); },
      fetchSettings: async () => null,
    };
    return mockRepo;
  }
  return origLoad.call(this, request, ...rest);
};

const TaskStorage = require('../src/services/TaskStorage');

let failures = 0;
const check = (l: string, ok: boolean, d = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${l}${d ? `  — ${d}` : ''}`);
};

const realNow = Date.now;
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;

const row = (id: string, extra: any = {}) => ({
  id, text: `task ${id}`, category: 'general', priority: 'need_to', isFixed: false,
  durationMinutes: 30, date: '2026-10-19', status: 'pending', createdAt: 1,
  historicalDurations: [], ...extra,
});

async function main() {
  console.log('\nOne download, shared\n');
  store.set('lumi.tasks.v1', JSON.stringify([row('a'), row('b')]));
  cloudRows.set('a', row('a'));
  cloudRows.set('b', row('b'));

  console.log('1. Ten callers at once');
  let open!: () => void;
  fetchGate = new Promise<void>((r) => { open = r; });
  const all = Promise.all(Array.from({ length: 10 }, () => TaskStorage.getAllTasks()));
  await new Promise((r) => setTimeout(r, 10));
  open(); fetchGate = null;
  const results = await all;
  check('ten callers, ONE download', fetches === 1, `${fetches} downloads`);
  check('each caller got both tasks', results.every((r: any[]) => r.length === 2));

  console.log('\n2. Reused for 3 s, then downloaded again');
  await TaskStorage.getAllTasks();
  check('a read 0 s later reuses it', fetches === 1, `${fetches}`);
  clockOffset += 3100;
  await TaskStorage.getAllTasks();
  check('a read 3.1 s later downloads again', fetches === 2, `${fetches}`);

  console.log('\n3. One caller editing its copy cannot leak into another');
  const mine = await TaskStorage.getAllTasks();
  mine[0].text = 'scribbled on';
  const theirs = await TaskStorage.getAllTasks();
  check('the next caller sees the stored text', theirs[0].text !== 'scribbled on', theirs[0].text);

  console.log('\n4. A write ends the reuse at once');
  const before = fetches;
  await TaskStorage.markTaskComplete('a', true);
  const afterTick = await TaskStorage.getAllTasks();
  check('the read after a tick downloads again', fetches === before + 1, `${fetches - before}`);
  check('…and shows the tick', afterTick.find((t: any) => t.id === 'a')?.status === 'complete');
  await TaskStorage.markTaskComplete('a', false);
  const afterUntick = await TaskStorage.getAllTasks();
  check('an untick is never hidden by a cached tick',
    afterUntick.find((t: any) => t.id === 'a')?.status === 'pending',
    afterUntick.find((t: any) => t.id === 'a')?.status);

  console.log('\n5. A read that started BEFORE a write does not fill the cache after it');
  open = () => {};
  fetchGate = new Promise<void>((r) => { open = r; });
  const early = TaskStorage.getAllTasks();                // starts, holds at the gate
  await new Promise((r) => setTimeout(r, 5));
  fetchGate = null;
  const added = await TaskStorage.addTask({
    text: 'new one', category: 'general', priority: 'need_to', isFixed: false,
    durationMinutes: 30, date: '2026-10-19', status: 'pending', historicalDurations: [],
  });
  open();
  await early;
  const late = await TaskStorage.getAllTasks();
  check('a read after the add has the new task', late.some((t: any) => t.id === added.id),
    `${late.length} tasks`);

  console.log('\n6. A delete is not resurrected by a cached read');
  await TaskStorage.getAllTasks();                          // warm the cache
  await TaskStorage.deleteTask('b');
  const afterDelete = await TaskStorage.getAllTasks();
  check('the deleted task is gone at once', !afterDelete.some((t: any) => t.id === 'b'));

  console.log('\n7. An unreachable cloud is said, not hidden (rule 1)');
  clockOffset += 3100;
  cloudDown = true;
  const read = await TaskStorage.getAllTasksChecked();
  check('the phone copy comes back', read.tasks.length > 0, `${read.tasks.length}`);
  check('…and carries the reason', typeof read.cloudError === 'string' && /resolve host/.test(read.cloudError),
    String(read.cloudError));
  cloudDown = false;
  clockOffset += 3100;
  const ok = await TaskStorage.getAllTasksChecked();
  check('a good read says nothing went wrong', ok.cloudError === null, String(ok.cloudError));

  console.log('\n8. The local-only read never touches the network');
  const n = fetches;
  const local = await TaskStorage.getLocalTasks();
  check('no download', fetches === n, `${fetches - n}`);
  check('the phone copy, deduped', local.length > 0 && new Set(local.map((t: any) => t.id)).size === local.length);

  Date.now = realNow;
  console.log(failures ? `\n❌ ${failures} failed\n` : '\n✅ all passed\n');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
