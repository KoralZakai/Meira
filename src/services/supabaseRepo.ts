/**
 * supabaseRepo — typed CRUD for tasks, profile, stats, settings, schedules,
 * quiz progress and daily logs over Supabase.
 *
 * Dependencies: supabaseClient. Row mappers here MUST match the Supabase
 * table columns — change them together with a migration. Consumed exclusively
 * through TaskStorage's best-effort cloud mirror (never call from screens).
 */
// Supabase repository — typed CRUD + row<->model mapping for every domain.
//
// This is the cloud half of the storage layer. TaskStorage.ts calls into here
// when a Supabase session exists; otherwise it stays on the AsyncStorage cache.
// Column names in the DB are camelCase (quoted) so they map 1:1 to the TS
// models — the only extra column per row is "userId" (for RLS) and a
// server-managed "updatedAt".
//
// Location note: the `location` value is persisted as-is into the jsonb column
// (it may be a TaskLocation object OR a plain string in the current model).
// We do not coerce strings to objects here, to avoid regressing the ~10 call
// sites that still read a string. The jsonb column is the single storage home;
// full normalization to TaskLocation is a follow-up.
import { changedColumns } from '../utils/changedColumns';
import { supabase } from './supabaseClient';
import type {
  Task,
  Goal,
  DailyLog,
  DailySchedule,
  UserProfile,
  UserStats,
  RewardEvent,
  QuizProgress,
} from '../types/index';
import type { AppSettings } from '../types/models';
import type { CustomCategory } from './TaskStorage';
import { normalizeProfile } from '../utils/profileShape';
import { forCloud } from '../utils/cloudPrivacy';
import { sealWith, openWith } from './EncryptedStorage';
import { getDataKey } from './DataKey';

/**
 * Upsert a row, dropping columns this database does not have yet.
 *
 * The client ships new fields the moment a feature lands; the SQL migration is
 * a separate act that may not have run. PostgREST answers a row with an unknown
 * key by refusing the WHOLE row (PGRST204, "Could not find the 'x' column of
 * 'y' in the schema cache"), so one new optional field takes every other field
 * with it. That is not hypothetical: `wakeAlarmEnabled` (a UI toggle) blocked
 * `whatsAppPhone` in the same row, and without that column reaching the cloud
 * the WhatsApp server can never resolve phone -> account — so WhatsApp tasks
 * queued forever and the app looked simply disconnected.
 *
 * A field the database cannot store is worth losing; the rest of the row is
 * not. Each rejected column is dropped (loudly) and the write retried, so
 * syncing degrades to "everything the schema knows about" instead of nothing.
 */
