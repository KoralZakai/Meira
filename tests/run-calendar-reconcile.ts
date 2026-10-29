/**
 * run-calendar-reconcile — the hole between "add" and "refresh".
 *
 * Observed on her phone, 2026-09-22, on the build that was supposed to have
 * fixed this. The app's own calendar check said, truthfully:
 *
 *     1 event(s) found in the next 14 days.
 *     0 already imported as tasks.
 *
 * Google had the Ceva interview. The app fetched it. The app imported nothing.
 * Nothing failed. Two functions politely declined:
 *
 *   mergeExternalTasks      `if (ids.has(t.id)) continue;`
 *                           the id is known → nothing to do, never looks again
 *   refreshImportedTasks    `if (current.source !== 'calendar') continue;`
 *                           not stamped ours → not our problem
 *
 * A row whose id is known but whose DATE is wrong, or whose provenance stamp
 * was lost, is unreachable by both. Forever, and in silence. And note the
 * second hole inside the first: refreshImportedTasks never wrote `date` at
 * all, so even a correctly-stamped row stranded on the wrong day stayed there.
 *
 * `reconcileExternalTask` is the pass that answers to neither. These checks
 * fail against the old code and pass against it.
 *
 * Run:  npx tsx tests/run-calendar-reconcile.ts
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
import type { Task } from '../src/types/index';

const TASKS_KEY = 'lumi.tasks.v1';
const DISMISSED_KEY = 'lumi.dismissedExternal.v1';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

const GCAL_ID =
  'gcal-_9t1j0u1m6sqkorq5a8o7gdphcgpmaj3f851j0u1jc8pjad336l66ukq361s36c316grm6oj19h06irjkclp7cqb5esn66rrdclin8bj3ds';
const EVENT_ID = GCAL_ID.slice('gcal-'.length);

/** The interview exactly as syncCalendarForDate shapes it from Google. */
const fromGoogle = (over: Partial<Task> = {}): Task => ({
  id: GCAL_ID,
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
  source: 'calendar',
  calendarEventId: EVENT_ID,
  ...over,
} as unknown as Task);

const rows = (): Task[] => JSON.parse(store.get(TASKS_KEY) || '[]');
const reset = (seed: Task[] = []) => {
  store.clear();
  store.set(TASKS_KEY, JSON.stringify(seed));
};

