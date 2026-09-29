/**
 * TaskStorage — the source of truth for tasks, settings, logs, stats and
 * schedules: AsyncStorage first, mirrored best-effort to Supabase when a
 * user is signed in.
 *
 * Dependencies: AsyncStorage, supabaseClient (isSupabaseConfigured),
 * SupabaseAuthService (getUserId), supabaseRepo (cloud CRUD).
 * Nearly every screen and service depends on this module — extend it
 * additively; do not change existing function signatures.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppSettings, DailyLog, Task } from '../types/models';
import { UserProfile, UserStats, DailySchedule, RewardEvent, Goal } from '../types/index';
import { isSupabaseConfigured } from './supabaseClient';
import { getUserId } from './SupabaseAuthService';
import * as repo from './supabaseRepo';
import { textSimilarity } from '../utils/fuzzyMatch';
import { addMinutes } from '../utils/timeUtils';
import { isStandingTask } from '../utils/taskShape';

// Storage model (Step 3): AsyncStorage is an offline/read cache; Supabase is the
// source of truth when a session exists. Every public function below keeps its
// original signature. When signed out or Supabase isn't configured, behavior is
// identical to the old AsyncStorage-only implementation.
//
// Reads: cloud-first (and refresh the cache); fall back to cache on any error.
// Writes: update the cache immediately (instant UI / offline), then push to the
// cloud. A failed cloud write is logged and left in the cache for this session;
// there is no retry queue yet (a future enhancement).

const TASKS_KEY = 'lumi.tasks.v1';
const LOGS_KEY = 'lumi.logs.v1';
const SETTINGS_KEY = 'lumi.settings.v1';
/** Set once the one-off undo of the old auto-rollover has run. */
const ROLLOVER_REPAIRED_KEY = 'lumi.rolloverRepaired.v1';

/** Fallback AppSettings used until the user saves their own. */
export const DEFAULT_SETTINGS: AppSettings = {
  morningTime: { hour: 7, minute: 30 },
  afternoonTime: { hour: 12, minute: 0 },
  eveningTime: { hour: 20, minute: 0 },
  androidMorningWindowStart: 6,
  androidMorningWindowEnd: 10,
  language: 'en',
  wakeAlarmEnabled: true,
};

/** Date -> YYYY-MM-DD key used across all storage maps. */
export function toDateKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function addDays(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T00:00:00`);
  d.setDate(d.getDate() + days);
  return toDateKey(d);
}

function randomId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function readJSON<T>(key: string, fallback: T): Promise<T> {
  const value = await AsyncStorage.getItem(key);
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

async function writeJSON<T>(key: string, value: T): Promise<void> {
  await AsyncStorage.setItem(key, JSON.stringify(value));
}

// ── Server task sync (Phase 1: app→server shared store) ──
// The app pushes every create/edit/delete to the phone-keyed server store
// (user_memory) so Lumi's nudges, agents and reminders see app-made tasks —
// the link that was missing. Fire-and-forget: never blocks the local write.
import { authedFetch } from './serverAuth';

const SERVER_URL = process.env.EXPO_PUBLIC_SERVER_URL || '';

async function serverPhone(): Promise<string> {
  const s = await getSettings();
  return String(s.whatsAppPhone || '').replace(/\D/g, '');
}

async function pushTaskToServer(task: Task): Promise<void> {
  const phone = await serverPhone();
  if (!SERVER_URL || !phone) return;
  try {
    await authedFetch(`${SERVER_URL}/tasks/${phone}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(task),
    });
  } catch (e) {
    console.warn('[TaskStorage] server push failed', e);
  }
}

async function deleteTaskOnServer(taskId: string): Promise<void> {
  const phone = await serverPhone();
  if (!SERVER_URL || !phone) return;
  try {
    await authedFetch(`${SERVER_URL}/tasks/${phone}/${taskId}`, { method: 'DELETE' });
  } catch (e) {
    console.warn('[TaskStorage] server delete failed', e);
  }
}

/**
 * Serializes every mutation of the task array.
 *
 * Every writer here was read-modify-write over the WHOLE array with no
 * locking: `updateTask` read via getAllTasks, mapped, and wrote everything
 * back. TodaySchedule fired five of these concurrently (calendar sync, travel
 * chain, travel-ahead, Gmail suggestions, goal suggestions), all
 * fire-and-forget, so whichever resolved last silently overwrote the others.
 *
 * That one race is why travel plans vanished after being computed, why the
 * same calendar event could be inserted twice (two merges both saw "not
 * present"), and why imported tasks went missing. Fixing it is the
 * precondition for everything else — no amount of better dedup survives a
 * lost write.
 *
 * A promise chain is the right size of tool: this is one JS thread racing
 * itself, not multiple processes.
 */
let _taskWriteQueue: Promise<unknown> = Promise.resolve();

export function withTaskLock<T>(fn: () => Promise<T>): Promise<T> {
  // Chain onto the tail, swallowing the predecessor's rejection so one failed
  // write cannot wedge the queue for the rest of the session.
  const run = _taskWriteQueue.then(fn, fn);
  _taskWriteQueue = run.catch(() => {});
  return run;
}

/** Returns the signed-in user id when cloud sync is active, else null. */
async function cloudUserId(): Promise<string | null> {
  if (!isSupabaseConfigured) {
    return null;
  }
  try {
    return await getUserId();
  } catch {
    return null;
  }
}

/** All tasks from AsyncStorage (cloud-hydrated when signed in). */
/** How "complete" a task is — used to keep the richest of a duplicate pair. */
function _taskRichness(t: Task): number {
  return (t.fixedTime ? 2 : 0) + (t.location ? 1 : 0) + (t.deadline ? 1 : 0);
}

/**
 * Collapse duplicate tasks — the "insane duplication" fix. Two rows are the same
 * task when they share an id, or the same (normalized text + date) while still
 * active. Keeps the richest of each group (has time/location) and reports the
 * losing ids so the caller can delete them from the cloud/server stores too.
 * Completion wins over richness when merging — that row holds the outcome.
 */
export function dedupeTasks(tasks: Task[]): { kept: Task[]; removedIds: string[] } {
  const norm = (s: string) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const byId = new Map<string, Task>();
  for (const t of tasks) if (!byId.has(t.id)) byId.set(t.id, t); // drop exact-id repeats
  const kept: Task[] = [];
  const removedIds: string[] = [];
  const seen = new Map<string, number>(); // key -> index in kept
  for (const t of byId.values()) {
    const key = `${norm(t.text)}|${t.date}`;
    const at = seen.get(key);
    if (at === undefined) { seen.set(key, kept.length); kept.push(t); continue; }
    const prev = kept[at];
    // Completed tasks used to skip this loop entirely, so duplicates among
    // finished tasks were never cleaned and piled up in the Done list forever.
    // They are merged now, and completion always wins: it is the row that
    // carries the outcome (completedAt, actualDurationMinutes), so keeping the
    // pending twin instead would look like the task was never done.
    // Two rows with DIFFERENT statuses are not a duplicate — they are a
    // question, and this function is not entitled to answer it.
    //
    // Merging them silently is what put a ✓ on work that was never done: this
    // runs inside saveAllTasks, which every Today load calls, so a completed
    // twin absorbed the open row and the result was written to local storage
    // AND pushed to the cloud. Permanently, and with no action from her.
    //
    // Same-status rows still collapse — two finished copies of one thing are
    // clutter, two pending copies are clutter. Across statuses they both stay,
    // and the SameThing card asks which she meant. A visible duplicate is a
    // small annoyance; a task marked done that is not done is the app lying
    // about her workload.
    if ((prev.status === 'complete') !== (t.status === 'complete')) {
      seen.set(`${key}|${t.status}`, kept.length);
      kept.push(t);
      continue;
    }
    const winner = _taskRichness(t) > _taskRichness(prev) ? t : prev;
    if (winner === t) { removedIds.push(prev.id); kept[at] = t; }
    else { removedIds.push(t.id); }
  }
  return { kept, removedIds };
}

/**
 * First cloud read after working signed-out: adopt the local data instead of
 * being erased by it.
 *
 * Every list loader here used to do `cloud = fetch(); writeJSON(cloud)`. That is
 * silent data loss the very first time a user signs in after using the app
 * offline: the account has no rows yet, so the empty cloud list is written
 * straight over everything on the device. It is exactly the wrong way round —
 * an empty account and a full device means the device is the source of truth.
 *
 * Only fires in that one unambiguous direction (cloud empty AND local not), so
 * a genuine "I deleted everything on my other phone" still propagates.
 */