async function upsertTolerant(
  table: string,
  rows: Record<string, unknown> | Record<string, unknown>[],
  onConflict: string,
): Promise<void> {
  let payload = (Array.isArray(rows) ? rows : [rows]).map((r) => ({ ...r }));
  if (!payload.length) return;
  // Bounded: one retry per unknown column, and no schema has an unbounded
  // number of those. Anything else rethrows on the first attempt.
  for (let attempt = 0; attempt < 8; attempt++) {
    // `.select()` is not decoration — it is the receipt.
    //
    // A PostgREST upsert that RLS refuses to apply does not fail. It returns
    // no error and touches nothing, so `if (!error) return` reported success
    // for a write that never happened. TaskStorage believes that report: it
    // clears the local-ahead flag, the local copy loses its protection, and
    // the next read pulls the server's untouched row straight over the user's
    // edit. That is "I untick the task and the tick comes back" — the write
    // did not fail, it was never applied and nobody checked.
    //
    // Asking for the affected rows back turns a silent no-op into an error the
    // caller already knows how to handle: keep the flag, keep the local copy,
    // retry on the next foreground.
    //
    // `.select()`, not `.select('id')`. Asking for a named column assumed
    // every table has one called `id`, and three of them do not:
    // app_settings, user_profiles and user_stats are all keyed by `userId`
    // alone. So the receipt intended to catch silent failures BECAME one —
    // Postgres answered 42703 `column app_settings.id does not exist`, which
    // is not a PGRST204 schema-cache miss, so the drop-and-retry above could
    // not help and the whole row was refused. Seen in her logcat as
    //   [App] settings mirror did NOT reach the cloud
    // which is the precise failure that leaves app_settings.whatsAppPhone
    // unwritten, and with it no phone -> account mapping and every WhatsApp
    // task queued forever with no symptom. A bare select returns the affected
    // rows whatever the table's key is.
    const { data, error } = await supabase
      .from(table)
      .upsert(Array.isArray(rows) ? payload : payload[0], { onConflict })
      .select();
    if (!error) {
      const applied = Array.isArray(data) ? data.length : (data ? 1 : 0);
      if (applied < payload.length) {
        throw new Error(
          `[supabaseRepo] ${table}: upsert affected ${applied} of ${payload.length} row(s) `
          + '— the write was accepted and not applied (row-level security, or a '
          + 'row owned by another account). Local copy kept.',
        );
      }
      return;
    }
    const missing = missingColumnOf(error);
    if (!missing || !(missing in payload[0])) throw error;
    // Dropping `sealed` would write the emptied columns with nothing behind
    // them — her task text replaced by a lock. Refuse instead (migration 0014).
    if (missing === 'sealed') throw new Error('[supabaseRepo] tasks.sealed is missing — run migration 0014 before SEAL_APP_ROWS=1');
    console.warn(
      `[supabaseRepo] ${table}.${missing} does not exist in this database — `
      + 'syncing the rest of the row without it. Run the pending migration in supabase/migrations.',
    );
    payload = payload.map(({ [missing]: _dropped, ...rest }) => rest);
  }
  throw new Error(`[supabaseRepo] ${table}: too many unknown columns to drop`);
}

/** The column name in a PostgREST "column not in schema cache" error, if that is what it is. */
function missingColumnOf(error: any): string | null {
  if (!error) return null;
  const text = `${error.code ?? ''} ${error.message ?? ''}`;
  if (!/PGRST204/.test(text) && !/schema cache/i.test(text)) return null;
  return /'([^']+)' column/.exec(error.message ?? '')?.[1] ?? null;
}

// ─── tasks ──────────────────────────────────────────────────────────────────

/** Map an in-memory Task to a tasks row. Explicit per column so an upsert
 *  fully replaces the row (undefined -> null, never silently kept). */
/**
 * The four values the `tasks_priority_check` constraint accepts.
 *
 * Postgres rejects the whole row for anything else — including an empty
 * string, which is what an extraction path that could not decide a priority
 * leaves behind. Seen live: 'new row for relation "tasks" violates check
 * constraint "tasks_priority_check"'. The row simply never reached the cloud,
 * silently, and the only trace was a warning in the console.
 *
 * NULL passes the check, so an unknown value degrades to "no priority stated"
 * rather than losing the task.
 */
const VALID_PRIORITIES = ['must', 'have_to', 'need_to', 'nice_to_do'];

function safePriority(value: unknown): string | null {
  return typeof value === 'string' && VALID_PRIORITIES.includes(value) ? value : null;
}

/**
 * The only `source` values the database will accept.
 *
 * Mirrors `tasks_source_check` in supabase/migrations/0003_whatsapp_sync.sql.
 * Keep the two in step, or rather: do not bother, because anything not in this
 * list is coerced below instead of being allowed to fail.
 */
const VALID_SOURCES = ['voice', 'manual', 'suggested', 'email', 'calendar', 'whatsapp'];

/**
 * A source the CHECK constraint will take, or null.
 *
 * WHY: a single row carrying an unrecognised `source` fails the whole upsert,
 * and PostgREST rejects the BATCH — so one bad value stopped all 142 of her
 * tasks reaching the cloud, every sync, with only a console line to show for
 * it. On the phone everything looked right, because the local write had
 * already succeeded and the row was simply marked as ahead of the cloud.
 *
 * Exactly the shape safePriority was written for, one column over. A column
 * whose allowed values live in the DATABASE must be defended here, because the
 * app ships new values (a new kind of generated task) long before anyone runs
 * a migration, and losing the label is survivable where losing the row is not.
 *
 * The coercion is logged, not silent: an unknown source that starts appearing
 * is either a migration somebody owes, or a typo, and neither should be
 * discoverable only by noticing that the cloud is quietly a bit wrong.
 */
