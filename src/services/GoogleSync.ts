/**
 * GoogleSync — the Google side of the day: pulls Calendar events for the week
 * ahead into tasks, scans Gmail (tight, event-focused query) for appointments
 * that are NOT on the calendar yet and offers them for approval (accepting
 * writes the event back to Google Calendar), routes every located stop of a day
 * chained home → stop → stop with traffic-aware refresh (ensureTravelChain),
 * and flags the week's clashes (analyzeWeek).
 * Client-side only; nothing here touches the Fly server.
 *
 * Patterns reused:
 * - mergeExternalTasks (TaskStorage) — idempotent inflow by stable id, same as
 *   WhatsAppTaskSync ('gcal-<eventId>' / 'gmail-<msgId>' never duplicate).
 * - scheduleTaskReminders / scheduleTransitNotifications — same alerts every
 *   other creation path gets, incl. location-aware leave-by when we can route.
 *
 * Consumed by TodaySchedule (fire-and-forget on load) and ProfileEditScreen
 * (connect state). All functions are best-effort and never throw.
 */
import AsyncStorage from './EncryptedStorage';  // AES-256-GCM at rest (7.10)
import { GMAIL_ENABLED } from '../utils/gmailAccess';
import { GoogleService } from './GoogleService';
import { emailsToEvents } from './LumiServer';
import {
  mergeExternalTasks, addTask, getAllTasks, getTasksForDate, updateTaskFields,
  getDismissedExternalIds, reconcileExternalTask, deleteTasks,
} from './TaskStorage';
import { loadProfile } from './UserProfileStorage';
import {
  calendarEventToTask, withoutDuplicates, type CalendarProvider,
} from '../utils/calendarEventTask';
import {
  missingPrepTasks, isInterview, departureTimeOf, runawayPrepIds, twinPrepIds,
} from '../utils/interviewPrep';
import {
  pickByPreference, tierNote, marginNote, vehicleOf, arrivalBufferFor,
  type RankedChoice,
} from '../utils/transitFallback';
import {
  type RouteFailure, networkFailure, worstFailure, failureLogLine,
} from '../utils/routeFailure';
import { normalizeProfile } from '../utils/profileShape';
import { checkPlan } from '../utils/planIntegrity';
import {
  armTaskAlerts, scheduleTaskReminders, scheduleTransitNotifications, cancelTaskNotifications,
  withTaskAlertLock,
} from './NotificationService';
import { getTodayString, getTomorrowString, timeToMinutes, subtractMinutes } from '../utils/timeUtils';
// Pure planning decisions (conflict detection, email-vs-calendar matching) live
// in utils/dayPlanning so they can be unit-tested outside the Expo runtime.
import { locOf, addrOf, timeOf, sortTimed, dayWarnings, alreadyScheduled, pickNextUpcoming } from '../utils/dayPlanning';
import { feasibilityOptionsOf } from '../utils/dayFeasibility';
import {
  compactSteps, hasCarOf, isHighStakes, ladderNote, rungMode, straightKm, vehicleLeftBehind, walkLadder,
} from '../utils/travelLadder';
import { isMeetingLink } from '../utils/meetingLink';
import { pickCoords, needsGeocode, locationIsPlaced } from '../utils/placeCoords';
import { learnPlace } from './KnownPlacesStore';
import { unplacedFailure } from '../questions/kinds/place';
import { modeFor } from './TravelPreferenceStore';
import { completeAddress, completeDestination } from '../utils/addressCompletion';
import { geocodeTaskLocation } from './NearbyTaskReminderService';
import { getLastKnownLocation } from './LocationService';
import { DayStart, StartKind, sameOrigin, startLine, tripStart, TripStart } from '../utils/tripStart';
import { getDayStart } from './DayStartStore';
import { decideAlarmState } from './AlarmPlanner';
import { dayWakeOwner } from '../utils/alarmPlan';
import {
  Task, AppLanguage, GapSuggestion, UserProfile, TaskLocation, TransportType, TransitPlan,
} from '../types/index';
import { describeChange } from '../utils/changeRecord';
import { CalendarPrefix, describeCancel, judgeDay, MissLog } from '../utils/cancelledEvents';
import { recordChange } from './ChangeRecordStore';

const GMAIL_SCAN_KEY = 'lumi.gmailScan.v1';          // last scan date (once/day)
const GMAIL_CACHE_KEY = 'lumi.gmailSuggestions.v1';  // cached suggestions for today
const GMAIL_DISMISSED_KEY = 'lumi.gmailDismissed.v1'; // dismissed suggestion ids

// Calendar pull throttle (per app session): the Today screen refocuses often.
let lastCalendarSyncAt = 0;
/**
 * Why the last calendar pull came back empty, or null when Google answered.
 *
 * Kept so the Profile check can say WHICH of "you have nothing booked" and
 * "Google refused us" is true. They were the same sentence until now.
 */
let lastCalendarError: string | null = null;
/** Per Google account: the last refusal, so the Calendars screen can name WHICH account failed. */
const lastCalendarErrors: Record<string, string> = {};

/** The last calendar failure of each Google account (address → Google's words). */
export function calendarErrorsByAccount(): Record<string, string> {
  return { ...lastCalendarErrors };
}
const CALENDAR_SYNC_INTERVAL_MS = 30 * 60 * 1000;

/**
 * How far ahead calendar events are imported.
 *
 * This was 7 days, which meant an event booked further out simply did not
 * exist in Lumi until the week it happened — a conference on Sept 2 was
 * invisible until Aug 27, so there was nothing to plan travel for and no
 * day-before warning could ever be scheduled. A month covers the horizon
 * people actually book appointments on.
 */
const CALENDAR_SYNC_DAYS = 30;

/**
 * How far ahead travel is actually routed. Was 7, which meant an interview
 * booked twelve days out had no route, no leave time and no alarm until the
 * week it happened. Matches the calendar import horizon so anything imported
 * also gets planned. Google returns schedules and traffic estimates for future
 * dates; the near-term refresh below re-checks them as the day approaches.
 */
const TRAVEL_PLAN_DAYS = 30;


/**
 * Reminders for a newly imported fixed-time task.
 * Travel alerts are NOT scheduled here: ensureTravelChain routes every located
 * task of the day from the PREVIOUS place (not always from home) and owns the
 * wake/leave alerts. Scheduling them here too produced two leave-home alerts,
 * the earlier one computed from a wrong origin.
 */
async function scheduleImportedTask(task: Task, lang: AppLanguage): Promise<void> {
  try {
    await armTaskAlerts(task, lang);
  } catch (e) {
    console.warn('[GoogleSync] reminder scheduling failed', e);
  }
}

/**
 * Pull one date's Google Calendar events into the task list (source
 * 'calendar'). Returns how many NEW tasks were added. Never throws.
 */
export async function syncCalendarForDate(date: string, lang: AppLanguage): Promise<number> {
  try {
    if (!(await GoogleService.isGoogleConnected())) {
      lastCalendarError = 'not_connected';
      return 0;
    }

    // Every account she connected for its calendar (private AND work, 6.10),
    // each failing on its own: one refused token must not hide the other's day.
    const accounts = (await GoogleService.listGoogleAccounts()).filter((a) => a.calendar);
    const tasks: Task[] = [];
    let failed = false;
    for (const account of accounts.length ? accounts : [null]) {
      const label = account?.email || '';
      const { events, allDay, error } = await GoogleService.fetchCalendarEvents(date, account?.email || undefined);
      // Only a real failure is remembered. A day that genuinely has nothing on
      // it must not overwrite the 403 we learned about yesterday's day.
      if (error) {
        failed = true;
        lastCalendarErrors[label] = error;
        lastCalendarError = label ? `${label}: ${error}` : error;
      } else {
        delete lastCalendarErrors[label];
      }
      tasks.push(...[...events, ...(allDay || [])].filter((e) => e.title)
        .map((e) => calendarEventToTask(e, date, 'google', label ? { calendarName: label } : {})));
    }
    if (!failed && lastCalendarError && lastCalendarError !== 'not_connected') lastCalendarError = null;
    // Google ANSWERED for this day (every account): an event it no longer lists is a cancelled one.
    // Before the early return below — a day whose every event was cancelled returns no tasks at all.
    if (!failed) await noteCancellationsFor('gcal-', [date], new Set(tasks.map((t) => t.id)), accounts.map((a) => a.email).join('|'), tasks);
    if (!tasks.length) return 0;
    // The same meeting invited to both accounts has one Google id — merged by id.
    return await importCalendarTasks(tasks, lang, 'google');
  } catch (e) {
    lastCalendarError = `sync: ${String((e as Error)?.message || e).slice(0, 200)}`;
    console.warn('[GoogleSync] calendar sync failed', e);
    return 0;
  }
}

const MISS_KEY = 'lumi.calendarMisses.v1';
const ACCOUNTS_KEY = 'lumi.calendarAccounts.v1';

/**
 * An event a calendar no longer lists (cancelled) becomes a card on Today — after it has been gone
 * from TWO syncs of the same day, and only ever to ASK (utils/cancelledEvents). One calendar at a
 * time (`prefix`): Google reads a day at a time, the phone's calendars and Outlook a month in one
 * go — they pass every date they covered. ONLY call this when that calendar ANSWERED (no failed
 * account). `sourceKey` names what was read (accounts / calendar ids): when it changes, the count
 * restarts, so a disconnected account is not a wave of cancellations. Triggers: every sync path
 * (launch, foreground, heartbeat, pull-to-refresh, the closed-app job, picking a day).
 * A failure here is a warning, never a failed sync (rule 2).
 */
