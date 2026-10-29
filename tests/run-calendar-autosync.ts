/**
 * run-calendar-autosync — "a new event in Google Calendar must reach Meira on
 * its own."
 *
 * What was actually wrong was not the import. It was that nothing RAN it:
 *
 *  1. The only trigger in the app was TodaySchedule coming into focus, behind
 *     a 30-minute throttle. Adding an event in Google and switching straight
 *     back to Meira did nothing at all — and did it silently.
 *  2. "Pick a day → Wednesday" was documented as "the quiet path. No sync"
 *     and read local storage only. The one screen she used to LOOK for the
 *     interview was the one screen that could never fetch it.
 *  3. An event deleted in-app once is tombstoned FOREVER: the merge does
 *     `if (dismissed.has(t.id)) continue;` and says nothing, so Google can
 *     hold an event that this phone refuses on every sync, with no surface
 *     anywhere able to say so.
 *
 * These checks exercise the real TaskStorage against an in-memory
 * AsyncStorage — no device, no network. (1) and (2) are wiring, and are
 * asserted on the source itself: the triggers either exist or they do not,
 * and "they do not" is exactly the bug.
 *
 * Run:  npx tsx tests/run-calendar-autosync.ts
 */

// ── in-memory AsyncStorage, installed before TaskStorage is imported ────────
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
    return { __esModule: true, getUserId: async () => null };
  }
  return origLoad.call(this, request, ...rest);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const TaskStorage = require('../src/services/TaskStorage');
import { readFileSync } from 'fs';
import { join } from 'path';
import type { Task } from '../src/types/index';

const TASKS_KEY = 'lumi.tasks.v1';
const DISMISSED_KEY = 'lumi.dismissedExternal.v1';
const ROOT = join(__dirname, '..');
const src = (p: string) => readFileSync(join(ROOT, p), 'utf8');

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

/** The Ceva interview, as syncCalendarForDate would shape it. */
const interview = (): Task => ({
  id: 'gcal-_9t1j0u1m6sqkorq5a8o7gdphcgpmaj3f851j0u1jc8pjad336l66ukq361s36c316grm6oj19h06irjkclp7cqb5esn66rrdclin8bj3ds',
  text: 'Your in-person interview with Ceva',
  category: 'meeting',
  priority: 'have_to',
  isFixed: true,
  fixedTime: '14:30',
  scheduledTime: '14:30',
  durationMinutes: 90,
  date: '2026-09-23',
  status: 'pending',
  createdAt: Date.now(),
  historicalDurations: [],
} as unknown as Task);