function safeSource(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  if (VALID_SOURCES.includes(value)) return value;
  console.warn(
    `[supabaseRepo] task source "${value}" is not in tasks_source_check — `
    + 'storing null so the row still syncs. Add it in a migration to keep it.',
  );
  return null;
}

function taskToRow(userId: string, t: Task): Record<string, unknown> {
  t = forCloud(t); // no live position leaves the phone (utils/cloudPrivacy)
  return {
    id: t.id,
    userId,
    text: t.text,
    category: t.category ?? null,
    priority: safePriority(t.priority),
    isFixed: t.isFixed ?? false,
    fixedTime: t.fixedTime ?? null,
    durationMinutes: t.durationMinutes ?? 30,
    actualDurationMinutes: t.actualDurationMinutes ?? null,
    date: t.date,
    status: t.status ?? 'pending',
    progress: t.progress ?? null,
    subtasks: t.subtasks ?? null,
    deadline: t.deadline ?? null,
    deadlineTime: t.deadlineTime ?? null,
    estimatedWorkMinutes: t.estimatedWorkMinutes ?? null,
    latestStartBy: t.latestStartBy ?? null,
    scheduledTime: t.scheduledTime ?? null,
    location: t.location ?? null,
    contact: t.contact ?? null,
    gmailThreadId: t.gmailThreadId ?? null,
    calendarEventId: t.calendarEventId ?? null,
    // Dropped until now, which is why reconciling them looped: the push
    // silently lost them and cloud hydration handed back a row without them.
    // upsertTolerant removes either one and warns if the column is not there
    // yet, so this is safe before 0011 is run — it just keeps not persisting
    // until it is.
    meetingUrl: t.meetingUrl ?? null,
    attendees: t.attendees ?? null,
    verifiedArrival: t.verifiedArrival ?? null,
    completedAt: t.completedAt ?? null,
    // Dropped here until now, which made it useless: it is stamped locally to
    // record "she explicitly UNticked this", and every cloud round trip erased
    // it, so nothing downstream could ever tell a task that was never done
    // from one she had just corrected.
    uncompletedAt: t.uncompletedAt ?? null,
    createdAt: t.createdAt,
    movedFromDate: t.movedFromDate ?? null,
    historicalDurations: t.historicalDurations ?? [],
    notificationIds: t.notificationIds ?? null,
    tags: t.tags ?? null,
    subgroup: t.subgroup ?? null,
    parentId: t.parentId ?? null,
    dueDate: t.dueDate ?? null,
    how: t.how ?? null,
    why: t.why ?? null,
    contactName: t.contactName ?? null,
    contactPhone: t.contactPhone ?? null,
    source: safeSource(t.source),
    hasLocation: t.hasLocation ?? null,
    hasDeadline: t.hasDeadline ?? null,
    locationLat: t.locationLat ?? null,
    locationLng: t.locationLng ?? null,
    lastNearbyReminderAt: t.lastNearbyReminderAt ?? null,
    lastWakeReminderAt: t.lastWakeReminderAt ?? null,
    lastDepartureDetectedAt: t.lastDepartureDetectedAt ?? null,
    lastArrivalDetectedAt: t.lastArrivalDetectedAt ?? null,
    // 29.10 (migration 0017). upsertTolerant drops them with a warning until it is run.
    allDay: t.allDay ?? null,
    endDate: t.endDate ?? null,
  };
}

