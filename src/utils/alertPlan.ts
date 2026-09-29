/**
 * alertPlan — WHICH alerts a task gets, WHEN they fire, WHAT they say, and
 * WHICH screen a tap opens. Pure: no expo-notifications, no storage.
 *
 * NotificationService turns these into real scheduled notifications; the week
 * harness (tests/run-week-schedule.ts) prints and asserts them without a
 * device. One source of truth, so the schedule shown in a test is the schedule
 * the phone actually fires.
 *
 * Screen routing mirrors App.tsx's subscribeNotificationTap wiring: the alert's
 * `screen` travels in the notification data and App navigates to it
 * (TaskDetail / LeaveNow), with data.checkInType → CheckIn and the
 * 'plan_tomorrow' action → PlanTomorrow. An alert with no route is a bug —
 * every kind here carries one.
 *
 * Dependencies: types, utils/timeUtils. Consumers: NotificationService,
 * tests/run-week-schedule.ts.
 */
import { briefAlertBody } from './briefDigest';
import { OUTING_PREP_MINUTES } from './yieldToFixed';
import { Task, TransitPlan, AppLanguage } from '../types/index';
import { timeToMinutes, minutesToTime, subtractMinutes } from './timeUtils';
import { DAY, DAY_BEFORE_HOUR, LeadTimeSources, describeLead, resolveLeadMinutes } from './leadTime';

export type AlertKind =
  | 'wake_up'
  | 'get_ready'
  | 'leave_home'
  | 'leave_nag'
  | 'day_before'
  | 'lead'
  | 'hour_before'
  | 'fifteen_before';

export type AlertScreen = 'TaskDetail' | 'CheckIn' | 'PlanTomorrow' | 'LeaveNow';

/** Where a tap lands. Leave-time alerts open the LeaveNow focus screen
 *  (countdown + map + "I left"); everything else opens the task itself. */
export const ALERT_SCREEN: Record<AlertKind, AlertScreen> = {
  wake_up: 'TaskDetail',
  get_ready: 'TaskDetail',
  leave_home: 'LeaveNow',
  leave_nag: 'LeaveNow',
  day_before: 'TaskDetail',
  lead: 'TaskDetail',
  hour_before: 'TaskDetail',
  fifteen_before: 'TaskDetail',
};

export interface PlannedAlert {
  kind: AlertKind;
  /** HH:MM, on the task's date shifted by `dayOffset`. */
  at: string;
  title: string;
  body: string;
  taskId: string;
  screen: AlertScreen;
  /** Leave-home + its nags share the "I left ✓" action category. */
  category?: 'leave-check';
  /** Alarm-grade importance (wake / leave). */
  urgent?: boolean;
  /**
   * Days to add to the task's date to get the real calendar day of this alert.
   * -1 when subtracting the lead time crossed back over midnight (an 00:30
   * task warned an hour ahead belongs to 23:30 the night BEFORE, not 23:30 the
   * same evening). 0 in the overwhelming majority of cases.
   */
  dayOffset?: number;
}

/** How long after the leave time the "did you go?" nags repeat. */
export const LEAVE_NAG_OFFSETS = [4, 8];

/**
 * Latest hour that can still plausibly be a "get out of bed" moment.
 * Israeli mornings: past 11:00 nobody is being woken up for a 19:00 gym class.
 */
const LATEST_WAKE_HOUR = 11;
/** Earliest — before this it is a night departure, which always warrants an alarm. */
const EARLIEST_WAKE_HOUR = 2;

/**
 * When a morning commitment rings a real phone alarm.
 *
 *   'every-morning'      any wake time inside the morning window rings.
 *                        THE DEFAULT, and Koral's explicit instruction on
 *                        2026-09-17: "need to be clock alarm! ... a clock alarm
 *                        must be every day according the schedule! in the AM
 *                        hours."
 *   'earlier-than-usual' the previous rule: ring only when the day forces her
 *                        up EARLIER than she normally rises. Kept because it
 *                        is a coherent policy, it is what every persona
 *                        fixture was built against, and it is the obvious
 *                        thing to offer as a setting if the new default turns
 *                        out to be too loud.
 */
export type WakeAlarmPolicy = 'every-morning' | 'earlier-than-usual';

export const DEFAULT_WAKE_ALARM_POLICY: WakeAlarmPolicy = 'every-morning';

