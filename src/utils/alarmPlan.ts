/**
 * alarmPlan — WHETHER a task needs a real phone alarm, WHEN it should ring, and
 * whether that moment is close enough to actually set. Pure: no react-native,
 * no storage, no intents.
 *
 * Split from services/AlarmPlanner for the same reason utils/alertPlan is split
 * from NotificationService — the decisions can then be verified in a test
 * without a device (see tests/run-future-task.ts), and the service is left
 * holding only the side effects.
 *
 * The constraint driving all of this: Android's ACTION_SET_ALARM carries no
 * date. It rings at the next occurrence of HH:MM, so an alarm for an interview
 * twelve days out cannot be set when the task is created — it has to be planned
 * now and armed once the ring time comes within a day.
 *
 * Dependencies: types, utils/alertPlan (needsWakeAlarm — the same wake-vs-
 * get-ready rule the notifications use). Consumers: services/AlarmPlanner,
 * services/GoogleSync, tests/run-future-task.ts.
 */
import { AlarmState, Task, UserProfile } from '../types/index';
import { needsWakeAlarm } from './alertPlan';
import { subtractMinutes } from './timeUtils';

/**
 * How far ahead a real phone alarm can be set. Beyond this ACTION_SET_ALARM
 * would ring on the wrong day, so the alarm waits in the 'planned' state.
 */
export const ALARM_REACH_MS = 24 * 60 * 60 * 1000;

/**
 * The time this task should wake her, or undefined when it should not.
 *
 * Three sources, most specific first:
 *   1. `alarmAt` — an explicit time set on the task (utils/wakeRequest fills it
 *      in from "wake me at 7" / "תעירי אותי ב-7", in the app and over WhatsApp);
 *   2. the route's `wakeUpBy` — travel already worked backwards from arrival;
 *   3. the task's own start, minus the morning routine.
 *
 * (3) is the one that was missing, and the bug was: an alarm existed ONLY for
 * a task with a routed trip. A 06:30 commitment with no travel — a call, a
 * delivery, anything at home — produced no wake time at all, so no alarm was
 * ever planned and the phone stayed silent. A task whose `location` is still a
 * bare address string hits the same wall, because a string has no wakeUpBy.
 *
 * `routineMinutes` is how long she needs between waking and starting. Without
 * it the fallback is skipped rather than guessed — a wake time invented from a
 * default routine is a real alarm at a wrong hour.
 */
export function plannedAlarmTime(task: Task, routineMinutes?: number): string | undefined {
  if (task.alarmAt) return task.alarmAt;
  if (typeof task.location === 'object' && task.location?.wakeUpBy) {
    return task.location.wakeUpBy;
  }
  // Any hour on her timeline, not only a fixed one. 3.10: "I added a task for
  // tomorrow at 8:40 — why no alarm?" She picked it from a free window, which
  // saves `scheduledTime`; the card sat at 08:40 and the morning stayed silent.
  const start = task.fixedTime || task.scheduledTime;
  if (!start) return undefined;
  if (Number.isFinite(routineMinutes as number) && (routineMinutes as number) > 0) {
    return subtractMinutes(start, routineMinutes as number);
  }
  // No routine on her profile, so no guessing — EXCEPT the one block whose
  // whole meaning is "get up early": the interview-morning study (prep-0d-…).
  // Koral, 2026-09-28, the night before the Amazon interview: "I need an alarm
  // clock". The block said "up early" at 09:00 and nothing rang, because her
  // profile has no routine length. Its own get-ready buffer (interviewPrep's
  // GET_READY_BUFFER_MIN, 30) is the honest number here.
  if (isInterviewMorning(task)) return subtractMinutes(start, INTERVIEW_MORNING_GET_READY_MIN);
  return undefined;
}

/** interviewPrep.GET_READY_BUFFER_MIN — duplicated, not imported, to keep this module leaf-level. */
const INTERVIEW_MORNING_GET_READY_MIN = 30;

function isInterviewMorning(task: Task): boolean {
  return String(task.id || '').startsWith('prep-0d-')
    && Boolean((task as { prepForTaskId?: string }).prepForTaskId)
    && Boolean(task.fixedTime) && (task.fixedTime as string) < '12:00';
}

