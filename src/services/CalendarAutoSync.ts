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
import { backgroundRun as backgroundQuestions, checkTripOrigin } from './QuestionService';
import { nudgeAboutChanges } from './ChangeNudgeService';
import { AppState, AppStateStatus } from 'react-native';
import AsyncStorage from './EncryptedStorage';  // AES-256-GCM at rest (7.10)
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
import { syncDeviceCalendars, type DeviceCalendarResult } from './DeviceCalendarSync';
import { syncOutlook, type OutlookSyncResult } from './OutlookService';
import { getTodayString, isExpoGo, timeToMinutes } from '../utils/timeUtils';
import { keepNextTripLive, lateNotifiedRecently, markArrivals, markLateNotified } from './LiveRoute';
import { stillHereAlert } from '../utils/stillHere';
import { isHighStakes } from '../utils/travelLadder';
import { loadProfile } from './UserProfileStorage';
import { nextTrip } from '../utils/liveRoutePlan';
import { timeOf } from '../utils/dayPlanning';
import { upcomingEventBriefs, upcomingInterviewBriefs } from './MeetingBriefService';
import { focusTick } from './FocusBypassService';
import { syncGeofences } from './GeofenceService';
import { historyTick } from './HistoryService';
import { groupTick } from './GroupService';
import { transitAlertTick } from './TransitAlertService';
import { overlapTick } from './OverlapNotifyService';
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
  /** The phone's own calendars (Outlook app, Samsung, work, family). */
  device?: DeviceCalendarResult;
  /** Outlook / Teams through Microsoft Graph. */
  outlook?: OutlookSyncResult;
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
    let device: DeviceCalendarResult | undefined;
    let outlook: OutlookSyncResult | undefined;
    try {
      added = await syncCalendarToday(language, opts.force ?? true);
      // Every other calendar she keeps, BEFORE the travel chain, so their
      // events get a route, a leave time and an alarm on this same run.
      device = await syncDeviceCalendars(language);
      outlook = await syncOutlook(language);
      added += (device.added || 0) + (outlook.added || 0);
      // Two events at one hour (new this run, or booked days ago and never told):
      // one push naming Meira's pick. Run BEFORE the slow steps below (routes,
      // briefs, cloud round trips) — on the phone those took minutes and the
      // check never got its turn. Same every-path trigger; never fails a sync.
      const overlap = await overlapTick(language, await getAllTasks().catch((e) => {
        console.warn('[CalendarAutoSync] overlap check could not read tasks', String((e as Error)?.message || e).slice(0, 120));
        return [] as Task[];
      }));
      if (overlap.error) console.warn('[CalendarAutoSync] overlap notify:', overlap.error);
      const today = getTodayString();
      await ensureTravelChain(today, language).catch((e) => {
        console.warn('[CalendarAutoSync] travel chain (today) failed', e);
      });
      await ensureTravelChainAhead(language).catch((e) => {
        console.warn('[CalendarAutoSync] travel chain (ahead) failed', e);
      });
      // Tomorrow's route was just (re)built from HOME. If the phone says she is
      // somewhere else, that is the moment to ask where she will leave from
      // (kinds/tripOrigin) — foreground, heartbeat, pull-to-refresh, and the
      // closed-app task (where backgroundQuestions turns it into a nudge).
      await checkTripOrigin(opts.reason ?? 'calendar-sync');
      // An interview today or in the next two days: its brief (company, job,
      // questions reported there) is fetched now, cached and deduped, so it is
      // ready the evening before without her opening Today (17.10). Every sync
      // path — launch, foreground, heartbeat, pull-to-refresh, closed-app task.
      const briefs = await upcomingInterviewBriefs().catch((e) => ({ briefs: [], error: String(e) }));
      if (briefs.error) console.warn('[CalendarAutoSync] interview brief prefetch:', briefs.error);
      // EVERY other calendar event of tomorrow (and the rest of today): who the
      // call is with, and what was covered last time (18.10, Koral: a brief the
      // day before is mandatory for every event). Same triggers as above; the
      // server refuses an event with nobody to look up without a model call.
      const events = await upcomingEventBriefs().catch((e) => ({ briefed: 0, error: String(e) }));
      if (events.error) console.warn('[CalendarAutoSync] event brief prefetch:', events.error);
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

    // Study sessions (17.10): the alarms that start "block WhatsApp and Instagram" at each study
    // task's hour are set here, on EVERY sync path (launch, foreground, heartbeat, pull-to-refresh
    // and the closed-app WorkManager job) — and a bypass the native side noticed while the app was
    // closed is collected, and notified when nobody is looking. Never lets a sync fail.
    try {
      const focus = await focusTick(language, opts.reason ?? 'calendar-sync');
      if (focus.error) console.warn('[CalendarAutoSync] focus tick:', focus.error);
    } catch (e) {
      console.warn('[CalendarAutoSync] focus tick failed', e);
    }

    // Location × calendar (28.10): she is still here and the next meeting is
    // elsewhere. App open: re-plan from where she stands and, if late, ask
    // (LiveRoute: still going / move / cancel). App closed: decided on the phone
    // only, no route (utils/stillHere). Before, only Today's screen ran this, so
    // with the chat as home it rarely ran at all (rule 7).
    try {
      const trip = await tripCheck(language);
      if (trip !== 'ok' && trip !== 'no_trip') console.warn('[CalendarAutoSync] trip check:', trip);
    } catch (e) {
      console.warn('[CalendarAutoSync] trip check failed', e);
    }

    // Nearby errands (28.10): Android drops geofences on reboot and permission changes, so they
    // are re-set on every sync path, the closed-app job included. Only when she turned them on.
    try {
      const fences = await syncGeofences();
      if (!fences.ok && fences.reason !== 'off') console.warn('[CalendarAutoSync] geofences:', fences.reason);
    } catch (e) {
      console.warn('[CalendarAutoSync] geofence sync failed', e);
    }

    // Her opt-in history (20.10): send what changed, log a running study
    // session, and say what is due — Sunday's week, Wednesday's nudge, the 3rd
    // move of one task. Every sync path, including the closed-app job.
    try {
      const h = await historyTick(language);
      if (h.error) console.warn('[CalendarAutoSync] history:', h.error);
    } catch (e) {
      console.warn('[CalendarAutoSync] history tick failed', e);
    }

    // Find time together (20.10): new invites, one 24h reminder, and "everyone
    // answered" for a group she organizes. Every sync path; never fails a sync.
    try {
      const g = await groupTick(language);
      if (g.error) console.warn('[CalendarAutoSync] groups:', g.error);
    } catch (e) {
      console.warn('[CalendarAutoSync] group tick failed', e);
    }

    // Disruptions on the way (20.10): a trip leaving within the hour gets a news
    // check — roadworks, closed lines, strikes — and a push if something new
    // turned up. Same every-path trigger as above; never fails a sync.
    try {
      const transit = await transitAlertTick(language);
      if (transit.error) console.warn('[CalendarAutoSync] transit alerts:', transit.error);
    } catch (e) {
      console.warn('[CalendarAutoSync] transit alerts failed', e);
    }

    const newTasks = all.filter((t) => !before.has(t.id) && (t as any).source === 'calendar');
    await AsyncStorage.setItem(LAST_SYNC_KEY, String(Date.now())).catch(() => {});

    const result: CalendarSyncResult = {
      added,
      error: lastCalendarFailure(),
      newTasks,
      ran: true,
      device,
      outlook,
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
/**
 * The next trip, re-checked from where she is. Never prompts for permission:
 * in the foreground it needs location, with the app closed "all the time"
 * (granted when she turned on location alerts). Returns why it did not run.
 */
const TRIP_CHECK_KEY = 'tripcheck.lastRun.v1';
async function tripCheck(language?: AppLanguage): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Location = require('expo-location') as typeof import('expo-location');
  const fg = await Location.getForegroundPermissionsAsync();
  if (!fg.granted) return 'no_permission';
  if (AppState.currentState !== 'active') {
    const bg = await Location.getBackgroundPermissionsAsync();
    if (!bg.granted) return 'no_background_permission';
  }
  const today = getTodayString();
  const tasks = (await getAllTasks()).filter((t) => t.date === today && t.status === 'pending');
  // Only a trip that is coming up (a place AND an hour, within 3 h) is worth a GPS fix.
  const now = new Date();
  const trip = nextTrip(tasks, now);
  const at = trip ? timeOf(trip) : null;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  if (!trip || !at || timeToMinutes(at) - nowMin > 180) return 'no_trip';
  // Closed app: a fresh JS run every ~15 min forgets LiveRoute's in-memory cooldown,
  // so the background keeps its own — once per trip per 30 min, or Google is asked every run.
  const background = AppState.currentState !== 'active';
  if (background) {
    const raw = await AsyncStorage.getItem(TRIP_CHECK_KEY).catch(() => null);
    const last: Record<string, number> = (() => { try { return raw ? JSON.parse(raw) : {}; } catch { return {}; } })();
    if (last[trip.id] && now.getTime() - last[trip.id] < 30 * 60_000) return 'cooldown';
    last[trip.id] = now.getTime();
    for (const [k, t] of Object.entries(last)) if (now.getTime() - t > 24 * 3600_000) delete last[k];
    await AsyncStorage.setItem(TRIP_CHECK_KEY, JSON.stringify(last))
      .catch((e) => console.warn('[CalendarAutoSync] trip-check stamp not saved', e));
  }
  const fresh = await Location.getLastKnownPositionAsync({ maxAge: 10 * 60_000 }).catch(() => null);
  const pos = fresh ?? await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
  if (background) {
    // App closed: decided on the phone, nothing routed — her background position never
    // leaves the device (the consent she gave in Profile › Alerts). See utils/stillHere.
    const profile: any = await loadProfile();
    const home = profile?.homeLatLng ?? null;
    const he = language === 'he';
    const alert = stillHereAlert(trip, { lat: pos.coords.latitude, lng: pos.coords.longitude }, home, now, he);
    if (!alert) return 'ok';
    if (await lateNotifiedRecently(trip.id, now.getTime())) return 'already_asked';
    await sendImmediate(alert.title, alert.body, { taskId: trip.id, type: 'running-late' },
      isHighStakes(trip) ? 'cannot-be-late' : 'running-late');
    await markLateNotified(trip.id, now.getTime());
    return 'ok';
  }
  const live = await keepNextTripLive(tasks, await loadProfile(), {
    current: { lat: pos.coords.latitude, lng: pos.coords.longitude }, notify: true, language,
  });
  return live.replanned ? 'ok' : live.reason === 'no-trip' ? 'no_trip' : 'ok';
}

/** Today's tasks she has reached, ticked — the closed-app trigger (rule 7). */
async function backgroundArrivals(language?: AppLanguage): Promise<void> {
  const today = getTodayString();
  const tasks = (await getAllTasks()).filter((t) => t.date === today && t.status === 'pending');
  if (!tasks.length) return;
  const { arrived } = await markArrivals(tasks, { language });
  if (arrived.length) console.warn(`[CalendarAutoSync] background: arrived at ${arrived.length} task(s)`);
}

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
          // Meira's questions while the app is closed: answers that waited for a
          // connection are sent, and an open question nudges at most once a day.
          await backgroundQuestions().catch((e) => console.warn('[CalendarAutoSync] questions run failed', e));
          // The calendar moved something while the app was closed: one knock, never at night,
          // at most two per change (utils/changeNudge). The card is waiting on Today.
          await nudgeAboutChanges(settings?.language ?? 'en')
            .then((r) => { if (r !== 'nothing') console.warn('[CalendarAutoSync] change nudge:', r); })
            .catch((e) => console.warn('[CalendarAutoSync] change nudge failed', e));
          // Arrived while the app was closed: it is done (16.10). Best effort —
          // a background location fix can be refused; that is said, not swallowed.
          await backgroundArrivals(settings?.language)
            .catch((e) => console.warn('[CalendarAutoSync] arrival sweep failed', e));
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