/**
 * Is this a WAKE-FROM-SLEEP alarm, or just a "start getting ready" nudge?
 *
 * They are different things and must not sound the same. An alarm ⏰ ("קום!")
 * belongs to the morning window; an afternoon class or an evening gym session
 * is a prep reminder 🧭 ("זמן להתארגן"), because she is already awake and being
 * yelled at to wake up is how an assistant loses trust. THAT part has not
 * changed and is not negotiable — it is why LATEST_WAKE_HOUR still exists.
 *
 * What changed on 2026-09-17 is the extra condition that used to sit inside
 * the morning window: `wake < usual`. It meant a 10:14 start for an 11:00 yoga
 * class raised no alarm, because she is normally up at 07:30 and would
 * "already be awake".
 *
 * I argued for that rule and she overruled it, in those words: "why? need to
 * be clock alarm! what is the role that you have? let's say a new role — a
 * clock alarm must be every day according the schedule! in the AM hours."
 *
 * It is her phone and her mornings, and the argument against was never that
 * the old rule was correct in some absolute sense — it was that a MAX-priority
 * alarm for someone already awake is startling. That is a judgement about her
 * own experience, which she is better placed to make than I am. So the default
 * is now hers, the old rule survives as a named policy rather than being
 * deleted, and every test that asserted the old behaviour has been changed
 * deliberately and in the open rather than quietly relaxed.
 */
export function needsWakeAlarm(
  wakeUpBy?: string,
  usualWakeTime?: string,
  policy: WakeAlarmPolicy = DEFAULT_WAKE_ALARM_POLICY,
): boolean {
  if (!wakeUpBy) return false;
  const wake = timeToMinutes(wakeUpBy);
  if (!Number.isFinite(wake)) return false;
  if (wake < EARLIEST_WAKE_HOUR * 60) return true; // 01:30 departure — ring it
  if (wake > LATEST_WAKE_HOUR * 60) return false;  // afternoon/evening — already awake
  // Inside the morning window. Under her rule that is the whole test.
  if (policy === 'every-morning') return true;
  if (!usualWakeTime) return true;
  const usual = timeToMinutes(usualWakeTime);
  return Number.isFinite(usual) ? wake < usual : true;
}

/**
 * Does this task need local alerts scheduled on the device at all?
 *
 * Every gate in the app used to ask `if (task.fixedTime)`. That is one of FOUR
 * independent reasons a task needs an alert, and the other three were silently
 * dropped: a trip with a route but no appointment hour got no wake / leave /
 * "still at home?" alerts, a deadline with no clock time got no warnings, and a
 * task carrying an explicit alarm was skipped by the launch-time re-arm.
 *
 * That was survivable while the server also reminded over WhatsApp. It is not
 * survivable now: the backend is allowed to sleep, so the phone is the only
 * thing awake and it has to be complete on its own.
 *
 * Pure, and deliberately generous — scheduling an alert for a task that turns
 * out not to need one costs a cancelled id; missing one costs a missed train.
 */
export function taskNeedsAlerts(task: Task): boolean {
  if (task.fixedTime || task.deadline) return true;
  if ((task as { alarmAt?: string }).alarmAt) return true;
  const loc = typeof task.location === 'object' ? task.location : undefined;
  return Boolean(loc?.transitPlan || loc?.leaveHomeBy || loc?.wakeUpBy);
}

/** HH:MM shifted by `mins`, plus which day it landed on relative to the input. */
function shiftWithDay(hhmm: string, mins: number): { at: string; dayOffset: number } {
  const total = timeToMinutes(hhmm) + mins;
  const dayOffset = Math.floor(total / 1440);
  return { at: minutesToTime(((total % 1440) + 1440) % 1440), dayOffset };
}


/**
 * Travel alerts derived from a real route: wake up, leave home (with the first
 * vehicle, the door-to-door total and the arrival), then two "did you go?"
 * nags that the "I left ✓" action cancels.
 */