/** Map a tasks row back to an in-memory Task (null -> undefined). */
function rowToTask(r: any): Task {
  const u = <T>(v: T | null): T | undefined => (v === null ? undefined : v);
  return {
    id: r.id,
    text: r.text,
    category: u(r.category),
    priority: u(r.priority),
    isFixed: r.isFixed ?? false,
    fixedTime: u(r.fixedTime),
    durationMinutes: r.durationMinutes ?? 30,
    actualDurationMinutes: u(r.actualDurationMinutes),
    date: r.date,
    status: r.status,
    progress: u(r.progress),
    subtasks: u(r.subtasks),
    deadline: u(r.deadline),
    deadlineTime: u(r.deadlineTime),
    estimatedWorkMinutes: u(r.estimatedWorkMinutes),
    latestStartBy: u(r.latestStartBy),
    scheduledTime: u(r.scheduledTime),
    location: u(r.location),
    contact: u(r.contact),
    gmailThreadId: u(r.gmailThreadId),
    calendarEventId: u(r.calendarEventId),
    verifiedArrival: u(r.verifiedArrival),
    completedAt: r.completedAt ?? null,
    uncompletedAt: r.uncompletedAt ?? null,
    createdAt: r.createdAt,
    movedFromDate: u(r.movedFromDate),
    historicalDurations: r.historicalDurations ?? [],
    notificationIds: u(r.notificationIds),
    tags: u(r.tags),
    subgroup: u(r.subgroup),
    parentId: u(r.parentId),
    dueDate: u(r.dueDate),
    how: u(r.how),
    why: u(r.why),
    contactName: u(r.contactName),
    contactPhone: u(r.contactPhone),
    source: u(r.source),
    hasLocation: u(r.hasLocation),
    hasDeadline: u(r.hasDeadline),
    locationLat: u(r.locationLat),
    locationLng: u(r.locationLng),
    lastNearbyReminderAt: u(r.lastNearbyReminderAt),
    lastWakeReminderAt: u(r.lastWakeReminderAt),
    lastDepartureDetectedAt: u(r.lastDepartureDetectedAt),
    lastArrivalDetectedAt: u(r.lastArrivalDetectedAt),
    allDay: u(r.allDay),
    endDate: u(r.endDate),
  };
}

// ── sealed rows (7.10) ──────────────────────────────────────────────────────
// What she will do, where and with whom leaves the phone as ONE AES-256-GCM
// blob in `sealed` (migration 0014), under her account's key (DataKey); the
// plaintext columns are emptied and `text` reads PLACEHOLDER. The server reads
// and writes the same format (server/supabase_tasks.py). A row whose `text`
// is not the placeholder came from an older build in plaintext — it wins.
export const SEALED_PLACEHOLDER = '🔒';
const TASK_SEALED = ['text', 'location', 'contact', 'contactName', 'contactPhone', 'attendees',
  'meetingUrl', 'progress', 'subtasks', 'how', 'why', 'locationLat', 'locationLng'] as const;
const PROFILE_SEALED = ['name', 'homeAddress', 'homeLat', 'homeLng', 'routinesNotes', 'hobbies'] as const;
const PROFILE_EMPTY: Record<string, unknown> = {
  name: SEALED_PLACEHOLDER, homeAddress: '', homeLat: 0, homeLng: 0, routinesNotes: null, hobbies: null,
};

export function sealTaskRow(row: Record<string, unknown>, key: Uint8Array): Record<string, unknown> {
  const blob: Record<string, unknown> = {};
  for (const k of TASK_SEALED) if (row[k] !== null && row[k] !== undefined) blob[k] = row[k];
  const out: Record<string, unknown> = { ...row };
  for (const k of TASK_SEALED) out[k] = null;
  out.text = SEALED_PLACEHOLDER;
  out.sealed = sealWith(key, `tasks:${row.id}`, JSON.stringify(blob));
  return out;
}

export function openTaskRow(r: any, key: Uint8Array | null | undefined): any {
  if (!r?.sealed || r.text !== SEALED_PLACEHOLDER) return r;
  if (!key) throw new Error('[supabaseRepo] a sealed task arrived and this phone has no key for it');
  return { ...r, ...JSON.parse(openWith(key, `tasks:${r.id}`, r.sealed)) };
}

export function sealProfileRow(row: Record<string, unknown>, key: Uint8Array): Record<string, unknown> {
  const blob: Record<string, unknown> = {};
  for (const k of PROFILE_SEALED) if (row[k] !== null && row[k] !== undefined) blob[k] = row[k];
  return {
    ...row, ...PROFILE_EMPTY,
    sealed: sealWith(key, `user_profiles:${row.userId}`, JSON.stringify(blob)),
  };
}