async function main() {
  console.log('\nAutomatic calendar sync\n');

  // ── 1. A brand-new event imports ─────────────────────────────────────────
  store.clear();
  store.set(TASKS_KEY, JSON.stringify([]));
  let added = await TaskStorage.mergeExternalTasks([interview()]);
  let rows: Task[] = JSON.parse(store.get(TASKS_KEY) || '[]');
  check('a new calendar event is imported', added === 1 && rows.length === 1,
    `added=${added} rows=${rows.length}`);

  // ── 2. Re-syncing the same event does NOT duplicate it ───────────────────
  added = await TaskStorage.mergeExternalTasks([interview()]);
  rows = JSON.parse(store.get(TASKS_KEY) || '[]');
  check('re-syncing is idempotent — 15 background runs make one task',
    added === 0 && rows.length === 1, `added=${added} rows=${rows.length}`);

  // ── 3. The long Google id survives the round trip ────────────────────────
  // Google event ids are long and opaque. Nothing here may truncate or re-key
  // one — a silently shortened id would import the same event twice forever.
  check('the long Google event id is stored verbatim',
    rows[0]?.id === interview().id, `len=${rows[0]?.id?.length}`);

  // ── 4. A tombstone blocks the import — permanently and silently ──────────
  store.clear();
  store.set(TASKS_KEY, JSON.stringify([]));
  store.set(DISMISSED_KEY, JSON.stringify([interview().id]));
  added = await TaskStorage.mergeExternalTasks([interview()]);
  rows = JSON.parse(store.get(TASKS_KEY) || '[]');
  check('a deleted-once event is blocked on re-sync (the behaviour)',
    added === 0 && rows.length === 0, `added=${added} rows=${rows.length}`);

  // ── 5. …and the block is now READABLE ────────────────────────────────────
  // This is the check that did not exist. The block was correct and invisible,
  // so "Google has it and the app does not" had no explanation on any screen.
  const blocked: string[] = await TaskStorage.getDismissedExternalIds();
  check('the block can be read back, so a diagnostic can name it',
    blocked.includes(interview().id), `${blocked.length} tombstone(s)`);

  // ── 6. …and liftable ─────────────────────────────────────────────────────
  const lifted = await TaskStorage.clearDismissedExternalIds();
  added = await TaskStorage.mergeExternalTasks([interview()]);
  rows = JSON.parse(store.get(TASKS_KEY) || '[]');
  check('lifting the block lets the event come back',
    lifted === 1 && added === 1 && rows.length === 1,
    `lifted=${lifted} added=${added}`);

  // ── 7. Lifting one id leaves the others alone ────────────────────────────
  store.set(DISMISSED_KEY, JSON.stringify(['gcal-a', 'gcal-b', 'gcal-c']));
  await TaskStorage.clearDismissedExternalIds(['gcal-b']);
  const left: string[] = await TaskStorage.getDismissedExternalIds();
  check('lifting one tombstone keeps the rest',
    left.length === 2 && !left.includes('gcal-b'), left.join(','));

  // ── 8. An event that MOVED is updated, not duplicated ────────────────────
  // An organiser shifting an interview by an hour used to leave the old hour
  // and the old alarm in place forever.
  store.clear();
  store.set(TASKS_KEY, JSON.stringify([interview()]));
  const moved = { ...interview(), fixedTime: '16:00', scheduledTime: '16:00' };
  await TaskStorage.mergeExternalTasks([moved]);
  rows = JSON.parse(store.get(TASKS_KEY) || '[]');
  check('a moved event does not become a second task',
    rows.length === 1, `rows=${rows.length}`);

  // ── 9..13. The triggers exist at all ─────────────────────────────────────
  // The whole bug was an import with nothing to run it. Asserting on the
  // source is crude and it is the only thing that would have caught it: a
  // green suite passed for months while no trigger existed.
  const autoSync = src('src/services/CalendarAutoSync.ts');
  const app = src('App.tsx');
  const today = src('src/screens/TodaySchedule.tsx');
  const appJson = JSON.parse(src('app.json'));

  check('the app root starts auto-sync, not a screen',
    app.includes('startCalendarAutoSync('),
    'App.tsx');

  check('returning to the app triggers a pull',
    /AppState\.addEventListener\('change'/.test(autoSync)
    && autoSync.includes("=== 'active'"),
    'AppState active');

  check('a background job is registered for when the app is closed',
    autoSync.includes('BackgroundTask.registerTaskAsync')
    && autoSync.includes('TaskManager.defineTask'),
    'expo-background-task');

  check('the background plugin is in the build config (no plugin, no job)',
    JSON.stringify(appJson.expo.plugins).includes('expo-background-task'),
    'app.json plugins');

  check('picking another day now asks Google about THAT day',
    today.includes('syncCalendarDate(dateKey'),
    'TodaySchedule day picker');

  // Drawn as one line that names the FIX (offline ≠ reconnect Google — the
  // 30.9 card told her to reconnect over a DNS blip); the raw reason stays one
  // tap away for the kinds that have no plain fix.
  check('a refused pull is drawn on the day, not swallowed — in words that name the fix',
    today.includes('calendarError') && today.includes('classifyCalendarError(calendarError)')
      && today.includes('calendarErrorLine('),
    'TodaySchedule calendar line');

  // ── 14. One announcement per event, both languages ───────────────────────
  check('the import announces itself (a silent background import is no import)',
    autoSync.includes('sendImmediate') && autoSync.includes('ANNOUNCED_KEY'),
    'CalendarAutoSync.announce');

  check('the announcement exists in Hebrew and English',
    autoSync.includes('נוסף ליומן') && autoSync.includes('New in your calendar'),
    'both languages');

  // ── 16. Rule 1: the result can say WHY, not just zero ────────────────────
  check('a sync result carries Google\'s reason, not a bare 0',
    /error: string \| null/.test(autoSync) && autoSync.includes('lastCalendarFailure()'),
    'CalendarSyncResult.error');

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} checks passed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
