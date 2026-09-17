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
  const start = task.fixedTime;
  if (!start || !Number.isFinite(routineMinutes as number) || (routineMinutes as number) <= 0) {
    return undefined;
  }
  return subtractMinutes(start, routineMinutes as number);
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
  const start = task.fixedTime ? task.fixedTime.split(':').map(Number) : null;
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

export function wakeChipFor(
  task: Task,
  { usualWakeTime, routineMinutes }: { usualWakeTime?: string; routineMinutes?: number } = {},
): WakeChip | null {
  const at = plannedAlarmTime(task, routineMinutes);
  if (!at) return null;

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