export function planTransitAlerts(
  task: Task,
  plan: TransitPlan,
  lang: AppLanguage,
  /** The hour this person normally gets up — see needsWakeAlarm below. */
  usualWakeTime?: string,
): PlannedAlert[] {
  const he = lang === 'he';
  const out: PlannedAlert[] = [];
  const loc = typeof task.location === 'object' ? task.location : undefined;
  // EVERY departure needs getting ready for, not only the first of the day.
  //
  // `wakeUpBy` is the only source this ever had, and GoogleSync sets it for the
  // FIRST trip of a day and deliberately leaves it undefined for the rest — a
  // "⏰ wake up!" at 16:40 for the gym is nonsense, and that part is right.
  // But the consequence was that a later trip got no prep alert AT ALL:
  // planFixedTimeAlerts suppresses its own because a leave time exists, and
  // this one had nothing to work from. So an 18:30 appointment that was not
  // the day's first journey was told "in an hour" and "in 15 minutes" and
  // never "start getting ready".
  //
  // Koral, 2026-09-17, watching her own phone: "why now for the next event was
  // there no notification to get ready?" Found by reading the posted
  // notifications on the device — exactly one had fired.
  //
  // It is the same shape as the bug fixed the day before (the prep window
  // existed only for journeys); this is the half left behind — it existed only
  // for the FIRST journey.
  //
  // A later trip prepares from its leave time, and is NEVER an alarm however
  // early it is: she is already up, she made the first trip. That invariant is
  // older than her new every-morning alarm rule and survives it — see
  // tests/run-multi-stop.
  const laterTripPrep = !loc?.wakeUpBy && plan.leaveHomeAt
    ? subtractMinutes(plan.leaveHomeAt, OUTING_PREP_MINUTES)
    : undefined;
  const prepAt = loc?.wakeUpBy ?? laterTripPrep;
  // Same moment, two different meanings: an alarm that wakes you, or a nudge to
  // start getting ready. needsWakeAlarm decides which one this is — unless this
  // is a later trip, which is a nudge by construction.
  const isAlarm = !laterTripPrep && needsWakeAlarm(prepAt, usualWakeTime);
  const ride = plan.legs.find((l) => l.type !== 'walk');
  const rideCount = plan.legs.filter((l) => l.type !== 'walk').length;
  // Door-to-door minutes + transfers: the number the user compares to Google.
  const trip = he
    ? `${plan.totalDurationMinutes} דק' עד ${plan.arriveAt}${rideCount > 1 ? `, ${rideCount - 1} החלפות` : ''}`
    : `${plan.totalDurationMinutes} min, arrive ${plan.arriveAt}${rideCount > 1 ? ` (${rideCount - 1} transfer${rideCount > 2 ? 's' : ''})` : ''}`;

  // How a person would actually say the journey: the vehicle, where it goes
  // from, and when. Walking or driving has no line to name, so it says the
  // duration instead of an empty "  departs  at ".
  const how = (() => {
    if (!ride) {
      return he
        ? `${plan.totalDurationMinutes} דק' נסיעה`
        : `${plan.totalDurationMinutes} min journey`;
    }
    const line = ride.lineNumber ? `${ride.lineNumber} ` : '';
    return he
      ? `${line}מ${plan.firstBusStop} ב-${plan.firstBusDeparture}`
      : `${line}from ${plan.firstBusStop} at ${plan.firstBusDeparture}`;
  })();
  // The whole point of leaving: being somewhere, on time. Two forms, because
  // a clause tacked onto another sentence and a sentence that stands alone
  // read very differently — "so you're at X by 19:00" is fine after a dot,
  // and wrong as the opening words of a notification.
  const startsAt = task.fixedTime || plan.arriveAt;
  const soThat = he
    ? `שתגיעי ל"${task.text}" ב-${startsAt}`
    : `so you're at "${task.text}" by ${startsAt}`;
  const arriveLine = he
    ? `"${task.text}" מתחיל ב-${startsAt}`
    : `"${task.text}" starts at ${startsAt}`;

  // A trip that departs just after midnight is woken/left on the PREVIOUS
  // calendar day: those clock times read as later than the departure itself.
  const leaveDayOffset = timeToMinutes(plan.leaveHomeAt) > timeToMinutes(plan.arriveAt) ? -1 : 0;
  const prepDayOffset = prepAt && timeToMinutes(prepAt) > timeToMinutes(plan.arriveAt) ? -1 : 0;

  if (prepAt) {
    out.push({
      kind: isAlarm ? 'wake_up' : 'get_ready',
      at: prepAt,
      dayOffset: prepDayOffset,
      title: isAlarm
        ? `⏰ ${he ? 'בוקר טוב! צריך לקום' : 'Good morning — time to get up'}`
        : `🧭 ${he ? 'זמן להתחיל להתארגן' : 'Time to start getting ready'}`,
      body: he
        ? `יוצאים ב-${plan.leaveHomeAt} · ${how} · ${soThat}`
        : `Leaving at ${plan.leaveHomeAt} · ${how} · ${soThat}`,
      taskId: task.id,
      screen: isAlarm ? ALERT_SCREEN.wake_up : ALERT_SCREEN.get_ready,
      // Only a real wake-from-sleep alarm gets the MAX-importance alarm channel.
      urgent: isAlarm,
    });
  }

  out.push({
    kind: 'leave_home',
    at: plan.leaveHomeAt,
    dayOffset: leaveDayOffset,
    title: he ? `🚪 זמן לצאת ל"${task.text}"` : `🚪 Time to head to "${task.text}"`,
    body: he
      ? `${how} · ${trip}`
      : `${how} · ${trip}`,
    taskId: task.id,
    screen: ALERT_SCREEN.leave_home,
    category: 'leave-check',
    urgent: true,
  });

  for (const offset of LEAVE_NAG_OFFSETS) {
    const nag = shiftWithDay(plan.leaveHomeAt, offset);
    out.push({
      kind: 'leave_nag',
      at: nag.at,
      dayOffset: leaveDayOffset + nag.dayOffset,
      // Was "Did you go? Did you go?" — a nag, twice, in the same breath.
      title: he ? '🚪 עדיין בבית?' : '🚪 Still at home?',
      body: he
        ? `${arriveLine} — הקישי "יצאתי ✓" ואשתוק`
        : `${arriveLine} — tap "I left ✓" and I'll stop`,
      taskId: task.id,
      screen: ALERT_SCREEN.leave_nag,
      category: 'leave-check',
      urgent: true,
    });
  }

  return out;
}