export function openProfileRow(r: any, key: Uint8Array | null | undefined): any {
  if (!r?.sealed || r.name !== SEALED_PLACEHOLDER) return r;
  if (!key) throw new Error('[supabaseRepo] a sealed profile arrived and this phone has no key for it');
  return { ...r, ...JSON.parse(openWith(key, `user_profiles:${r.userId}`, r.sealed)) };
}

/** The key for writing: null = sealing is off (write as before). Throws when it
 *  cannot be known — the write then fails and is retried, never sent plaintext. */
async function writeKey(userId: string): Promise<Uint8Array | null> {
  return getDataKey(userId);
}

/** The key for reading: undefined when unknown. Only a SEALED row needs it, and
 *  openTaskRow throws then — so a list it cannot read is never taken as truth. */
async function readKey(userId: string): Promise<Uint8Array | null | undefined> {
  try {
    return await getDataKey(userId);
  } catch (e) {
    console.warn('[supabaseRepo] data key unknown for this read', String(e));
    return undefined;
  }
}

/** All task rows for a user, mapped to the app Task shape. */
export async function fetchTasks(userId: string): Promise<Task[]> {
  const { data, error } = await supabase
    .from('tasks')
    .select('*')
    .eq('userId', userId);
  if (error) throw error;
  const key = await readKey(userId);
  return (data ?? []).map((r) => rowToTask(openTaskRow(r, key)));
}

/** Insert/update one task row keyed by (user_id, id). */
export async function upsertTask(userId: string, task: Task): Promise<void> {
  const key = await writeKey(userId);
  const row = taskToRow(userId, task);
  await upsertTolerant('tasks', key ? sealTaskRow(row, key) : row, 'userId,id');
}

/**
 * Write ONLY the columns an edit changed.
 *
 * `upsertTask` sends the whole row, so any edit made from a local copy that is
 * older than the cloud's (the server retitled it, moved it, added a place)
 * silently put the stale columns back. A column the edit did not touch is not
 * ours to write. Falls back to the whole row when there is nothing to compare
 * against, when rows are sealed (one blob, cannot be patched per column), or
 * when the row does not exist in the cloud yet.
 */
export async function upsertTaskChanges(userId: string, before: Task | undefined, after: Task): Promise<void> {
  const key = await writeKey(userId);
  if (!before || key) return upsertTask(userId, after);
  const changed = changedColumns(
    taskToRow(userId, before) as Record<string, unknown>,
    taskToRow(userId, after) as Record<string, unknown>,
  );
  if (!Object.keys(changed).length) return;
  const { data, error } = await supabase
    .from('tasks').update(changed).eq('userId', userId).eq('id', after.id).select();
  if (error) {
    console.warn('[supabaseRepo] column patch refused, writing the whole row', error.message);
    return upsertTask(userId, after);
  }
  if (!data || !data.length) return upsertTask(userId, after);   // not in the cloud yet
}

/** Batch upsert of task rows. */
export async function upsertTasks(userId: string, tasks: Task[]): Promise<void> {
  if (!tasks.length) return;
  const key = await writeKey(userId);
  await upsertTolerant('tasks', tasks.map((t) => {
    const row = taskToRow(userId, t);
    return key ? sealTaskRow(row, key) : row;
  }), 'userId,id');
}

/**
 * Delete one task row, and say HOW MANY rows that was.
 *
 * It used to return `void` and throw only on an error, which made "removed it"
 * and "matched nothing at all" the same observable outcome — rule 1, exactly.
 * PostgREST answers a delete that hits zero rows with a cheerful 204: no error,
 * no rows, nothing to tell the caller apart.
 *
 * That mattered on Koral's phone. Three mangled prep rows were swept locally,
 * tombstoned, and deleted from the cloud — and came back from the cloud on
 * every single launch, three times, for days. `deleteTaskRow` reported success
 * each time. The tombstone list hid the symptom, so nothing rendered wrong and
 * the delete that was doing nothing was never suspected. A growing denylist is
 * not a fix; it is the sound of a delete that does not delete.
 *
 * A zero-count delete is now a warn naming the id, so the next launch says
 * plainly whether the row was there and refused (RLS, a userId mismatch) or was
 * never there at all. The count is returned for callers that can act on it;
 * the ones that cannot may keep ignoring it.
 */