async function adoptLocalIfCloudEmpty<T>(
  cloud: T[],
  local: T[],
  push: (rows: T[]) => Promise<void>,
  label: string,
): Promise<T[]> {
  if (cloud.length || !local.length) return cloud;
  console.log(`[TaskStorage] cloud ${label} empty, adopting ${local.length} local row(s)`);
  try {
    await push(local);
  } catch (err) {
    // Even if the push fails, returning `local` is what protects the data —
    // the next save will retry the mirror.
    console.warn(`[TaskStorage] adopting local ${label} failed`, err);
  }
  return local;
}


/**
 * Tasks whose LOCAL copy is ahead of the cloud, because the push failed.
 *
 * getAllTasks is cloud-first: when signed in it takes the server's rows and
 * uses them. That is right when the two agree, and silently destructive when
 * they do not. A push that throws — a constraint the row violates, an RLS
 * refusal, a dropped connection — was caught, logged to a console nobody
 * reads, and forgotten; the next read then handed back the STALE cloud row and
 * overwrote the correct local one.
 *
 * Seen live: unticking a completed task put it back to pending locally, the
 * push was rejected by tasks_priority_check, and the next render showed it
 * ticked again. From the outside the app simply refused to be corrected.
 *
 * So a failed push records the id, and reads prefer the local copy for those
 * ids until a push finally lands. Local-ahead is a fact worth keeping, not a
 * warning worth dropping.
 */
const CLOUD_BEHIND_KEY = 'lumi.cloudBehind.v1';

async function readCloudBehind(): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(CLOUD_BEHIND_KEY);
    return new Set<string>(raw ? JSON.parse(raw) : []);
  } catch { return new Set(); }
}

async function markCloudBehind(taskId: string): Promise<void> {
  try {
    const ids = await readCloudBehind();
    ids.add(taskId);
    // Bounded: this is a repair hint, not a queue. The newest failures matter.
    await AsyncStorage.setItem(CLOUD_BEHIND_KEY, JSON.stringify([...ids].slice(-200)));
  } catch { /* a hint we could not store is not worth failing a write over */ }
}

async function clearCloudBehind(taskId: string): Promise<void> {
  try {
    const ids = await readCloudBehind();
    if (!ids.delete(taskId)) return;
    await AsyncStorage.setItem(CLOUD_BEHIND_KEY, JSON.stringify([...ids]));
  } catch { /* ignore */ }
}

/**
 * Re-push everything the server never received.
 *
 * The local-ahead flag keeps the phone correct when a write cannot reach
 * Supabase — but nothing ever went back for those rows, so the server stayed
 * behind until some unrelated write happened to succeed. On the device the
 * failure is usually not a rejection at all:
 *
 *   UnknownHostException: Unable to resolve host "…supabase.co"
 *
 * i.e. she was on a train. The row is fine, the network was not, and the fix
 * is to try again later rather than to make her wait at the moment she taps.
 *
 * Runs on app start and whenever the app returns to the foreground. Silent by
 * design: a retry that works needs no announcement, and one that fails leaves
 * the flag exactly where it was for the next attempt.
 */
export async function flushPendingCloudWrites(): Promise<number> {
  const userId = await cloudUserId();
  if (!userId) return 0;
  const behind = await readCloudBehind();
  if (!behind.size) return 0;

  const local = await readJSON<Task[]>(TASKS_KEY, []);
  const byId = new Map(local.map((t) => [t.id, t]));
  let flushed = 0;

  for (const id of behind) {
    const task = byId.get(id);
    // Gone locally: nothing left to send, so stop carrying the flag.
    if (!task) { await clearCloudBehind(id); continue; }
    try {
      await repo.upsertTask(userId, task);
      await clearCloudBehind(id);
      flushed += 1;
    } catch {
      // Still unreachable. Keep the flag; local stays authoritative.
      break;   // one failure means the network is down — do not hammer it
    }
  }
  if (flushed) console.log('[TaskStorage] flushed pending cloud writes', { flushed });
  return flushed;
}

export async function getAllTasks(): Promise<Task[]> {
  let raw: Task[];
  const userId = await cloudUserId();
  if (userId) {
    const local = await readJSON<Task[]>(TASKS_KEY, []);
    try {
      const cloud = await repo.fetchTasks(userId);
      const merged = await adoptLocalIfCloudEmpty(
        cloud, local, (rows) => repo.syncAllTasks(userId, rows), 'tasks');
      // Anything whose push failed is newer HERE than there. Take the local
      // copy back, or the cloud's stale row silently undoes the user's edit.
      const behind = await readCloudBehind();
      const withFlag = behind.size
        ? merged.map((t) => (behind.has(t.id) ? local.find((l) => l.id === t.id) ?? t : t))
        : merged;
      // And the same protection WITHOUT the flag.
      //
      // The flag only survives while we believe the push failed, and a push
      // can be accepted-and-not-applied — RLS refusing a row owned by another
      // account returns no error at all. upsertTolerant now catches that, but
      // an edit made before this fix is already sitting on a phone whose flag
      // was cleared, and a server that writes the row itself (WhatsApp) can
      // re-assert 'complete' at any time.
      //
      // So the correction carries its own evidence. `uncompletedAt` is stamped
      // the moment she unticks something; if the cloud comes back claiming the
      // task is complete and her correction is NEWER than the completion it
      // claims, her correction wins and the row goes back on the retry queue.
      // A tick she removed must never reappear on its own — that is the app
      // telling her she did work she did not do.
      raw = withFlag.map((t) => {
        if (t.status !== 'complete') return t;
        const mine = local.find((l) => l.id === t.id);
        const corrected = mine?.uncompletedAt;
        if (!corrected || mine!.status === 'complete') return t;
        if (t.completedAt && t.completedAt > corrected) return t;   // genuinely re-done since
        // Worth a line in the log: it means some other writer still believes
        // this task is done, and the phone is overruling it.
        console.log('[TaskStorage] held a correction against the cloud', {
          id: t.id,
          text: t.text.slice(0, 40),
          cloudStatus: t.status,
          cloudCompletedAt: t.completedAt,
          cloudUncompletedAt: (t as any).uncompletedAt,
          localStatus: mine!.status,
          localUncompletedAt: corrected,
          source: t.source,
        });
        void markCloudBehind(t.id);
        return mine!;
      });
    } catch (err) {
      console.warn('[TaskStorage] cloud fetchTasks failed; using cache', err);
      raw = local;
    }
  } else {
    raw = await readJSON<Task[]>(TASKS_KEY, []);
  }
  // De-duplicated for the caller, but NOT written back. This used to end with
  // `writeJSON(TASKS_KEY, kept)`, which made every READ a write — and since
  // every mutator starts by calling this, two concurrent mutators would both
  // read, both write, and the second would erase the first. Healing the stored
  // list is now an explicit, locked, once-per-launch job: healTaskStore().
  const { kept } = dedupeTasks(raw);
  return kept;
}

/**
 * Rewrite the stored task list in its healed form — deduped, once, at launch.
 *
 * This is the write that used to happen on every read. Doing it here, inside
 * the lock and exactly once, keeps the benefit (duplicates never reach the UI
 * and the cache stays tidy) without turning reads into a source of lost writes.
 */
export async function healTaskStore(): Promise<number> {
  return withTaskLock(async () => {
    const raw = await readJSON<Task[]>(TASKS_KEY, []);
    const { kept, removedIds } = dedupeTasks(raw);
    if (removedIds.length) await writeJSON(TASKS_KEY, kept);
    return removedIds.length;
  });
}

/**
 * Permanently delete duplicate task rows from the cloud + server stores.
 *
 * It reads the CLOUD to decide what to delete, which is correct — those are
 * the rows being removed. What it must NOT do is write that cloud list back
 * over local storage, and it used to: `writeJSON(TASKS_KEY, kept)` on a list
 * fetched from Supabase. Running once on every app load, on a store with any
 * duplicate at all, that quietly replaced every local task with the server's
 * version of it.
 *
 * That is the second half of "I untick a task and it comes back". The first
 * was a rejected push leaving the cloud stale; this overwrote the local copy
 * with that stale row on the next launch, no rejection required. An edit made
 * offline, or in the seconds before a sync, died the same way.
 *
 * Local de-duplication is healTaskStore's job — it dedupes the LOCAL list and
 * writes only that. This function now touches nothing on disk.
 */