/**
 * Time-only reminders for a fixed-time task (no travel assumptions — the
 * travel alerts come from planTransitAlerts once a route exists).
 */
export function planFixedTimeAlerts(
  task: Task,
  lang: AppLanguage,
  /** Departure time, when a route exists — see the same-day suppression below. */
  leaveAt?: string,
  /** Per-category lead times Lumi has learned for this user. */
  learned?: LeadTimeSources['learned'],
  /**
   * How long she needs to become a person who can leave, and when she is
   * normally up. Without these there is no honest prep time to offer.
   */
  prep?: { routineMinutes?: number; usualWakeTime?: string },
): PlannedAlert[] {
  if (!task.fixedTime) return [];
  const he = lang === 'he';
  const start = timeToMinutes(task.fixedTime);
  const out: PlannedAlert[] = [];
  const leadMinutes = resolveLeadMinutes(task, { learned });

  // ── "Time to start getting ready", for a task with NO route ──
  //
  // get_ready and wake_up used to be emitted in exactly one place —
  // planTransitAlerts — which needs a TransitPlan. So a task without a
  // journey produced "in 1 hour" and "in 15 min" and nothing else, however
  // long she actually needs to get going. Koral asked about precisely this on
  // 2026-09-16: an 11:00 task moved to tomorrow, and no prep alert at all.
  //
  // That prep window is the product. The app is backward time calculation,
  // and the version of it that does not involve a bus is the one that applies
  // to most of the day.
  //
  // Deliberately stands down when `leaveAt` is set: a route exists, and
  // planTransitAlerts writes a better version of this alert — one that knows
  // the bus. Two "start getting ready" pings for one task is the bug that
  // NotificationService's per-task lock exists to prevent, and there is no
  // sense re-creating it here.
  const routineMinutes = prep?.routineMinutes;
  if (!leaveAt && Number.isFinite(routineMinutes as number) && (routineMinutes as number) > 0) {
    const prepAt = subtractMinutes(task.fixedTime, routineMinutes as number);
    // Only a genuine wake-from-sleep gets the alarm channel. Koral's own
    // invariant: a MAX-priority alarm at 10:00 for someone awake since 07:30
    // is not a service, it is a fright.
    const isAlarm = needsWakeAlarm(prepAt, prep?.usualWakeTime);
    // A prep time later on the clock than the task belongs to the night
    // before — a 00:40 departure is prepared for at 23:40. Same rule the
    // transit path uses.
    const dayOffset = timeToMinutes(prepAt) > start ? -1 : 0;
    out.push({
      kind: isAlarm ? 'wake_up' : 'get_ready',
      at: prepAt,
      dayOffset,
      title: isAlarm
        ? `⏰ ${he ? 'בוקר טוב! צריך לקום' : 'Good morning — time to get up'}`
        : `🧭 ${he ? 'זמן להתחיל להתארגן' : 'Time to start getting ready'}`,
      body: he
        ? `"${task.text}" מתחיל ב-${task.fixedTime}`
        : `"${task.text}" starts at ${task.fixedTime}`,
      taskId: task.id,
      screen: isAlarm ? ALERT_SCREEN.wake_up : ALERT_SCREEN.get_ready,
      urgent: isAlarm,
    });
  }

  for (const lead of leadMinutes) {
    // "In an hour" is only useful while you can still act on it. On a long trip
    // you have already left by then, and the ping lands on the bus as noise.
    if (lead < DAY && leaveAt && timeToMinutes(leaveAt) <= start - lead) continue;

    if (lead >= DAY) {
      // A 10:00 meeting reminded at 10:00 yesterday is a worse reminder than one
      // at 20:00 last night. Snap whole-day leads to the previous evening.
      out.push({
        kind: 'day_before',
        at: `${String(DAY_BEFORE_HOUR).padStart(2, '0')}:00`,
        dayOffset: -Math.round(lead / DAY),
        title: he ? `📅 מחר: ${task.text}` : `📅 Tomorrow: ${task.text}`,
        // The whole plan, the night before — so the morning holds no surprises.
        //
        // And, when Lumi has researched who is in the room, the research: this
        // is the moment there is still time to act on it. The travel plan is
        // never dropped for it — knowing about Ceva is no use if she misses
        // the meeting — so the brief is appended, not substituted.
        body: [dayBeforeBody(task, he), briefAlertBody(task.brief, lang, 'day-before')]
          .filter(Boolean).join(' · '),
        taskId: task.id,
        screen: ALERT_SCREEN.day_before,
      });
      continue;
    }

    const when = shiftWithDay(task.fixedTime, -lead);
    // The final nudge is alarm-grade; the earlier heads-ups are not.
    const isLast = lead === leadMinutes[leadMinutes.length - 1];
    out.push({
      kind: lead === 60 ? 'hour_before' : lead === 15 ? 'fifteen_before' : 'lead',
      at: when.at,
      dayOffset: when.dayOffset,
      title: `${isLast ? '🔔' : '⏰'} ${describeLead(lead, he)} — ${task.text}`,
      // An hour or two out is the second moment she asked for, and it is a
      // different kind of moment from last night: she is about to pick up the
      // phone, so it carries ONE line and ONE question. Only the 60-minute
      // lead gets it — the same paragraph at 15 minutes is noise on top of an
      // alert she needs to act on.
      body: [
        he ? `מתחיל ב-${task.fixedTime}` : `Starts at ${task.fixedTime}`,
        lead >= 60 ? briefAlertBody(task.brief, lang, 'hour-before') : undefined,
      ].filter(Boolean).join(' · '),
      taskId: task.id,
      screen: ALERT_SCREEN.lead,
      urgent: isLast,
    });
  }
  return out;
}