/**
 * What this task's alarm state SHOULD be, given its route and the user's normal
 * wake time. Pure — the caller persists.
 */
export function decideAlarmState(task: Task, usualWakeTime?: string,
                                 routineMinutes?: number): AlarmState {
  const at = plannedAlarmTime(task, routineMinutes);
  if (!at) return 'not_needed';
  // An hour she ASKED for is not a candidate to be weighed against her usual
  // wake time — it is the answer. "תעירי אותי ב-7 שאקום ללמוד" before an
  // interview whose route only needs her up at 09:04 used to lose to
  // needsWakeAlarm's "you'll be awake by then anyway", and the phone stayed
  // silent on the morning she had explicitly asked to be woken.
  if (task.alarmAt) return 'planned';
  return needsWakeAlarm(at, usualWakeTime) ? 'planned' : 'not_needed';
}

/** Absolute moment the alarm should ring, or null if not computable / past. */
export function alarmMomentOf(task: Task, now: number = Date.now(),
                              routineMinutes?: number): Date | null {
  const at = plannedAlarmTime(task, routineMinutes);
  if (!at || !task.date) return null;
  const [y, mo, d] = task.date.split('-').map(Number);
  const [h, m] = at.split(':').map(Number);
  if ([y, mo, d, h, m].some((n) => !Number.isFinite(n))) return null;
  // A wake time later on the clock than the task itself belongs to the night
  // before (a 00:40 flight woken at 22:55). Mirrors alertPlan's dayOffset rule.
  const own = task.fixedTime || task.scheduledTime;
  const start = own ? own.split(':').map(Number) : null;
  const crossesMidnight = start ? h * 60 + m > start[0] * 60 + start[1] : false;
  const when = new Date(y, mo - 1, d - (crossesMidnight ? 1 : 0), h, m, 0, 0);
  return when.getTime() > now ? when : null;
}

/** True when the alarm can actually be set now (inside Android's 24 h reach). */
export function isWithinAlarmReach(task: Task, now: number = Date.now(),
                                   routineMinutes?: number): boolean {
  const when = alarmMomentOf(task, now, routineMinutes);
  return Boolean(when && when.getTime() - now <= ALARM_REACH_MS);
}

/**
 * Identity of a wake moment — same task, same calendar day, same clock time.
 * Used to tell "the plan refreshed but the wake time didn't move" apart from
 * "the wake time actually changed" (see needsRearm).
 */
export function wakeAlarmMarker(date: string, at: string): string {
  return `${date}T${at}`;
}

/**
 * Whether a wake_up alert's real phone alarm still needs (re-)arming, given
 * the marker recorded the last time NotificationService armed one for this
 * task.
 *
 * ACTION_SET_ALARM carries no id to replace an existing alarm — firing it
 * again for a wake time that is already set doesn't update that alarm, it
 * ADDS ANOTHER ONE. A transit plan is re-probed for fresh traffic roughly
 * every 30 min in the pre-departure window (GoogleSync.ensureTravelChain),
 * and each stale-plan refresh used to call setSystemAlarm again even when
 * the computed wake time hadn't moved at all — stacking a duplicate alarm on
 * every refresh. Only a genuine change in date or clock time should re-arm.
 */
export function needsRearm(lastArmedMarker: string | null | undefined, date: string, at: string): boolean {
  return lastArmedMarker !== wakeAlarmMarker(date, at);
}

/**
 * How a wake-up should be DRAWN, or null when this task raises none.
 *
 * This exists because the alarm that RINGS and the alarm that is SHOWN were
 * decided by two different rules. plannedAlarmTime has three sources (an
 * explicit `alarmAt`, the route's `wakeUpBy`, the task's own start minus the
 * morning routine); every UI that drew an alarm re-derived its own version
 * from the first two only:
 *
 *     task.alarmAt || (typeof location === 'object' ? location.wakeUpBy : undefined)
 *
 * hand-written three times over, in NextUpCard, TravelChainCard and
 * TodaySchedule. So the routine fallback — the source covering a task with no
 * route yet, which is MOST of tomorrow, because ensureTravelChain has not swept
 * that day or the location is still a bare address string — rang the phone and
 * rendered nothing.
 *
 * The alarm was never lost. It was invisible, which is worse: an alarm you
 * cannot see is one you can neither trust nor turn off.
 *
 * One rule, one place. Everything that draws a wake-up reads this.
 */