export async function deleteTaskRow(userId: string, taskId: string): Promise<number> {
  const { error, count } = await supabase
    .from('tasks')
    .delete({ count: 'exact' })
    .eq('userId', userId)
    .eq('id', taskId);
  if (error) throw error;
  const removed = count ?? 0;
  if (removed === 0) {
    console.warn(
      `[supabaseRepo] delete of task ${taskId} matched NO cloud row. Either it was `
      + 'already gone, or row-level security is refusing this user the delete — '
      + 'in which case it will be pulled back on the next sync and only the '
      + 'tombstone list is keeping it off the screen.',
    );
  }
  return removed;
}

/**
 * Reconcile the cloud `tasks` to the given list: upsert all, and delete rows
 * that are absent locally — EXCEPT externally-sourced tasks (WhatsApp / Google).
 * Those are written server-side and may legitimately be missing from a stale
 * local list; deleting them here is the "WhatsApp tasks vanish" bug. Explicit
 * user deletions go through deleteTaskRow and are unaffected by this guard.
 */

export async function syncAllTasks(userId: string, tasks: Task[]): Promise<void> {
  const { data: existing, error: idErr } = await supabase
    .from('tasks')
    .select('id, source')
    .eq('userId', userId);
  if (idErr) throw idErr;

  const nextIds = new Set(tasks.map((t) => t.id));
  // Delete only what this device can PROVE it owns.
  //
  // The rule used to be "delete anything not in my local list unless its source
  // is external", which makes absence of evidence the trigger for destruction:
  // a row with a null or unrecognised source — one written by an older client,
  // or by a path that never set the column — was treated as app-local and
  // removed, even though this device had never seen it. A phone that has not
  // finished pulling could quietly erase rows it knows nothing about.
  //
  // Inverted: a row is deletable only when it positively identifies itself as
  // created by the app. Anything else is left alone. The cost of being wrong
  // this way is a stale row the user can delete; the cost of being wrong the
  // other way is losing something they wrote.
  const APP_SOURCES = new Set(['voice', 'manual', 'suggested']);
  const toDelete = (existing ?? [])
    .filter(
      (r: any) =>
        !nextIds.has(r.id as string) &&
        APP_SOURCES.has(String(r.source ?? '')),
    )
    .map((r: any) => r.id as string);

  await upsertTasks(userId, tasks);

  if (toDelete.length) {
    const { error: delErr } = await supabase
      .from('tasks')
      .delete()
      .eq('userId', userId)
      .in('id', toDelete);
    if (delErr) throw delErr;
  }
}

// ─── user_profiles (singleton per user) ──────────────────────────────────────

