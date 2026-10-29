/**
 * LumiCoachEngine — the single "brain" both the app Chat tab and the WhatsApp
 * bot should route through. One conversational turn:
 *   understand → SAVE the task → (located appointment?) ask transport →
 *   plan the trip (train/car via Google) → schedule the leave reminder → reply.
 *
 * Pure of React; returns what to say + whether the task list changed, plus a
 * `pending` handoff when it asked "how will you get there?" (the UI keeps that
 * and passes it back on the next turn).
 *
 * Since the consolidation this is the OFFLINE half of the chat: the rule-based
 * EN+HE intent router runs here in under 100 ms and works with no network, and
 * anything needing a model goes to the server (LumiBrain for a reply,
 * LumiServer for extraction). No model call is made from the device.
 */
import { extractTasks as extractServerTasks } from './LumiServer';
import { extractLocally, looksLikeAQuestion, describeLocalSave } from '../utils/localTaskExtract';
import { parseTimeExpression } from '../utils/timeParser';
import { extractHebrewPlaceParts } from '../utils/hebrewPlace';
import { placePartsFrom } from '../utils/placeFromText';
import { inferTaskDetails } from './TaskParser';
import { addTasksForDate, updateTaskFields, getTasksForDate, getBacklogBeforeDate, getAllTasks } from './TaskStorage';
import { scheduleWakeUpTest } from './MorningBriefingService';
import { GoogleService } from './GoogleService';
import { loadProfile, saveProfile } from './UserProfileStorage';
import { normalizeProfile } from '../utils/profileShape';
import { cancelTaskNotifications, scheduleTransitNotifications, scheduleTaskReminders, withTaskAlertLock } from './NotificationService';
import {
  setStandaloneReminder,
  setLeadTimeForTask,
  resolveFocusTask,
  setTaskFocus,
} from './ReminderService';
import { describeLead } from '../utils/leadTime';
import { preferredPlaceMode, rememberPlaceMode } from '../utils/placeMode';
import { addrOf, timeOf } from '../utils/dayPlanning';
import { HOME_HERE_CHIP } from '../utils/homeFromHere';
import { getTodayString, getTomorrowString, sortTasksByPriorityAndTime, timeToMinutes } from '../utils/timeUtils';
import { Task, TaskCategory, TransitPlan } from '../types';

const VALID_CATEGORIES = new Set<TaskCategory>([
  'interview', 'course', 'conference', 'class', 'work', 'meeting', 'call',
  'doctor', 'gym', 'aspiration', 'leisure', 'general', 'zoom', 'hobby_class',
]);

type Lang = 'en' | 'he';

/** Handoff state carried between chat turns while we wait for transport choice, origin confirmation, or home address. */
export interface CoachPending {
  taskId: string;
  taskText: string;
  destination: string;
  arrivalTime: string; // HH:MM
  date: string;        // YYYY-MM-DD
  mode?: 'car' | 'transit' | 'foot' | 'bicycle'; // set once the user picked how they'll travel
  /** Where the trip starts: 'home' (confirmed by the user) or a typed address. Never assumed. */
  origin?: string;
  /** True when the previous turn asked "leaving from home or somewhere else?". */
  awaitingOrigin?: boolean;
  /** Train options offered to the user (earliest-first); set with awaitingTrainChoice. */
  options?: TransitPlan[];
  /** True when the previous turn asked "which train?". */
  awaitingTrainChoice?: boolean;
  /** Which transit vehicle the options should prefer (trains by default;
   *  'bus' after the user asks for bus options). */
  transitPref?: 'rail' | 'bus';
  /** True when the previous turn asked "…already passed — want to reschedule?".
   *  Lets the next turn interpret "yes" / a new time instead of falling through
   *  to the fresh-message extractor (which used to reply with the generic chit). */
  awaitingReschedule?: boolean;
}

/** One turn's outcome: reply text, tasks saved, pending handoff, whether the task list changed. */
export interface CoachResult {
  reply: string;
  savedCount: number;
  pending?: CoachPending; // set when we asked the transport question
  refreshTasks: boolean;  // UI should reload the task list
  chips?: string[];       // quick-reply chips for the pending question (e.g. train numbers)
  /** UI side-effect: 'openPlanTomorrow' navigates to the PlanTomorrow screen. */
  action?: 'openPlanTomorrow';
}

interface Extracted {
  text: string;
  category: TaskCategory;
  priority: 'must' | 'have_to' | 'need_to' | 'nice_to_do';
  fixedTime?: string;   // HH:MM
  /** Length in minutes. Absent means "use the category default". */
  durationMinutes?: number;
  location?: string;    // address / place
  date: string;         // YYYY-MM-DD
}

// Message words → travel mode. Covers EN + HE (train/bus = transit).
const TRANSPORT_WORDS: Record<string, 'car' | 'transit' | 'foot' | 'bicycle'> = {
  train: 'transit', רכבת: 'transit', bus: 'transit', אוטובוס: 'transit', transit: 'transit',
  'public transport': 'transit', מטרו: 'transit', subway: 'transit',
  car: 'car', רכב: 'car', אוטו: 'car', driving: 'car', drive: 'car', נהיגה: 'car',
  walk: 'foot', foot: 'foot', walking: 'foot', רגל: 'foot', הליכה: 'foot',
  bike: 'bicycle', bicycle: 'bicycle', cycling: 'bicycle', אופניים: 'bicycle',
};

function detectTransport(text: string): 'car' | 'transit' | 'foot' | 'bicycle' | null {
  const t = (text || '').toLowerCase();
  for (const [word, mode] of Object.entries(TRANSPORT_WORDS)) {
    if (t.includes(word)) return mode;
  }
  return null;
}

/** Trains vs buses: which vehicle did the user actually name? */
function detectTransitPref(text: string): 'rail' | 'bus' | undefined {
  const t = (text || '').toLowerCase();
  if (/train|רכבת/.test(t)) return 'rail';
  if (/bus|אוטובוס/.test(t)) return 'bus';
  return undefined;
}

/** 'home' if the message says the trip starts at home (EN/HE), else null. */
function detectHomeOrigin(text: string): 'home' | null {
  return /(from home|מהבית|^home$|^בית$)/i.test((text || '').trim()) ? 'home' : null;
}

const GET_READY_MINUTES = 20; // buffer to get ready before leaving home