export async function purgeDuplicateTasks(): Promise<number> {
  const userId = await cloudUserId();
  let raw: Task[];
  try {
    raw = userId ? await repo.fetchTasks(userId) : await readJSON<Task[]>(TASKS_KEY, []);
  } catch {
    return 0;
  }
  const { removedIds } = dedupeTasks(raw);
  if (!removedIds.length) return 0;
  for (const id of removedIds) {
    if (userId) { try { await repo.deleteTaskRow(userId, id); } catch { /* best effort */ } }
    void deleteTaskOnServer(id);
  }
  // Whatever duplicates the LOCAL list has are healed here, from the local
  // list — never from the cloud's copy of it.
  await healTaskStore().catch(() => 0);
  console.log('[TaskStorage] purged duplicate tasks', { removed: removedIds.length });
  return removedIds.length;
}

/** Overwrite the full task list locally and mirror to Supabase best-effort. */
async function saveAllTasksUnlocked(tasks: Task[]): Promise<void> {
  const { kept } = dedupeTasks(tasks);
  await writeJSON(TASKS_KEY, kept);
  const userId = await cloudUserId();
  if (userId) {
    try {
      await repo.syncAllTasks(userId, kept);
    } catch (err) {
      console.warn('[TaskStorage] cloud syncAllTasks failed', err);
    }
  }
}

/**
 * Overwrite the full task list.
 *
 * Locked. The lock is NOT reentrant, so anything already holding it must call
 * saveAllTasksUnlocked instead — calling this from inside withTaskLock would
 * deadlock the queue for the rest of the session.
 */
export async function saveAllTasks(tasks: Task[]): Promise<void> {
  return withTaskLock(() => saveAllTasksUnlocked(tasks));
}

// Ids of external tasks the user deleted in-app. The server doesn't know about
// local deletions, so without this list every pull would resurrect them.
const DISMISSED_KEY = 'lumi.dismissedExternal.v1';

async function getDismissedIds(): Promise<string[]> {
  return readJSON<string[]>(DISMISSED_KEY, []);
}

/**
 * The tombstones, readable from outside.
 *
 * This list can block an import FOREVER and says nothing while it does it:
 * `mergeExternalTasks` skips a tombstoned id with a bare `continue`, so a
 * calendar event that is on Google, fetched successfully, and correctly
 * mapped still never becomes a task — and every diagnostic reports a healthy
 * connection, because the connection IS healthy. Exposed so the Profile check
 * can count how many of the events Google just returned are being dropped
 * here, instead of that being invisible state. (CLAUDE.md, rule 1.)
 */
export async function getDismissedExternalIds(): Promise<string[]> {
  return getDismissedIds();
}

/**
 * Forget tombstones, so the next sync may import them again.
 *
 * Pass ids to lift specific ones; pass nothing to lift every tombstone whose
 * id came from Google Calendar. Deliberately narrow by default: the WhatsApp
 * tombstones are still doing their job, and clearing those would resurrect
 * tasks she deleted on purpose.
 */
export async function clearDismissedExternalIds(ids?: string[]): Promise<number> {
  const current = await getDismissedIds();
  const drop = new Set(ids ?? current.filter((id) => /^(gcal|dcal|ocal)-/.test(id)));
  if (!drop.size) return 0;
  const kept = current.filter((id) => !drop.has(id));
  await writeJSON(DISMISSED_KEY, kept);
  return current.length - kept.length;
}

/**
 * Same value? `===` is not enough here.
 *
 * `attendees` is an array and `location` is an object, so a reference compare
 * says "different" every time even when the contents are identical. Seen in
 * the wild immediately: every 15-minute sync logged
 * `corrected "…interview with Ceva": attendees`, wrote the row and pushed it
 * to the cloud, forever, over nothing. A reconcile that never converges is not
 * a reconcile, it is a loop.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

/** What `reconcileExternalTask` did with one incoming row. */
export type ReconcileOutcome =
  | 'inserted'    // it was not here; it is now
  | 'updated'     // it was here and wrong; the named fields were corrected
  | 'unchanged'   // it was here and already right
  | 'blocked'     // tombstoned: she deleted it in-app, so we do not resurrect it
  | 'complete';   // she has already done it; Google does not get to reopen it

/**
 * Make the stored row match an external one, by id, whatever else is true.
 *
 * `mergeExternalTasks` is an ADD. Its first line is `if (ids.has(t.id)) continue`
 * — an id it already holds means "nothing to do", and it returns without
 * looking at the row. That is correct for an add and catastrophic as the only
 * path, because it means an existing row is never compared against the thing
 * it was imported FROM. A calendar row sitting on the wrong date, or one that
 * lost its `source` stamp, is unreachable: the merge skips it (the id is
 * known) and `refreshImportedTasks` skips it too (it only touches rows still
 * marked `source: 'calendar'`). Both halves decline, nothing reports it, and
 * the event is invisible forever.
 *
 * That is what happened to the Ceva interview: Google returned it, the app
 * found it — "1 event(s) found" — and imported 0, on every sync, silently.
 *
 * This is the path that cannot be dodged. It writes the fields the external
 * source OWNS (`owned`), including `date`, which nothing else has ever
 * corrected, and it re-stamps provenance so the row is recognisable next time.
 *
 * Two things it will NOT do, both deliberate:
 *   - resurrect a tombstoned row. She deleted it on purpose; that decision
 *     outranks Google. Returns 'blocked' so a diagnostic can SAY so.
 *   - reopen a completed task. Done is done.
 */
export async function reconcileExternalTask(
  incoming: Task,
  owned: Array<keyof Task | string> = [
    'date', 'fixedTime', 'scheduledTime', 'durationMinutes', 'text',
  ],
  /**
   * Fields the external source may also EMPTY.
   *
   * `owned` skips an incoming undefined, so a value that Google has since
   * removed could never be taken off the row. That is not a hypothetical: the
   * interview was stuck as category 'zoom' carrying a meetingUrl scraped from
   * a Google MAPS link, and every sync left both in place — a task you travel
   * to, that the app was certain you could attend from your sofa.
   */
  clearable: Array<keyof Task | string> = [],
): Promise<{ outcome: ReconcileOutcome; changed: string[]; before?: Task }> {
  const dismissed = new Set(await getDismissedIds());
  if (dismissed.has(incoming.id)) return { outcome: 'blocked', changed: [] };

  const result = await withTaskLock(async () => {
    const tasks = await readJSON<Task[]>(TASKS_KEY, []);
    // By id first. Failing that, by the event id the row was imported from —
    // a row that was re-keyed at some point still knows where it came from.
    const idx = tasks.findIndex(
      (t) => t.id === incoming.id
        || (incoming.calendarEventId && t.calendarEventId === incoming.calendarEventId),
    );

    if (idx === -1) {
      // Straight in, id intact. NOT via addTask, which mints a fresh id and
      // would break the idempotence the next sync depends on.
      const { kept } = dedupeTasks([...tasks, incoming]);
      await writeJSON(TASKS_KEY, kept);
      await markCloudBehind(incoming.id);
      return { outcome: 'inserted' as ReconcileOutcome, changed: ['*'], row: incoming };
    }

    const current = tasks[idx];
    if (current.status === 'complete') {
      return { outcome: 'complete' as ReconcileOutcome, changed: [], row: current };
    }

    const changed: string[] = [];
    const next: Task = { ...current };
    for (const key of owned) {
      const k = key as keyof Task;
      const value = (incoming as any)[k];
      if (value === undefined || value === null || value === '') continue;
      if (sameValue((current as any)[k], value)) continue;
      (next as any)[k] = value;
      changed.push(String(k));
    }
    for (const key of clearable) {
      const k = key as keyof Task;
      const value = (incoming as any)[k];
      const blank = value === undefined || value === null || value === '';
      const currentBlank = (current as any)[k] === undefined
        || (current as any)[k] === null || (current as any)[k] === '';
      if (!blank || currentBlank) continue;   // 'owned' above handles the set case
      (next as any)[k] = undefined;
      changed.push(String(k));
    }
    // Provenance, always. A row that lost its stamp is how it became
    // unreachable in the first place.
    if ((current as any).source !== 'calendar' && (incoming as any).source === 'calendar') {
      (next as any).source = 'calendar';
      changed.push('source');
    }
    if (incoming.calendarEventId && current.calendarEventId !== incoming.calendarEventId) {
      next.calendarEventId = incoming.calendarEventId;
      changed.push('calendarEventId');
    }
    if (!changed.length) {
      return { outcome: 'unchanged' as ReconcileOutcome, changed: [], row: current };
    }
    tasks[idx] = next;
    await writeJSON(TASKS_KEY, tasks);
    await markCloudBehind(next.id);
    return { outcome: 'updated' as ReconcileOutcome, changed, row: next, before: current };
  });

  const userId = await cloudUserId();
  if (userId && (result.outcome === 'inserted' || result.outcome === 'updated')) {
    try {
      await repo.upsertTask(userId, result.row as Task);
      await clearCloudBehind((result.row as Task).id);
    } catch (err) {
      // Local is saved and flagged local-ahead; the cloud can catch up.
      console.warn('[TaskStorage] cloud upsert of a reconciled row failed', err);
    }
  }
  return {
    outcome: result.outcome,
    changed: result.changed,
    before: (result as any).before,
  };
}