export interface WakeChip {
  /** HH:MM it rings — or would ring, when muted. */
  at: string;
  /** She turned this one off. Drawn as 🔕, never hidden: hiding it removes the
   *  only control that turns it back on. */
  muted: boolean;
}

/**
 * The two profile-derived inputs the wake rules need, in one call, so no caller
 * has to remember that the routine is routine PLUS buffer — forgetting the
 * buffer moves every fallback alarm 15 minutes late.
 */
export function wakeInputs(profile?: UserProfile | null): {
  usualWakeTime?: string;
  routineMinutes?: number;
} {
  if (!profile) return {};
  const routine = (profile.morningRoutineMinutes ?? 0) + (profile.wakeBufferMinutes ?? 0);
  return {
    usualWakeTime: profile.defaultWakeTime || undefined,
    routineMinutes: routine > 0 ? routine : undefined,
  };
}

/** Local alias, so dayWakeOwner below reads as the day rule and not the task rule. */
const decideAlarmStateForTask = decideAlarmState;

/**
 * The one hour a DAY wakes her, and the task that owns it.
 *
 * Koral, 2026-09-22: "when adding a task before another task the clock alarm
 * should change to an earlier". Every rule above this one judges a single
 * task, so a day with an 08:00 class and a 10:00 appointment planned TWO
 * alarms — 07:20 and 09:20 — and the phone rang twice; and adding something
 * earlier than everything else did not move the morning, it just added to it.
 *
 * A morning has one beginning. It belongs to whatever starts first.
 *
 * Ties break on the task's own start hour and then its id, so the owner does
 * not flip between syncs and re-arm the same alarm twice.
 */
export function dayWakeOwner(
  tasks: Task[],
  { usualWakeTime, routineMinutes }: { usualWakeTime?: string; routineMinutes?: number } = {},
): { taskId: string; at: string } | null {
  let best: { taskId: string; at: string; tie: string } | null = null;
  for (const task of tasks) {
    if (task.status !== 'pending') continue;
    if (decideAlarmStateForTask(task, usualWakeTime, routineMinutes) !== 'planned') continue;
    const at = plannedAlarmTime(task, routineMinutes);
    if (!at) continue;
    const tie = `${at}|${task.fixedTime ?? task.scheduledTime ?? '99:99'}|${task.id}`;
    if (!best || tie < best.tie) best = { taskId: task.id, at, tie };
  }
  return best ? { taskId: best.taskId, at: best.at } : null;
}

/** The earliest wake a set of tasks needs, or undefined when none do. */
export function earliestWakeOf(
  tasks: Task[],
  inputs: { usualWakeTime?: string; routineMinutes?: number } = {},
): string | undefined {
  return dayWakeOwner(tasks, inputs)?.at;
}

export function wakeChipFor(
  task: Task,
  { usualWakeTime, routineMinutes }: { usualWakeTime?: string; routineMinutes?: number } = {},
  /**
   * The day's single wake hour, when the caller has the whole day in hand.
   * A task that wanted a later one is not muted — it is superseded, and a 🔕
   * on it would read as "you turned this off", which she did not.
   */
  opts: { dayEarliestWake?: string } = {},
): WakeChip | null {
  const at = plannedAlarmTime(task, routineMinutes);
  if (!at) return null;
  if (opts.dayEarliestWake && at > opts.dayEarliestWake) return null;

  // What the SCHEDULER would decide for this task, from the same inputs — so
  // the chip and the phone can never disagree about whether a morning rings.
  const wanted = decideAlarmState(task, usualWakeTime, routineMinutes);

  // A stored state saying an alarm EXISTS always wins. markAlarmStates may have
  // planned this one from a route that has since been recomputed, and an alarm
  // that is physically armed must never be drawn as absent.
  if (task.alarmState === 'armed' || task.alarmState === 'planned') return { at, muted: false };

  if (task.alarmState === 'not_needed') {
    // 'not_needed' is two different facts wearing one name. If the rule agrees
    // nothing is due (a 14:00 coffee), there is nothing to draw. If the rule
    // says one IS due, the only way to reach this state is that she turned it
    // off — so it stays on screen, muted.
    return wanted === 'not_needed' ? null : { at, muted: true };
  }

  // No stored state at all: a task saved seconds ago, or one on a day
  // markAlarmStates has not swept yet. This is the case that rendered blank.
  return wanted === 'not_needed' ? null : { at, muted: false };
}

