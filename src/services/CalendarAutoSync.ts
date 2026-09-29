/**
 * CalendarAutoSync — Google Calendar reaches Meira without being asked.
 *
 * WHY THIS EXISTS
 *
 * The import itself worked. What did not exist was a reason for it to RUN.
 * Every calendar pull in this app hung off one thing: `TodaySchedule` coming
 * into focus, throttled to once every 30 minutes per app session. So:
 *
 *   - An event booked while the app was closed reached Meira only when she
 *     next opened the Today tab — which for an interview booked on Sunday for
 *     Wednesday could be days, and the travel chain and the wake alarm are
 *     built from the import, so none of them existed either.
 *   - "Pick a day → Wednesday" is documented as "the quiet path. No sync" and
 *     read local storage only, so the one screen she used to LOOK for the
 *     event was the one screen guaranteed not to fetch it.
 *   - Opening the app, adding an event in Google Calendar, and switching back
 *     inside the same half hour hit the throttle and did nothing, silently.
 *
 * This module owns the trigger side of that, in three layers:
 *
 *   1. FOREGROUND   — every return to the app runs a sync (AppState 'active'),
 *                     plus a heartbeat while it stays open.
 *   2. BACKGROUND   — expo-background-task keeps pulling while the app is
 *                     closed, so an event booked overnight already has its
 *                     route and its alarm by morning. Android's WorkManager
 *                     decides when; the floor is ~15 minutes and it may be
 *                     later on a dozing phone. This is a safety net, not a
 *                     clock — the foreground layer is what she actually feels.
 *   3. ON DEMAND    — `syncCalendarNow` for a screen that has a reason to ask
 *                     (pull-to-refresh, picking another day, the Profile check).
 *
 * A sync is not just the import. An event that lands with no route, no leave
 * time and no alarm has "appeared" without being HANDLED, which is the same
 * complaint one step later. So every run here is import → travel chain →
 * arm alerts, in that order, and only then reports what changed.
 *
 * THE SILENT-STATE RULE APPLIES (see CLAUDE.md): this returns a result that
 * can say "Google refused us", never a bare 0 that also means "nothing new".
 *
 * Dependencies: GoogleSync (import + travel chain), NotificationService
 * (arming, and the heads-up when something new lands), TaskStorage (settings).
 */
import { AppState, AppStateStatus } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as TaskManager from 'expo-task-manager';
import * as BackgroundTask from 'expo-background-task';

import {
  syncCalendarToday,
  syncCalendarForDate,
  ensureTravelChain,
  ensureTravelChainAhead,
  lastCalendarFailure,
} from './GoogleSync';
import {
  armMissingTaskAlerts,
  sendImmediate,
} from './NotificationService';
import {
  getAllTasks,
  getSettings,
  updateTaskFields,
} from './TaskStorage';
import { getTodayString, isExpoGo } from '../utils/timeUtils';
import { AppLanguage, Task } from '../types/index';

/** WorkManager job name. Versioned: renaming it orphans the old registration. */
export const CALENDAR_BACKGROUND_TASK = 'lumi.calendar.autosync.v1';

/** Wall-clock stamp of the last completed sync, survives app restarts. */
const LAST_SYNC_KEY = 'lumi.calendar.lastAutoSync.v1';
/** Ids we have already announced, so one event is announced once. */
const ANNOUNCED_KEY = 'lumi.calendar.announced.v1';

/**
 * How stale a sync may be before returning to the app triggers a new one.
 *
 * Two minutes, not thirty. The case this is FOR is: she books something in
 * Google Calendar and switches straight back to Meira to see it. Under the
 * old 30-minute throttle that switch did nothing at all, with no way to tell
 * that from "there was nothing new".
 */
const FOREGROUND_STALE_MS = 2 * 60 * 1000;

/** Heartbeat while the app is open and in front. */
const FOREGROUND_INTERVAL_MS = 10 * 60 * 1000;

/**
 * What Android is asked for. It is a request, not a promise — WorkManager
 * batches jobs and a dozing phone will run this later than asked.
 */