export async function noteCancellationsFor(
  prefix: CalendarPrefix, dates: string[], fetchedIds: Set<string>, sourceKey: string, fetched: Task[] = [],
): Promise<void> {
  try {
    const accountsKey = `${ACCOUNTS_KEY}:${prefix}`;
    const lastSource = await AsyncStorage.getItem(accountsKey);
    if (lastSource !== sourceKey) {
      await AsyncStorage.setItem(accountsKey, sourceKey);
      await AsyncStorage.setItem(`${MISS_KEY}:${prefix}`, '{}');
      if (lastSource !== null) return;
    }
    const all = await getAllTasks();
    let log: MissLog = JSON.parse((await AsyncStorage.getItem(`${MISS_KEY}:${prefix}`)) || '{}');
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const today = getTodayString();
    const gone: Task[] = [];
    for (const date of dates) {
      const r = judgeDay(all, fetchedIds, date, today, hhmm, log, prefix, fetched);
      log = r.log;
      gone.push(...r.cancelled);
    }
    await AsyncStorage.setItem(`${MISS_KEY}:${prefix}`, JSON.stringify(log));
    // Only when something is being tracked: the line that says "an event is missing, 1 of 2" (rule 1 — an
    // absence being counted must be visible somewhere, or a check that never fires looks like one that works).
    const tracked = Object.keys(log).length;
    if (tracked || gone.length) console.warn(`[GoogleSync] ${prefix} cancel-check: ${tracked} missing once, ${gone.length} confirmed gone`);
    for (const ev of gone) {
      const rec = describeCancel(ev, all, today, hhmm);
      if (!rec) continue;
      const noted = await recordChange(rec, today);
      if (noted.error) console.warn('[GoogleSync] cancellation card not saved:', noted.error);
      else console.warn(`[GoogleSync] ${prefix} ${ev.date}: an event is gone from its calendar — card raised`);
    }
  } catch (e) {
    console.warn('[GoogleSync] cancellation check failed', e);
  }
}

/**
 * Land a batch of calendar events as tasks: merge → refresh → reconcile →
 * interview prep. Shared by every calendar Meira reads (Google, the phone's
 * own calendars, Outlook), so an event is handled the same way whichever app
 * she booked it in. Returns how many rows were added or corrected.
 *
 * The same meeting seen through two calendars (Outlook mirrored into Google)
 * is imported once — `withoutDuplicates`, logged at warn so a dropped event
 * is never a silent one.
 */
export async function importCalendarTasks(
  incoming: Task[],
  lang: AppLanguage,
  provider: CalendarProvider,
): Promise<number> {
  const store = await getAllTasks();
  const { kept: tasks, duplicates } = withoutDuplicates(incoming, store);
  if (duplicates.length) {
    console.warn(`[CalendarImport] ${provider}: ${duplicates.length} already in the day from another calendar:`,
      duplicates.map((t) => `${t.date} ${t.fixedTime} ${t.text}`).join(' | '));
  }
  if (!tasks.length) return 0;
  // Snapshot existing ids BEFORE the merge so only genuinely new imports
  // get alerts (re-scheduling existing ones would duplicate notifications).
  const existingIds = new Set(store.map((t) => t.id));
  const added = await mergeExternalTasks(tasks);
  if (added > 0) {
    for (const t of tasks) {
      if (!existingIds.has(t.id) && t.fixedTime) scheduleImportedTask(t, lang);
    }
  }
  // An event that was ALREADY imported is skipped by mergeExternalTasks — it
  // matches on id and moves on — so for the whole life of the task Lumi kept
  // whatever Google said the first time. An organiser moving an interview by
  // an hour, or adding the address they forgot, changed nothing here and the
  // old alarm stayed armed for the old hour. Re-read the ones we already have.
  await refreshImportedTasks(tasks, lang);
  // The authority, and it runs BEFORE prep blocks are derived — those are
  // built from the stored interview, so the stored interview has to be right
  // first. Whatever the two passes above declined to touch, this makes match
  // Google, including a row whose date is wrong: nothing else in this file
  // has ever been able to fix that.
  const report = await reconcileCalendarTasks(tasks, lang);
  await ensureInterviewPrep(lang);
  return added + report.inserted + report.updated;
}

/**
 * An interview on the calendar means preparation days — required, not offered.
 *
 * Her rule, in her words: "מאירה מחייבת!!! ללמוד יומיים לפני". So this is not
 * a gap-filler suggestion she can ignore into existence; the blocks are
 * created as `must`, the same way the interview itself is.
 *
 * Runs after every import, which is every 15 minutes forever — which is
 * exactly why `missingPrepTasks` keys on ids derived from the interview. Two
 * blocks are created once and then recognised, never re-created, and any edit
 * she makes to them survives, because they are matched by id and not by
 * regeneration.
 *
 * Deliberately scans the WHOLE store and not just this date's import: the
 * interview that needs preparing may have been imported days ago, and its
 * prep days may be today.
 */
/**
 * Remove the prep blocks no interview earns any more — no network, no model.
 * Its own trigger: the day she LOOKS at (Today), because the calendar sync
 * that also runs it is throttled and silent when it succeeds (5.10: two
 * "Prep for…" blocks stayed on Tuesday through two installs). Returns how
 * many went, so the screen redraws only when something changed.
 */
export async function sweepStalePrep(): Promise<number> {
  const all = await getAllTasks();
  const stale = [...new Set([...runawayPrepIds(all), ...twinPrepIds(all, getTodayString())])];
  if (!stale.length) return 0;
  const gone = await deleteTasks(stale).catch((e) => {
    console.warn('[GoogleSync] prep sweep could not delete', e);
    return 0;
  });
  console.warn(`[GoogleSync] swept ${gone} prep block(s) no interview earns: ${stale.slice(0, 3).join(', ')}`);
  return gone;
}

async function ensureInterviewPrep(lang: AppLanguage): Promise<number> {
  try {
    const today = getTodayString();
    let all = await getAllTasks();

    // Clear up after the runaway before deriving anything new.
    //
    // A prep block's own title contains the word "interview", so the rule
    // matched its own output and prepared for the preparation. It terminated
    // by accident while every generated day was in the past; the morning block
    // lands on the SAME day, so it stopped terminating and minted another
    // level every sync — five at a time, four hours of her Wednesday.
    // isInterview now refuses a prep block outright, and these are the ones
    // already written to her store. They cannot be hers: nothing but this file
    // has ever minted a `prep-<n>d-` id.
    const runaway = runawayPrepIds(all);
    if (runaway.length) {
      const gone = await deleteTasks(runaway).catch(() => 0);
      console.warn(
        `[GoogleSync] removed ${gone} runaway prep block(s) — prep minted for prep`
        + `: ${runaway.slice(0, 3).join(', ')}`,
      );
      all = await getAllTasks();
    }
    // The second set for one meeting: her typed row and the calendar's, one
    // hour, each given its own blocks (5.10 — two "Prep for…" at 19:00).
    const twins = twinPrepIds(all, today);
    if (twins.length) {
      const gone = await deleteTasks(twins).catch(() => 0);
      console.warn(`[GoogleSync] removed ${gone} prep block(s) minted for a twin of the same meeting`
        + `: ${twins.slice(0, 3).join(', ')}`);
      all = await getAllTasks();
    }

    // Only interviews still ahead of us. Preparing for one that has happened
    // is not a task, it is a row in the overdue card reproaching her.
    const upcoming = all.filter((t) => t.date >= today && t.status !== 'complete');
    const now = new Date().toTimeString().slice(0, 5);
    const prep = missingPrepTasks(upcoming, all, { lang, today, now });
    // Rule 1: an absent morning block and a satisfied one must not look alike.
    // The morning of the interview is measured backwards from `leaveHomeBy`,
    // so an interview whose route has not been computed yet gets no morning
    // block — correctly, and silently, until this line.
    for (const t of upcoming) {
      if (!isInterview(t) || departureTimeOf(t)) continue;
      console.warn(
        `[GoogleSync] no morning prep for "${t.text.slice(0, 30)}" on ${t.date}`
        + ' — no leaveHomeBy yet; it appears once the route is computed',
      );
    }
    if (!prep.length) return 0;
    // fuzzyMerge: false — these are keyed by a DERIVED id, which is the whole
    // idempotence design. Letting the store fold one into a row that merely
    // reads like it means the id is never stored, so the next sync asks for it
    // again: four blocks "created" every fifteen minutes and none of them kept.
    const created = await mergeExternalTasks(prep, { fuzzyMerge: false });
    if (created > 0) {
      console.warn(`[GoogleSync] created ${created} interview prep block(s)`);
      for (const p of prep) {
        if (p.scheduledTime) scheduleImportedTask(p, lang);
      }
    }
    return created;
  } catch (e) {
    // Rule 2: the throw may be swallowed, the reason may not.
    console.warn('[GoogleSync] interview prep failed', e);
    return 0;
  }
}

/**
 * What the last reconcile pass did. Read by `calendarDiagnostics` so the
 * Profile check can answer "Google has it — where is it?" in one sentence
 * instead of leaving two numbers to be stared at.
 */
export interface CalendarReconcileReport {
  /** Events Google returned on this pass. */
  seen: number;
  inserted: number;
  updated: number;
  unchanged: number;
  /** Tombstoned: deleted in-app, so deliberately not resurrected. */
  blocked: number;
  /** Already ticked off; Google does not get to reopen them. */
  complete: number;
  failed: number;
  /** One line per event that was NOT simply already correct. */
  notes: string[];
}

let lastReconcile: CalendarReconcileReport | null = null;

/** What the last reconcile pass did, or null if one has not run yet. */
export function lastCalendarReconcile(): CalendarReconcileReport | null {
  return lastReconcile;
}

/**
 * Make the store match Google. The pass that cannot be dodged.
 *
 * `mergeExternalTasks` is an ADD — `if (ids.has(t.id)) continue` — and
 * `refreshImportedTasks` only touches rows still stamped `source: 'calendar'`.
 * Between those two guards is a hole an event can fall into and never come out
 * of: a row whose id is known but whose date is wrong, or whose provenance
 * stamp was lost, is skipped by BOTH, and neither says a word.
 *
 * The Ceva interview lived in that hole. Google returned it, the app's own
 * check reported "1 event(s) found", and every sync imported 0 — for days,
 * with no error anywhere, because nothing was failing. Two functions were
 * politely declining.
 *
 * So this runs after them and answers to neither: for every event Google
 * returned, the stored row is made to match, by id, including the DATE. If no
 * row exists, one is inserted with the Google id intact, so the next pass
 * recognises it instead of adding a second copy.
 */