async function addDismissedId(id: string): Promise<void> {
  const ids = await getDismissedIds();
  if (!ids.includes(id)) {
    await writeJSON(DISMISSED_KEY, [...ids, id].slice(-300));
  }
}

/**
 * Add tasks that came from outside the app (e.g. pulled from the WhatsApp
 * server) without disturbing existing ones. Dedups by id, skips ids the user
 * deleted in-app (tombstones), and adopts server UUIDs onto local rows that
 * still carry a legacy "wa_" hash id with the same text+date (the one-time
 * client half of the wa_→UUID migration). Non-destructive: never deletes
 * local tasks. Returns how many rows changed (added or re-keyed).
 */
export async function mergeExternalTasks(
  incoming: Task[],
  opts: MergeOptions = {},
): Promise<number> {
  if (!incoming.length) return 0;
  return withTaskLock(() => mergeExternalTasksUnlocked(incoming, opts));
}

export interface MergeOptions {
  /**
   * Allow an incoming task to be absorbed into an existing one that merely
   * READS like it (textSimilarity >= 0.7).
   *
   * Default true, and wrong for anything whose id is derived rather than
   * minted. Interview prep blocks are keyed `prep-<n>d-<interview id>`
   * precisely so that running the rule every fifteen minutes produces the same
   * blocks and never a third — and the fuzzy branch defeats that completely:
   * "Final review for Ceva" is 0.7-similar to "Prepare for: … interview with
   * Ceva", so the block was folded into that row, its id was never stored, and
   * the next sync found it missing and made it again. Forever, four a sync,
   * each pass overwriting the other task's text with whichever was longer —
   * which is how "Final review for להתכונן לראיון…" got its title.
   */
  fuzzyMerge?: boolean;
}

/** The body of mergeExternalTasks. Assumes the caller holds the task lock. */
async function mergeExternalTasksUnlocked(
  incoming: Task[],
  opts: MergeOptions = {},
): Promise<number> {
  const existing = await readJSON<Task[]>(TASKS_KEY, []);
  const dismissed = new Set(await getDismissedIds());
  const ids = new Set(existing.map((t) => t.id));
  const toAdd: Task[] = [];
  const rekeyedOldIds: string[] = [];
  const enriched: Task[] = [];
  let changed = 0;
  let blocked = 0;
  let absorbed = 0;
  for (const t of incoming) {
    if (ids.has(t.id)) continue;
    if (dismissed.has(t.id)) {
      // Rule 2: the skip may be silent to the merge, never to the log. This
      // one line is the difference between "Google has nothing" and "we are
      // refusing to import something Google handed us", which were the same
      // observable state for as long as this tombstone list has existed.
      console.warn('[TaskStorage] import blocked by tombstone', t.id, t.date, t.text);
      blocked += 1;
      continue;
    }
    const legacyTwin = existing.find(
      (e) => e.id.startsWith('wa_') && e.text === t.text && e.date === t.date,
    );
    if (legacyTwin) {
      rekeyedOldIds.push(legacyTwin.id);
      legacyTwin.id = t.id; // keep the user's local fields, adopt the shared UUID
      changed += 1;
      continue;
    }
    // Same task worded differently ("interview tomorrow in Ramat Gan" vs
    // "interview tomorrow, Ramat Gan, 11:30") → enrich the existing task with
    // the new details instead of adding a duplicate.
    const similar = opts.fuzzyMerge === false ? undefined : existing.find(
      (e) => e.date === t.date && e.status !== 'complete' && textSimilarity(e.text, t.text) >= 0.7,
    );
    if (similar) {
      // Rule 1 and rule 3: absorbing is not adding, and the count this
      // function returns is read as "how many landed". It was counting these,
      // so `created 4 interview prep block(s)` was printed every sync for four
      // blocks that were never stored — a creation reported, a store
      // unchanged, and nothing anywhere able to tell the two apart.
      console.warn(
        `[TaskStorage] "${t.text.slice(0, 40)}" (${t.id}) was absorbed into`
        + ` "${similar.text.slice(0, 40)}" (${similar.id}) — its id is NOT in the store`,
      );
      if (t.text.length > similar.text.length) similar.text = t.text; // more detailed wins
      if (t.fixedTime && !similar.fixedTime) {
        similar.fixedTime = t.fixedTime;
        similar.scheduledTime = t.fixedTime;
        similar.isFixed = true;
      }
      if (t.location && !similar.location) similar.location = t.location;
      if (t.durationMinutes && (!similar.durationMinutes || similar.durationMinutes === 30)) {
        similar.durationMinutes = t.durationMinutes;
      }
      enriched.push(similar);
      absorbed += 1;
      changed += 1;
      continue;
    }
    toAdd.push(t);
    ids.add(t.id);
    changed += 1;
  }
  if (blocked) {
    console.warn(
      `[TaskStorage] ${blocked} external task(s) were dropped by the tombstone list. `
      + 'Profile → Calendar check reports this; clearDismissedExternalIds() lifts it.',
    );
  }
  if (!changed) return 0;
  if (absorbed) {
    console.warn(
      `[TaskStorage] ${absorbed} incoming task(s) were absorbed into similar rows. `
      + 'A caller that keys on id will ask for them again next time.',
    );
  }
  const { kept } = dedupeTasks([...existing, ...toAdd]);
  const keptIds = new Set(kept.map((task) => task.id));
  await writeJSON(TASKS_KEY, kept);
  const userId = await cloudUserId();
  if (userId) {
    try {
      const rekeyed = existing.filter((e) => incoming.some((t) => t.id === e.id));
      await repo.upsertTasks(userId, kept.filter((task) =>
        toAdd.some((incomingTask) => incomingTask.id === task.id)
        || rekeyed.some((incomingTask) => incomingTask.id === task.id)
        || enriched.some((incomingTask) => incomingTask.id === task.id),
      ));
      for (const oldId of rekeyedOldIds) {
        await repo.deleteTaskRow(userId, oldId).catch(() => {});
      }
    } catch (err) {
      console.warn('[TaskStorage] cloud upsert of external tasks failed', err);
    }
  }
  return changed;
}

/** Tasks whose date equals the YYYY-MM-DD key. */
export async function getTasksForDate(date: string): Promise<Task[]> {
  const tasks = await getAllTasks();
  return tasks.filter((task) => task.date === date && task.status !== 'moved');
}

/** Remove old occurrences of tasks that were repeated across multiple dates. */
export async function removePastRecurringInstances(today = toDateKey()): Promise<number> {
  const tasks = await getAllTasks();
  const groups = new Map<string, Task[]>();
  for (const task of tasks) {
    const key = task.text.trim().toLowerCase().replace(/\s+/g, ' ');
    const group = groups.get(key) ?? [];
    group.push(task);
    groups.set(key, group);
  }

  const recurringKeys = new Set(
    Array.from(groups.entries())
      .filter(([, group]) => group.some((task) => (task.repeatDays?.length ?? 0) > 0)
        || new Set(group.map((task) => task.date)).size > 1)
      .map(([key]) => key),
  );
  const removeIds = tasks
    .filter((task) => recurringKeys.has(task.text.trim().toLowerCase().replace(/\s+/g, ' '))
      && task.date < today)
    .map((task) => task.id);
  if (!removeIds.length) return 0;
  await deleteTasks(removeIds);
  return removeIds.length;
}

/** Pending tasks dated before today (rollover candidates). */
export async function getBacklogBeforeDate(today: string): Promise<Task[]> {
  const tasks = await getAllTasks();
  return tasks.filter((task) => task.date < today && task.status !== 'complete');
}

/**
 * Tasks whose relevance has passed — a dated event/deadline before today that
 * was never completed. Backs the "clean up old tasks?" suggestion + the bulk
 * delete. (Same rule as getBacklogBeforeDate; named for the cleanup intent.)
 */
export async function getExpiredTasks(today: string): Promise<Task[]> {
  return getBacklogBeforeDate(today);
}

/**
 * Delete many tasks at once (multi-select + expired cleanup). One read/write
 * instead of N; tombstones external-source ids so a later pull won't resurrect
 * them, and mirrors the delete to cloud + server per id. Returns how many were
 * removed.
 */