const BACKGROUND_INTERVAL_MINUTES = 15;

export interface CalendarSyncResult {
  /** New tasks imported from Google on this run. */
  added: number;
  /** Google's own words when it refused us, else null. Never inferred. */
  error: string | null;
  /** Tasks that were imported on this run, for announcing. */
  newTasks: Task[];
  /** Whether anything at all ran (false = skipped, not failed). */
  ran: boolean;
}

/** One sync at a time. Two at once race on the task array — see TodaySchedule. */
let inFlight: Promise<CalendarSyncResult> | null = null;

let listeners: Array<(r: CalendarSyncResult) => void> = [];

/**
 * Be told when a sync lands something new, so a screen can redraw without
 * polling. Returns the unsubscribe.
 */
export function onCalendarSync(fn: (r: CalendarSyncResult) => void): () => void {
  listeners.push(fn);
  return () => { listeners = listeners.filter((l) => l !== fn); };
}

/** When the last completed sync finished, or 0 if it never has. */
export async function lastSyncAt(): Promise<number> {
  const raw = await AsyncStorage.getItem(LAST_SYNC_KEY).catch(() => null);
  return raw ? Number(raw) || 0 : 0;
}

/**
 * Import → route → arm, once.
 *
 * `force` skips GoogleSync's own 30-minute throttle. Everything that calls
 * this because a HUMAN acted (tapped refresh, picked a day, came back to the
 * app) passes force, because a throttle she cannot see reads as a bug.
 */
