/**
 * run-signin-push — signing in sends the cloud what only this phone has, and
 * never writes the cloud's copy back over the phone.
 *
 * The sign-in backfill was `saveAllTasks(await getAllTasks())`: a cloud-merged
 * READ written over local storage (the shape behind the untick that kept coming
 * back), which dropped the rows she wrote while signed out — the very rows the
 * backfill exists to push — then upserted everything and deleted cloud rows the
 * phone had not seen. App.tsx's launch alert re-arm did the same on every start.
 *
 *   npx tsx tests/run-signin-push.ts
 */
import * as fs from 'fs';
import * as path from 'path';

const store = new Map<string, string>();
const memoryAsyncStorage = {
  async getItem(k: string) { return store.has(k) ? store.get(k)! : null; },
  async setItem(k: string, v: string) { store.set(k, v); },
  async removeItem(k: string) { store.delete(k); },
  async multiRemove(ks: string[]) { ks.forEach((k) => store.delete(k)); },
  async getAllKeys() { return [...store.keys()]; },
};
const cloudRows = new Map<string, any>();
const deleted: string[] = [];
let upserted: string[] = [];

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
  if (request === './supabaseRepo' || request.endsWith('/supabaseRepo')) {
    return {
      __esModule: true,
      fetchTasks: async () => [...cloudRows.values()].map((r) => ({ ...r })),
      upsertTasks: async (_u: string, ts: any[]) => {
        upserted = ts.map((t) => t.id);
        ts.forEach((t) => cloudRows.set(t.id, { ...t }));
      },
      upsertTask: async () => {}, upsertTaskChanges: async () => {}, syncAllTasks: async () => {},
      deleteTaskRow: async (_u: string, id: string) => { deleted.push(id); cloudRows.delete(id); },
      fetchSettings: async () => null,
    };
  }
  return origLoad.call(this, request, ...rest);
};
console.warn = () => {};
console.log = (() => { const log = console.log; return (...a: any[]) => { if (/^\s+[✓✗]|^\n|^[✅❌]|^\d\./.test(String(a[0]))) log(...a); }; })();
const TaskStorage = require('../src/services/TaskStorage');

let fail = 0;
const ok = (cond: boolean, label: string, detail = '') => {
  if (!cond) fail += 1;
  console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
};
const row = (id: string, extra: any = {}) => ({
  id, text: `task ${id}`, category: 'general', priority: 'need_to', isFixed: false,
  durationMinutes: 30, date: '2026-10-19', status: 'pending', createdAt: 1,
  historicalDurations: [], source: 'manual', ...extra,
});

async function main() {
  console.log('\nSigning in pushes what only the phone has\n');
  // shared: in both. offline: written while signed out. ahead: unticked here,
  // push never landed (flagged). serverOnly: made by WhatsApp, not on the phone.
  store.set('lumi.tasks.v1', JSON.stringify([
    row('shared'), row('offline'), row('ahead', { status: 'pending', uncompletedAt: 5 }),
  ]));
  store.set('lumi.cloudBehind.v1', JSON.stringify(['ahead']));
  cloudRows.set('shared', row('shared', { text: 'retitled by the server' }));
  cloudRows.set('ahead', row('ahead', { status: 'complete', completedAt: 2 }));
  cloudRows.set('serverOnly', row('serverOnly', { source: 'whatsapp' }));
  const localBefore = store.get('lumi.tasks.v1');

  const res = await TaskStorage.pushLocalTasksToCloud();

  ok(upserted.includes('offline'), 'the task written while signed out reaches the cloud');
  ok(upserted.includes('ahead') && cloudRows.get('ahead').status === 'pending',
    'the local-ahead untick reaches the cloud', cloudRows.get('ahead').status);
  ok(!upserted.includes('shared'), 'a row the cloud already has is not overwritten with the phone\'s older copy');
  ok(cloudRows.get('shared').text === 'retitled by the server', '…so the server\'s retitle survives');
  ok(deleted.length === 0 && cloudRows.has('serverOnly'), 'nothing is deleted in the cloud', deleted.join(','));
  ok(store.get('lumi.tasks.v1') === localBefore, 'the phone\'s own list is not rewritten');
  ok(!JSON.parse(store.get('lumi.cloudBehind.v1') || '[]').includes('ahead'), 'the pushed row leaves the retry queue');
  ok(res.pushed === 2 && res.local === 3, 'it reports what it pushed', JSON.stringify(res));

  console.log('\n2. App.tsx no longer writes a cloud-merged read back');
  const app = fs.readFileSync(path.join(__dirname, '..', 'App.tsx'), 'utf8');
  const code = app.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  ok(!/saveAllTasks\(/.test(code), 'no saveAllTasks call anywhere in App.tsx');
  ok(/updateTaskFields\(t\.id, \{ notificationIds: t\.notificationIds \}\)/.test(app),
    'the launch re-arm saves only the alert ids, row by row');
  ok(/pushLocalTasksToCloud\(\)/.test(app), 'the sign-in backfill pushes the phone\'s rows');

  console.log(fail ? `\n❌ ${fail} failed\n` : '\n✅ all passed\n');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