async function main() {
  console.log('\nCalendar reconcile — the hole between add and refresh\n');

  // ── 1. Nothing stored → the event is inserted, id intact ─────────────────
  reset();
  let r = await TaskStorage.reconcileExternalTask(fromGoogle());
  check('an event that is not here is added', r.outcome === 'inserted', r.outcome);
  check('the Google id is preserved, so the next sync recognises it',
    rows()[0]?.id === GCAL_ID, `len=${rows()[0]?.id?.length}`);

  // ── 2. Running again changes nothing ─────────────────────────────────────
  r = await TaskStorage.reconcileExternalTask(fromGoogle());
  check('a second pass is a no-op — 96 background runs a day make one task',
    r.outcome === 'unchanged' && rows().length === 1,
    `${r.outcome}, ${rows().length} row(s)`);

  // ── 3. THE BUG. Known id, wrong date. ────────────────────────────────────
  // mergeExternalTasks skips it (id known). refreshImportedTasks never wrote
  // `date`. So the interview sat on some other day and Wednesday was empty,
  // on every sync, forever.
  reset([fromGoogle({ date: '2026-09-17' })]);
  r = await TaskStorage.reconcileExternalTask(fromGoogle());
  check('a row stranded on the WRONG DATE is moved back',
    r.outcome === 'updated' && rows()[0]?.date === '2026-09-23',
    `${r.outcome} → ${rows()[0]?.date}`);
  check('and it does not become a second copy', rows().length === 1,
    `${rows().length} row(s)`);

  // ── 4. Known id, provenance stamp lost ───────────────────────────────────
  // refreshImportedTasks declines anything not marked source:'calendar', so a
  // row that lost the stamp was unreachable by BOTH passes.
  reset([fromGoogle({ source: undefined, date: '2026-09-20' }) as any]);
  r = await TaskStorage.reconcileExternalTask(fromGoogle());
  check('a row that lost source:calendar is still reconciled',
    r.outcome === 'updated' && rows()[0]?.date === '2026-09-23',
    r.outcome);
  check('...and is re-stamped, so it is recognised next time',
    (rows()[0] as any)?.source === 'calendar');

  // ── 5. Matched by calendarEventId when the id was re-keyed ───────────────
  reset([fromGoogle({ id: 'wa_legacy_hash', date: '2026-09-01' })]);
  r = await TaskStorage.reconcileExternalTask(fromGoogle());
  check('a re-keyed row is found by the event id it came from',
    r.outcome === 'updated' && rows().length === 1 && rows()[0]?.date === '2026-09-23',
    `${r.outcome}, ${rows().length} row(s)`);

  // ── 6. The organiser moves the hour ──────────────────────────────────────
  reset([fromGoogle()]);
  r = await TaskStorage.reconcileExternalTask(fromGoogle({ fixedTime: '16:00', scheduledTime: '16:00' }));
  check('a rescheduled hour is taken',
    r.outcome === 'updated' && rows()[0]?.fixedTime === '16:00',
    String(rows()[0]?.fixedTime));
  check('the caller is told WHICH fields moved, so alerts can be re-armed',
    r.changed.includes('fixedTime'), r.changed.join(','));

  // ── 7. Her decisions outrank Google ──────────────────────────────────────
  reset([fromGoogle({ status: 'complete' })]);
  r = await TaskStorage.reconcileExternalTask(fromGoogle());
  check('a task she already ticked is not reopened',
    r.outcome === 'complete' && rows()[0]?.status === 'complete', r.outcome);

  reset();
  store.set(DISMISSED_KEY, JSON.stringify([GCAL_ID]));
  r = await TaskStorage.reconcileExternalTask(fromGoogle());
  check('an event she deleted in-app is NOT resurrected',
    r.outcome === 'blocked' && rows().length === 0, r.outcome);
  check('...and the refusal is reported, not silent',
    r.outcome === 'blocked', 'outcome is a word, not an empty result');

  // ── 8. A field Google left empty does not erase a better local one ───────
  reset([fromGoogle({ text: 'Ceva interview — building D, 9th floor' })]);
  r = await TaskStorage.reconcileExternalTask(fromGoogle({ text: '' } as any));
  check('an empty incoming field does not wipe the stored one',
    rows()[0]?.text === 'Ceva interview — building D, 9th floor',
    String(rows()[0]?.text));

  // ── 9. Seen on her phone: right day, wrong KIND of commitment ───────────
  // The row had been created back when any URL in the invitation body counted
  // as a join link, so a Google MAPS link made it category 'zoom'. A zoom task
  // is REMOTE — departureOf returns undefined — so an in-person interview in
  // Ra'anana had no route, no leave-home time and no wake alarm, and showed a
  // 💻 on the card. Correcting the date alone did not touch any of that.
  reset([fromGoogle({ category: 'zoom', meetingUrl: 'https://www.google.com/maps/place/7+HaPnina' } as any)]);
  r = await TaskStorage.reconcileExternalTask(
    fromGoogle({ category: 'meeting' }),
    ['date', 'fixedTime', 'scheduledTime', 'durationMinutes', 'text', 'category', 'meetingUrl'],
    ['meetingUrl'],
  );
  check('a row wrongly filed as remote is corrected to a place you travel to',
    rows()[0]?.category === 'meeting', String(rows()[0]?.category));
  check('and the map link masquerading as a join link is CLEARED',
    !(rows()[0] as any)?.meetingUrl,
    String((rows()[0] as any)?.meetingUrl));
  check('clearing is reported as a change, so alerts can be rebuilt',
    r.changed.includes('meetingUrl'), r.changed.join(','));

  // ── 10. A real join link is not cleared ─────────────────────────────────
  reset([fromGoogle({ category: 'zoom', meetingUrl: 'https://zoom.us/j/42' } as any)]);
  r = await TaskStorage.reconcileExternalTask(
    fromGoogle({ category: 'zoom', meetingUrl: 'https://zoom.us/j/42' } as any),
    ['category', 'meetingUrl'],
    ['meetingUrl'],
  );
  check('a genuine Zoom link survives untouched',
    (rows()[0] as any)?.meetingUrl === 'https://zoom.us/j/42' && r.outcome === 'unchanged',
    r.outcome);

  // ── 11. A reconcile that never converges is a loop ──────────────────────
  // Caught on her phone within a minute of installing: every sync logged
  // `corrected "…interview with Ceva": attendees`, wrote the row and pushed it
  // to the cloud — forever, over nothing. `attendees` is an array, so a
  // reference compare is never equal to an identical array.
  const withGuests = fromGoogle({ attendees: ['koralzakai1@gmail.com'] } as any);
  reset([withGuests]);
  r = await TaskStorage.reconcileExternalTask(
    fromGoogle({ attendees: ['koralzakai1@gmail.com'] } as any),
    ['date', 'fixedTime', 'durationMinutes', 'text', 'attendees'],
  );
  check('an identical attendee list is NOT a change',
    r.outcome === 'unchanged', `${r.outcome} (${r.changed.join(',')})`);

  r = await TaskStorage.reconcileExternalTask(
    fromGoogle({ attendees: ['koralzakai1@gmail.com', 'marika@ceva-dsp.com'] } as any),
    ['attendees'],
  );
  check('a genuinely different attendee list IS a change',
    r.outcome === 'updated' && r.changed.includes('attendees'), r.outcome);

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} checks passed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