export async function deleteTasks(ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const idSet = new Set(ids);
  const removed = await withTaskLock(async () => {
    const tasks = await readJSON<Task[]>(TASKS_KEY, []);
    // Same reasoning as deleteTask: every id gets a tombstone, or the next
    // sync resurrects whatever the server still holds.
    for (const id of ids) {
      await addDismissedId(id);
    }
    const remaining = tasks.filter((t) => !idSet.has(t.id));
    await writeJSON(TASKS_KEY, remaining);
    return tasks.length - remaining.length;
  });

  const userId = await cloudUserId();
  for (const id of ids) {
    if (userId) {
      try { await repo.deleteTaskRow(userId, id); } catch (err) {
        console.warn('[TaskStorage] cloud deleteTasks failed', err);
      }
    }
    void deleteTaskOnServer(id);
  }
  return removed;
}

/** Create one task (id/createdAt filled in) and persist. */
export async function addTask(task: Omit<Task, 'id' | 'createdAt' | 'completedAt'>): Promise<Task> {
  const created: Task = {
    ...task,
    id: randomId(),
    createdAt: Date.now(),
    completedAt: null,
  };
  // Read, dedupe and write as one hold — otherwise two adds racing each other
  // both read the pre-insert list and the second erases the first.
  const saved = await withTaskLock(async () => {
    const tasks = await readJSON<Task[]>(TASKS_KEY, []);
    const { kept } = dedupeTasks([...tasks, created]);
    await writeJSON(TASKS_KEY, kept);
    return kept.find((t) => t.id === created.id)
      ?? kept.find((t) => t.date === created.date
        && t.text.trim().toLowerCase() === created.text.trim().toLowerCase())
      ?? created;
  });

  const userId = await cloudUserId();
  if (userId && saved.id === created.id) {
    try {
      await repo.upsertTask(userId, created);
    } catch (err) {
      console.warn('[TaskStorage] cloud upsertTask failed', err);
    }
  }
  if (saved.id === created.id) void pushTaskToServer(created);  // app→server shared store
  return saved;
}

/** Bulk-create tasks for a date, applying category default durations. */
export async function addTasksForDate(
  date: string,
  entries: Array<{
    text: string;
    tags: string[];
    priority?: Task['priority'];
    category?: Task['category'];
    subgroup?: Task['subgroup'];
    hasLocation?: Task['hasLocation'];
    location?: Task['location'];
    locationLat?: Task['locationLat'];
    locationLng?: Task['locationLng'];
    hasDeadline?: Task['hasDeadline'];
    deadline?: string | null;
    how?: string | null;
    why?: string | null;
    contactName?: string | null;
    contactPhone?: string | null;
    fixedTime?: string | null;
    durationMinutes?: number;
  }>,
  /**
   * Where these tasks came from. Every task through this funnel used to be
   * stamped 'voice' — chat, manual entry and imports included — so `source`
   * described the code path rather than the origin, and a task created over
   * WhatsApp was indistinguishable from one she spoke into the app.
   *
   * Optional and last so existing callers keep working; each is being moved
   * onto its real origin rather than all of them changing at once.
   */
  origin: NonNullable<Task['source']> = 'voice',
): Promise<Task[]> {
  console.log('[TASK_SPLITTER] preparing to write parsed tasks to store:', { date, entries });
  const existing = await getAllTasks();
  const now = Date.now();

  // Default durations by category
  const DEFAULT_DURATIONS: Record<string, number> = {
    interview: 90, course: 60, conference: 120, class: 90, work: 60,
    meeting: 45, call: 15, doctor: 60, gym: 60, aspiration: 30,
    leisure: 60, general: 30, zoom: 45, hobby_class: 90,
  };

  const tasks: Task[] = entries.map((entry, index) => {
    const category = entry.category || 'general';
    const hasFixedTime = !!entry.fixedTime;
    const durationMinutes = entry.durationMinutes || DEFAULT_DURATIONS[category] || 30;

    return {
      id: `${now}-${index}-${Math.random().toString(36).slice(2, 8)}`,
      text: entry.text,
      tags: entry.tags,
      date,
      status: 'pending',
      createdAt: now,
      completedAt: null,
      source: origin,
      priority: entry.priority || 'need_to',
      category,
      subgroup: entry.subgroup,
      isFixed: hasFixedTime,
      fixedTime: entry.fixedTime ?? undefined,
      // Show fixed-time tasks at their time immediately (the card reads
      // scheduledTime); the optimizer can reassign flexible tasks later.
      scheduledTime: entry.fixedTime ?? undefined,
      durationMinutes,
      hasLocation: entry.hasLocation,
      location: entry.location ?? undefined,
      locationLat: entry.locationLat,
      locationLng: entry.locationLng,
      hasDeadline: entry.hasDeadline,
      dueDate: entry.deadline ?? undefined,
      historicalDurations: [],
      ...(entry.how ? { how: entry.how } : {}),
      ...(entry.why ? { why: entry.why } : {}),
      ...(entry.contactName ? { contactName: entry.contactName } : {}),
      ...(entry.contactPhone ? { contactPhone: entry.contactPhone } : {}),
    };
  });

  const { kept } = dedupeTasks([...existing, ...tasks]);
  const keptIds = new Set(kept.map((task) => task.id));
  const savedTasks = tasks.filter((task) => keptIds.has(task.id));
  await withTaskLock(async () => { await writeJSON(TASKS_KEY, kept); });

  const userId = await cloudUserId();
  if (userId) {
    try {
      await repo.upsertTasks(userId, savedTasks);
    } catch (err) {
      console.warn('[TaskStorage] cloud upsertTasks failed', err);
    }
  }

  console.log('[TASK_SPLITTER] tasks written to data store:', {
    createdCount: savedTasks.length,
    createdTaskIds: savedTasks.map((task) => task.id),
  });
  return savedTasks;
}

/** Load-modify-save one task via an updater function. */
export async function updateTask(taskId: string, updater: (task: Task) => Task): Promise<void> {
  // The read and the write are one critical section. Previously they were not,
  // so a concurrent updateTask could read the array, be overtaken, and then
  // write its now-stale copy over the winner — the reason a computed
  // transitPlan could vanish moments after being saved.
  const updatedTask = await withTaskLock(async () => {
    const tasks = await readJSON<Task[]>(TASKS_KEY, []);
    let touched: Task | undefined;
    const updated = tasks.map((task) => {
      if (task.id === taskId) {
        touched = updater(task);
        return touched;
      }
      return task;
    });
    await writeJSON(TASKS_KEY, updated);
    // Mark it local-ahead HERE, inside the lock, the instant the local write
    // lands — not later, and not only when the push fails.
    //
    // This is the bug that survived four fixes. The flag used to be set in the
    // catch below, so between this line and the push returning there is a
    // window containing a whole network round-trip in which the task looks
    // perfectly clean. Any refresh in that window — on focus, on the timer,
    // after any other action — read cloud-first and handed back the row the
    // server still had. She unticks, the screen shows pending, a refresh lands
    // half a second later, and the tick is back. The write never failed; it
    // was simply overtaken.
    if (touched) await markCloudBehind(touched.id);
    return touched;
  });

  const userId = await cloudUserId();
  if (userId && updatedTask) {
    try {
      await repo.upsertTask(userId, updatedTask);
      // Cleared only once the server has actually accepted it, so the local
      // copy stays authoritative for the whole in-flight period.
      await clearCloudBehind(updatedTask.id);
    } catch (err) {
      // The edit IS saved locally; what failed is telling the server. The flag
      // is already set, so the next read still prefers the local copy.
      console.warn('[TaskStorage] cloud upsertTask (update) failed — keeping local copy', err);
    }
  }
  if (updatedTask) void pushTaskToServer(updatedTask);  // sync edit to server store
}

/** Remove a task locally and from Supabase. External (WhatsApp/Google) tasks
 * also leave a tombstone so the next server pull doesn't resurrect them. */
export async function deleteTask(taskId: string): Promise<void> {
  await withTaskLock(async () => {
    const tasks = await readJSON<Task[]>(TASKS_KEY, []);
    // Tombstone EVERY delete, whatever the source. It used to tombstone only
    // tasks from whatsapp/gcal/gmail/calendar, on the assumption that a
    // 'manual' task exists nowhere else — but manual tasks are mirrored to the
    // server too, so deleting one removed it here and the very next pull put it
    // straight back. The user deletes a task, watches it reappear, and stops
    // trusting the list. The tombstone is local, so it holds even when the
    // server delete below never lands (no phone linked, or offline).
    await addDismissedId(taskId);
    await writeJSON(TASKS_KEY, tasks.filter((task) => task.id !== taskId));
  });

  const userId = await cloudUserId();
  if (userId) {
    try {
      await repo.deleteTaskRow(userId, taskId);
    } catch (err) {
      console.warn('[TaskStorage] cloud deleteTask failed', err);
    }
  }
  void deleteTaskOnServer(taskId);  // soft-delete in the server store too
}