function subMinutes(hhmm: string, mins: number): string {
  const [h, m] = hhmm.split(':').map(Number);
  const total = (((h * 60 + m - mins) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function nowHHMM(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Extract tasks from the message — on the SERVER.
 *
 * The prompt that used to live here (one commitment = one task; reminders and
 * travel are not tasks; the end of a range is not a second task) moved to
 * server/task_extract.py, so WhatsApp and the app now read a sentence the same
 * way instead of drifting apart one edit at a time. The clock time, the date
 * and the category are decided by deterministic Python once the words come
 * back, which is why nothing below re-parses them.
 *
 * Returns [] when the server is unreachable: this engine is the OFFLINE
 * fallback, and offline is exactly when an extraction call was never going to
 * work anyway. The deterministic intent router above it still answers.
 */
async function extractTasks(
  input: string,
  today: string,
  history?: { role: 'user' | 'lumi'; text: string }[],
): Promise<Extracted[]> {
  const extracted = await extractServerTasks(input, today);
  // THE SERVER GAVE NOTHING. That used to end here, with `[]`, and the caller
  // answered with small talk — so "יוגה ב 11 בבוקר ביגאל אלון 94" got a warm
  // reply and was thrown away. The fallback was never local: this function's
  // only source was the backend.
  //
  // The parsers below are the ones addManualTask has always used, and they
  // handle that sentence exactly. See utils/localTaskExtract.
  if (!extracted) {
    const local = extractLocally(input, today, {
      time: (t, ref) => parseTimeExpression(t, ref) as any,
      place: placePartsFrom,
      details: inferTaskDetails,
    });
    if (!local) {
      console.warn('[LumiCoachEngine] server unreachable and nothing parsed locally');
      return [];
    }
    console.warn('[LumiCoachEngine] server unreachable — parsed locally');
    return [{
      text: local.text,
      category: local.category,
      priority: local.priority,
      fixedTime: local.fixedTime,
      durationMinutes: local.durationMinutes,
      location: local.location,
      date: local.date,
    }];
  }
  return extracted
    .filter((t: any) => t && t.text)
    .map((t: any) => ({
      text: String(t.text),
      category: (VALID_CATEGORIES.has(t.category) ? t.category : 'general') as TaskCategory,
      priority: t.priority || 'need_to',
      fixedTime: t.fixed_time || undefined,
      durationMinutes: Number.isFinite(Number(t.duration_minutes)) && Number(t.duration_minutes) > 0
        ? Number(t.duration_minutes)
        : undefined,
      location: t.location || undefined,
      date: /^\d{4}-\d{2}-\d{2}$/.test(t.date) ? t.date : today,
    }));
}

// Map our internal mode to the index UserProfile.transportType GoogleService expects.
const modeToTransportType: Record<string, 'car' | 'bus' | 'walk' | 'bike'> = {
  car: 'car', transit: 'bus', foot: 'walk', bicycle: 'bike',
};

// Persist a chosen plan on the task and schedule the get-ready + leave reminders.
async function persistAndSchedule(pending: CoachPending, plan: TransitPlan, readyBy: string, language: Lang): Promise<void> {
  const locationObj = {
    address: pending.destination,
    displayName: pending.destination,
    lat: 0,
    lng: 0,
    confirmed: true,
    leaveHomeBy: plan.leaveHomeAt,
    wakeUpBy: readyBy, // get-ready time → fires the "get ready" reminder
    transitPlan: plan,
  };
  await updateTaskFields(pending.taskId, { location: locationObj as any, isFixed: true });
  try {
    // Under the per-task lock: this is one of four paths that schedule travel
    // alerts for the same task, and interleaving runs are what produced the
    // repeated "time to start getting ready".
    await withTaskAlertLock(pending.taskId, async () => {
      // date is needed by the system-alarm 24h guard in scheduleTransitNotifications.
      const existing = (await getAllTasks()).find((task) => task.id === pending.taskId);
      if (existing) await cancelTaskNotifications(existing);
      const notifTask = { id: pending.taskId, text: pending.taskText, date: pending.date, location: locationObj, notificationIds: [] } as unknown as Task;
      // Without the usual wake hour, needsWakeAlarm treats every morning prep
      // time as a wake-from-sleep alarm — see the same fix in GoogleSync.
      const usualWake = normalizeProfile(await loadProfile())?.defaultWakeTime;
      await scheduleTransitNotifications(notifTask, language, usualWake);
      await updateTaskFields(pending.taskId, { notificationIds: notifTask.notificationIds });
    });
  } catch (e) {
    console.warn('[LumiCoachEngine] reminder scheduling failed', e);
  }
}

// One transit option, as a compact "leave → walk → train" line.
function transitStep(plan: TransitPlan, language: Lang): string {
  const leg = plan.legs?.find((l) => l.type === 'bus' || l.type === 'train');
  const line = leg?.lineNumber ? ` ${leg.lineNumber}` : '';
  const walk = plan.walkToStopMinutes && plan.firstBusStop
    ? (language === 'he' ? `🚶 ${plan.walkToStopMinutes} דק' ל${plan.firstBusStop} · ` : `🚶 ${plan.walkToStopMinutes}m to ${plan.firstBusStop} · `)
    : '';
  // Door-to-door total appended — the compact line used to imply the whole trip
  // was just the first ride.
  return `${walk}🚆${line} ${plan.firstBusDeparture} · ${plan.totalDurationMinutes}m`;
}

/** planAndNotify outcome: text to show, plus a pending handoff + chips when it asked "which train?". */
interface PlanOutcome {
  reply: string;
  pending?: CoachPending;
  chips?: string[];
}

// Plan the trip, persist + schedule reminders, and return the reasoning to show.
// Transit with several viable trains does NOT persist — it asks the user to
// pick one first (pending.awaitingTrainChoice).
async function planAndNotify(
  pending: CoachPending,
  mode: 'car' | 'transit' | 'foot' | 'bicycle',
  language: Lang,
): Promise<PlanOutcome> {
  // Every trip that actually gets planned teaches the habit. This is the one
  // funnel all of them pass through, so recording here means the answer is
  // learned however it arrived — a chip, a typed reply, or a remembered one.
  // Transit is stored as the SPECIFIC vehicle, because "transit to Nahariya"
  // would happily come back as a bus next time.
  if (pending.destination) {
    const specific = mode === 'transit'
      ? (pending.transitPref === 'bus' ? 'bus' : 'train')
      : mode === 'foot' ? 'walk' : mode === 'bicycle' ? 'bike' : 'car';
    void rememberPlaceMode(pending.destination, specific);
  }
  const profile = await loadProfile();
  // An origin the user typed always wins. Otherwise the day decides: the trip
  // starts wherever the previous commitment leaves her, not at home by default.
  // 'home' and 'implied' are sentinels, not addresses — only a real typed
  // place counts as explicit. Without this guard the literal string "implied"
  // would be handed to Directions as the start point.
  const SENTINELS = new Set(['home', 'implied']);
  const explicit = pending.origin && !SENTINELS.has(pending.origin) ? pending.origin : undefined;
  const implied = await impliedOrigin(pending.date, pending.arrivalTime, profile?.homeAddress || '');
  const startAddress = explicit ?? (pending.origin === 'home' ? profile?.homeAddress : implied.address);
  const fromHome = !explicit && (pending.origin === 'home' || implied.fromHome);
  const originNote = explicit
    ? ''
    : (language === 'he' ? ` (${implied.whereHe})` : ` (${implied.whereEn})`);
  if (!startAddress) {
    return {
      reply: language === 'he'
        ? `כדי לחשב מתי לצאת אני צריך את כתובת הבית שלך — לחצ/י על „${HOME_HERE_CHIP.he}” או כתוב/י כתובת 🏠`
        : `To plan when to leave I need your home — tap "${HOME_HERE_CHIP.en}" or type your address 🏠`,
    };
  }
  // GoogleService routes FROM gProfile.homeAddress, so the confirmed origin goes there.
  const gProfile = { homeAddress: startAddress, transportType: modeToTransportType[mode] } as any;
  const he = language === 'he';
  const noRoute = he
    ? `לא הצלחתי למצוא מסלול ל${pending.destination} — אפשר לוודא את הכתובת?`
    : `Couldn't find a route to ${pending.destination} — can you confirm the address?`;

  // Never offer a plan in the past. If it's today, the leave time must be after now;
  // if the appointment time itself already passed, don't plan travel at all.
  const isToday = pending.date === getTodayString();
  const now = nowHHMM();
  if (isToday && pending.arrivalTime <= now) {
    return {
      reply: he
        ? `⏰ הזמן של ${pending.destination} (${pending.arrivalTime}) כבר עבר היום — לתזמן מחדש?`
        : `⏰ ${pending.destination} at ${pending.arrivalTime} has already passed today — want to reschedule?`,
      // Keep the conversation alive: the next turn's "yes"/new time is a reschedule answer.
      pending: { ...pending, mode, awaitingReschedule: true },
      chips: rescheduleChips(he),
    };
  }
  const notPast = (p: TransitPlan | null): TransitPlan | null =>
    p && (!isToday || p.leaveHomeAt >= now) ? p : null;

  /**
   * Google returned nothing at all — which is NOT the same as "you're too late".
   *
   * Transit timetables are only published a few weeks out, so asking for a bus
   * or train a month ahead reliably returns zero routes. The code used to fold
   * that into the past-departure branch and tell the user "every departure has
   * already left" for an appointment in September, which is nonsense and
   * invites them to reschedule something that is perfectly fine.
   */
  const noRouteForDate = (): PlanOutcome => ({
    reply: he
      ? (isToday
        ? noRoute
        : `לא מצאתי מסלול ל${pending.destination} בתאריך ${pending.date}. `
          + 'לוחות זמנים של תחב״צ מתפרסמים כמה שבועות מראש, אז לתאריך רחוק עדיין אין נתונים — '
          + 'המשימה נשמרה, ואחשב את המסלול כשהתאריך יתקרב 📅')
      : (isToday
        ? noRoute
        : `No route found to ${pending.destination} on ${pending.date}. `
          + 'Public-transport timetables are only published a few weeks ahead, so a far-off date '
          + "has no data yet — the task is saved, and I'll work out the route closer to the day 📅"),
  });

  // ── Car / bike / walk: single direct route (bike used to wrongly fall into
  // the transit branch and never worked as its own mode). ──
  if (mode === 'car' || mode === 'bicycle' || mode === 'foot') {
    const gMode = modeToTransportType[mode];
    const emoji = mode === 'car' ? '🚗' : mode === 'bicycle' ? '🚲' : '🚶';
    const rideWord = he
      ? mode === 'car' ? "דק' נסיעה" : mode === 'bicycle' ? "דק' רכיבה" : "דק' הליכה"
      : mode === 'car' ? 'min drive' : mode === 'bicycle' ? 'min ride' : 'min walk';
    const raw = await GoogleService.getPlanForMode(gMode, pending.destination, pending.arrivalTime, gProfile, pending.date);
    if (!raw) return noRouteForDate();
    const plan = notPast(raw);
    if (!plan) {
      // A route exists, it has simply already departed. Only reachable today.
      return {
        reply: he
          ? `${emoji} כדי להגיע ל${pending.destination} עד ${pending.arrivalTime} היית צריך/ה כבר לצאת — לתזמן מחדש?`
          : `${emoji} To reach ${pending.destination} by ${pending.arrivalTime} you'd already need to have left — reschedule?`,
        pending: { ...pending, mode, awaitingReschedule: true },
        chips: rescheduleChips(he),
      };
    }
    const readyBy = subMinutes(plan.leaveHomeAt, GET_READY_MINUTES);
    await persistAndSchedule(pending, plan, readyBy, language);
    return {
      reply: (he
        ? [`${emoji} תוכנית ל${pending.destination} עד ${pending.arrivalTime}:`,
           `🧍 להתחיל להתכונן: ${readyBy}`,
           `🚪 לצאת מהבית: ${plan.leaveHomeAt} (${plan.totalDurationMinutes} ${rideWord})`,
           `📍 הגעה עד ${pending.arrivalTime}`,
           `⏰ קבעתי תזכורות להתכונן ולצאת`]
        : [`${emoji} Plan for ${pending.destination} by ${pending.arrivalTime}:`,
           `🧍 Start getting ready: ${readyBy}`,
           `🚪 Leave home: ${plan.leaveHomeAt} (${plan.totalDurationMinutes} ${rideWord})`,
           `📍 Arrive by ${pending.arrivalTime}`,
           `⏰ Reminders set to get ready & to leave`]
      ).join('\n'),
    };
  }

  // ── Transit: trains by default (buses only when asked). Consecutive real
  // departures, NEVER mixed vehicles, each option a full readable block, and
  // the user picks before anything is booked. ──
  const pref: 'rail' | 'bus' = pending.transitPref ?? 'rail';
  const rawPlans = await GoogleService.getTransitPlans(
    pending.destination, pending.arrivalTime, gProfile, pending.date, 3, pref);
  // Zero routes means Google had no data — say that, don't claim she is late.
  if (rawPlans.length === 0) return noRouteForDate();
  const wanted = pref === 'rail' ? ['train', 'subway'] : ['bus'];
  // Keep only options whose vehicle matches what was asked — no more "trains"
  // list with a bus hiding inside it.
  let plans = rawPlans
    .filter((p) => notPast(p) !== null)
    .filter((p) => wanted.includes(p.legs?.find((l) => l.type !== 'walk')?.type ?? ''));
  let vehicleNote = '';
  if (plans.length === 0) {
    // No pure-vehicle option exists — fall back to whatever transit there is,
    // but SAY so instead of silently mixing.
    plans = rawPlans.filter((p) => notPast(p) !== null);
    vehicleNote = pref === 'rail'
      ? (he ? 'אין רכבת ישירה למסלול הזה — אלו האפשרויות בתחב״צ:' : 'No direct train on this route — public-transport options:')
      : (he ? 'לא נמצא קו אוטובוס מתאים — אפשרויות אחרות:' : 'No suitable bus found — other options:');
  }
  if (plans.length === 0) {
    return {
      reply: he
        ? `🚆 כל היציאות ל${pending.destination} עד ${pending.arrivalTime} כבר עברו — לתזמן מחדש?`
        : `🚆 Every departure to ${pending.destination} for ${pending.arrivalTime} has already left — reschedule?`,
      pending: { ...pending, mode, awaitingReschedule: true },
      chips: rescheduleChips(he),
    };
  }

  const isInterview = /interview|ראיון/i.test(pending.taskText || '');
  const blocks = plans.map((p, i) => transitOptionBlock(p, i, pending, language, isInterview));
  const tail = pref === 'rail'
    ? (he
        ? `אפשר גם 🚌 אוטובוס או 🚲 אופניים — או שבחר/י רכבת (1-${plans.length}) ואקבע שעון אמיתי ⏰`
        : `Bus 🚌 or bike 🚲 are options too — or pick a train (1-${plans.length}) and I'll set a real alarm ⏰`)
    : (he
        ? `איזה אוטובוס? (1-${plans.length}) — או 🚆 רכבת / 🚲 אופניים`
        : `Which bus? (1-${plans.length}) — or 🚆 train / 🚲 bike`);
  const header = pref === 'rail'
    ? (he ? `🚆 רכבות ל${pending.destination} (להגיע עד ${pending.arrivalTime}):` : `🚆 Trains to ${pending.destination} (arrive by ${pending.arrivalTime}):`)
    : (he ? `🚌 אוטובוסים ל${pending.destination} (להגיע עד ${pending.arrivalTime}):` : `🚌 Buses to ${pending.destination} (arrive by ${pending.arrivalTime}):`);
  return {
    reply: [header, vehicleNote, ...blocks, tail].filter(Boolean).join('\n\n'),
    pending: { ...pending, mode: 'transit', transitPref: pref, options: plans, awaitingTrainChoice: true },
    chips: [
      ...plans.map((_, i) => String(i + 1)),
      pref === 'rail' ? (he ? '🚌 אוטובוס' : '🚌 Bus') : (he ? '🚆 רכבת' : '🚆 Train'),
      he ? '🚲 אופניים' : '🚲 Bike',
    ],
  };
}

/** One transit option in the full readable shape:
 *  wake → EVERY leg in clock order (walks, rides, transfers) → final arrival
 *  (+ aim-early note for interviews).
 *  Was rendering only the first ride + one walk, so a two-bus trip read as the
 *  first bus's duration ("15 min" for a 45-min route). */
function transitOptionBlock(
  p: TransitPlan, index: number, pending: CoachPending, language: Lang, isInterview: boolean,
): string {
  const he = language === 'he';
  const wake = subMinutes(p.leaveHomeAt, GET_READY_MINUTES);
  const iconOf = (t: string) =>
    t === 'train' ? '🚆' : t === 'subway' ? '🚇' : t === 'walk' ? '🚶' : '🚌';
  const lines = [
    he ? `אפשרות ${index + 1}:` : `Option ${index + 1}:`,
    he ? `⏰ להתעורר עד ${wake} · 🚪 לצאת ב-${p.leaveHomeAt}` : `⏰ Wake by ${wake} · 🚪 Leave at ${p.leaveHomeAt}`,
    // Door-to-door total up front — the number the user compares to Google.
    he ? `⏱ סה"כ ${p.totalDurationMinutes} דק'` : `⏱ ${p.totalDurationMinutes} min door to door`,
  ];
  for (const leg of p.legs || []) {
    const where = leg.to || (leg.type === 'walk' ? pending.destination : '');
    if (leg.type === 'walk') {
      lines.push(he
        ? `🚶 ${leg.durationMinutes} דק'${where ? ` ל${where}` : ''}`
        : `🚶 ${leg.durationMinutes} min${where ? ` to ${where}` : ''}`);
      continue;
    }
    const name = leg.lineNumber
      ? `${iconOf(leg.type)} ${he ? 'קו' : 'line'} ${leg.lineNumber}`
      : `${iconOf(leg.type)} ${he ? (leg.type === 'bus' ? 'אוטובוס' : 'רכבת') : leg.type}`;
    lines.push(he
      ? `${name} ב-${leg.departureTime} מ${leg.from} → ${leg.arrivalTime} ל${where} (${leg.durationMinutes} דק')`
      : `${name} at ${leg.departureTime} from ${leg.from} → ${leg.arrivalTime} at ${where} (${leg.durationMinutes} min)`);
  }
  lines.push(he ? `📍 הגעה ב-${p.arriveAt}` : `📍 Arrive at ${p.arriveAt}`);
  if (isInterview) {
    lines.push(he
      ? '💼 לראיון עדיף להגיע 10–15 דק׳ לפני'
      : '💼 For an interview, aim to arrive 10–15 min early');
  }
  return lines.join('\n');
}

// Persist the chosen train + schedule notifications/alarm, and return the SHORT confirmation.
async function confirmTrainChoice(pending: CoachPending, plan: TransitPlan, language: Lang): Promise<string> {
  const readyBy = subMinutes(plan.leaveHomeAt, GET_READY_MINUTES);
  await persistAndSchedule(pending, plan, readyBy, language);
  return language === 'he'
    ? `נקבע! ⏰ קימה ${readyBy} · 🚪 יציאה ${plan.leaveHomeAt} · ${transitStep(plan, language)}\nשעון מעורר + תזכורות פעילים ✓`
    : `Set! ⏰ Wake ${readyBy} · 🚪 Leave ${plan.leaveHomeAt} · ${transitStep(plan, language)}\nReal alarm + reminders on ✓`;
}

const chit = (language: Lang) =>
  language === 'he'
    ? 'ספר/י לי מה על היום ואני אארגן לפי זמן וקטגוריה 🌟'
    : "Tell me what's on your plate and I'll sort it by time and category 🌟";

/** Not just a count — SHOW the user what got saved, with date + hour. */
const savedLine = (tasks: Task[], language: Lang) => {
  const he = language === 'he';
  const head = he
    ? `נשמר${tasks.length > 1 ? `ו ${tasks.length} משימות` : 'ה משימה'} ✓`
    : `Saved ${tasks.length} task${tasks.length > 1 ? 's' : ''} ✓`;
  const lines = tasks.slice(0, 6).map((t) => {
    const when = [t.date === getTodayString() ? (he ? 'היום' : 'today')
      : t.date === getTomorrowString() ? (he ? 'מחר' : 'tomorrow') : t.date,
      t.fixedTime].filter(Boolean).join(' ');
    return `• ${t.text}${when ? ` (${when})` : ''}`;
  });
  return `${head}\n${lines.join('\n')}`;
};

/** Said out loud, so a remembered habit never looks like a silent decision. */
const usualModeNote = (dest: string, mode: string, language: Lang) => {
  const he = language === 'he';
  const label: Record<string, [string, string]> = {
    train: ['ברכבת', 'by train'], bus: ['באוטובוס', 'by bus'],
    car: ['ברכב', 'by car'], walk: ['ברגל', 'on foot'], bike: ['באופניים', 'by bike'],
  };
  const [heWord, enWord] = label[mode] ?? ['', ''];
  return he
    ? `לנהריה את בדרך כלל נוסעת ${heWord} — תכננתי ככה 🚆`.replace('לנהריה', `ל${dest}`)
    : `You usually get to ${dest} ${enWord} — planned it that way.`;
};

const askTransport = (dest: string, language: Lang) =>
  language === 'he'
    ? `איך תגיע/י ל${dest}? 🚆 רכבת · 🚌 אוטובוס · 🚗 רכב · 🚶 רגל`
    : `How will you get to ${dest}? 🚆 train · 🚌 bus · 🚗 car · 🚶 walk`;

const askHome = (language: Lang) =>
  language === 'he'
    ? `מעולה! מה כתובת הבית שלך? כתוב/י אותה, או לחצ/י על „${HOME_HERE_CHIP.he}” 🏠`
    : `Great! What's your home address? Type it, or tap "${HOME_HERE_CHIP.en}" 🏠`;

const askOrigin = (language: Lang) =>
  language === 'he'
    ? 'מאיפה תצא/י — מהבית או ממקום אחר? כתוב/י "מהבית" או כתובת 📍'
    : 'Where are you leaving from — home or somewhere else? Reply "home" or type an address 📍';

/**
 * Where this trip actually starts — read off the day, not asked.
 *
 * A day is a FLOW. If a 14:00 appointment in Holon follows a 10:00 one in Tel
 * Aviv, the journey starts in Tel Aviv; asking "from home?" is both a wasted
 * question and, if answered "home", a wrong route and a wrong leave time.
 * ensureTravelChain has always chained correctly via prevAddress — the chat
 * was the path that didn't, because it insisted on confirming every origin.
 *
 * Returns the previous committed place when there is one, else home. The
 * caller states which, so a wrong guess is visible and correctable rather than
 * silent.
 */
async function impliedOrigin(
  date: string, arrivalTime: string, homeAddress: string,
): Promise<{ address: string; fromHome: boolean; whereEn: string; whereHe: string }> {
  const home = { address: homeAddress, fromHome: true, whereEn: 'from home', whereHe: 'מהבית' };
  try {
    const previous = (await getTasksForDate(date))
      .filter((t) => t.status !== 'complete' && addrOf(t) && timeOf(t) && timeOf(t)! < arrivalTime)
      .sort((a, b) => (timeOf(a)! < timeOf(b)! ? 1 : -1))[0];
    if (!previous) return home;
    return {
      address: addrOf(previous)!,
      fromHome: false,
      whereEn: `from "${previous.text}"`,
      whereHe: `מ"${previous.text}"`,
    };
  } catch {
    return home;
  }
}

// ── Reschedule answer parsing (pure — covered by the self-check below) ──

const rescheduleChips = (he: boolean): string[] =>
  he ? ['מחר באותה שעה', 'לא, עזוב'] : ['Tomorrow same time', 'No, leave it'];

const isYesWord = (t: string) => /^(yes|yeah|yep|sure|ok(ay)?|כן|בטח|יאללה|סבבה)[.!]?$/i.test(t.trim());
const isNoWord = (t: string) => /(^|\b)(no|nope|לא|leave it|עזוב|בטל|cancel|never mind)\b/i.test(t.trim());

/** "17:30" / "at 5" / "בשעה 17" → HH:MM, else null. Bare small ints 1-9 are ambiguous → null. */
function parseTimeToken(text: string): string | null {
  const m = (text || '').match(/(\d{1,2}):(\d{2})/);
  if (m) {
    const h = parseInt(m[1], 10), mm = parseInt(m[2], 10);
    if (h < 24 && mm < 60) return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }
  const bare = (text || '').match(/(?:at|בשעה|ב-?)\s*(\d{1,2})\b/i) || (text || '').match(/^\s*(\d{1,2})\s*$/);
  if (bare) {
    const h = parseInt(bare[1], 10);
    if (h >= 0 && h < 24) return `${String(h).padStart(2, '0')}:00`;
  }
  return null;
}

const wantsTomorrow = (t: string) => /(tomorrow|מחר)/i.test(t || '');

/**
 * The previous turn asked "…already passed — reschedule?". Interpret the answer:
 * no → drop it; bare yes → ask for the new time; a time and/or "tomorrow" →
 * update the task and resume planning with the already-known mode/origin.
 */
async function handleReschedule(input: string, pending: CoachPending, language: Lang): Promise<CoachResult> {
  const he = language === 'he';

  if (isNoWord(input)) {
    return {
      reply: he ? 'אוקיי, משאיר ככה 👍' : 'OK, leaving it as-is 👍',
      savedCount: 0,
      refreshTasks: false,
    };
  }

  const newTime = parseTimeToken(input);
  const tomorrow = wantsTomorrow(input);

  // Bare "yes" — we still need a time. Keep waiting.
  if (!newTime && !tomorrow) {
    if (isYesWord(input)) {
      return {
        reply: he
          ? `לאיזו שעה להזיז את ${pending.taskText}? אפשר גם "מחר באותה שעה" ⏰`
          : `What time should I move ${pending.taskText} to? You can also say "tomorrow same time" ⏰`,
        savedCount: 0,
        pending,
        chips: rescheduleChips(he),
        refreshTasks: false,
      };
    }
    // Unrelated answer — drop the reschedule and let the fresh path handle it.
    return coachTurn(input, { language });
  }

  const newDate = tomorrow ? getTomorrowString() : pending.date;
  const arrivalTime = newTime ?? pending.arrivalTime; // "tomorrow same time" keeps the hour
  await updateTaskFields(pending.taskId, { fixedTime: arrivalTime, date: newDate });

  const next: CoachPending = { ...pending, arrivalTime, date: newDate, awaitingReschedule: false };
  const confirmed = he
    ? `הוזז ל-${tomorrow ? 'מחר ' : ''}${arrivalTime} ✓`
    : `Moved to ${tomorrow ? 'tomorrow ' : ''}${arrivalTime} ✓`;

  // We know how they travel; where FROM is read off the day, so there is
  // nothing left to ask before replanning.
  if (next.mode) {
    const planned = await planAndNotify(next, next.mode, language);
    return {
      reply: `${confirmed}\n${planned.reply}`,
      savedCount: 0,
      pending: planned.pending,
      chips: planned.chips,
      refreshTasks: true,
    };
  }
  // Ask only if we do not already know. Having answered "by train" for
  // Nahariya twice, being asked a third time is the assistant forgetting
  // something she told it — so a settled habit answers for her and the trip is
  // planned straight away.
  const learned = await preferredPlaceMode(next.destination).catch(() => null);
  if (learned) {
    // The coach speaks in coarse modes and keeps rail-vs-bus separately, so a
    // remembered "train" has to set BOTH — otherwise "usually by train" plans
    // whatever bus happens to be quickest, which is the answer she rejected.
    const coachMode = learned === 'train' || learned === 'bus' ? 'transit'
      : learned === 'walk' ? 'foot'
      : learned === 'bike' ? 'bicycle' : 'car';
    const withPref: CoachPending = learned === 'train' || learned === 'bus'
      ? { ...next, transitPref: learned === 'train' ? 'rail' : 'bus' }
      : next;
    const planned = await planAndNotify(withPref, coachMode as any, language);
    return {
      reply: `${confirmed}\n${usualModeNote(next.destination, learned, language)}\n${planned.reply}`,
      savedCount: 0,
      pending: planned.pending,
      chips: planned.chips,
      refreshTasks: true,
    };
  }
  return {
    reply: `${confirmed}\n${askTransport(next.destination, language)}`,
    savedCount: 0,
    pending: next,
    refreshTasks: true,
  };
}

// ── Direct intents: deterministic, zero LLM calls (fast + never hallucinate) ──

export const PLAN_DAY_RE = /(plan (my )?day|plan today|^plan$|תכנן (לי )?את היום|סדר (לי )?את היום|מה התוכנית( שלי)?( להיום)?)/i;
export const URGENT_RE = /(what'?s urgent|anything urgent|^urgent\??$|מה דחוף|יש משהו דחוף|דחוף להיום)/i;
// Checked BEFORE PLAN_DAY (its "מה התוכנית" would swallow tomorrow questions).
export const PLAN_TOMORROW_RE = /(plan (for )?tomorrow|schedule tomorrow|plans? for tomorrow|תכנן (לי )?(את )?מחר|לתכנן (את )?מחר|סדר (לי )?את מחר|מה (התוכנית|התוכניות|יש)( שלי)? (ל)?מחר)/i;
// A question must NEVER be "saved as a task" — answer it from the store.
const QUESTION_RE = /^(what|when|where|how|which|do i|did i|is there|are there|מה|מתי|איפה|איך|כמה|האם)\b|\?\s*$/i;
// "wake me up at 7" / "להתעורר ב-7:00" → set the real wake alarm.
const WAKE_RE = /(?:wake (?:me )?(?:up )?(?:at|on)|להתעורר ב-?|תעירי? אותי ב-?|לקום ב-?)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/i;

// ── Reminders (NOT tasks) ────────────────────────────────────────────────────
// "תתריע לי ב-16:00" used to be saved as a task called "תתריע לי ב-16:00" and
// no alert ever fired. These three patterns split the cases apart:
//   REMIND_TRIGGER + a clock time  → a standalone reminder at that time
//   REMIND_TRIGGER + "N before"    → lead time on the task being discussed
//   REMIND_TRIGGER + no time       → a normal task ("remind me to buy milk")
const REMIND_TRIGGER_RE =
  /\b(remind|notify|ping|alert)\s+me\b|\bset\s+(?:an?\s+)?(?:alarm|reminder)\b|(?:^|\s)(?:תזכיר[יי]?\s+לי|תתריע[יי]?\s+לי|תתריעי?\s+לי|שים\s+לי\s+(?:התראה|תזכורת)|שימי\s+לי\s+(?:התראה|תזכורת)|קבע[יי]?\s+(?:לי\s+)?(?:התראה|תזכורת)|תשלח[יי]?\s+לי\s+תזכורת|תעדכן[יי]?\s+אותי)(?:\s|$)/i;
/** A clock time introduced by at/@/ב/בשעה — "at 16:00", "ב-16:00", "בשעה 4". */
const AT_TIME_RE = /(?:\bat\b|\bfor\b|@|בשעה|לשעה|ב-)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/i;
/**
 * "30 minutes before" / "חצי שעה לפני" / "שעה קודם".
 * The bare-unit alternatives ("an hour", "שעה") come LAST so that "חצי שעה"
 * is read as half an hour rather than a whole one.
 */
const LEAD_BEFORE_RE =
  /(?:(\d{1,3})\s*(minutes?|mins?|hours?|hrs?|דקות|דקה|דק'?|שעות|שעה)|half\s+an\s+hour|חצי\s+שעה|an?\s+hour|שעה)\s*(?:before|earlier|ahead|לפני|קודם|מראש)/i;

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * A reminder request → a real scheduled alert, or null when the sentence names
 * no time at all (then it is an ordinary task and the caller continues).
 *
 * Never claims success without an id coming back from the scheduler — a ✓ for
 * an alert that does not exist is worse than saying nothing.
 */
async function handleReminderRequest(input: string, language: Lang): Promise<CoachResult | null> {
  const he = language === 'he';

  // ── "…30 minutes before" → lead time on the task under discussion ──
  const lead = input.match(LEAD_BEFORE_RE);
  if (lead) {
    const minutes = lead[1]
      ? parseInt(lead[1], 10) * (/hour|hr|שע/i.test(lead[2] || '') ? 60 : 1)
      // No number: "half an hour" / "חצי שעה" is 30, a bare "hour" / "שעה" is 60.
      : /half|חצי/i.test(lead[0]) ? 30 : 60;
    const task = await resolveFocusTask();
    if (!task) {
      return {
        reply: he ? 'לפני מה? לא מצאתי משימה קרובה 🙏' : 'Before what? I have no upcoming task 🙏',
        savedCount: 0,
        refreshTasks: false,
      };
    }
    const updated = await setLeadTimeForTask(task.id, [minutes]);
    if (!updated) {
      return {
        reply: he ? 'לא הצלחתי לקבוע את ההתראה 🙏' : "Couldn't set that alert 🙏",
        savedCount: 0,
        refreshTasks: false,
      };
    }
    const at = subMinutes(task.fixedTime || '00:00', minutes);
    return {
      reply: he
        ? `✓ אתריע ${describeLead(minutes, true)} — ב-${at}, לפני "${task.text}"`
        : `✓ I'll alert you ${describeLead(minutes, false)} — at ${at}, before "${task.text}"`,
      savedCount: 0,
      refreshTasks: true,
    };
  }

  // ── "…at 16:00" → a standalone reminder ──
  const at = input.match(AT_TIME_RE);
  if (!at) return null; // no time → let the task extractor have it

  let h = parseInt(at[1], 10);
  const m = at[2] ? parseInt(at[2], 10) : 0;
  const meridiem = (at[3] || '').toLowerCase();
  if (/p/.test(meridiem) && h < 12) h += 12;
  if (/a/.test(meridiem) && h === 12) h = 0;
  if (h > 23 || m > 59) return null;

  // Which day: an explicit "tomorrow", otherwise today — and if that moment
  // already passed today, the user plainly means tomorrow.
  const time = `${pad2(h)}:${pad2(m)}`;
  const saysTomorrow = /\b(tomorrow|מחר)\b/i.test(input);
  let date = saysTomorrow ? getTomorrowString() : getTodayString();
  if (!saysTomorrow && time <= nowHHMM()) date = getTomorrowString();

  // What to say: strip the trigger and the time, keep the actual subject.
  const subject = input
    .replace(REMIND_TRIGGER_RE, ' ')
    .replace(AT_TIME_RE, ' ')
    .replace(/\b(tomorrow|today|מחר|היום)\b/gi, ' ')
    .replace(/^\s*(to|that|ש|ל)\s+/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const saved = await setStandaloneReminder({ text: subject, date, time });
  if (!saved) {
    return {
      reply: he
        ? `הזמן ${time} כבר עבר — תגידי לי שעה עתידית 🙏`
        : `${time} has already passed — give me a future time 🙏`,
      savedCount: 0,
      refreshTasks: false,
    };
  }
  const dayWord = date === getTodayString() ? (he ? 'היום' : 'today') : (he ? 'מחר' : 'tomorrow');
  return {
    reply: he
      ? `⏰ אתריע לך ${dayWord} ב-${time}${subject ? ` — ${subject}` : ''} ✓`
      : `⏰ Reminder set for ${dayWord} at ${time}${subject ? ` — ${subject}` : ''} ✓`,
    savedCount: 0,
    refreshTasks: false,
  };
}

/** List a date's tasks in clock order; empty → suggest the closest deadlines. */
async function listForDate(date: string, label: string, language: Lang): Promise<CoachResult> {
  const he = language === 'he';
  const tasks = (await getTasksForDate(date))
    .filter((t) => t.status !== 'complete')
    .sort((a, b) => ((a.fixedTime || a.scheduledTime || '99') < (b.fixedTime || b.scheduledTime || '99') ? -1 : 1));
  if (tasks.length > 0) {
    const lines = tasks.map((t) => {
      const time = t.fixedTime || t.scheduledTime;
      return `${PRIORITY_EMOJI[t.priority ?? 'need_to'] ?? '🟡'} ${time ? `${time} ` : ''}${t.text}`;
    });
    return {
      reply: `${label}\n${lines.join('\n')}`,
      savedCount: 0,
      refreshTasks: false,
      chips: he ? ['תכנן לי את מחר'] : ['Plan tomorrow'],
    };
  }
  // Nothing scheduled → suggest what matters: nearest deadlines + backlog.
  const all = (await getAllTasks()).filter((t) => t.status !== 'complete');
  const byDeadline = all
    .filter((t) => t.deadline)
    .sort((a, b) => (a.deadline! < b.deadline! ? -1 : 1))
    .slice(0, 3);
  const suggestions = byDeadline.map(
    (t) => `⏳ ${t.text} (${he ? 'דדליין' : 'due'} ${t.deadline})`,
  );
  const header = he ? `${label}\nעוד אין תוכנית 🌙` : `${label}\nNothing scheduled yet 🌙`;
  const offer = suggestions.length
    ? (he ? 'הכי קרובים לדדליין:\n' : 'Closest deadlines:\n') + suggestions.join('\n')
    : he ? 'ספר/י לי מה על הפרק ואסדר הכל ✨' : "Tell me what's coming up and I'll lay it out ✨";
  return {
    reply: `${header}\n${offer}`,
    savedCount: 0,
    refreshTasks: false,
    chips: he ? ['תכנן לי את מחר'] : ['Plan tomorrow'],
    action: 'openPlanTomorrow',
  };
}

const PRIORITY_EMOJI: Record<string, string> = { must: '🔴', have_to: '🟠', need_to: '🟡', nice_to_do: '🟢' };

/** "Plan my day": read today's pending tasks, keep fixed times, place flexible
 *  ones from now onward around the fixed blocks, persist, and show the schedule. */
async function handlePlanMyDay(language: Lang): Promise<CoachResult> {
  const he = language === 'he';
  const today = getTodayString();
  const tasks = (await getTasksForDate(today)).filter((t) => t.status !== 'complete');
  if (tasks.length === 0) {
    return { reply: chit(language), savedCount: 0, refreshTasks: false };
  }

  const sorted = sortTasksByPriorityAndTime(tasks) as Task[];
  const fixed = sorted.filter((t) => t.fixedTime);
  // Cursor starts at the next quarter hour from now.
  const nowMin = timeToMinutes(nowHHMM());
  let cursor = Math.ceil(nowMin / 15) * 15;
  const changed: Task[] = [];

  for (const t of sorted) {
    if (t.fixedTime) continue; // fixed tasks keep their time
    const dur = t.durationMinutes || 30;
    // Skip over any fixed block the slot would collide with.
    let placed = false;
    while (!placed) {
      placed = true;
      for (const f of fixed) {
        const fStart = timeToMinutes(f.fixedTime!);
        const fEnd = fStart + (f.durationMinutes || 30);
        if (cursor < fEnd && cursor + dur > fStart) {
          cursor = fEnd; // jump past the fixed block and re-check
          placed = false;
        }
      }
    }
    const hhmm = `${String(Math.floor(cursor / 60) % 24).padStart(2, '0')}:${String(cursor % 60).padStart(2, '0')}`;
    if (t.scheduledTime !== hhmm) {
      changed.push({ ...t, scheduledTime: hhmm });
    }
    t.scheduledTime = hhmm;
    cursor += dur + 10; // 10-min buffer between tasks
  }
  for (const t of changed) {
    await updateTaskFields(t.id, { scheduledTime: t.scheduledTime });
  }

  const lines = sorted.map((t) => {
    const time = t.fixedTime || t.scheduledTime || '--:--';
    const dur = t.durationMinutes ? ` (~${t.durationMinutes}m)` : '';
    return `${PRIORITY_EMOJI[t.priority ?? 'need_to'] ?? '🟡'} ${time} · ${t.text}${dur}`;
  });
  return {
    reply: [(he ? `הנה היום שלך (${sorted.length} משימות) 👇` : `Here's your day (${sorted.length} tasks) 👇`), ...lines].join('\n'),
    savedCount: 0,
    refreshTasks: changed.length > 0,
  };
}

/** "What's urgent?": today + backlog, filtered to must/have_to, near deadlines,
 *  or appointments within 3 hours. Deterministic — no LLM. */
async function handleWhatsUrgent(language: Lang): Promise<CoachResult> {
  const he = language === 'he';
  const today = getTodayString();
  const pool = [...(await getTasksForDate(today)), ...(await getBacklogBeforeDate(today))]
    .filter((t) => t.status !== 'complete');

  const nowMin = timeToMinutes(nowHHMM());
  const soonMs = Date.now() + 48 * 3600 * 1000;
  const urgent = pool.filter((t) => {
    if (t.priority === 'must' || t.priority === 'have_to') return true;
    if (t.deadline && new Date(`${t.deadline}T${t.deadlineTime || '23:59'}`).getTime() <= soonMs) return true;
    if (t.date === today && t.fixedTime) {
      const start = timeToMinutes(t.fixedTime);
      if (start >= nowMin && start - nowMin <= 180) return true;
    }
    return false;
  });

  if (urgent.length === 0) {
    return { reply: he ? 'אין כלום דחוף — רגוע ונעים 🌿' : 'Nothing urgent — nice and calm 🌿', savedCount: 0, refreshTasks: false };
  }
  const lines = (sortTasksByPriorityAndTime(urgent) as Task[]).map((t) => {
    const when = t.fixedTime ? ` — ${t.fixedTime}` : t.deadline ? ` — ${he ? 'דדליין' : 'due'} ${t.deadline}` : '';
    return `${PRIORITY_EMOJI[t.priority ?? 'need_to'] ?? '🔴'} ${t.text}${when}`;
  });
  return {
    reply: [(he ? 'הנה מה שדחוף 👇' : "Here's what's urgent 👇"), ...lines].join('\n'),
    savedCount: 0,
    refreshTasks: false,
  };
}

/**
 * One conversational turn. Pass `pending` back in when the previous turn asked
 * the transport question.
 */
// "X זה הבית שלי" / "הבית שלי זה X" / "אני גרה ב-X" / "my home is X" / "I live at X".
const HOME_LEAD_RE = /(?:הבית שלי(?:\s+(?:זה|הוא|נמצא ב))?|אני גר(?:ה)?\s*ב|my home is|i live (?:at|in|on))\s*[:\-–]?\s*(.{3,})/i;
const HOME_TRAIL_RE = /^(.{3,}?)\s*(?:זה|הוא)\s*הבית שלי/i;

/** The address in a "this is my home" statement, or null. */
function extractHomeStatement(input: string): string | null {
  const m = input.match(HOME_TRAIL_RE) || input.match(HOME_LEAD_RE);
  const addr = m?.[1]?.trim().replace(/[.!?،]+$/, '');
  return addr && addr.length >= 3 ? addr : null;
}

/** Save the home address (best-effort geocode for lat/lng) and confirm. */
async function saveHomeAddress(address: string, language: Lang): Promise<CoachResult> {
  const he = language === 'he';
  try {
    const profile = await loadProfile();
    if (!profile) {
      return { reply: he ? 'קודם נסיים את ההיכרות הקצרה 🙂' : "Let's finish the quick onboarding first 🙂", savedCount: 0, refreshTasks: false };
    }
    let homeLatLng = profile.homeLatLng ?? null;
    try {
      const places = await GoogleService.searchPlaces(address);
      if (places[0]) homeLatLng = { lat: places[0].lat, lng: places[0].lng };
    } catch { /* geocode is best-effort */ }
    await saveProfile({ ...profile, homeAddress: address, homeLatLng, lastUpdated: new Date().toISOString() });
    return {
      reply: he ? `🏠 שמרתי! ${address} הוא הבית שלך מעכשיו ✓` : `🏠 Saved! ${address} is your home now ✓`,
      savedCount: 0,
      refreshTasks: false,
    };
  } catch (e) {
    console.warn('[LumiCoachEngine] save home failed', e);
    return { reply: he ? 'לא הצלחתי לשמור את הכתובת 🙏 נסה/י שוב' : "Couldn't save the address 🙏 try again", savedCount: 0, refreshTasks: false };
  }
}

export async function coachTurn(
  input: string,
  opts: {
    language?: Lang;
    pending?: CoachPending;
    /** Last few chat turns (oldest first) — context for the extractor only. */
    history?: { role: 'user' | 'lumi'; text: string }[];
  },
): Promise<CoachResult> {
  const language: Lang = opts.language ?? 'en';

  // ── Continuation: waiting on transport choice, origin, and/or home address ──
  if (opts.pending) {
    // Waiting on "reschedule?" → interpret yes/no/new time (was a dead-end before).
    if (opts.pending.awaitingReschedule) {
      return handleReschedule(input, opts.pending, language);
    }
    // Waiting on "which train?" → a number books it; "bus"/"train" re-lists
    // that vehicle's options; "bike" switches to a direct bike plan.
    if (opts.pending.awaitingTrainChoice && opts.pending.options?.length) {
      const options = opts.pending.options;
      if (/bike|bicycle|אופניים/i.test(input)) {
        const planned = await planAndNotify(
          { ...opts.pending, awaitingTrainChoice: false, options: undefined }, 'bicycle', language);
        return { reply: planned.reply, savedCount: 0, pending: planned.pending, chips: planned.chips, refreshTasks: true };
      }
      const switchPref = detectTransitPref(input);
      if (switchPref && switchPref !== (opts.pending.transitPref ?? 'rail')) {
        const planned = await planAndNotify(
          { ...opts.pending, transitPref: switchPref, awaitingTrainChoice: false, options: undefined },
          'transit', language);
        return { reply: planned.reply, savedCount: 0, pending: planned.pending, chips: planned.chips, refreshTasks: false };
      }
      const picked = input.trim().match(/[1-9]/);
      const chosen = picked ? options[parseInt(picked[0], 10) - 1] : undefined;
      if (!chosen) {
        return {
          reply: language === 'he' ? `איזו אפשרות? השב/י 1-${options.length} 🚆` : `Which option? Reply 1-${options.length} 🚆`,
          savedCount: 0,
          pending: opts.pending,
          chips: options.map((_, i) => String(i + 1)),
          refreshTasks: false,
        };
      }
      const reply = await confirmTrainChoice(opts.pending, chosen, language);
      return { reply, savedCount: 0, refreshTasks: true };
    }

    // Mode already chosen (we're now waiting on origin/home) OR read it from this message.
    const mode = opts.pending.mode ?? detectTransport(input);
    if (!mode) {
      return { reply: askTransport(opts.pending.destination, language), savedCount: 0, pending: opts.pending, refreshTasks: false };
    }
    // Origin must be CONFIRMED, never assumed: 'home' or a typed address.
    let origin = opts.pending.origin;
    // "X זה הבית שלי" while she's waiting for the origin → save it as home
    // AND continue the plan from home (used to be misread as a raw address).
    const statedHome = extractHomeStatement(input);
    if (statedHome) {
      await saveHomeAddress(statedHome, language);
      origin = 'home';
    }
    if (!origin && opts.pending.awaitingOrigin) {
      origin = detectHomeOrigin(input) ?? (input.trim() || undefined);
    }
    // No explicit origin is no longer a blocker: planAndNotify reads the
    // previous commitment off the day and falls back to home.
    if (!origin) origin = 'implied';
    const profile = await loadProfile();
    if (origin === 'home' && !profile?.homeAddress) {
      // Keep the appointment + chosen mode alive until home is set (via 📍 or typed).
      return { reply: askHome(language), savedCount: 0, pending: { ...opts.pending, mode, origin }, refreshTasks: false };
    }
    const planned = await planAndNotify(
      { ...opts.pending, origin, transitPref: opts.pending.transitPref ?? detectTransitPref(input) },
      mode, language);
    return { reply: planned.reply, savedCount: 0, pending: planned.pending, chips: planned.chips, refreshTasks: true };
  }

  // "Wake me up at 7" — set the real alarm, then handle whatever else the
  // message says ("…and I want to study until 10") as its own turn.
  const wakeMatch = input.match(WAKE_RE);
  if (wakeMatch) {
    let h = parseInt(wakeMatch[1], 10);
    const m = wakeMatch[2] ? parseInt(wakeMatch[2], 10) : 0;
    if (/p/i.test(wakeMatch[3] || '') && h < 12) h += 12;
    let confirm: string;
    try {
      await scheduleWakeUpTest(h, m);
      confirm = language === 'he'
        ? `⏰ אעיר אותך מחר ב-${pad2(h)}:${pad2(m)} עם תדריך בוקר ✓`
        : `⏰ Wake alarm set for ${pad2(h)}:${pad2(m)} — morning briefing included ✓`;
    } catch {
      confirm = language === 'he' ? 'לא הצלחתי לקבוע את ההשכמה 🙏' : "Couldn't set the wake alarm 🙏";
    }
    const rest = input.replace(wakeMatch[0], ' ').replace(/^\s*(and|וגם|ו)\s+/i, '').trim();
    if (rest.split(/\s+/).filter(Boolean).length < 3) {
      return { reply: confirm, savedCount: 0, refreshTasks: false };
    }
    const restResult = await coachTurn(rest, opts);
    return { ...restResult, reply: `${confirm}\n${restResult.reply}` };
  }

  // "Remind me at 16:00" / "remind me 30 minutes before" — an ALERT, not a
  // to-do. Must run before extractTasks, which would otherwise save the
  // sentence itself as a task and schedule nothing.
  if (REMIND_TRIGGER_RE.test(input)) {
    const reminderResult = await handleReminderRequest(input, language);
    if (reminderResult) return reminderResult;
    // No time anywhere in the sentence → "remind me to buy milk" is a real
    // task; fall through to the normal creation path.
  }

  // ── Direct intents: answered from the task store, no LLM round-trip ──
  if (PLAN_TOMORROW_RE.test(input)) {
    const res = await listForDate(
      getTomorrowString(),
      language === 'he' ? '🌙 מחר:' : '🌙 Tomorrow:',
      language,
    );
    return { ...res, action: 'openPlanTomorrow' };
  }
  if (PLAN_DAY_RE.test(input)) return handlePlanMyDay(language);
  if (URGENT_RE.test(input)) return handleWhatsUrgent(language);

  // Questions are ANSWERED, never saved as tasks ("What are my plans for
  // tomorrow?" used to come back as "Saved 2 tasks ✓").
  if (QUESTION_RE.test(input.trim())) {
    if (/(tomorrow|מחר)/i.test(input)) {
      return listForDate(getTomorrowString(), language === 'he' ? '🌙 מחר:' : '🌙 Tomorrow:', language);
    }
    if (/(today|היום)/i.test(input)) {
      return listForDate(getTodayString(), language === 'he' ? '☀️ היום:' : '☀️ Today:', language);
    }
    const today = getTodayString();
    const upcoming = (await getAllTasks())
      .filter((t) => t.status !== 'complete' && t.date >= today)
      .sort((a, b) => (a.date + (a.fixedTime || '99') < b.date + (b.fixedTime || '99') ? -1 : 1))
      .slice(0, 8);
    if (!upcoming.length) {
      return { reply: chit(language), savedCount: 0, refreshTasks: false };
    }
    const lines = upcoming.map(
      (t) => `${PRIORITY_EMOJI[t.priority ?? 'need_to'] ?? '🟡'} ${t.date}${t.fixedTime ? ` ${t.fixedTime}` : ''} — ${t.text}`,
    );
    return {
      reply: (language === 'he' ? '📋 הקרובות:\n' : '📋 Coming up:\n') + lines.join('\n'),
      savedCount: 0,
      refreshTasks: false,
    };
  }

  // "מורדי הגטאות 23 זה הבית שלי" / "my home is X" → save it as home, don't
  // treat it as a task (this used to fall through to chit-chat).
  const homeAddr = extractHomeStatement(input);
  if (homeAddr) {
    return saveHomeAddress(homeAddr, language);
  }

  // ── Fresh message: extract → save → maybe ask transport ──
  const today = getTodayString();
  let extracted: Extracted[] = [];
  try {
    extracted = await extractTasks(input, today, opts.history);
  } catch (e) {
    console.warn('[LumiCoachEngine] extraction failed', e);
  }
  if (extracted.length === 0) {
    // SMALL TALK IS NOT AN ANSWER TO A TASK.
    //
    // This was the last step of the path that lost her yoga class: the server
    // was unreachable, extraction returned nothing, and `chit()` replied with
    // something friendly. She read a correct-sounding answer and the task was
    // gone. "Meira answers correctly! but now i see that nothing have been
    // saved?!" — there was no way for her to tell, because a warm reply is
    // exactly what a successful save sounds like.
    //
    // Now, when the message REALLY looks like a commitment and it still could
    // not be saved, it says so. A sentence she can act on beats a pleasant one
    // she cannot.
    if (!looksLikeAQuestion(input) && (parseTimeExpression(input, today).fixedTime
      || extractHebrewPlaceParts(input).place)) {
      return { reply: describeLocalSave(null, language === 'he'), savedCount: 0, refreshTasks: false };
    }
    return { reply: chit(language), savedCount: 0, refreshTasks: false };
  }

  // Save (grouped by date). addTasksForDate applies the correct category durations.
  const saved: Task[] = [];
  const byDate = new Map<string, Extracted[]>();
  for (const t of extracted) {
    const bucket = byDate.get(t.date) ?? [];
    bucket.push(t);
    byDate.set(t.date, bucket);
  }
  for (const [date, ts] of byDate) {
    const created = await addTasksForDate(date, ts.map((t) => ({
      text: t.text,
      tags: [],
      category: t.category,
      priority: t.priority,
      fixedTime: t.fixedTime ?? null,
      location: t.location,
      hasLocation: !!t.location,
    })), 'chat');
    saved.push(...created);
  }

  // Time-fixed tasks get reminders even without a transit plan (a plain
  // "dentist at 15:00" used to get none — only the transit flow scheduled any).
  for (const t of saved) {
    if (t.fixedTime) {
      scheduleTaskReminders(t, language).catch(() => {});
    }
  }

  // Remember what we just created, so an immediate follow-up like
  // "תזכיר לי חצי שעה לפני" attaches to THIS task instead of guessing.
  const focus = saved.find((t) => t.fixedTime) ?? saved[0];
  if (focus) setTaskFocus(focus.id).catch(() => {});

  // A located, time-fixed appointment → we can plan travel.
  const appt = saved.find((t) => t.location && t.fixedTime);
  if (appt && typeof appt.location === 'string' && appt.fixedTime) {
    const pending: CoachPending = {
      taskId: appt.id,
      taskText: appt.text,
      destination: appt.location,
      arrivalTime: appt.fixedTime,
      date: appt.date,
    };
    const mode = detectTransport(input); // did they already say "by train"?
    if (mode) {
      // Even with a mode we never assume the start point — confirm it first.
      // Was: ask "from home or somewhere else?". A day is a flow — the answer
      // is already in the schedule, and asking made every trip start at home.
      const origin = detectHomeOrigin(input) || 'implied';
      const profile = await loadProfile();
      if (!profile?.homeAddress) {
        return { reply: `${savedLine(saved, language)}\n${askHome(language)}`, savedCount: saved.length, pending: { ...pending, mode, origin }, refreshTasks: true };
      }
      const planned = await planAndNotify(
        { ...pending, origin, transitPref: pending.transitPref ?? detectTransitPref(input) },
        mode, language);
      return {
        reply: `${savedLine(saved, language)}\n${planned.reply}`,
        savedCount: saved.length,
        pending: planned.pending,
        chips: planned.chips,
        refreshTasks: true,
      };
    }
    // Ask how they'll travel; carry the appointment forward.
    return {
      reply: `${savedLine(saved, language)}\n${askTransport(appt.location, language)}`,
      savedCount: saved.length,
      pending,
      refreshTasks: true,
    };
  }

  return { reply: savedLine(saved, language), savedCount: saved.length, refreshTasks: true };
}

// A tiny self-check for the pure bits (run with: npx tsx src/services/LumiCoachEngine.ts)
if (require.main === module) {
  console.assert(detectTransport('I will take the רכבת') === 'transit', 'train→transit');
  console.assert(detectTransport('by car') === 'car', 'car');
  console.assert(detectTransport('no idea') === null, 'none');
  console.assert(detectHomeOrigin('I leave from home') === 'home', 'origin-en');
  console.assert(detectHomeOrigin('אני יוצא מהבית') === 'home', 'origin-he');
  console.assert(detectHomeOrigin('from the office') === null, 'origin-other');
  // Intent regexes (EN + HE)
  console.assert(PLAN_DAY_RE.test('Plan my day'), 'intent-plan-en');
  console.assert(PLAN_DAY_RE.test('תכנן לי את היום'), 'intent-plan-he');
  console.assert(URGENT_RE.test("What's urgent?"), 'intent-urgent-en');
  console.assert(URGENT_RE.test('מה דחוף'), 'intent-urgent-he');
  console.assert(!PLAN_DAY_RE.test('buy a planner'), 'intent-plan-negative');
  // Reschedule answer parsing
  console.assert(parseTimeToken('17:30') === '17:30', 'time-colon');
  console.assert(parseTimeToken('at 5') === '05:00', 'time-at');
  console.assert(parseTimeToken('בשעה 17') === '17:00', 'time-he');
  console.assert(parseTimeToken('yes') === null, 'time-none');
  console.assert(isYesWord('yes') && isYesWord('כן'), 'yes-words');
  console.assert(isNoWord('no, leave it') && isNoWord('לא'), 'no-words');
  console.assert(wantsTomorrow('tomorrow same time') && wantsTomorrow('מחר באותה שעה'), 'tomorrow');
  console.log('LumiCoachEngine self-check OK');
}