async function reconcileCalendarTasks(
  incoming: Task[],
  lang: AppLanguage,
): Promise<CalendarReconcileReport> {
  const report: CalendarReconcileReport = {
    seen: incoming.length,
    inserted: 0, updated: 0, unchanged: 0, blocked: 0, complete: 0, failed: 0,
    notes: [],
  };
  // Read once: the location rule below needs to see what the row already has.
  const existing = await getAllTasks().catch(() => [] as Task[]);
  const byId = new Map(existing.map((t) => [t.id, t]));

  for (const fresh of incoming) {
    try {
      const current = byId.get(fresh.id)
        ?? existing.find((t) => fresh.calendarEventId
          && t.calendarEventId === fresh.calendarEventId);

      // What Google owns on a calendar row.
      //
      // `category` and `meetingUrl` are on this list because of the interview.
      // The row had been created back when any URL in the invitation body
      // counted as a join link, so a Google MAPS link made it category 'zoom'
      // — and a zoom task is REMOTE, so departureOf returns undefined and the
      // whole travel chain is skipped. Correcting the date alone left an
      // in-person interview in Ra'anana that the app was certain she could
      // attend from her sofa: no route, no leave-home time, no wake alarm,
      // and a 💻 on the card.
      // ONLY fields that survive a round trip through storage may be
      // reconciled. `attendees` did not: it is not a column in Supabase and
      // not in taskToRow, so every push dropped it, cloud hydration returned a
      // row without it, and the next reconcile "corrected" it again — writing
      // the row and pushing it, every 15 minutes, forever, over nothing.
      //
      // sameValue was taught to compare arrays by value, which was necessary
      // and not sufficient: the two sides were genuinely different every time,
      // because one of them kept being erased. A reconcile of a field that
      // cannot be stored cannot converge, whatever the comparison does.
      //
      // run-reconcile-persistence asserts this list against taskToRow so the
      // next field added here cannot reintroduce the loop.
      const owned: string[] = [
        'date', 'fixedTime', 'scheduledTime', 'durationMinutes', 'text',
        'category', 'meetingUrl',
      ];
      // The address, ONLY when the stored row has nothing better. Once a place
      // is geocoded or confirmed, that copy carries the coordinates and the
      // route; replacing it with the raw string Google hands back would throw
      // both away to re-derive them.
      if (!addrOf(current as Task) && !locationIsPlaced((current as any)?.location)) {
        owned.push('location', 'hasLocation');
      }

      const { outcome, changed, before } = await reconcileExternalTask(
        fresh,
        owned,
        // Google is allowed to take a join link back OFF a row. Without this a
        // stale meetingUrl — like the map link above — is permanent.
        ['meetingUrl'],
      );
      report[outcome] += 1;

      if (outcome === 'inserted') {
        report.notes.push(`added "${fresh.text}" on ${fresh.date}`);
        if (fresh.fixedTime) await scheduleImportedTask(fresh, lang);
      } else if (outcome === 'updated') {
        report.notes.push(
          `corrected "${fresh.text}": ${changed.join(', ')}`
          + (before && before.date !== fresh.date ? ` (was on ${before.date})` : ''),
        );
        // The hour or the day moved, so anything armed for the old one is now
        // wrong. A wake alarm for a meeting that no longer starts then is
        // worse than no alarm at all.
        const movedInTime = changed.includes('date') || changed.includes('fixedTime');
        // Google moved it: tell her, on Today, in one card (utils/changeRecord). Every sync
        // path reaches here — including the closed-app job — so the card is waiting when she
        // opens the app. A failure to note it is a warning, never a failed sync (rule 2).
        if (movedInTime && before) {
          try {
            const now = new Date();
            const rec = describeChange(before, fresh, getTodayString(),
              `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`);
            if (rec) {
              const noted = await recordChange(rec, getTodayString());
              if (noted.error) console.warn('[GoogleSync] change card not saved:', noted.error);
            }
          } catch (e) {
            console.warn('[GoogleSync] change card failed', e);
          }
        }
        if (movedInTime && fresh.fixedTime) {
          await withTaskAlertLock(fresh.id, async () => {
            if (before) await cancelTaskNotifications(before);
            await armTaskAlerts({ ...(before ?? fresh), ...fresh } as Task, lang);
          }).catch((e) => console.warn('[GoogleSync] re-arm after reconcile failed', e));
        }
      } else if (outcome === 'blocked') {
        // Rule 1: this is a REFUSAL, not an absence, and it must read as one.
        report.notes.push(
          `"${fresh.text}" is on Google but blocked here — it was deleted in `
          + 'the app once. Profile → Calendar can unblock it.',
        );
      }
    } catch (e) {
      report.failed += 1;
      const why = String((e as Error)?.message || e).slice(0, 120);
      report.notes.push(`could not reconcile "${fresh.text}": ${why}`);
      console.warn('[GoogleSync] reconcile failed', fresh.id, e);
    }
  }
  if (report.inserted || report.updated || report.blocked || report.failed) {
    // Counts only: `notes` quote her event titles, which do not belong in logcat (7.10).
    const { notes: _notes, ...counts } = report as any;
    console.warn('[GoogleSync] reconcile:', JSON.stringify({ ...counts, notes: (_notes ?? []).length }));
  }
  lastReconcile = report;
  return report;
}

/**
 * Bring already-imported calendar tasks back in line with Google.
 *
 * Only touches rows that are still `source: 'calendar'` and only the fields
 * Google owns: the hour, the length, the title, the link, and a location the
 * task does not have yet. A location she has since confirmed (an object with
 * coordinates, a transit plan) is never overwritten by a raw string — that
 * would throw away the route to re-derive it.
 *
 * When the HOUR moves, the alerts armed for the old hour are cancelled and
 * re-armed, because a wake alarm for a meeting that no longer starts then is
 * worse than no alarm at all.
 */
async function refreshImportedTasks(incoming: Task[], lang: AppLanguage): Promise<void> {
  if (!incoming.length) return;
  let existing: Task[];
  try {
    existing = await getAllTasks();
  } catch { return; }
  const byId = new Map(existing.map((t) => [t.id, t]));

  for (const fresh of incoming) {
    const current = byId.get(fresh.id);
    if (!current || (current as any).source !== 'calendar') continue;
    if (current.status === 'complete') continue;

    const changes: Partial<Task> = {};
    const freshTime = fresh.fixedTime;
    const timeMoved = Boolean(freshTime) && freshTime !== current.fixedTime;
    if (timeMoved) {
      changes.fixedTime = freshTime;
      changes.scheduledTime = freshTime;
    }
    if (fresh.durationMinutes && fresh.durationMinutes !== current.durationMinutes) {
      changes.durationMinutes = fresh.durationMinutes;
    }
    if (fresh.text && fresh.text !== current.text) changes.text = fresh.text;
    if ((fresh as any).meetingUrl && (fresh as any).meetingUrl !== (current as any).meetingUrl) {
      (changes as any).meetingUrl = (fresh as any).meetingUrl;
    }
    // The address, only when the task has none. locationIsPlaced() is true once
    // the place has been geocoded or confirmed; that copy is worth more than
    // the string Google would hand back.
    if (fresh.location && !addrOf(current) && !locationIsPlaced(current.location as any)) {
      (changes as any).location = fresh.location;
      (changes as any).hasLocation = true;
    }
    if (!Object.keys(changes).length) continue;

    try {
      await updateTaskFields(fresh.id, changes);
      if (timeMoved) {
        await withTaskAlertLock(fresh.id, async () => {
          await cancelTaskNotifications(current);
          await armTaskAlerts({ ...current, ...changes } as Task, lang);
        });
      }
      console.log('[GoogleSync] refreshed an imported event', {
        id: fresh.id, changed: Object.keys(changes), timeMoved,
      });
    } catch (e) {
      console.warn('[GoogleSync] refresh of an imported event failed', fresh.id, e);
    }
  }
}