export async function runCalendarSync(
  lang?: AppLanguage,
  opts: { force?: boolean; announce?: boolean; reason?: string } = {},
): Promise<CalendarSyncResult> {
  if (inFlight) return inFlight;
  inFlight = (async (): Promise<CalendarSyncResult> => {
    const language = lang ?? await getSettings().then((s) => s.language).catch(() => 'en' as AppLanguage);
    const before = new Set((await getAllTasks().catch(() => [] as Task[])).map((t) => t.id));
    let added = 0;
    try {
      added = await syncCalendarToday(language, opts.force ?? true);
      const today = getTodayString();
      await ensureTravelChain(today, language).catch((e) => {
        console.warn('[CalendarAutoSync] travel chain (today) failed', e);
      });
      await ensureTravelChainAhead(language).catch((e) => {
        console.warn('[CalendarAutoSync] travel chain (ahead) failed', e);
      });
    } catch (e) {
      // Rule 2: the throw may be swallowed, the reason may not.
      console.warn('[CalendarAutoSync] sync failed', opts.reason ?? '', e);
    }

    // Whatever just arrived has no alerts — the merge writes rows, nothing
    // more. Arm the month ahead, which is the same horizon the import uses.
    const all = await getAllTasks().catch(() => [] as Task[]);
    const today = getTodayString();
    const horizon = new Date();
    horizon.setDate(horizon.getDate() + 30);
    const horizonKey = horizon.toISOString().slice(0, 10);
    try {
      const armed = await armMissingTaskAlerts(
        all.filter((t) => t.date >= today && t.date <= horizonKey),
        language,
        today,
      );
      // Only the one field arming produces, merged onto the LOCAL row — never
      // a whole-array save, which is how local-only fields died before.
      for (const t of armed) {
        await updateTaskFields(t.id, { notificationIds: t.notificationIds }).catch(() => {});
      }
    } catch (e) {
      console.warn('[CalendarAutoSync] arming failed', e);
    }

    const newTasks = all.filter((t) => !before.has(t.id) && (t as any).source === 'calendar');
    await AsyncStorage.setItem(LAST_SYNC_KEY, String(Date.now())).catch(() => {});

    const result: CalendarSyncResult = {
      added,
      error: lastCalendarFailure(),
      newTasks,
      ran: true,
    };
    if (opts.announce && newTasks.length) await announce(newTasks, language);
    for (const l of listeners) { try { l(result); } catch { /* a bad listener is not a sync failure */ } }
    return result;
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/**
 * A sync a screen asked for. Same thing, named for the call site so the warn
 * lines say who wanted it.
 */
export function syncCalendarNow(lang?: AppLanguage, reason = 'manual'): Promise<CalendarSyncResult> {
  return runCalendarSync(lang, { force: true, announce: false, reason });
}

/**
 * Pull one specific date and route it — for "pick a day", where the whole
 * point is the day she chose and a month-wide sweep is wasted work.
 */
export async function syncCalendarDate(date: string, lang?: AppLanguage): Promise<number> {
  const language = lang ?? await getSettings().then((s) => s.language).catch(() => 'en' as AppLanguage);
  const added = await syncCalendarForDate(date, language).catch((e) => {
    console.warn('[CalendarAutoSync] single-day sync failed', date, e);
    return 0;
  });
  if (added > 0) {
    await ensureTravelChainAhead(language).catch(() => {});
    const all = await getAllTasks().catch(() => [] as Task[]);
    const armed = await armMissingTaskAlerts(
      all.filter((t) => t.date === date), language, getTodayString(),
    ).catch(() => [] as Task[]);
    for (const t of armed) {
      await updateTaskFields(t.id, { notificationIds: t.notificationIds }).catch(() => {});
    }
  }
  return added;
}

/**
 * Tell her something landed.
 *
 * This is the half that makes the feature real: a background import she never
 * hears about is indistinguishable from no import — which is the exact shape
 * of every bug in THE SILENT-STATE RULE. One notification per event, ever,
 * tracked by id, because WorkManager will run this again in fifteen minutes.
 */
async function announce(tasks: Task[], lang: AppLanguage): Promise<void> {
  if (isExpoGo()) return;
  let seen: string[] = [];
  try {
    seen = JSON.parse((await AsyncStorage.getItem(ANNOUNCED_KEY)) || '[]');
  } catch { seen = []; }
  const fresh = tasks.filter((t) => !seen.includes(t.id));
  if (!fresh.length) return;

  const he = lang === 'he';
  for (const t of fresh.slice(0, 3)) {
    const when = dayLabel(t.date, he);
    const at = t.fixedTime ? ` ${t.fixedTime}` : '';
    const where = typeof t.location === 'string'
      ? t.location
      : t.location?.displayName || t.location?.address;
    await sendImmediate(
      he ? '📅 נוסף ליומן' : '📅 New in your calendar',
      he
        ? `${t.text} — ${when}${at}${where ? `, ${where}` : ''}`
        : `${t.text} — ${when}${at}${where ? `, ${where}` : ''}`,
      { taskId: t.id, type: 'calendar_import' },
    ).catch((e) => console.warn('[CalendarAutoSync] announce failed', e));
  }
  if (fresh.length > 3) {
    await sendImmediate(
      he ? '📅 נוסף ליומן' : '📅 New in your calendar',
      he ? `ועוד ${fresh.length - 3} אירועים` : `and ${fresh.length - 3} more events`,
      { type: 'calendar_import' },
    ).catch(() => {});
  }
  await AsyncStorage
    .setItem(ANNOUNCED_KEY, JSON.stringify([...seen, ...fresh.map((t) => t.id)].slice(-300)))
    .catch(() => {});
}

/** "today" / "tomorrow" / "23.9" — rule 4: anything dated shows its date. */
function dayLabel(date: string, he: boolean): string {
  const today = getTodayString();
  if (date === today) return he ? 'היום' : 'today';
  const t = new Date(`${today}T12:00:00`);
  t.setDate(t.getDate() + 1);
  const tomorrow = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  if (date === tomorrow) return he ? 'מחר' : 'tomorrow';
  const [, m, d] = date.split('-').map(Number);
  return `${d}.${m}`;
}

// ---------------------------------------------------------------------------
// Background (app closed)
// ---------------------------------------------------------------------------

/**
 * Defined at module scope on purpose: expo-task-manager requires the handler
 * to be registered during the JS bundle's first evaluation, because a headless
 * launch runs the bundle and then looks the task up by name. Registering it
 * inside a component or an effect means the handler does not exist yet when
 * Android starts us, and the job silently no-ops.
 */
if (!isExpoGo()) {
  try {
    if (!TaskManager.isTaskDefined(CALENDAR_BACKGROUND_TASK)) {
      TaskManager.defineTask(CALENDAR_BACKGROUND_TASK, async () => {
        try {
          const settings = await getSettings().catch(() => null);
          const result = await runCalendarSync(settings?.language, {
            force: true,
            announce: true,
            reason: 'background',
          });
          if (result.error) {
            console.warn('[CalendarAutoSync] background run: google said', result.error);
          }
          return BackgroundTask.BackgroundTaskResult.Success;
        } catch (e) {
          console.warn('[CalendarAutoSync] background task threw', e);
          return BackgroundTask.BackgroundTaskResult.Failed;
        }
      });
    }
  } catch (e) {
    console.warn('[CalendarAutoSync] could not define background task', e);
  }
}

/**
 * Ask Android to run us periodically. Idempotent — re-registering an existing
 * task just updates its interval.
 *
 * Returns what actually happened, in words, because "background sync is on"
 * is precisely the kind of claim that was false for weeks elsewhere in this
 * app. The user-visible surface prints this, it does not assume it.
 */
export async function registerBackgroundCalendarSync(): Promise<
  { ok: true; intervalMinutes: number } | { ok: false; reason: string }
> {
  if (isExpoGo()) return { ok: false, reason: 'expo_go' };
  try {
    const status = await BackgroundTask.getStatusAsync();
    if (status === BackgroundTask.BackgroundTaskStatus.Restricted) {
      return { ok: false, reason: 'restricted_by_os' };
    }
    await BackgroundTask.registerTaskAsync(CALENDAR_BACKGROUND_TASK, {
      minimumInterval: BACKGROUND_INTERVAL_MINUTES,
    });
    return { ok: true, intervalMinutes: BACKGROUND_INTERVAL_MINUTES };
  } catch (e) {
    const reason = String((e as Error)?.message || e).slice(0, 200);
    console.warn('[CalendarAutoSync] background registration failed', reason);
    return { ok: false, reason };
  }
}

/** Is the periodic job actually registered with Android right now? */
export async function backgroundSyncRegistered(): Promise<boolean> {
  if (isExpoGo()) return false;
  return TaskManager.isTaskRegisteredAsync(CALENDAR_BACKGROUND_TASK).catch(() => false);
}

// ---------------------------------------------------------------------------
// Foreground
// ---------------------------------------------------------------------------

let started = false;
let appStateSub: { remove: () => void } | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;

/**
 * Wire up the foreground triggers and the background job. Call once, from the
 * app root — NOT from a screen, because the screen she is on must not decide
 * whether her calendar is being read.
 */
export function startCalendarAutoSync(lang?: AppLanguage): void {
  if (started) return;
  started = true;

  const maybeSync = async (reason: string) => {
    const last = await lastSyncAt();
    if (Date.now() - last < FOREGROUND_STALE_MS) return;
    await runCalendarSync(lang, { force: true, announce: true, reason });
  };

  const onChange = (state: AppStateStatus) => {
    if (state === 'active') {
      maybeSync('foreground').catch((e) =>
        console.warn('[CalendarAutoSync] foreground sync failed', e));
    }
  };
  appStateSub = AppState.addEventListener('change', onChange);

  heartbeat = setInterval(() => {
    if (AppState.currentState !== 'active') return;
    runCalendarSync(lang, { force: true, announce: true, reason: 'heartbeat' })
      .catch((e) => console.warn('[CalendarAutoSync] heartbeat sync failed', e));
  }, FOREGROUND_INTERVAL_MS);

  // The launch itself counts as coming to the foreground.
  maybeSync('launch').catch((e) => console.warn('[CalendarAutoSync] launch sync failed', e));

  registerBackgroundCalendarSync().then((r) => {
    if (!r.ok) console.warn('[CalendarAutoSync] background sync is OFF:', r.reason);
  });
}

/** Tear down — for tests and for a full sign-out. */
export function stopCalendarAutoSync(): void {
  appStateSub?.remove();
  appStateSub = null;
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
  started = false;
}