/**
 * The night-before briefing: when it starts, where, when to wake, when to leave
 * and WHY that leave time. Everything needed to go to sleep knowing the morning
 * is already solved — previously this said only "At 10:00. Want to plan it?",
 * which told the user nothing they did not already know.
 */
function dayBeforeBody(task: Task, he: boolean): string {
  const loc = typeof task.location === 'object' ? task.location : undefined;
  const plan = loc?.transitPlan;
  const place = locationLabel(task);
  const parts: string[] = [];

  parts.push(he
    ? `ב-${task.fixedTime}${place ? ` — ${place}` : ''}`
    : `At ${task.fixedTime}${place ? ` — ${place}` : ''}`);

  if (loc?.wakeUpBy) parts.push(he ? `⏰ השכמה ${loc.wakeUpBy}` : `⏰ wake ${loc.wakeUpBy}`);
  if (loc?.leaveHomeBy) parts.push(he ? `🚪 יציאה ${loc.leaveHomeBy}` : `🚪 leave ${loc.leaveHomeBy}`);

  // The "why" — the number the leave time is derived from, so it is checkable
  // rather than something the user has to take on faith.
  if (plan) {
    const ride = plan.legs.find((l) => l.type !== 'walk');
    const how = ride?.lineNumber ? `${ride.lineNumber}, ` : '';
    parts.push(he
      ? `כי ${how}${plan.totalDurationMinutes} דק' נסיעה`
      : `because ${how}${plan.totalDurationMinutes} min travel`);
  } else if (loc?.travelMinutes) {
    parts.push(he ? `כי ${loc.travelMinutes} דק' נסיעה` : `because ${loc.travelMinutes} min travel`);
  }

  return parts.join(' · ');
}

/** Short place label for an alert body, whichever shape `location` is in. */
function locationLabel(task: Task): string {
  if (typeof task.location === 'string') return task.location;
  return task.location?.displayName || task.location?.address || '';
}