/**
 * How long the task actually took, derived from when it was completed.
 *
 * A weak proxy on purpose: it assumes the task was ticked off when it ended.
 * FocusNowScreen measures the real thing with a timer, so an existing
 * `actualDurationMinutes` always wins. Everything implausible is discarded
 * rather than averaged in — a 09:00 task ticked at 22:00 is someone tidying up
 * their day, not a thirteen-hour task, and letting that into the rolling
 * average would poison every future estimate for the category.
 */
function derivedDurationMinutes(task: Task, completedAt: number): number | undefined {
  if (typeof task.actualDurationMinutes === 'number') return task.actualDurationMinutes;
  const start = task.scheduledTime || task.fixedTime;
  if (!start || !task.date) return undefined;
  const startedAt = new Date(`${task.date}T${start}:00`).getTime();
  if (!Number.isFinite(startedAt)) return undefined;
  const minutes = Math.round((completedAt - startedAt) / 60000);
  if (minutes < 1) return undefined;             // ticked before it began
  const estimate = task.durationMinutes || 30;
  const ceiling = Math.min(8 * 60, Math.max(120, estimate * 3));
  return minutes > ceiling ? undefined : minutes;
}

/**
 * Feed one completion into the learning + reward engines.
 *
 * Dynamically imported: both services import this module, so a static import
 * would close a require cycle. Best-effort — a completion must persist even if
 * the learning side throws.
 */
async function recordLeadLearning(task: Task): Promise<void> {
  const leaveHomeBy = typeof task.location === 'object' ? task.location?.leaveHomeBy : undefined;
  if (!leaveHomeBy || typeof task.lastDepartureDetectedAt !== 'number') return;
  try {
    const [{ loadProfile, saveProfile }, { normalizeProfile }, { resolveLeadMinutes, DAY }, { learnLead }] =
      await Promise.all([
        import('./UserProfileStorage'),
        import('../utils/profileShape'),
        import('../utils/leadTime'),
        import('../utils/leadLearning'),
      ]);
    const stored = await loadProfile();
    const profile = normalizeProfile(stored);
    if (!stored || !profile) return;
    // The category's OWN default — resolved with no learned table on purpose.
    // Anchoring to the value we are currently learning would move the target
    // every time it is approached, and the lead would climb without end.
    // Same fallback resolveLeadMinutes itself uses for an uncategorized task.
    const category = task.category ?? 'general';
    const baseLead = resolveLeadMinutes({ category }, {}).filter((n) => n < DAY)[0];
    if (baseLead === undefined) return;
    const learned = learnLead(profile.learnedLeadMinutes, {
      category,
      baseLead,
      date: task.date,
      leaveHomeBy,
      departedAt: task.lastDepartureDetectedAt,
    });
    if (!learned) return;
    await saveProfile({ ...(stored as any), learnedLeadMinutes: learned });
  } catch (err) {
    console.warn('[TaskStorage] lead learning failed', err);
  }
}

async function recordCompletionLearning(task: Task): Promise<void> {
  try {
    const language = await getSettings().then((s) => s.language).catch(() => 'en' as const);
    if (typeof task.actualDurationMinutes === 'number') {
      const { LearningService } = await import('./LearningService');
      await LearningService.recordTaskCompletion(task, task.actualDurationMinutes);
      await LearningService.recordWeeklyStats(task, task.actualDurationMinutes);
    }
    const { RewardService } = await import('./RewardService');
    let stats = await loadStats();
    ({ stats } = await RewardService.awardPoints('task_complete', stats, language));
    // On-time is only meaningful for something that had a time to be on time
    // for; without this, totalTasksOnTime stays 0 forever and Analytics shows
    // a permanent 0% that means "no data", not "never on time".
    const due = task.fixedTime || task.scheduledTime;
    if (due && task.date && task.completedAt) {
      const deadline = new Date(`${task.date}T${due}:00`).getTime()
        + (task.durationMinutes || 30) * 60000;
      if (Number.isFinite(deadline) && task.completedAt <= deadline) {
        await RewardService.awardPoints('on_time', stats, language);
      }
    }
  } catch (err) {
    console.warn('[TaskStorage] completion learning failed', err);
  }
  await recordLeadLearning(task);
}

/** Toggle completion (sets completedAt) and persist. */
export async function markTaskComplete(taskId: string, complete: boolean): Promise<void> {
  // The single funnel every completion path goes through (TodaySchedule,
  // MyTasks, FocusNow, DayReview, useTasks) — so it is the one place the
  // duration learning and the reward engine need to be wired.
  let completed: Task | undefined;
  await updateTask(taskId, (task) => {
    const completedAt = complete ? Date.now() : null;
    const next = {
      ...task,
      status: complete ? 'complete' : 'pending',
      completedAt,
      // Stamp the correction so a completed duplicate cannot outvote it.
      uncompletedAt: complete ? task.uncompletedAt ?? null : Date.now(),
    } as Task;
    if (complete && completedAt) {
      const actual = derivedDurationMinutes(task, completedAt);
      if (actual !== undefined) {
        next.actualDurationMinutes = actual;
        next.historicalDurations = [...(task.historicalDurations ?? []), actual].slice(-10);
      }
      completed = next;
    }
    return next;
  });
  if (completed) void recordCompletionLearning(completed);
}

/** Update a task's text + tags. */
export async function editTaskText(taskId: string, text: string, tags: string[]): Promise<void> {
  await updateTask(taskId, (task) => ({
    ...task,
    text,
    tags,
  }));
}

/** Shallow-merge a partial patch into a task (e.g. location/transit plan). */
export async function updateTaskFields(taskId: string, patch: Partial<Task>): Promise<void> {
  await updateTask(taskId, (task) => ({
    ...task,
    ...patch,
  }));
}

/** All daily check-in logs. */
export async function getDailyLogs(): Promise<DailyLog[]> {
  const userId = await cloudUserId();
  if (userId) {
    try {
      const logs = await repo.fetchDailyLogs(userId);
      await writeJSON(LOGS_KEY, logs);
      return logs;
    } catch (err) {
      console.warn('[TaskStorage] cloud fetchDailyLogs failed; using cache', err);
    }
  }
  return readJSON<DailyLog[]>(LOGS_KEY, []);
}

/** The log for one date, defaulted if absent. */
export async function getDailyLog(date: string): Promise<DailyLog> {
  const logs = await getDailyLogs();
  const found = logs.find((log) => log.date === date);
  if (found) {
    return found;
  }

  return {
    date,
    morningDone: false,
    afternoonDone: false,
    eveningDone: false,
  };
}

/** Persist one daily log and mirror to cloud. */
export async function saveDailyLog(log: DailyLog): Promise<void> {
  const logs = await getDailyLogs();
  const next = logs.filter((item) => item.date !== log.date);
  next.push(log);
  await writeJSON(LOGS_KEY, next);

  const userId = await cloudUserId();
  if (userId) {
    try {
      await repo.upsertDailyLog(userId, log);
    } catch (err) {
      console.warn('[TaskStorage] cloud upsertDailyLog failed', err);
    }
  }
}

/** AppSettings from storage, defaulted to DEFAULT_SETTINGS. */
export async function getSettings(): Promise<AppSettings> {
  const userId = await cloudUserId();
  if (userId) {
    try {
      const cloud = await repo.fetchSettings(userId);
      if (cloud) {
        const merged = { ...DEFAULT_SETTINGS, ...cloud };
        await writeJSON(SETTINGS_KEY, merged);
        return merged;
      }
    } catch (err) {
      console.warn('[TaskStorage] cloud fetchSettings failed; using cache', err);
    }
  }
  const stored = await readJSON<AppSettings | null>(SETTINGS_KEY, null);
  return {
    ...DEFAULT_SETTINGS,
    ...(stored ?? {}),
  };
}

/** Persist settings and mirror to cloud. */
export async function saveSettings(settings: AppSettings): Promise<void> {
  await saveSettingsChecked(settings);
}