/** YYYY-MM-DD, `offset` days from today. */
export function dateOffset(offset: number, from = getTodayString()): string {
  const d = new Date(`${from}T12:00:00`);
  d.setDate(d.getDate() + offset);
  // Local, not UTC: toISOString() on a local noon is fine east of Greenwich but
  // rolls back a day west of it. Keep every date key in one calendar.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Pull the whole week ahead from Google Calendar (today + `days - 1`), one
 * request per day — the Calendar list endpoint is queried per date here.
 * Sequential on purpose: 7 parallel fetches on app open competed with the
 * task load. Returns how many NEW tasks were imported across the week.
 */
export async function syncCalendarWeek(lang: AppLanguage, days = CALENDAR_SYNC_DAYS): Promise<number> {
  if (!(await GoogleService.isGoogleConnected())) return 0;
  let added = 0;
  for (let i = 0; i < days; i++) {
    added += await syncCalendarForDate(dateOffset(i), lang);
  }
  return added;
}

/**
 * Today's calendar pull + the rest of the week, throttled (the Today screen
 * refocuses often). Today is pulled first so the visible day updates fast.
 */
export async function syncCalendarToday(
  lang: AppLanguage,
  /** Skip the 30-minute throttle. For an explicit "sync now" tap: a user who
   *  just added an event to Google should not have to wait out a timer, or
   *  guess whether the app is even trying. */
  force = false,
): Promise<number> {
  if (!force && Date.now() - lastCalendarSyncAt < CALENDAR_SYNC_INTERVAL_MS) return 0;
  lastCalendarSyncAt = Date.now();
  const today = await syncCalendarForDate(getTodayString(), lang);
  // The days ahead, AWAITED. It used to be fire-and-forget, which meant the
  // caller's "now refresh the list" ran before the import finished and the new
  // tasks only showed up on some later render.
  const ahead = await syncCalendarWeek(lang).catch(() => 0);
  return today + ahead;
}

/**
 * What the calendar connection is actually doing — for the Profile screen.
 *
 * "I added events to Google and I don't see them" is impossible to debug from
 * the outside: connected-but-empty, not-connected, and imported-but-hidden all
 * look identical. This distinguishes them.
 */
export async function calendarDiagnostics(): Promise<{
  connected: boolean;
  eventsFound: number;
  daysScanned: number;
  imported: number;
  /** Google's own words when it refused us, else null. */
  error: string | null;
  /** Events Google returned that carry no place to travel to. */
  withoutLocation: number;
  /**
   * Events Google HAS that this phone is refusing to import, because their id
   * is on the deleted-in-app tombstone list. A permanent, silent block until
   * now: the merge skips them and says nothing, so "Google has it and the app
   * does not" had no explanation anywhere on screen.
   */
  blockedByDismiss: number;
  /** Their titles, so the alert can name what is being blocked. */
  blockedTitles: string[];
}> {
  const connected = await GoogleService.isGoogleConnected();
  if (!connected) {
    return {
      connected: false, eventsFound: 0, daysScanned: 0, imported: 0,
      error: 'not_connected', withoutLocation: 0,
      blockedByDismiss: 0, blockedTitles: [],
    };
  }

  let eventsFound = 0;
  let withoutLocation = 0;
  const dismissed = new Set(await getDismissedExternalIds().catch(() => [] as string[]));
  const blockedTitles: string[] = [];
  // First real failure wins: 14 identical 403s are one fact, not fourteen.
  let error: string | null = null;
  const days = 14;
  for (let i = 0; i < days; i++) {
    const result = await GoogleService
      .fetchCalendarEvents(dateOffset(i))
      .catch((e) => ({ events: [], error: `threw: ${String(e)}` }));
    if (result.error && !error) error = result.error;
    eventsFound += result.events.length;
    withoutLocation += result.events.filter(
      (e) => !e.location && !e.meetingUrl,
    ).length;
    for (const e of result.events) {
      if (dismissed.has(`gcal-${e.id}`)) blockedTitles.push(e.title);
    }
  }
  const all = await getAllTasks();
  const imported = all.filter((t) => (t as any).source === 'calendar').length;
  return {
    connected, eventsFound, daysScanned: days, imported, error, withoutLocation,
    blockedByDismiss: blockedTitles.length, blockedTitles,
  };
}

/** Why the last calendar pull found nothing, or null when Google answered. */
export function lastCalendarFailure(): string | null {
  return lastCalendarError;
}

/**
 * The evening "plan tomorrow" pull: import tomorrow's calendar events as tasks
 * and surface Gmail event suggestions dated tomorrow. Feeds PlanTomorrow.tsx.
 */
export async function planTomorrowFromGoogle(
  lang: AppLanguage,
): Promise<{ added: number; suggestions: GapSuggestion[] }> {
  const tomorrow = getTomorrowString();
  const added = await syncCalendarForDate(tomorrow, lang);
  const all = await getGmailEventSuggestions(lang);
  return { added, suggestions: all.filter((s) => s.taskToAdd.date === tomorrow) };
}

interface ParsedEmailEvent {
  title: string;
  date: string;      // YYYY-MM-DD
  time?: string;     // HH:MM
  location?: string;
  /** What must be prepared/brought/completed, extracted from the email body. */
  prep?: string;
  sourceIndex: number;
}

/**
 * Email subjects/snippets → upcoming events, extracted on the SERVER.
 *
 * This was the app's last model call: Gmail content went from the device
 * straight to Nebius with the key that ships inside the APK. The mailbox has
 * not moved — Gmail is still read here with the user's own Google token — only
 * the extraction did, and the server drops anything it cannot date, because an
 * invented appointment arrives with an alarm attached.
 */
async function parseEmailsToEvents(
  emails: { subject: string; sender: string; snippet: string }[],
  today: string,
): Promise<ParsedEmailEvent[]> {
  const events = await emailsToEvents(emails, today);
  if (!events) return [];
  return events
    .filter((e: any) => e && e.title && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && e.date >= today)
    .map((e: any) => ({
      title: String(e.title),
      date: e.date,
      time: e.time && /^\d{1,2}:\d{2}$/.test(e.time) ? e.time : undefined,
      location: e.location ? String(e.location) : undefined,
      prep: e.prep ? String(e.prep) : undefined,
      sourceIndex: Number(e.sourceIndex) || 0,
    }));
}

/**
 * Scan Gmail for event-like emails and return task suggestions (once per day,
 * cached). The user approves/rejects each via GapSuggestionCard on Today.
 * Events already sitting on the calendar are filtered out — Lumi only asks
 * about appointments the user has NOT put in the calendar yet.
 */
export async function getGmailEventSuggestions(lang: AppLanguage): Promise<GapSuggestion[]> {
  // Off in this build (utils/gmailAccess). [] here means "not read"; every surface that
  // shows these checks GMAIL_ENABLED and says so instead of showing an empty list.
  if (!GMAIL_ENABLED) return [];
  try {
    if (!(await GoogleService.isGoogleConnected())) return [];
    const today = getTodayString();
    const dismissed: string[] = JSON.parse((await AsyncStorage.getItem(GMAIL_DISMISSED_KEY)) || '[]');

    // Already scanned today → serve the cached suggestions (minus dismissed).
    if ((await AsyncStorage.getItem(GMAIL_SCAN_KEY)) === today) {
      const cached: GapSuggestion[] = JSON.parse((await AsyncStorage.getItem(GMAIL_CACHE_KEY)) || '[]');
      return cached.filter((s) => !dismissed.includes(s.id));
    }

    // Every mailbox she connected for its mail; the same email sent to two of
    // them is read once (subject + sender).
    const boxes = (await GoogleService.listGoogleAccounts()).filter((a) => a.mail);
    const emails: (Awaited<ReturnType<typeof GoogleService.scanGmailForEvents>>[number] & { account?: string })[] = [];
    const seenMail = new Set<string>();
    for (const box of boxes.length ? boxes : [null]) {
      for (const m of await GoogleService.scanGmailForEvents(box?.email || undefined)) {
        const key = `${m.subject}|${m.sender}`.toLowerCase();
        if (seenMail.has(key)) continue;
        seenMail.add(key);
        emails.push({ ...m, account: box?.email || undefined });
      }
    }
    await AsyncStorage.setItem(GMAIL_SCAN_KEY, today);
    if (!emails.length) {
      await AsyncStorage.setItem(GMAIL_CACHE_KEY, '[]');
      return [];
    }

    const parsed = await parseEmailsToEvents(emails, today);
    // Only surface what is NOT already on the calendar / in the task list.
    const existing = await getAllTasks();
    const events = parsed.filter((ev) => !alreadyScheduled(existing, ev));
    const suggestions: GapSuggestion[] = events.map((ev) => {
      const src = emails[ev.sourceIndex];
      return {
        id: `gmail-${src?.id ?? ev.sourceIndex}`,
        taskToAdd: {
          text: ev.title,
          date: ev.date,
          fixedTime: ev.time,
          isFixed: Boolean(ev.time),
          location: ev.location,
          hasLocation: Boolean(ev.location),
          category: 'meeting',
          priority: 'have_to',
          durationMinutes: 60,
          source: 'email',
          gmailThreadId: src?.threadId,
          // Accepting it writes to THIS account's calendar, not the first one's.
          calendarName: src?.account,
          // What the email says must be prepared/completed — shown on the task.
          how: ev.prep,
        } as Partial<Task>,
        reason: `From your email: ${src?.subject || ev.title}`,
        reasonHe: `מהמייל שלך: ${src?.subject || ev.title}`,
        gapStart: ev.time || '',
        gapEnd: '',
        source: 'lumi_suggestion',
        status: 'pending',
      };
    });

    await AsyncStorage.setItem(GMAIL_CACHE_KEY, JSON.stringify(suggestions));
    return suggestions.filter((s) => !dismissed.includes(s.id));
  } catch (e) {
    console.warn('[GoogleSync] gmail suggestions failed', e);
    return [];
  }
}

/** Accept an email suggestion → real task + reminders (+ transit plan if located). */
export async function acceptGmailSuggestion(s: GapSuggestion, lang: AppLanguage): Promise<Task | null> {
  try {
    const task = await addTask({
      text: s.taskToAdd.text || 'Event',
      category: (s.taskToAdd.category as Task['category']) || 'meeting',
      priority: (s.taskToAdd.priority as Task['priority']) || 'have_to',
      isFixed: Boolean(s.taskToAdd.fixedTime),
      fixedTime: s.taskToAdd.fixedTime,
      durationMinutes: s.taskToAdd.durationMinutes || 60,
      date: s.taskToAdd.date || getTodayString(),
      status: 'pending',
      source: 'email',
      gmailThreadId: s.taskToAdd.gmailThreadId,
      location: s.taskToAdd.location,
      hasLocation: Boolean(s.taskToAdd.location),
      how: s.taskToAdd.how,
      historicalDurations: [],
    } as unknown as Omit<Task, 'id' | 'createdAt' | 'completedAt'>);
    await dismissGmailSuggestion(s.id); // never resurface after accept
    if (task.fixedTime) {
      scheduleImportedTask(task, lang);
      // "Yes I'm going" → put it on the real Google Calendar, then plan the
      // road to it (chained from wherever the previous stop of that day is).
      GoogleService.createCalendarEvent(
        task.text, task.date, task.fixedTime, task.durationMinutes || 60,
        typeof task.location === 'string' ? task.location : task.location?.address,
        (s.taskToAdd as any).calendarName || undefined,
      ).then((eventId) => {
        if (eventId) updateTaskFields(task.id, { calendarEventId: eventId } as any);
      }).catch(() => {});
      ensureTravelChain(task.date, lang).catch(() => {});
    }
    return task;
  } catch (e) {
    console.warn('[GoogleSync] accept suggestion failed', e);
    return null;
  }
}

// ── Travel chain: home → stop 1 → stop 2 → … across a whole day ──────────────

/**
 * Bump this whenever the RULES that choose a route change.
 *
 * A stored plan is otherwise only refreshed when it is half an hour old and
 * its departure is within three hours — right for traffic, and useless when
 * the choosing itself changes. On 2026-09-23 the ranker learned to leave a
 * `must` thirty minutes of margin; her interview that afternoon kept the plan
 * the old rule had picked, arriving 14:29 for 14:30, and the next recompute
 * was not due until 10:39 that morning. A plan chosen by rules we no longer
 * believe in is stale whatever its age.
 *
 * AND BUMPING IT IS PART OF THE CHANGE, not an afterthought. Version 2 shipped
 * at 00:44 the same night with a ranker that had been rewritten again since —
 * so the plan on her phone was "fresh", no recompute ran, and the route still
 * on screen was the one the replaced rule had chosen. The mechanism worked
 * perfectly and was pointed at the wrong number. If you touched `rankPlans`,
 * `missesTargetBy`, `arrivalBufferFor` or the candidate pool, you are not
 * finished until the line below has moved.
 *
 *   1 — before this existed
 *   2 — margin for a `must`, integrity checks, the second arrive-by probe
 *   3 — the margin is a TARGET, not a floor (missesTargetBy)
 *   4 — a train journey beats buses (railCarries, RAIL_PREFERENCE) — 13.10, Haifa
 *   5 — her bike / car only where she left them; today starts where she is
 *   6 — the margin target is 20, not 30: the latest train still on time (13.10)
 */
export const ROUTE_RULES_VERSION = 7;

/** A route recomputed less recently than this is treated as stale (traffic moves). */
const PLAN_FRESH_MS = 30 * 60 * 1000;
/** Only refresh routes whose departure is within this window — no point re-pricing tonight's traffic at 09:00. */
const REFRESH_WINDOW_MIN = 180;

/**
 * A task whose place nobody could find (15.10, Koral's pick: "Where is X?").
 *
 * The geocode returned null and the card stayed a card with no pin, no route
 * and no word about why. Now the place is looked up on the map (Places — never
 * a model) and, when the map knows candidates, she is asked which one it is
 * (QuestionService.askWhereIs → the popup). Either way the card's why-line
 * carries the reason (utils/routeFailure `not_found`: "Google cannot place
 * this address"), unless a more specific reason is already there.
 *
 * Lazy-imports QuestionService: it re-plans THROUGH this file, and a static
 * import in both directions would load one of them half-built.
 * Returns true when the task was written.
 */
async function askAboutUnplaced(t: Task, date: string, homeAddress?: string): Promise<boolean> {
  try {
    // From the store, not from `t`: a route that landed a moment ago may have
    // brought the coordinates with it, and then there is nothing to ask.
    const fresh = (await getTasksForDate(date)).find((x) => x.id === t.id) ?? t;
    if (locationIsPlaced(locOf(fresh))) return false;
    const placeText = addrOf(fresh);
    if (!placeText) return false;
    const { askWhereIs } = await import('./QuestionService');
    const ask = await askWhereIs({ task: fresh, placeText, homeAddress });
    // Warn, not log (a release build drops log); the reason of a failed search
    // is here and nowhere else, because the card claims nothing about it.
    console.warn(`[GoogleSync] geocode found nothing for ${t.id}; map lookup: ${ask.outcome}`
      + (ask.outcome === 'skipped' ? ` (${ask.why})` : '')
      + (ask.outcome === 'search_failed' ? ` (${ask.reason}) — will try again` : ''));
    const failure = unplacedFailure(ask);
    const loc = locOf(fresh);
    // Keep a reason that is already there: "the key was refused" outranks "not found".
    if (!failure || loc?.routeFailure) return false;
    await updateTaskFields(t.id, {
      location: { ...(loc ?? { address: placeText, confirmed: false }), routeFailure: failure },
    } as any);
    return true;
  } catch (e) {
    console.warn('[GoogleSync] could not ask where this place is', e);
    return false;
  }
}

/** Minutes from now until HH:MM today (negative when it already passed). */
function minutesUntil(hhmm: string): number {
  const now = new Date();
  return timeToMinutes(hhmm) - (now.getHours() * 60 + now.getMinutes());
}

/** How long a NOT_FOUND address is left alone before Google is asked again. */
export const NOT_FOUND_BACKOFF_MS = 30 * 60 * 1000;

/**
 * Compute (or refresh) the travel plan for EVERY located, timed task of `date`,
 * chained: the first trip starts at home, each later trip starts wherever the
 * previous appointment was. A normal day is home → work → appointment →
 * appointment, and routing all of them from home made every leave-time after
 * the first one wrong.
 *
 * A plan is (re)computed when the task has none, or when it is older than
 * PLAN_FRESH_MS and departure is less than REFRESH_WINDOW_MIN away — that
 * re-probe is what picks up current traffic before the user leaves.
 * Alerts (wake / leave / nags) are scheduled for each plan, replacing the ones
 * from a previous plan so a refresh never doubles the notifications.
 *
 * Best-effort and sequential; returns true when any task was updated.
 */
export async function ensureTravelChain(
  date: string,
  lang: AppLanguage,
  opts: {
    /**
     * Recompute this task's route even though it already has a fresh one.
     *
     * The transport switcher used to get its recompute by writing
     * `transitPlan: undefined` before calling this — the only way to make the
     * "already has a plan, skip it" test fail. The cost was that every time on
     * the card vanished for the seconds the Google call took, which is exactly
     * the "switching modes hides the timestamps" report. Saying WHICH task must
     * be re-routed lets the old plan stay on screen until the new one replaces
     * it.
     */
    forceTaskId?: string;
    /**
     * With `forceTaskId`: a vehicle the ladder chose ITSELF is not her choice,
     * so the ladder decides again.
     *
     * A forced recompute reads the stored vehicle as hers — right for the
     * transport switcher, which wrote it. But when the START moved (17.10:
     * tomorrow's interview, planned from home, now to be planned from
     * Nahariya), the stored "bus, by the ladder" belongs to a 4 km trip across
     * Tel Aviv; kept as hers it would force a bus-only route over 100 km and
     * then freeze as her pick. A mode she chose herself (`transportTypeBy:
     * 'her'`, or stored before the ladder existed) still stands.
     */
    reladder?: boolean;
  } = {},
): Promise<boolean> {
  try {
    const profile: any = await loadProfile();
    // Where the day starts. homeAddress lives in SecureStore, so it can be
    // empty on a profile that is otherwise complete — a restore, a reinstall,
    // an onboarding that never reached the address step. This used to be a bare
    // `if (!profile?.homeAddress) return false`, which turned that into "no
    // route, no leave time, no bus line, no alarm — for every task, forever,
    // with nothing in the UI or the log to say why". Coordinates route just as
    // well as an address, so fall back to them before giving up, and when there
    // is genuinely no origin, SAY so.
    const homeOrigin: string = profile?.homeAddress
      || (profile?.homeLatLng?.lat && profile?.homeLatLng?.lng
        ? `${profile.homeLatLng.lat},${profile.homeLatLng.lng}`
        : '')
      || profile?.currentAddress
      || '';
    if (!homeOrigin) {
      console.warn(
        '[GoogleSync] no home address and no home coordinates — every route is '
        + 'skipped. Set the home address in Profile to get leave times and bus lines.',
      );
      return false;
    }
    // The hour this person normally gets up. Without it needsWakeAlarm falls
    // back to "any morning prep time is a wake-up", so a 10:30 appointment
    // planned here fired a MAX-priority alarm AND a real system alarm at 09:15
    // for someone awake since 07:00. Read once — the loop below plans every
    // trip of the day.
    const usualWake = normalizeProfile(profile)?.defaultWakeTime;
    /**
     * How long before leaving she has to be awake — from the NORMALIZED
     * profile, which is the only shape that has these fields.
     *
     * This used to read `profile.morningRoutineMinutes` off the RAW profile.
     * utils/profileShape documents, in a table, that the stored shape calls it
     * `totalMorningRoutineMinutes` — so the read was always undefined and the
     * `?? 30` / `?? 10` defaults always won. Her real settings are 20 + 15, so
     * the wake alarm was computed from 40 minutes instead of 35 and fired five
     * minutes early, every trip.
     *
     * It also made two screens disagree about one plan: the timeline card
     * showed "Wake 12:38" (this arithmetic) while the Leave-Now detail showed
     * "Wake 12:43 · 15m buffer · 20m routine" (buildTravelChain, which
     * normalizes). Two numbers for the same morning is how an alarm stops
     * being something she can trust.
     */
    const prep = normalizeProfile(profile);
    const prepMinutes = (prep?.morningRoutineMinutes ?? 30)
      + (prep?.wakeBufferMinutes ?? 10);
    // Her actual choice of vehicle. The stored profile carries BOTH a coarse
    // transportMode ('transit') and the specific transportType ('train') —
    // normalizeProfile is what resolves one into the other. Reading only the
    // coarse field and folding everything that is not a car into 'bus' is how
    // "I chose train" came back as bus 271.
    const preferredMode = (normalizeProfile(profile)?.transportType
      ?? 'bus') as TransportType;
    const tasks = await getTasksForDate(date);
    const isToday = date === getTodayString();

    const timed = sortTimed(tasks.filter((t) => t.status !== 'complete' && addrOf(t)));

    let changed = false;
    let prevAddress: string = homeOrigin;
    // Where the previous stop is on the map — the ladder needs the distance
    // to judge "walkable" and "a short ride".
    let prevCoords: { lat?: number; lng?: number } | undefined;
    // TODAY the next trip starts where she IS (13.10, Koral: "it doesn't
    // matter my home address — it matters where I am now"). The Haifa
    // interview was planned from home, and home had been geocoded to Be'er
    // Sheva: 212 minutes and four buses, while the phone knew she was in Tel
    // Aviv. Home stays the start for other days and when the fix is unknown —
    // and every plan says which one it used. See utils/tripStart.
    const hereNow = isToday ? await getLastKnownLocation(15 * 60 * 1000).catch(() => null) : null;
    // What she SAID about where this day starts (17.10: "will you leave tomorrow
    // from your current location?" — kinds/tripOrigin). Unreadable is not "she
    // said nothing": the day is planned from home, and the log says why.
    const dayStart: DayStart | null = await getDayStart(date).catch((e) => {
      console.warn('[GoogleSync] the day start she gave could not be read; planning from home', e);
      return null;
    });
    // The start she named, once it is the chain's start (kind 'set'): kept so
    // the first trip can tell, by identity, that it is the one planned from it.
    let setStart: TripStart | null = null;
    let startKind: StartKind | null = isToday ? null : 'home';
    if (!isToday && dayStart) {
      // A day that has not begun starts where she said, not at home.
      const start = tripStart(null, profile?.homeLatLng, homeOrigin, false, dayStart);
      if (start.kind === 'set') {
        prevAddress = start.origin;
        prevCoords = start.coords ?? undefined;
        startKind = 'set';
        setStart = start;
      }
    }
    // How she reached the previous stop — undefined at the start of the day.
    let prevMode: TransportType | undefined;
    for (const [index, t] of timed.entries()) {
      const firstTrip = index === 0;
      const arrival = timeOf(t)!;
      // The first trip still ahead today: from here, not from wherever the
      // chain (or home) would have put her.
      // Unknown position: the chain stays — after an earlier stop she is far
      // likelier there than at home — and a from-home start says it guessed.
      if (startKind === null && minutesUntil(arrival) > 0 && !t.verifiedArrival) {
        if (hereNow) {
          // (The day start she gave is not passed: with a fix, where she IS wins.)
          const start = tripStart(hereNow, profile?.homeLatLng, homeOrigin, true);
          prevAddress = start.origin;
          prevCoords = start.coords ?? undefined;
          startKind = start.kind;
          // At home her vehicles are with her; elsewhere, how she got there decides.
          if (start.kind === 'home') prevMode = undefined;
        } else if (dayStart && firstTrip) {
          // No fix, but she told Meira where today starts (yesterday evening's
          // answer): that beats guessing home. Only for the day's first trip —
          // after an earlier stop the chain is likelier to be right.
          const start = tripStart(null, profile?.homeLatLng, homeOrigin, true, dayStart);
          if (start.kind === 'set') {
            prevAddress = start.origin;
            prevCoords = start.coords ?? undefined;
            startKind = 'set';
            setStart = start;
          } else {
            startKind = 'home_unknown_here';
          }
        } else {
          startKind = 'home_unknown_here';
        }
      }
      // Which start THIS trip is planned from — said on the plan.
      const thisStart: StartKind | null = prevAddress === homeOrigin
        ? (startKind === 'home_unknown_here' ? 'home_unknown_here' : 'home')
        : startKind === 'here' && prevCoords === hereNow ? 'here'
          : startKind === 'set' && setStart && prevCoords === setStart.coords ? 'set' : null;
      // "יגאל אלון 94" is an address; it is just not a complete one, and
      // region=il narrows it to a country that has several. Completing it from
      // her home city before it reaches Directions is the difference between
      // her gym and a street with the same name in another town — and a wrong
      // one is not an error, it is a confident route with an alarm on top.
      // A no-op for anything that already names a place. See addressCompletion.
      const dest = completeDestination(addrOf(t)!, t.text, homeOrigin);

      // Already standing there. The journey to this task is history, so do not
      // compute or refresh a route to a building she is inside, and leave no
      // "time to leave" alert armed for a trip she has already made.
      //
      // prevAddress still advances: this place is exactly where the NEXT leg
      // starts from, which is the whole point of the chain. Skipping the
      // iteration outright would measure the next trip from home again.
      if (t.verifiedArrival) {
        prevAddress = dest;
        prevMode = locOf(t)?.transportType;
        continue;
      }

      const existing = locOf(t)?.transitPlan;
      // A plan computed from the WRONG PLACE is stale no matter how fresh it
      // is. Every task used to be routed from home and then frozen, because
      // staleness was purely about age: add a gym at 19:00 and a beach at
      // 20:00 on separate occasions and you get two independent from-home
      // journeys, both departing at once. The day is a chain — if the previous
      // commitment has moved, or one was inserted ahead of this task, the
      // journey has to be worked out again.
      //
      // A plan from before this field existed reports no origin at all. Only
      // recompute those when the chain says the start is NOT home, since
      // from-home is what they would have assumed anyway.
      const wrongOrigin = Boolean(
        existing
          && (existing.originAddress
            ? !sameOrigin(existing.originAddress, prevAddress)
            : prevAddress !== homeOrigin),
      );
      // Chosen by rules we have since replaced — see ROUTE_RULES_VERSION.
      // Deliberately outside the age and departure-window tests below: those
      // ask "has the world moved", and this asks "did we change our mind".
      const byOldRules = Boolean(existing && (existing.rulesVersion ?? 1) < ROUTE_RULES_VERSION);
      // Her own pick from the arrows: only a new origin re-plans it.
      const herPick = existing?.pickedBy === 'her';
      const stale = wrongOrigin || (!herPick && byOldRules) || Boolean(
        !herPick
          && existing
          && isToday
          && Date.now() - (existing.fetchedAt || 0) > PLAN_FRESH_MS
          && minutesUntil(existing.leaveHomeAt) > -5
          && minutesUntil(existing.leaveHomeAt) < REFRESH_WINDOW_MIN,
      );
      const forced = opts.forceTaskId === t.id;
      // A trip that has already STARTED is the live re-plan's, not the chain's (21.10, 09:38 → 10:55:
      // the doctor at 10:30, she was late. The live plan — "leave 11:19, arrive 12:26" — carries no
      // rulesVersion, so `byOldRules` read it as stale and the chain re-planned it ARRIVE-BY 10:30:
      // "leave 09:18, 32 min in hand", a time 90 minutes gone, over the true one.) A task whose start
      // has passed keeps the plan it has; with none, there is nothing honest to compute to a deadline
      // that is behind her — the live re-plan answers "from now".
      const startedAlready = isToday && Boolean(t.fixedTime || t.scheduledTime)
        && minutesUntil(String(t.fixedTime || t.scheduledTime)) < 0;
      if (startedAlready && !forced) {
        prevAddress = dest;
        prevMode = locOf(t)?.transportType;
        continue;
      }
      // Google could not PLACE this address a moment ago. Asking again on every
      // foreground, heartbeat and refresh gets the same NOT_FOUND each time — five
      // parallel Directions calls per sweep for nothing (18.10, the slowness in the
      // logs). The reason stays on the card; she fixing the place, or the retry
      // button, both reach here as `forced` or as a fresh location object.
      const lastFailure = locOf(t)?.routeFailure;
      if (!existing && !forced && lastFailure?.kind === 'not_found'
        && Date.now() - (lastFailure.at ?? 0) < NOT_FOUND_BACKOFF_MS) {
        prevAddress = dest;
        prevMode = locOf(t)?.transportType;
        continue;
      }
      if (!existing || stale || forced) {
        try {
          const gProfile = {
            ...profile,
            homeAddress: prevAddress, // chain: leave from the PREVIOUS place
            homeLat: prevAddress === homeOrigin ? profile.homeLatLng?.lat : thisStart === 'here' || thisStart === 'set' ? prevCoords?.lat : undefined,
            homeLng: prevAddress === homeOrigin ? profile.homeLatLng?.lng : thisStart === 'here' || thisStart === 'set' ? prevCoords?.lng : undefined,
          } as unknown as UserProfile;
          // How she gets to THIS place, if she has ever said.
          //
          // A per-task override still wins — that is an explicit choice about
          // this trip. Below it, what she has actually done before beats the
          // single global mode picked once in onboarding, which is wrong for
          // some part of every week: she cycles to yoga and does not cycle to
          // Herzliya, and a wrong mode is a wrong travel time, a wrong leave
          // time and a wrong alarm. See utils/travelPreference.
          const learnedMode = await modeFor(
            { place: dest, category: t.category }, preferredMode,
          ).catch(() => ({ mode: preferredMode, from: 'default' as const, timesSeen: 0 }));
          // Her choice for THIS trip, when there is one: picked on the card
          // (forced, or stored before the ladder existed), or remembered for
          // this place / kind of thing. Then that is the plan. Otherwise the
          // ladder decides from what she has (car or not), the distance and
          // what actually arrives in time — utils/travelLadder.
          const stored0 = locOf(t);
          const keepsStored = (forced && !(opts.reladder && stored0?.transportTypeBy === 'ladder'))
            || stored0?.transportTypeBy !== 'ladder';
          const explicit: TransportType | undefined =
            stored0?.transportType && keepsStored
              ? stored0.transportType
              : learnedMode.from !== 'default' ? learnedMode.mode : undefined;
          const mode = (explicit ?? preferredMode) as TransportType;
          // Direct train ‹ direct bus ‹ mixed. Koral's ordering, and it is
          // about DIRECTNESS, not the vehicle: a transfer on the morning of an
          // interview is a second chance to miss something.
          //
          // Public transport asks BOTH vehicle queries and ranks the answers
          // together, because "is there a direct train" and "is there a direct
          // bus" is one comparison, not two questions whose answers never meet.
          // It used to be one call to getPlanForMode, which is absolute by
          // design — no rail route means null, never a bus in disguise — so a
          // train preference plus a destination no train reaches (Ra'anana, for
          // one) produced no route, no leave time, no alarm and an empty card.
          //
          // Private modes keep the single call: someone who drives does not
          // want a bus timetable as a consolation prize.
          // Written by the transit rung (askTransit), read after the ladder.
          let chosen = null as RankedChoice | null;
          let plan: TransitPlan | null = null;
          // WHY there is no plan, when there is no plan.
          //
          // Every one of these calls used to end in `.catch(() => [])`, which
          // is the same empty array Google returns for a free timetable. Her
          // console then showed what that had been hiding: 107 Directions
          // requests, 99% errors, 9 ms median — every lookup refused before
          // any routing ran, reported on the card as "no route for the chosen
          // way of getting there". The app had never had a route to show.
          let failure: RouteFailure | undefined;
          // The public-transport rung: every rail / bus / mixed journey
          // Google offers, ranked by transitFallback (in time › direct train ›
          // direct bus › mixed).
          const askTransit = async (): Promise<TransitPlan | null> => {
            // ONE round trip for all three preferences.
            //
            // "Is there a direct train" and "is there a direct bus" is one
            // comparison, not two questions whose answers never meet — and the
            // third, unconstrained, query is the only one that can return a
            // train+bus combination, which both filtered queries discard.
            // They used to be three separate requests from the phone; the
            // server now fans them out concurrently and caches the answers, so
            // a four-stop day costs four requests instead of twelve.
            const [rail, buses, any] = await GoogleService.transitAlternativesMulti(
              dest, arrival, gProfile, date, ['rail', 'bus', undefined], 4,
            ).catch((e: unknown) => {
              const f = networkFailure(e);
              return [{ plans: [], failure: f }, { plans: [], failure: f }, { plans: [], failure: f }];
            });

            // A `must` is asked a SECOND question: what leaves early enough to
            // get there with half an hour in hand.
            //
            // Google answers an arrive-by query with the journeys that land
            // closest before the hour given, so asking it for 14:30 can only
            // ever return trains that scrape in — the 13:20 express arriving
            // 13:58 is not in the response to be ranked, however the ranker is
            // written. Koral found it herself and asked for it by number.
            //
            // Only for a `must`, only when the buffer is non-zero, and the
            // server caches per query, so a re-sync costs nothing.
            const buffer = arrivalBufferFor(t);
            let earlier: TransitPlan[] = [];
            if (buffer > 0) {
              const comfortableBy = subtractMinutes(arrival, buffer);
              const probe = await GoogleService.transitAlternativesMulti(
                dest, comfortableBy, gProfile, date, ['rail', 'bus', undefined], 4,
              ).catch(() => []);
              earlier = probe.flatMap((r: { plans: TransitPlan[] }) => r.plans);
            }

            // Every candidate, named, before anything is chosen.
            //
            // "have you checked the trains you're offering? … you wrote:
            // 13:51-14:13 ?!?!" — and there was no way to answer that
            // question, because nothing ever wrote down what Google had
            // offered. Rule 10's mirror: an app that cannot state its own
            // numbers is asking her to be its monitoring. One line per
            // candidate, at warn, so it survives a release build.
            const candidates = [...rail.plans, ...buses.plans, ...any.plans, ...earlier];
            for (const c of candidates) {
              const v = checkPlan(c);
              console.warn(
                `[GoogleSync] offer ${c.leaveHomeAt}→${c.arriveAt} (${c.totalDurationMinutes}m, `
                + `${(c.legs ?? []).filter((l) => l.type !== 'walk')
                  .map((l) => `${l.type} ${l.lineNumber ?? ''} ${l.departureTime}→${l.arrivalTime}`)
                  .join(' + ') || 'walk only'})`
                + (v.ok ? '' : `  ✗ ${v.problems.join(',')}: ${v.detail}`),
              );
            }
            // And only sound ones may be chosen. A plan whose own four
            // accounts of the trip contradict each other is not a plan.
            const sound = candidates.filter((c) => checkPlan(c).ok);
            if (sound.length < candidates.length) {
              console.warn(
                `[GoogleSync] ${candidates.length - sound.length} of ${candidates.length} `
                + 'route(s) failed their own arithmetic and were discarded',
              );
            }
            // Her tap on 🚌 or 🚆 is a request for THAT vehicle. Ranked together, a
            // direct train always beat the bus she had just chosen (27.10: bus
            // tapped, train 14:21→15:28 came back). Only when that vehicle has
            // no sound journey does the whole field answer — and the plan then
            // carries the sentence that says so (rule 9, fallbackNote).
            const herVehicle = explicit === 'bus' || explicit === 'train' ? explicit : undefined;
            const wanted = herVehicle ? sound.filter((c) => vehicleOf(c) === herVehicle) : sound;
            chosen = pickByPreference(wanted.length ? wanted : sound, arrival, { minBufferMinutes: buffer });
            plan = chosen?.plan ?? null;
            // worstFailure, not "the first one": if two queries say ZERO_RESULTS
            // and one says REQUEST_DENIED, "there is no train" is a lie — the
            // third question was never actually answered.
            if (!plan) failure = worstFailure([rail.failure, buses.failure, any.failure]);
            return plan;
          };
          // The ladder. Car if she has one and drives; else walk a short hop,
          // public transport, a bike or scooter if the ride is short, and her
          // car or a taxi last — see utils/travelLadder. An explicit choice is
          // the only rung.
          const here = prevAddress === homeOrigin ? profile?.homeLatLng : prevCoords;
          // The distance decides "walkable" and "a short ride", so a place the
          // app has never placed is placed FIRST. It used to be geocoded only
          // after routing, which left every new event at "distance unknown" and
          // a 600 m hop routed by bus. One lookup per new place: the route
          // below stores the coordinates it ends at.
          let there: { lat?: number; lng?: number } | null | undefined = locOf(t);
          if (straightKm(here, there) === undefined && here) {
            there = await geocodeTaskLocation(dest).catch(() => null);
          }
          // Her bike and her car are where she LEFT them (13.10: 5 minutes by bike
          // from a Haifa interview she had reached by train — the bike was in
          // Tel Aviv). After a leg by bus, train, foot or taxi, only a choice she
          // made herself puts her on her own vehicle again.
          const leftBehind = vehicleLeftBehind(prevMode, explicit);
          const ladderCtx = {
            preferred: (leftBehind && (mode === 'bike' || mode === 'car') ? 'bus' : mode) as TransportType,
            hasCar: hasCarOf(normalizeProfile(profile) as any) && !leftBehind,
            km: straightKm(here, there),
            highStakes: isHighStakes(t),
            explicit,
          };
          const choice = await walkLadder(ladderCtx, arrival, async (rung) => {
            if (rung === 'transit') return askTransit();
            const rm = rungMode(rung, mode);
            const single = await GoogleService.planForMode(rm, dest, arrival, gProfile, date)
              .catch((e: unknown) => ({ plan: null as TransitPlan | null, failure: networkFailure(e, rm) }));
            if (!single.plan && !failure) failure = single.failure;
            return single.plan;
          });
          // The reasoning, kept WITH the plan — shown under "Why this way?" on
          // the trip — rather than printed: a route she can question is one
          // she can correct.
          const routeWhy = [
            ...(thisStart ? [startLine(thisStart, lang, thisStart === 'set' ? setStart?.label : undefined)] : []),
            ...compactSteps(choice?.steps ?? [], lang),
          ];
          plan = choice?.plan ?? null;
          if (choice && choice.rung !== 'transit') chosen = null;
          if (plan) failure = undefined;
          // Which journey actually answered — not the one she asked for.
          const planMode = (chosen
            ? vehicleOf(chosen.plan)
            : choice ? rungMode(choice.rung, mode) : mode) as TransportType;
          // Things worth saying: the ladder stepped down (too far to ride, no
          // bus in time — a taxi), it is not the vehicle she asked for, and it
          // leaves earlier than it has to. Any, all, or none.
          const note = [
            ladderNote(choice, lang),
            chosen ? tierNote(chosen, dest, lang) : undefined,
            chosen ? marginNote(chosen, lang) : undefined,
          ].filter(Boolean).join(' · ') || undefined;
          if (note) console.warn('[GoogleSync]', note);
          if (!plan) {
            // Train is strict — no rail route means none, not "here is a bus".
            // Record it, WITH the reason, so the card states what actually
            // happened rather than the one cause nobody had checked.
            const base0 = locOf(t);
            if (failure) {
              console.warn('[GoogleSync]', failureLogLine(failure, dest));
            }
            // "Meira could not place this" (askAboutUnplaced) is a reason too, and
            // a route lookup that said nothing must not wipe it — it would be
            // written back a moment later, on every sweep.
            const reason = failure
              ?? (base0?.routeFailure?.status === 'NO_PLACE' ? base0.routeFailure : undefined);
            const sameReason = base0?.routeFailure?.kind === reason?.kind;
            if (base0 && (base0.noRouteForMode !== mode || !sameReason)) {
              await updateTaskFields(t.id, {
                location: {
                  ...base0, noRouteForMode: mode, transitPlan: undefined, routeFailure: reason,
                },
              } as any).catch((e) => console.warn('[GoogleSync] route failure not recorded on the task', e));
              changed = true;
            }
          }
          if (plan) {
            const base = locOf(t) ?? { address: dest, lat: 0, lng: 0, confirmed: false };
            // ALWAYS derived from THIS plan's departure.
            //
            // It used to keep `base.wakeUpBy` untouched for any trip that was
            // not the day's first, which meant it kept whatever an earlier
            // route had computed — for an earlier departure. Her interview
            // card, 2026-09-23: "🧭 12:38 get ready → 🚪 13:39 leave". Sixty-one
            // minutes for a forty-minute routine, because 12:38 was worked back
            // from the 13:18 departure the route had BEFORE a study block was
            // added ahead of it and the journey was replanned.
            //
            // Two numbers on one card describing one morning, disagreeing.
            // Whether this hour is a WAKE alarm or merely "start getting ready"
            // is a separate question, and alertPlan.needsWakeAlarm already
            // answers it properly by the hour — an afternoon trip raises no
            // alarm because 16:40 is not a morning, not because of where it
            // sits in the chain.
            const wakeUpBy = subtractMinutes(plan.leaveHomeAt, prepMinutes);
            void firstTrip;
            // The journey Google just returned ENDS at this place, so its end
            // point is the most accurate coordinate we will ever get for free.
            // Before this, `base` could be the 0,0 placeholder minted two lines
            // up and nothing ever replaced it — the task had a real address, a
            // real route and a position in the Atlantic, so the map drew nothing.
            const location: TaskLocation = {
              ...base,
              noRouteForMode: undefined,   // a route exists again
              routeFailure: undefined,     // …and so the reason it failed is gone too
              transitPlan: {
                ...plan,
                originAddress: prevAddress,
                // A start she named is shown by name, never as "32.9,35.1".
                ...(thisStart === 'set'
                  ? { originLabel: setStart?.label || (lang === 'he' ? 'המקום שאמרת' : 'Where you said') }
                  : {}),
                rulesVersion: ROUTE_RULES_VERSION,
              },
              leaveHomeBy: plan.leaveHomeAt,
              travelMinutes: plan.totalDurationMinutes,
              wakeUpBy,
              // The vehicle that actually answered, and the sentence that says
              // so when it was not the one she wanted. A bus arriving under a
              // 🚆 chip is the complaint already on the known-open list.
              transportType: planMode,
              transportTypeBy: explicit ? 'her' : 'ladder',
              modeNote: note,
              routeWhy,
              ...(pickCoords(base, plan) ?? {}),
            };
            // Replace the old alerts so a traffic refresh doesn't stack them.
            // Under the per-task lock: armTaskAlerts re-plans the same task
            // from five other call sites, and two runs interleaving here is
            // how "time to start getting ready" arrived four times over.
            console.warn(`[GoogleSync] chain saved ${plan.leaveHomeAt}→${plan.arriveAt} for task ${t.id} at ${arrival} on ${date}`);
            await withTaskAlertLock(t.id, async () => {
              await cancelTaskNotifications(t).catch(() => {});
              const notifTask = { ...t, location, notificationIds: [] } as Task;
              await scheduleTransitNotifications(notifTask, lang, usualWake);
              // Persist the ids too — without them the next refresh can't cancel
              // what this run scheduled, and alerts pile up.
              await updateTaskFields(t.id, {
                location, notificationIds: notifTask.notificationIds,
              } as any);
            });
            changed = true;
          }
        } catch (e) {
          console.warn('[GoogleSync] travel leg failed', e);
        }
      }

      // A PLACE, even when no journey to it could be worked out.
      //
      // Everything above only ever writes a location when a route comes back,
      // so a task Google could not route — or one whose route predates
      // destLat/destLng — kept an address and no coordinates, and the map had
      // nothing to draw. That is the empty map under the yoga class at
      // צ׳ארלס קלור: the name was resolved, the address was right, and the
      // position was Null Island (see utils/placeCoords).
      //
      // One geocode, once, and only when the place is genuinely unplaced —
      // needsGeocode is false the moment real coordinates exist, so this does
      // not run again on the next sweep.
      try {
        const placed = locOf(t);
        const unplaced = placed ? needsGeocode(placed) : Boolean(dest);
        if (unplaced) {
          const coords = await geocodeTaskLocation(dest);
          if (coords) {
            await updateTaskFields(t.id, {
              location: {
                ...(placed ?? { address: dest, confirmed: false }),
                ...coords,
                // "Meira could not place this" (askAboutUnplaced) is no longer true.
                ...(placed?.routeFailure?.status === 'NO_PLACE' ? { routeFailure: undefined } : {}),
              },
            } as any);
            changed = true;
          } else {
            // Warn, not log: a release build drops console.log entirely, and
            // this is precisely the line that explains an empty map.
            console.warn('[GoogleSync] could not geocode', dest, '— no map pin for', t.id);
            // …and it used to end there: a card with no pin, no route and no
            // word about why. Meira now looks the place up on the map and asks
            // her which one it is (15.10), and the card says it could not place it.
            if (await askAboutUnplaced(t, date, profile?.homeAddress)) changed = true;
          }
        }
      } catch (e) {
        console.warn('[GoogleSync] geocode failed', e);
      }

      // LEARN WHERE THIS HAPPENS. She wrote the address once; the activity
      // name should find it forever after — "this is my gym address".
      //
      // Only a placed address is learned: one that geocoded, or that a route
      // was actually built to. Learning from a string nobody could resolve is
      // how a typo becomes a permanent wrong answer.
      try {
        const placedNow = locOf(await getTasksForDate(date)
          .then((all) => all.find((x) => x.id === t.id) ?? t));
        if (placedNow && locationIsPlaced(placedNow)) {
          await learnPlace(t.text, placedNow.address || dest,
            { lat: placedNow.lat, lng: placedNow.lng });
        }
      } catch (e) {
        console.warn('[GoogleSync] could not learn this place', e);
      }

      prevAddress = dest;
      prevCoords = locOf(t);
      prevMode = locOf(t)?.transportType;
    }
    return changed;
  } catch (e) {
    console.warn('[GoogleSync] travel chain failed', e);
    return false;
  }
}

/**
 * Run the travel chain for today AND the days ahead.
 *
 * ensureTravelChain was only ever called for today (TodaySchedule) and for
 * tomorrow (PlanTomorrow, and only if that screen was opened). So a meeting
 * tomorrow morning had no route, no leaveHomeBy, no wakeUpBy and therefore no
 * wake alarm and no "time to leave" alert — unless the user happened to open
 * the right screen the night before. Planning has to happen because the
 * appointment exists, not because a screen was visited.
 *
 * Sequential and best-effort: each day is a few Directions calls, and a failure
 * on one day must not stop the next. Returns true if anything changed.
 */
export async function ensureTravelChainAhead(
  lang: AppLanguage,
  days = TRAVEL_PLAN_DAYS,
): Promise<boolean> {
  let changed = false;
  for (let i = 0; i < days; i++) {
    try {
      if (await ensureTravelChain(dateOffset(i), lang)) changed = true;
    } catch (e) {
      console.warn('[GoogleSync] travel chain failed for day', i, e);
    }
  }
  // The morning-of study block is measured backwards from `leaveHomeBy`, which
  // only exists once the loop above has run. Deriving it in the calendar sync
  // alone meant the first sweep after an interview arrived produced no morning
  // block, and the next chance was fifteen minutes later — rule 7: name the
  // trigger, and this is it.
  try {
    if (await ensureInterviewPrep(lang)) changed = true;
  } catch (e) {
    console.warn('[GoogleSync] interview prep after travel chain failed', e);
  }
  // The way home after the day's last trip is a task too (services/ReturnHomeTasks).
  try {
    const { ensureReturnHomeTasks } = await import('./ReturnHomeTasks');
    if (await ensureReturnHomeTasks(lang)) changed = true;
  } catch (e) {
    console.warn('[GoogleSync] way-home tasks failed', e);
  }

  // A route implies a wake time; record whether that wake time needs a REAL
  // phone alarm. It cannot be set yet for anything beyond 24 h (ACTION_SET_ALARM
  // has no date), so it is marked 'planned' and AlarmPlanner arms it once the
  // morning comes into reach — otherwise a far-future interview got no alarm at
  // all, because nothing ever came back to set one.
  try {
    if (await markAlarmStates()) changed = true;
  } catch (e) {
    console.warn('[GoogleSync] alarm-state marking failed', e);
  }
  return changed;
}

/**
 * Give every upcoming routed task an alarmState. Pure bookkeeping — arming the
 * physical alarm is AlarmPlanner's job, and only once it is within 24 h.
 * Returns true if any task's state changed.
 */
async function markAlarmStates(): Promise<boolean> {
  const profile = normalizeProfile(await loadProfile().catch(() => null));
  const usualWake = profile?.defaultWakeTime || undefined;
  // How long she needs between waking and starting. This is what lets a task
  // with NO travel still raise an alarm — without it, only routed trips ever
  // could, and a 06:30 commitment at home rang nothing.
  const routineMinutes = profile
    ? (profile.morningRoutineMinutes ?? 0) + (profile.wakeBufferMinutes ?? 0)
    : undefined;
  const today = getTodayString();
  const horizon = dateOffset(TRAVEL_PLAN_DAYS);
  const tasks = (await getAllTasks()).filter(
    (t) => t.status === 'pending' && t.date >= today && t.date <= horizon,
  );

  // ONE alarm per day, owned by whatever starts first.
  //
  // decideAlarmState judges a single task, and this loop applied it to each
  // task independently — so a day with an 08:00 class and a 10:00 appointment
  // planned two alarms, 07:20 and 09:20, and the phone rang twice. And the
  // thing Koral actually asked for did not happen either: adding something
  // EARLIER than everything else did not move the morning, it only added
  // another ring to it. utils/alarmPlan.dayWakeOwner picks the day's one.
  const byDate = new Map<string, Task[]>();
  for (const task of tasks) {
    const day = byDate.get(task.date);
    if (day) day.push(task); else byDate.set(task.date, [task]);
  }
  const owners = new Map<string, string>();      // date → task id
  for (const [date, dayTasks] of byDate) {
    const owner = dayWakeOwner(dayTasks, { usualWakeTime: usualWake, routineMinutes });
    if (owner) owners.set(date, owner.taskId);
  }

  let changed = false;
  for (const task of tasks) {
    let want = decideAlarmState(task, usualWake, routineMinutes);
    // Superseded: this task wants a wake-up, but a task earlier in its day
    // already owns the morning. Waking her twice is not two alarms, it is one
    // alarm and one interruption.
    const owner = owners.get(task.date);
    if (want === 'planned' && owner && owner !== task.id) want = 'not_needed';
    // Never downgrade an alarm that is already physically set — only a
    // re-route that removes the wake time entirely should do that.
    if (task.alarmState === 'armed' && want !== 'not_needed') continue;
    if (task.alarmState === want) continue;
    await updateTaskFields(task.id, { alarmState: want }).catch(() => {});
    changed = true;
  }
  if (owners.size) {
    console.warn(
      `[GoogleSync] wake alarms: ${[...owners.entries()]
        .map(([d, id]) => `${d}←${id.slice(0, 22)}`).join(', ')}`,
    );
  }
  return changed;
}

/**
 * The next timed task from now on, looking `days` ahead — "what is actually
 * coming next", which is not the same as "the first thing in today's list".
 * Today's leftovers whose time has passed are skipped; a meeting tomorrow
 * morning outranks an undated to-do sitting in today's column.
 */
export async function getNextUpcomingTask(days = 7): Promise<Task | null> {
  // ONE read of the store. This used to call getTasksForDate seven times —
  // seven cloud-hydrated reads — and swallow each failure as an empty day, so
  // "nothing coming up" and "I could not read your tasks" were the same null
  // (rule 1). A failed read now throws to the caller, which says so.
  const all = await getAllTasks();
  return pickNextUpcoming(all, Date.now(), dateOffset(0), days);
}

/** One day of the week-ahead view. */
export interface WeekDayPlan {
  date: string;
  taskCount: number;
  /** Earliest departure of the day, when a route is known. */
  leaveHomeBy?: string;
  firstTaskTime?: string;
  /** Human warnings: overlapping appointments, or not enough travel time between them. */
  warnings: string[];
}

/**
 * Look over the next `days` days and flag what will hurt: two appointments at
 * the same time, or a gap between two places that is shorter than the travel
 * between them. Deterministic — no LLM call, so it can run on every open.
 */
export async function analyzeWeek(lang: AppLanguage, days = 7): Promise<WeekDayPlan[]> {
  const he = lang === 'he';
  const out: WeekDayPlan[] = [];
  // Her margin and wake floor, so "possible but tight" and "needs you up at
  // 04:49" are said too — not only what is outright impossible.
  const feasibility = feasibilityOptionsOf(normalizeProfile(await loadProfile().catch(() => null)));
  for (let i = 0; i < days; i++) {
    const date = dateOffset(i);
    const tasks = (await getTasksForDate(date)).filter((t) => t.status !== 'complete');
    const timed = sortTimed(tasks);
    const departures = timed
      .map((t) => locOf(t)?.leaveHomeBy)
      .filter((v): v is string => Boolean(v))
      .sort();
    out.push({
      date,
      taskCount: tasks.length,
      leaveHomeBy: departures[0],
      firstTaskTime: timed[0] ? timeOf(timed[0]) : undefined,
      warnings: dayWarnings(timed, he, feasibility),
    });
  }
  return out;
}

/** Hide a suggestion permanently (persisted dismissed-id set). */
export async function dismissGmailSuggestion(id: string): Promise<void> {
  try {
    const dismissed: string[] = JSON.parse((await AsyncStorage.getItem(GMAIL_DISMISSED_KEY)) || '[]');
    if (!dismissed.includes(id)) {
      dismissed.push(id);
      await AsyncStorage.setItem(GMAIL_DISMISSED_KEY, JSON.stringify(dismissed.slice(-100)));
    }
  } catch { /* best-effort */ }
}
