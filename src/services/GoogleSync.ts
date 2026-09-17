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
import AsyncStorage from '@react-native-async-storage/async-storage';
import { GoogleService } from './GoogleService';
import { emailsToEvents } from './LumiServer';
import { mergeExternalTasks, addTask, getAllTasks, getTasksForDate, updateTaskFields } from './TaskStorage';
import { loadProfile } from './UserProfileStorage';
import { normalizeProfile } from '../utils/profileShape';
import {
  armTaskAlerts, scheduleTaskReminders, scheduleTransitNotifications, cancelTaskNotifications,
  withTaskAlertLock,
} from './NotificationService';
import { getTodayString, getTomorrowString, timeToMinutes, subtractMinutes } from '../utils/timeUtils';
// Pure planning decisions (conflict detection, email-vs-calendar matching) live
// in utils/dayPlanning so they can be unit-tested outside the Expo runtime.
import { locOf, addrOf, timeOf, sortTimed, dayWarnings, alreadyScheduled } from '../utils/dayPlanning';
import { isMeetingLink } from '../utils/meetingLink';
import { pickCoords, needsGeocode, locationIsPlaced } from '../utils/placeCoords';
import { learnPlace } from './KnownPlacesStore';
import { modeFor } from './TravelPreferenceStore';
import { completeAddress } from '../utils/addressCompletion';
import { geocodeTaskLocation } from './NearbyTaskReminderService';
import { decideAlarmState } from './AlarmPlanner';
import { Task, AppLanguage, GapSuggestion, UserProfile, TaskLocation, TransportType } from '../types/index';

const GMAIL_SCAN_KEY = 'lumi.gmailScan.v1';          // last scan date (once/day)
const GMAIL_CACHE_KEY = 'lumi.gmailSuggestions.v1';  // cached suggestions for today
const GMAIL_DISMISSED_KEY = 'lumi.gmailDismissed.v1'; // dismissed suggestion ids

// Calendar pull throttle (per app session): the Today screen refocuses often.
let lastCalendarSyncAt = 0;
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