/**
 * Same as saveSettings, but REPORTS whether the cloud mirror actually landed.
 *
 * saveSettings swallows the cloud error into a console.warn, which is invisible
 * on a real device — app_settings stayed empty for weeks with no symptom except
 * WhatsApp tasks silently failing to link (the server resolves a phone through
 * app_settings."whatsAppPhone", so no row means no sync, forever).
 *
 * Returns why it did not sync so the caller can SAY so instead of showing a
 * generic "couldn't link".
 */
export async function saveSettingsChecked(
  settings: AppSettings,
): Promise<{ cloudSynced: boolean; reason?: string }> {
  await writeJSON(SETTINGS_KEY, settings);

  if (!isSupabaseConfigured) {
    return { cloudSynced: false, reason: 'Supabase is not configured in this build' };
  }
  const userId = await cloudUserId();
  if (!userId) {
    return { cloudSynced: false, reason: 'not signed in — sign in so settings can sync' };
  }
  try {
    await repo.upsertSettings(userId, settings);
  } catch (err: any) {
    const reason = err?.message || err?.error_description || String(err);
    console.warn('[TaskStorage] cloud upsertSettings failed', err);
    return { cloudSynced: false, reason };
  }
  // Read it back: an upsert that "succeeds" but writes nothing (RLS silently
  // filtering the row) is exactly the failure mode that hid this for weeks.
  try {
    const back = await repo.fetchSettings(userId);
    if (!back) return { cloudSynced: false, reason: 'row did not persist (check RLS policy)' };
  } catch (err: any) {
    return { cloudSynced: false, reason: `saved but unreadable: ${err?.message || err}` };
  }
  return { cloudSynced: true };
}

/** Postpone all of today's pending tasks to tomorrow (swipe-left semantics). */
export async function movePendingTasksToTomorrow(today: string): Promise<number> {
  const tasks = await readJSON<Task[]>(TASKS_KEY, []);
  const tomorrow = addDays(today, 1);
  const now = Date.now();

  const pending = tasks.filter((task) => task.date === today && task.status === 'pending');
  if (!pending.length) {
    return 0;
  }

  const movedOld = tasks.map((task) => {
    if (task.date !== today || task.status !== 'pending') {
      return task;
    }
    return { ...task, status: 'moved' as const };
  });

  const copies: Task[] = pending.map((task, index) => ({
    ...task,
    id: `${now}-${index}-${Math.random().toString(36).slice(2, 8)}`,
    date: tomorrow,
    status: 'pending',
    createdAt: now,
    completedAt: null,
  }));

  await saveAllTasks([...movedOld, ...copies]);
  return copies.length;
}

/**
 * Undo a silent auto-rollover — one time, on first run after the fix.
 *
 * The deleted rolloverOverdueTasksToToday used to run on EVERY app open,
 * from useTasks: it copied every pending task dated before today
 * onto today under a NEW id and stamped the original 'moved'. Nobody asked.
 * An evening show from the 30th reappeared on the 31st as if it were still
 * ahead of her, and because the original was no longer 'pending',
 * getOverdueTasks could not see it either — so the "did you go?" card that
 * exists for exactly this never had anything to show.
 *
 * This finds those pairs and puts them back: the copy on `today` is deleted,
 * the original returns to 'pending' on its own date, and the YesterdayCard
 * asks. Deliberately narrow — a pair only counts when the copy is an
 * untouched clone (same text, duration and fixed time, no movedFromDate of
 * its own, created after the original) — so a task the user genuinely moved
 * by hand, or let go of, is never touched.
 */
export async function repairAutoRolledTasks(today: string): Promise<number> {
  if ((await AsyncStorage.getItem(ROLLOVER_REPAIRED_KEY)) === '1') return 0;

  const tasks = await readJSON<Task[]>(TASKS_KEY, []);
  const strays = tasks.filter((t) => t.date < today && t.status === 'moved');
  const restoreIds = new Set<string>();
  const dropIds = new Set<string>();

  for (const original of strays) {
    const clone = tasks.find((t) =>
      t.id !== original.id
      && t.date === today
      && t.status === 'pending'
      && !t.movedFromDate
      && t.text === original.text
      && t.durationMinutes === original.durationMinutes
      && (t.fixedTime ?? null) === (original.fixedTime ?? null)
      && t.createdAt > original.createdAt
      && !dropIds.has(t.id));
    if (!clone) continue;
    restoreIds.add(original.id);
    dropIds.add(clone.id);
  }

  await AsyncStorage.setItem(ROLLOVER_REPAIRED_KEY, '1');
  if (!dropIds.size) return 0;

  await saveAllTasks(
    tasks.map((t) => (restoreIds.has(t.id) ? { ...t, status: 'pending' as const } : t)),
  );
  // deleteTasks, not a filtered saveAllTasks: the clone inherited the
  // original's `source`, and a WhatsApp/calendar row dropped from the local
  // list alone is simply pulled back on the next sync. deleteTasks tombstones
  // the id so it stays gone.
  await deleteTasks([...dropIds]);
  return dropIds.size;
}

// ─── Unfinished tasks from previous days ─────────────────────────────────────
// Nothing auto-moves a task to another day. The rollover that used to do it
// on every app open is gone (see repairAutoRolledTasks above): silently piling
// yesterday's failures onto this morning is the shame-spiral shape, and it
// also erased the only question worth asking — "did you go?". The user
// decides, one tap, and "let them go" is a first-class option.

/** Pending tasks left behind on earlier dates, newest day first. */
export async function getOverdueTasks(today: string, now?: string): Promise<Task[]> {
  const tasks = await getAllTasks();
  // A task scheduled for 14:00 that is still pending at 16:00 has passed just
  // as surely as one from last week, but `date < today` never caught it — so
  // the only tasks offered a Done/Move/Delete action were yesterday's, and the
  // ones that had just slipped had none at all. Pass `now` to include them.
  const elapsedToday = (task: Task): boolean => {
    if (!now || task.date !== today) return false;
    const start = task.fixedTime || task.scheduledTime;
    if (!start) return false; // no time set means nothing to be late for
    return addMinutes(start, task.durationMinutes || 0) < now;
  };
  return tasks
    .filter((task) => task.status === 'pending' && (task.date < today || elapsedToday(task)))
    // Standing work is not overdue — it was never due.
    //
    // "להגיש קורות חיים" carries the date she typed it, not a date anybody
    // agreed to, and this filter was pure `date < today`. So the morning
    // after she wrote it down it appeared in the missed card being asked
    // "did you do this? move it? let it go?" — the same three questions
    // every morning, and the only way to stop them was to reschedule it by
    // hand, daily. Rule 6: the question has to fit the thing. It belongs in
    // the flexible list on today, which is where TodaySchedule now carries
    // it, still holding its original date so rule 4 is kept.
    .filter((task) => !isStandingTask(task))
    .sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0));
}

/**
 * Move tasks onto a new date IN PLACE — the id never changes.
 *
 * The deleted rolloverOverdueTasksToToday copied each task under a fresh id and
 * marked the original 'moved'. That forks a second Supabase row for what the user thinks
 * of as one task, which is precisely the duplicate class the dedup service now
 * has to clean up afterwards. Editing in place keeps one row per task.
 *
 * A stale transitPlan is dropped: it was computed against the OLD date, so
 * keeping it would hand back a leave time for the wrong day's traffic.
 * ensureTravelChain recomputes it on the next load.
 */
export async function moveTasksToDate(ids: string[], date: string): Promise<number> {
  if (!ids.length) return 0;
  const wanted = new Set(ids);
  const tasks = await readJSON<Task[]>(TASKS_KEY, []);
  const moved: Task[] = [];

  const next = tasks.map((task) => {
    if (!wanted.has(task.id)) return task;
    const location =
      task.location && typeof task.location === 'object'
        ? { ...task.location, transitPlan: undefined, wakeUpBy: undefined, leaveHomeBy: undefined }
        : task.location;
    const updated: Task = {
      ...task,
      date,
      movedFromDate: task.date,
      status: 'pending',
      scheduledTime: undefined,   // Lumi assigned that slot for another day
      location,
      notificationIds: [],
    };
    moved.push(updated);
    return updated;
  });

  await withTaskLock(() => saveAllTasksUnlocked(next));

  // Re-arm the alerts for the new date IN THE BACKGROUND.
  //
  // This used to be awaited, and getSettings() can reach the network, so the
  // caller sat waiting on notification scheduling before it could refresh the
  // screen. The data had already changed — the UI just could not show it, so
  // tapping "move to today" looked like it did nothing at all.
  void (async () => {
    try {
      const [{ armTaskAlerts, cancelTaskNotifications }, settings] = await Promise.all([
        import('./NotificationService'),
        getSettings(),
      ]);
      for (const task of moved) {
        const before = tasks.find((t) => t.id === task.id);
        if (before) await cancelTaskNotifications(before).catch(() => {});
        await armTaskAlerts(task, settings.language).catch(() => {});
      }
    } catch (err) {
      console.warn('[TaskStorage] re-arming alerts after move failed', err);
    }
  })();

  return moved.length;
}

