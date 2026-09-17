/**
 * AlarmPlanner — decides WHETHER a task needs a real phone alarm, and arms it
 * once the ring time comes within Android's reach.
 *
 * The problem this exists for: ACTION_SET_ALARM carries no date. It rings at the
 * next occurrence of HH:MM, so an alarm for an interview twelve days out simply
 * cannot be set when the task is created — AlarmService refuses anything beyond
 * 24 h. Before this, that meant a far-future task got no alarm at all: nothing
 * ever came back to set it once the day approached.
 *
 * So the decision and the act are split:
 *   plan  — as soon as a route exists we know the wake time → alarmState
 *           'planned' (or 'not_needed' for anything that isn't a morning start)
 *   arm   — when the ring time is inside 24 h, actually fire the intent and
 *           flip to 'armed'
 *
 * armDueAlarms() is the sweeper for the second half. It runs on app start and
 * from the evening "tomorrow you have…" reminder, which is exactly when a
 * next-morning alarm first comes into reach.
 *
 * The DECISIONS (does it need one, when, is it close enough) are pure and live
 * in utils/alarmPlan so they can be tested without a device. This file holds
 * only the side effects: firing the intent and persisting the new state.
 *
 * Dependencies: utils/alarmPlan, AlarmService (the real intent), TaskStorage.
 * Consumed by App bootstrap and GoogleSync.
 */
import { Task } from '../types/index';
import {
  ALARM_REACH_MS, alarmMomentOf, isWithinAlarmReach, plannedAlarmTime,
} from '../utils/alarmPlan';
import { setSystemAlarm } from './AlarmService';
import { wakeAlarmEnabled } from './NotificationService';
import { updateTaskFields } from './TaskStorage';
import { loadProfile } from './UserProfileStorage';
import { normalizeProfile } from '../utils/profileShape';

// Re-exported so callers have one import site for "everything alarm".
export {
  ALARM_REACH_MS, alarmMomentOf, isWithinAlarmReach, plannedAlarmTime,
} from '../utils/alarmPlan';
export { decideAlarmState } from '../utils/alarmPlan';

export interface ArmResult {
  /** Tasks whose physical alarm was just set. */
  armed: Task[];
  /** Tasks that need one but are still too far out — checked again next run. */
  stillWaiting: Task[];
}

/**
 * Set the phone alarm for every task whose planned wake time is now within
 * reach, and record that it happened so it is never set twice.
 *
 * Idempotent: only 'planned' tasks are touched, and each flips to 'armed'.
 */
export async function armDueAlarms(tasks: Task[]): Promise<ArmResult> {
  const armed: Task[] = [];
  const stillWaiting: Task[] = [];
  // Same routine length markAlarmStates used to decide 'planned' — the two
  // must agree, or a task is marked planned and then never found armable.
  const profile = normalizeProfile(await loadProfile().catch(() => null));
  const routineMinutes = profile
    ? (profile.morningRoutineMinutes ?? 0) + (profile.wakeBufferMinutes ?? 0)
    : undefined;

  for (const task of tasks) {
    if (task.status !== 'pending') continue;
    if (task.alarmState !== 'planned') continue;

    // WITH the routine. Without it, plannedAlarmTime falls through to its
    // third source — the task's own start minus the morning routine — and
    // returns undefined, so `when` was null and this loop quietly skipped the
    // task. markAlarmStates had already marked it 'planned' using that very
    // fallback, so the two disagreed and the phone stayed silent: no crash,
    // no log, no alarm. Koral, 2026-09-17: "check the alarm clock (today it
    // didn't work)".
    //
    // The routine was computed ten lines above and passed to plannedAlarmTime
    // further down. Only this call was missing it.
    const when = alarmMomentOf(task, Date.now(), routineMinutes);
    if (!when) continue;

    if (!isWithinAlarmReach(task, Date.now(), routineMinutes)) {
      stillWaiting.push(task);
      continue;
    }

    const at = plannedAlarmTime(task, routineMinutes)!;
    // The user's toggle: when the loud clock alarm is off, leave the task
    // 'planned' (its wake notification still fires) rather than marking it armed.
    if (!(await wakeAlarmEnabled())) {
      stillWaiting.push(task);
      continue;
    }
    const ok = await setSystemAlarm(at, task.text, task.date).catch(() => false);
    if (!ok) {
      // Expo Go, iOS, or a refused intent — leave it 'planned' so a later run
      // (or a real build) retries rather than silently marking it done.
      stillWaiting.push(task);
      continue;
    }

    await updateTaskFields(task.id, {
      alarmState: 'armed', alarmArmedAt: Date.now(),
    }).catch(() => {});
    armed.push({ ...task, alarmState: 'armed', alarmArmedAt: Date.now() });
  }

  if (armed.length || stillWaiting.length) {
    console.log(`[AlarmPlanner] armed ${armed.length}, waiting ${stillWaiting.length}`);
  }
  return { armed, stillWaiting };
}