/** Duration in minutes between two HH:MM times (>= 15). */
function diffMinutes(start: string, end: string): number {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  return Math.max(15, eh * 60 + em - (sh * 60 + sm));
}

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
    if (!(await GoogleService.isGoogleConnected())) return 0;

    const events = await GoogleService.getCalendarEventsToday(date);
    if (!events.length) return 0;

    const tasks: Task[] = events
      .filter((e) => e.title)
      .map((e) => ({
        id: `gcal-${e.id}`,
        text: e.title,
        priority: 'have_to',
        isFixed: true,
        fixedTime: e.startTime,
        scheduledTime: e.startTime,
        durationMinutes: diffMinutes(e.startTime, e.endTime),
        date,
        status: 'pending',
        source: 'calendar',
        calendarEventId: e.id,
        // A video link is NOT a location. Putting it there made Lumi geocode
        // it, plan a bus to it and set a wake alarm for it. Links go to
        // meetingUrl; `location` keeps only somewhere you can actually stand.
        location: isMeetingLink(e.location) ? undefined : e.location,
        hasLocation: Boolean(e.location) && !isMeetingLink(e.location),
        meetingUrl: e.meetingUrl,
        attendees: e.attendees,
        // A call you join from anywhere is a different KIND of commitment from
        // one you travel to — the schedule needs to know which it is.
        category: e.meetingUrl ? 'zoom' : 'meeting',
        createdAt: Date.now(),
        historicalDurations: [],
      } as unknown as Task));

    // Snapshot existing ids BEFORE the merge so only genuinely new imports
    // get alerts (re-scheduling existing ones would duplicate notifications).
    const existingIds = new Set((await getAllTasks()).map((t) => t.id));
    const added = await mergeExternalTasks(tasks);
    if (added > 0) {
      for (const t of tasks) {
        if (!existingIds.has(t.id) && t.fixedTime) scheduleImportedTask(t, lang);
      }
    }
    return added;
  } catch (e) {
    console.warn('[GoogleSync] calendar sync failed', e);
    return 0;
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
}> {
  const connected = await GoogleService.isGoogleConnected();
  if (!connected) return { connected: false, eventsFound: 0, daysScanned: 0, imported: 0 };

  let eventsFound = 0;
  const days = 14;
  for (let i = 0; i < days; i++) {
    const events = await GoogleService.getCalendarEventsToday(dateOffset(i)).catch(() => []);
    eventsFound += events.length;
  }
  const all = await getAllTasks();
  const imported = all.filter((t) => (t as any).source === 'calendar').length;
  return { connected, eventsFound, daysScanned: days, imported };
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
  try {
    if (!(await GoogleService.isGoogleConnected())) return [];
    const today = getTodayString();
    const dismissed: string[] = JSON.parse((await AsyncStorage.getItem(GMAIL_DISMISSED_KEY)) || '[]');

    // Already scanned today → serve the cached suggestions (minus dismissed).
    if ((await AsyncStorage.getItem(GMAIL_SCAN_KEY)) === today) {
      const cached: GapSuggestion[] = JSON.parse((await AsyncStorage.getItem(GMAIL_CACHE_KEY)) || '[]');
      return cached.filter((s) => !dismissed.includes(s.id));
    }

    const emails = await GoogleService.scanGmailForEvents();
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

/** A route recomputed less recently than this is treated as stale (traffic moves). */
const PLAN_FRESH_MS = 30 * 60 * 1000;
/** Only refresh routes whose departure is within this window — no point re-pricing tonight's traffic at 09:00. */
const REFRESH_WINDOW_MIN = 180;

/** Minutes from now until HH:MM today (negative when it already passed). */
function minutesUntil(hhmm: string): number {
  const now = new Date();
  return timeToMinutes(hhmm) - (now.getHours() * 60 + now.getMinutes());
}

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
    for (const [index, t] of timed.entries()) {
      const firstTrip = index === 0;
      const arrival = timeOf(t)!;
      // "יגאל אלון 94" is an address; it is just not a complete one, and
      // region=il narrows it to a country that has several. Completing it from
      // her home city before it reaches Directions is the difference between
      // her gym and a street with the same name in another town — and a wrong
      // one is not an error, it is a confident route with an alarm on top.
      // A no-op for anything that already names a place. See addressCompletion.
      const dest = completeAddress(addrOf(t)!, homeOrigin);

      // Already standing there. The journey to this task is history, so do not
      // compute or refresh a route to a building she is inside, and leave no
      // "time to leave" alert armed for a trip she has already made.
      //
      // prevAddress still advances: this place is exactly where the NEXT leg
      // starts from, which is the whole point of the chain. Skipping the
      // iteration outright would measure the next trip from home again.
      if (t.verifiedArrival) {
        prevAddress = dest;
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
            ? existing.originAddress !== prevAddress
            : prevAddress !== homeOrigin),
      );
      const stale = wrongOrigin || Boolean(
        existing
          && isToday
          && Date.now() - (existing.fetchedAt || 0) > PLAN_FRESH_MS
          && minutesUntil(existing.leaveHomeAt) > -5
          && minutesUntil(existing.leaveHomeAt) < REFRESH_WINDOW_MIN,
      );
      const forced = opts.forceTaskId === t.id;
      if (!existing || stale || forced) {
        try {
          const gProfile = {
            ...profile,
            homeAddress: prevAddress, // chain: leave from the PREVIOUS place
            homeLat: prevAddress === homeOrigin ? profile.homeLatLng?.lat : undefined,
            homeLng: prevAddress === homeOrigin ? profile.homeLatLng?.lng : undefined,
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
          const mode = (locOf(t)?.transportType ?? learnedMode.mode) as TransportType;
          const plan = await GoogleService.getPlanForMode(mode, dest, arrival, gProfile, date);
          if (!plan) {
            // Train is strict — no rail route means none, not "here is a bus".
            // Record it so the card can say so instead of showing a stale journey.
            const base0 = locOf(t);
            if (base0 && base0.noRouteForMode !== mode) {
              await updateTaskFields(t.id, {
                location: { ...base0, noRouteForMode: mode, transitPlan: undefined },
              } as any).catch(() => {});
              changed = true;
            }
          }
          if (plan) {
            const base = locOf(t) ?? { address: dest, lat: 0, lng: 0, confirmed: false };
            // Wake alarm belongs to the FIRST trip of the day only — the later
            // trips start from wherever you already are, and a "⏰ Wake up!" at
            // 16:40 for the gym is nonsense. They keep leave-home + nags.
            const wakeUpBy = firstTrip
              ? subtractMinutes(
                plan.leaveHomeAt,
                (profile.morningRoutineMinutes ?? 30) + (profile.wakeBufferMinutes ?? 10),
              )
              : base.wakeUpBy;
            // The journey Google just returned ENDS at this place, so its end
            // point is the most accurate coordinate we will ever get for free.
            // Before this, `base` could be the 0,0 placeholder minted two lines
            // up and nothing ever replaced it — the task had a real address, a
            // real route and a position in the Atlantic, so the map drew nothing.
            const location: TaskLocation = {
              ...base,
              noRouteForMode: undefined,   // a route exists again
              transitPlan: { ...plan, originAddress: prevAddress },
              leaveHomeBy: plan.leaveHomeAt,
              travelMinutes: plan.totalDurationMinutes,
              wakeUpBy,
              ...(pickCoords(base, plan) ?? {}),
            };
            // Replace the old alerts so a traffic refresh doesn't stack them.
            // Under the per-task lock: armTaskAlerts re-plans the same task
            // from five other call sites, and two runs interleaving here is
            // how "time to start getting ready" arrived four times over.
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
              },
            } as any);
            changed = true;
          } else {
            // Warn, not log: a release build drops console.log entirely, and
            // this is precisely the line that explains an empty map.
            console.warn('[GoogleSync] could not geocode', dest, '— no map pin for', t.id);
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

  let changed = false;
  for (const task of tasks) {
    const want = decideAlarmState(task, usualWake, routineMinutes);
    // Never downgrade an alarm that is already physically set — only a
    // re-route that removes the wake time entirely should do that.
    if (task.alarmState === 'armed' && want !== 'not_needed') continue;
    if (task.alarmState === want) continue;
    await updateTaskFields(task.id, { alarmState: want }).catch(() => {});
    changed = true;
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
  const now = Date.now();
  let best: { task: Task; when: number } | null = null;
  for (let i = 0; i < days; i++) {
    const date = dateOffset(i);
    const tasks = await getTasksForDate(date).catch(() => [] as Task[]);
    for (const t of tasks) {
      if (t.status === 'complete') continue;
      const time = timeOf(t);
      if (!time) continue;
      const [h, m] = time.split(':').map(Number);
      const [y, mo, d] = date.split('-').map(Number);
      if ([h, m, y, mo, d].some((n) => !Number.isFinite(n))) continue;
      const when = new Date(y, mo - 1, d, h, m).getTime();
      if (when <= now) continue;
      if (!best || when < best.when) best = { task: t, when };
    }
  }
  return best?.task ?? null;
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
      warnings: dayWarnings(timed, he),
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