/**
 * Stop tracking tasks without deleting them: status 'moved', not removed.
 *
 * Recoverable on purpose — 'moved' is already how the app records "this is no
 * longer live" elsewhere, and the dedup service uses the same marker instead of
 * deleting rows.
 */
export async function letGoTasks(ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const wanted = new Set(ids);
  const tasks = await readJSON<Task[]>(TASKS_KEY, []);
  const hit = tasks.filter((t) => wanted.has(t.id));

  await saveAllTasks(
    tasks.map((task) => (wanted.has(task.id) ? { ...task, status: 'moved' as const } : task)),
  );

  // Cancelling in the background for the same reason: the row must vanish
  // from the screen the moment it is written, not after the notification
  // module has finished with it.
  void (async () => {
    const { cancelTaskNotifications } = await import('./NotificationService');
    for (const task of hit) await cancelTaskNotifications(task).catch(() => {});
  })();
  return hit.length;
}

// ─── NEW: Profile, Stats, Schedule, Rewards, Goals ───

const PROFILE_KEY = 'user_profile';
const STATS_KEY = 'user_stats';
const SCHEDULE_KEY = (date: string) => `schedule:${date}`;
const REWARDS_KEY = 'reward_events';
const GOALS_KEY = 'goals';

// Profile
export async function saveProfile(profile: UserProfile): Promise<void> {
  await writeJSON(PROFILE_KEY, profile);

  const userId = await cloudUserId();
  if (userId) {
    try {
      await repo.upsertProfile(userId, profile);
    } catch (err) {
      console.warn('[TaskStorage] cloud upsertProfile failed', err);
    }
  }
}

/** UserProfile stored alongside tasks (null before onboarding). */
export async function loadProfile(): Promise<UserProfile | null> {
  const userId = await cloudUserId();
  if (userId) {
    try {
      const cloud = await repo.fetchProfile(userId);
      if (cloud) {
        await writeJSON(PROFILE_KEY, cloud);
        return cloud;
      }
    } catch (err) {
      console.warn('[TaskStorage] cloud fetchProfile failed; using cache', err);
    }
  }
  return readJSON<UserProfile | null>(PROFILE_KEY, null);
}

// Custom categories (user-created, in addition to the built-in CATEGORY_META)
const CUSTOM_CATEGORIES_KEY = 'lumi.customCategories.v1';

/** A user-defined task category (label + emoji + color). */
export interface CustomCategory {
  key: string;
  icon: string;
  color: string;
  labelEn: string;
  labelHe: string;
}

/** User-defined categories list. */
export async function loadCustomCategories(): Promise<CustomCategory[]> {
  const userId = await cloudUserId();
  if (userId) {
    try {
      const cloud = await repo.fetchCustomCategories(userId);
      await writeJSON(CUSTOM_CATEGORIES_KEY, cloud);
      return cloud;
    } catch (err) {
      console.warn('[TaskStorage] cloud fetchCustomCategories failed; using cache', err);
    }
  }
  return readJSON<CustomCategory[]>(CUSTOM_CATEGORIES_KEY, []);
}

/** Add/update a custom category and mirror to cloud. */
export async function saveCustomCategory(category: CustomCategory): Promise<void> {
  const all = await loadCustomCategories();
  if (all.some((c) => c.key === category.key)) {
    return;
  }
  all.push(category);
  await writeJSON(CUSTOM_CATEGORIES_KEY, all);

  const userId = await cloudUserId();
  if (userId) {
    try {
      await repo.upsertCustomCategory(userId, category);
    } catch (err) {
      console.warn('[TaskStorage] cloud upsertCustomCategory failed', err);
    }
  }
}

// Stats
export async function saveStats(stats: UserStats): Promise<void> {
  await writeJSON(STATS_KEY, stats);

  const userId = await cloudUserId();
  if (userId) {
    try {
      await repo.upsertStats(userId, stats);
    } catch (err) {
      console.warn('[TaskStorage] cloud upsertStats failed', err);
    }
  }
}

/** UserStats (points/level/streak), zero-initialized when absent. */
export async function loadStats(): Promise<UserStats> {
  const defaults: UserStats = {
    totalPoints: 0,
    level: 1,
    currentStreak: 0,
    longestStreak: 0,
    totalTasksCompleted: 0,
    totalTasksOnTime: 0,
    totalTasksMissed: 0,
    categoryDurationAverages: {},
    weeklyHoursByCategory: {},
    weeklyTaskCountByCategory: {},
    lastUpdated: Date.now(),
  };

  const userId = await cloudUserId();
  if (userId) {
    try {
      const cloud = await repo.fetchStats(userId);
      if (cloud) {
        await writeJSON(STATS_KEY, cloud);
        return cloud;
      }
    } catch (err) {
      console.warn('[TaskStorage] cloud fetchStats failed; using cache', err);
    }
  }
  return readJSON<UserStats>(STATS_KEY, defaults);
}

// Schedule
export async function saveSchedule(schedule: DailySchedule): Promise<void> {
  await writeJSON(SCHEDULE_KEY(schedule.date), schedule);

  const userId = await cloudUserId();
  if (userId) {
    try {
      await repo.upsertSchedule(userId, schedule);
    } catch (err) {
      console.warn('[TaskStorage] cloud upsertSchedule failed', err);
    }
  }
}

/** The generated DailySchedule for a date, or null. */
export async function loadSchedule(date: string): Promise<DailySchedule | null> {
  const userId = await cloudUserId();
  if (userId) {
    try {
      const cloud = await repo.fetchSchedule(userId, date);
      if (cloud) {
        await writeJSON(SCHEDULE_KEY(date), cloud);
        return cloud;
      }
    } catch (err) {
      console.warn('[TaskStorage] cloud fetchSchedule failed; using cache', err);
    }
  }
  return readJSON<DailySchedule | null>(SCHEDULE_KEY(date), null);
}

// Rewards
export async function saveRewardEvent(event: RewardEvent): Promise<void> {
  const existing = await loadRewardEvents();
  existing.unshift(event);
  // Keep only last 50 events
  await writeJSON(REWARDS_KEY, existing.slice(0, 50));

  const userId = await cloudUserId();
  if (userId) {
    try {
      await repo.insertRewardEvent(userId, event);
    } catch (err) {
      console.warn('[TaskStorage] cloud insertRewardEvent failed', err);
    }
  }
}

/** Recent reward events for the stats screen. */
export async function loadRewardEvents(): Promise<RewardEvent[]> {
  const userId = await cloudUserId();
  if (userId) {
    try {
      const cloud = await repo.fetchRewardEvents(userId);
      const local = await readJSON<RewardEvent[]>(REWARDS_KEY, []);
      // No bulk writer for reward events (they are inserted one at a time), so
      // this only refuses to erase the local history — it does not back-fill.
      const rows = await adoptLocalIfCloudEmpty(
        cloud, local, async () => {}, 'reward events');
      await writeJSON(REWARDS_KEY, rows);
      return rows;
    } catch (err) {
      console.warn('[TaskStorage] cloud fetchRewardEvents failed; using cache', err);
    }
  }
  return readJSON<RewardEvent[]>(REWARDS_KEY, []);
}

// Goals
export async function saveGoals(goals: Goal[]): Promise<void> {
  await writeJSON(GOALS_KEY, goals);

  const userId = await cloudUserId();
  if (userId) {
    try {
      await repo.syncAllGoals(userId, goals);
    } catch (err) {
      console.warn('[TaskStorage] cloud syncAllGoals failed', err);
    }
  }
}

/** All goals (projects + aspirations). */
export async function loadGoals(): Promise<Goal[]> {
  const userId = await cloudUserId();
  if (userId) {
    try {
      const cloud = await repo.fetchGoals(userId);
      const local = await readJSON<Goal[]>(GOALS_KEY, []);
      const rows = await adoptLocalIfCloudEmpty(
        cloud, local, (r) => repo.syncAllGoals(userId, r), 'goals');
      await writeJSON(GOALS_KEY, rows);
      return rows;
    } catch (err) {
      console.warn('[TaskStorage] cloud fetchGoals failed; using cache', err);
    }
  }
  return readJSON<Goal[]>(GOALS_KEY, []);
}