/** Profile row -> UserProfile, or null. */
export async function fetchProfile(userId: string): Promise<UserProfile | null> {
  const { data, error } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('userId', userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const opened = openProfileRow(data, await readKey(userId));
  const { userId: _u, updatedAt: _up, sealed: _s, ...rest } = opened as any;
  return rest as UserProfile;
}

/**
 * Insert/update the profile row — mapped explicitly, column by column.
 *
 * The app carries two UserProfile shapes (see utils/profileShape) and the
 * `user_profiles` table is the types/ one: transportType, morningRoutineMinutes,
 * homeLat/homeLng. Screens save the models/ one: transportMode, homeLatLng,
 * totalMorningRoutineMinutes, an ISO-string createdAt. Spreading that straight
 * in offered PostgREST a dozen columns that do not exist, so every profile
 * write was refused — which is why this table held ZERO rows while the same
 * account had 96 tasks. Normalizing first is what makes the two shapes meet.
 */
export async function upsertProfile(userId: string, profile: any): Promise<void> {
  const p: any = normalizeProfile(profile) ?? profile;
  const epoch = (v: any): number =>
    typeof v === 'number' ? v : (Date.parse(v ?? '') || Date.now());
  const key = await writeKey(userId);
  const row: Record<string, unknown> = {
    userId,
    name: p.name ?? '',
    language: p.language ?? 'en',
    theme: p.theme ?? 'light',
    transportType: p.transportType ?? 'bus',
    morningRoutineMinutes: p.morningRoutineMinutes ?? 45,
    wakeBufferMinutes: p.wakeBufferMinutes ?? 15,
    // The home address is the one field the whole travel chain is built on.
    // Kept out of the cloud it cannot survive a reinstall, and a profile with
    // no origin plans no routes at all — no leave time, no bus, no alarm.
    homeAddress: p.homeAddress ?? '',
    homeLat: p.homeLat ?? p.homeLatLng?.lat ?? null,
    homeLng: p.homeLng ?? p.homeLatLng?.lng ?? null,
    defaultWakeTime: p.defaultWakeTime ?? null,
    sleepTime: p.sleepTime ?? null,
    // Her standing week, in her own words ("gym Mon/Wed 18:00", "kids at
    // 16:00"). Collected at onboarding, never stored anywhere but this device
    // — so a reinstall lost the facts that decide whether a free hour is
    // really free. utils/routines reads them; migration 0006 adds the columns.
    routinesNotes: p.routinesNotes ?? null,
    hobbies: p.hobbies ?? null,
    googleConnected: Boolean(p.googleConnected),
    createdAt: epoch(p.createdAt),
  };
  await upsertTolerant('user_profiles', key ? sealProfileRow(row, key) : row, 'userId');
}

// ─── personality_quiz (singleton per user) ───────────────────────────────────
// Cloud home for the 30-question MBTI quiz progress + result. One row per user,
// keyed on userId (auth.uid). Additive — mirrors the user_profiles pattern.

/**
 * Fetch this user's saved quiz progress from Supabase, or null if none yet.
 * Strips the RLS/bookkeeping columns so the caller gets a clean QuizProgress.
 */
export async function fetchQuizProgress(userId: string): Promise<QuizProgress | null> {
  const { data, error } = await supabase
    .from('personality_quiz')
    .select('*')
    .eq('userId', userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const { userId: _u, ...rest } = data as any;
  return rest as QuizProgress;
}

/**
 * Upsert this user's quiz progress (answers, sectionIndex, completed, finalType).
 * onConflict 'userId' → one row per user, last write wins.
 */
export async function upsertQuizProgress(userId: string, progress: QuizProgress): Promise<void> {
  const { error } = await supabase
    .from('personality_quiz')
    .upsert({ ...progress, userId }, { onConflict: 'userId' });
  if (error) throw error;
}

// ─── user_stats (singleton per user) ─────────────────────────────────────────

/** Stats row -> UserStats, or null. */
export async function fetchStats(userId: string): Promise<UserStats | null> {
  const { data, error } = await supabase
    .from('user_stats')
    .select('*')
    .eq('userId', userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const { userId: _u, updatedAt: _up, ...rest } = data as any;
  return rest as UserStats;
}

/** Insert/update the stats row. */
export async function upsertStats(userId: string, stats: UserStats): Promise<void> {
  const { error } = await supabase
    .from('user_stats')
    .upsert({ ...stats, userId }, { onConflict: 'userId' });
  if (error) throw error;
}

// ─── app_settings (singleton per user) ───────────────────────────────────────

/** Settings row -> AppSettings, or null. */
export async function fetchSettings(userId: string): Promise<AppSettings | null> {
  const { data, error } = await supabase
    .from('app_settings')
    .select('*')
    .eq('userId', userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const { userId: _u, updatedAt: _up, ...rest } = data as any;
  return rest as AppSettings;
}

/** Insert/update the settings row.
 *  Tolerant of a database that predates a new setting: whatsAppPhone must reach
 *  the cloud even when a newer toggle has no column yet (see upsertTolerant). */
export async function upsertSettings(userId: string, settings: AppSettings): Promise<void> {
  await upsertTolerant('app_settings', { ...settings, userId }, 'userId');
}

// ─── schedules (per user per date) ───────────────────────────────────────────

/** Schedule row for a date -> DailySchedule, or null. */
export async function fetchSchedule(userId: string, date: string): Promise<DailySchedule | null> {
  const { data, error } = await supabase
    .from('schedules')
    .select('*')
    .eq('userId', userId)
    .eq('date', date)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const { userId: _u, updatedAt: _up, ...rest } = data as any;
  return rest as DailySchedule;
}

/** Insert/update the schedule row for its date. */
export async function upsertSchedule(userId: string, schedule: DailySchedule): Promise<void> {
  const { error } = await supabase
    .from('schedules')
    .upsert({ ...schedule, tasks: (schedule.tasks ?? []).map(forCloud), userId },
      { onConflict: 'userId,date' });
  if (error) throw error;
}

// ─── daily_logs (per user per date) ─────────────────────────────────────────

/** All daily log rows. */
export async function fetchDailyLogs(userId: string): Promise<DailyLog[]> {
  const { data, error } = await supabase
    .from('daily_logs')
    .select('*')
    .eq('userId', userId);
  if (error) throw error;
  return (data ?? []).map((r: any) => {
    const { userId: _u, updatedAt: _up, ...rest } = r;
    return rest as DailyLog;
  });
}

/** Insert/update one daily log row keyed by date. */
export async function upsertDailyLog(userId: string, log: DailyLog): Promise<void> {
  const { error } = await supabase
    .from('daily_logs')
    .upsert({ ...log, userId }, { onConflict: 'userId,date' });
  if (error) throw error;
}

// ─── reward_events (per user) ────────────────────────────────────────────────

/** Recent reward event rows. */
export async function fetchRewardEvents(userId: string): Promise<RewardEvent[]> {
  const { data, error } = await supabase
    .from('reward_events')
    .select('*')
    .eq('userId', userId)
    .order('timestamp', { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []).map((r: any) => {
    const { userId: _u, ...rest } = r;
    return rest as RewardEvent;
  });
}

/** Append one reward event row. */
export async function insertRewardEvent(userId: string, event: RewardEvent): Promise<void> {
  const { error } = await supabase
    .from('reward_events')
    .upsert({ ...event, userId }, { onConflict: 'userId,id' });
  if (error) throw error;
}

// ─── goals (per user) ─────────────────────────────────────────────────────

/** All goal rows -> Goal[]. */
export async function fetchGoals(userId: string): Promise<Goal[]> {
  const { data, error } = await supabase
    .from('goals')
    .select('*')
    .eq('userId', userId);
  if (error) throw error;
  return (data ?? []).map((r: any) => {
    const { userId: _u, updatedAt: _up, ...rest } = r;
    return rest as Goal;
  });
}

/** Make the cloud match `goals` exactly: upsert all, delete any not present. */
export async function syncAllGoals(userId: string, goals: Goal[]): Promise<void> {
  const { data: existing, error: idErr } = await supabase
    .from('goals')
    .select('id')
    .eq('userId', userId);
  if (idErr) throw idErr;

  const nextIds = new Set(goals.map((g) => g.id));
  const toDelete = (existing ?? [])
    .map((r: any) => r.id as string)
    .filter((id) => !nextIds.has(id));

  if (goals.length) {
    const { error } = await supabase
      .from('goals')
      .upsert(goals.map((g) => ({ ...g, userId })), { onConflict: 'userId,id' });
    if (error) throw error;
  }

  if (toDelete.length) {
    const { error: delErr } = await supabase
      .from('goals')
      .delete()
      .eq('userId', userId)
      .in('id', toDelete);
    if (delErr) throw delErr;
  }
}

// ─── custom_categories (per user) ────────────────────────────────────────────

/** Custom category rows. */
export async function fetchCustomCategories(userId: string): Promise<CustomCategory[]> {
  const { data, error } = await supabase
    .from('custom_categories')
    .select('*')
    .eq('userId', userId);
  if (error) throw error;
  return (data ?? []).map((r: any) => ({
    key: r.key,
    icon: r.icon,
    color: r.color,
    labelEn: r.labelEn,
    labelHe: r.labelHe,
  }));
}

/** Insert/update one custom category row. */
export async function upsertCustomCategory(userId: string, category: CustomCategory): Promise<void> {
  const { error } = await supabase
    .from('custom_categories')
    .upsert({ ...category, userId }, { onConflict: 'userId,key' });
  if (error) throw error;
}