/**
 * The route's "be ready" time when it is NOT a wake-from-sleep moment — 13:00
 * for a 14:00 class. alertPlan.needsWakeAlarm deliberately refuses to call that
 * an alarm, and a card must not label it "wake up" either; but dropping it
 * loses the one time that says when to start moving. Draw it as 🧭 get ready.
 */
export function getReadyTimeFor(
  task: Task,
  inputs: { usualWakeTime?: string; routineMinutes?: number } = {},
): string | undefined {
  if (wakeChipFor(task, inputs)) return undefined;
  const l = typeof task.location === 'object' ? task.location : undefined;
  return l?.wakeUpBy;
}

/**
 * The morning alarms a write should arm: each day's wake owner (dayWakeOwner),
 * today and tomorrow only (ACTION_SET_ALARM reaches 24 h), returned with
 * alarmState 'planned'.
 *
 * A task with NO stored state is promoted — that is a task saved seconds ago,
 * the one whose ⏰ chip was already on screen (wakeChipFor draws it unmuted)
 * while nothing set the clock. 'not_needed' on an owner means she turned it
 * off, and 'armed' is done; both are left alone.
 */
export function wakeAlarmsToArm(
  tasks: Task[],
  days: string[],
  inputs: { usualWakeTime?: string; routineMinutes?: number } = {},
): Task[] {
  const out: Task[] = [];
  for (const day of days) {
    const owner = dayWakeOwner(tasks.filter((t) => t.date === day), inputs);
    const task = owner && tasks.find((t) => t.id === owner.taskId);
    if (!task) continue;
    if (task.alarmState === 'planned' || task.alarmState === undefined || task.alarmState === null) {
      out.push({ ...task, alarmState: 'planned' });
    }
  }
  return out;
}

/**
 * Why this alarm, in one line — said whenever Meira sets one on her own
 * (silent-state rule 7: a background act must say so). 20.10, Koral: "must
 * have reasoning of why it acts the way it acts".
 */
export function wakeAlarmWhy(task: Task, at: string, routineMinutes: number | undefined,
                             lang: 'he' | 'en'): { title: string; body: string } {
  const start = task.fixedTime || task.scheduledTime || '';
  const what = task.text.slice(0, 40);
  const fromRoute = !task.alarmAt && typeof task.location === 'object' && task.location?.wakeUpBy === at;
  if (lang === 'he') {
    const why = task.alarmAt ? 'כמו שביקשת'
      : fromRoute ? 'לפי זמן הנסיעה'
        : routineMinutes ? `${routineMinutes} דק׳ להתארגנות לפני` : 'לפני';
    return { title: `⏰ כיוונתי שעון מעורר ל-${at}`, body: `${what} ב-${start} — הדבר הראשון בבוקר, ${why}.` };
  }
  const why = task.alarmAt ? 'as you asked'
    : fromRoute ? 'from the travel time'
      : routineMinutes ? `${routineMinutes} min to get ready before it` : 'before it';
  return { title: `⏰ Alarm set for ${at}`, body: `${what} at ${start} — first thing in the morning, ${why}.` };
}

/** "YYYY-MM-DD|HH:MM" — one Clock alarm, whatever task owns it. */
export function wakeAlarmKey(date: string, at: string): string {
  return `${date}|${at}`;
}

/** The ones not yet in Clock: an alarm already set is never set or announced again. */
export function alarmsNotYetSet(due: Task[], alreadySet: Set<string>, routineMinutes?: number): Task[] {
  return due.filter((t) => {
    const at = plannedAlarmTime(t, routineMinutes);
    return Boolean(at) && !alreadySet.has(wakeAlarmKey(t.date, at!));
  });
}
