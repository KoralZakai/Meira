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
  ALARM_REACH_MS, alarmMomentOf, isWithinAlarmReach, plannedAlarmTime, wakeAlarmWhy, wakeAlarmKey,
} from '../utils/alarmPlan';
import { dismissSystemAlarm, setSystemAlarm } from './AlarmService';
import { loadMorningChoices } from './MorningAlarmService';
import { momentOf, morningAlarmFor } from '../utils/morningAlarm';
import { sendImmediate, wakeAlarmEnabled } from './NotificationService';
import { getAllTasks, getSettings, updateTaskFields } from './TaskStorage';
import AsyncStorage from './EncryptedStorage';
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
  /** HH:MM of Meira alarms she asked to take out of Clock (only on her tap). */
  dismissed?: string[];
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
    // warn, not log. A release build drops console.log entirely, so on
    // 2026-09-17 — checking on her phone whether a 09:58 alarm had actually
    // been armed — there was nothing in logcat either way. The one line that
    // could have answered it was the one that never survives a release.
    console.warn(
      `[AlarmPlanner] armed ${armed.length}, waiting ${stillWaiting.length}`
      + (armed.length ? ` — next ${armed.map((t) => `${t.date} ${t.text.slice(0, 20)}`).join(', ')}` : ''),
    );
  }
  return { armed, stillWaiting };
}

function dayKey(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}


// The alarms this phone has already put in Clock, as "YYYY-MM-DD|HH:MM".
// alarmState cannot be the memory: the cloud row has no column for it, and for
// a signed-in user the cloud copy wins on read — so 'armed' vanished on the next
// read, the owner looked new, and every save armed (and announced) it again.
// 20.10 on her phone: a loop every ~4 s. This record is local and is the only
// thing syncWakeAlarms trusts.
const SET_KEY = 'meira.wakeAlarmsSet';

async function alarmsAlreadySet(): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(SET_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch (e) {
    console.warn('[AlarmPlanner] could not read the set-alarms record', e);
    return new Set();
  }
}

async function rememberAlarmsSet(keys: Set<string>): Promise<void> {
  const keep = [...keys].filter((k) => k.slice(0, 10) >= dayKey(-1));   // last two days are plenty
  await AsyncStorage.setItem(SET_KEY, JSON.stringify(keep))
    .catch((e) => console.warn('[AlarmPlanner] could not save the set-alarms record', e));
}

/**
 * After any task write, on app open, and when she taps the morning ⏰: Clock
 * holds exactly the alarm each morning should have — today's and tomorrow's
 * (ACTION_SET_ALARM reaches 24 h).
 *
 * Each morning's alarm is utils/morningAlarm.morningAlarmFor: its first task,
 * Meira's hour, unless she turned it off or picked another hour
 * (MorningAlarmService). A Meira alarm in Clock that is no longer the one —
 * she turned it off, moved it, or an earlier task took the morning — is taken
 * out first (dismissSystemAlarm, by its "Meira · HH:MM" label).
 *
 * The local record is the only memory (see SET_KEY), and an alarm already in it
 * is never set or announced twice, so the write hook that calls this cannot loop.
 */
export async function syncWakeAlarms(opts: { announce?: boolean; dismiss?: boolean } = {}): Promise<ArmResult | null> {
  // Her own tap must not be dropped because a background sync is running —
  // setting the alarm writes the task, which starts exactly such a sync, and
  // the moved alarm then stayed in Clock beside the new one (20.10, her phone).
  // A background sync that finds one running has nothing to add and returns.
  if (running) {
    if (!opts.dismiss) return null;
    await running.catch(() => null);
    return syncWakeAlarms(opts);
  }
  running = syncOnce(opts);
  try {
    return await running;
  } finally {
    running = null;
  }
}

let running: Promise<ArmResult | null> | null = null;

async function syncOnce(opts: { announce?: boolean; dismiss?: boolean }): Promise<ArmResult | null> {
  {
    const announce = opts.announce !== false;
    const profile = normalizeProfile(await loadProfile().catch(() => null));
    const inputs = {
      usualWakeTime: profile?.defaultWakeTime || undefined,
      routineMinutes: profile
        ? (profile.morningRoutineMinutes ?? 0) + (profile.wakeBufferMinutes ?? 0)
        : undefined,
    };
    const [tasks, choices, done, enabled] = await Promise.all([
      getAllTasks(), loadMorningChoices(), alarmsAlreadySet(), wakeAlarmEnabled()]);
    const res: ArmResult = { armed: [], stillWaiting: [], dismissed: [] };
    let changed = false;
    const now = Date.now();
    // Taken out AFTER the new one is set: the Clock screen a dismissal opens
    // blocks any further intent until she leaves it ("IntentLauncher activity
    // is already started", her phone 20.10).
    const toDismiss: string[] = [];
    const lang = (await getSettings().catch(() => null))?.language === 'en' ? 'en' : 'he';
    for (const date of [dayKey(0), dayKey(1)]) {
      const plan = morningAlarmFor(date, tasks, inputs, choices[date]);
      const want = plan && plan.on && enabled ? wakeAlarmKey(date, plan.at) : null;
      // Taking one out of Clock opens Samsung's alarm list (DISMISS_ALARM has no
      // silent mode there — seen on her phone 20.10), so it happens only when SHE
      // turned it off or moved it, never from a background sync, and only for an
      // alarm still ahead.
      for (const k of opts.dismiss ? [...done] : []) {
        if (!k.startsWith(`${date}|`) || k === want) continue;
        const hhmm = k.slice(date.length + 1);
        done.delete(k);
        changed = true;
        if (momentOf({ date, at: hhmm, on: true, custom: false, task: plan?.task }).getTime() <= now) continue;
        toDismiss.push(hhmm);
      }
      if (!plan || !want || done.has(want)) continue;
      const moment = momentOf(plan);
      if (moment.getTime() <= now) continue;
      if (moment.getTime() - now > ALARM_REACH_MS) {
        if (plan.task) res.stillWaiting.push(plan.task);
        continue;
      }
      const ringDay = `${moment.getFullYear()}-${String(moment.getMonth() + 1).padStart(2, '0')}-${String(moment.getDate()).padStart(2, '0')}`;
      const ok = await setSystemAlarm(plan.at, plan.task?.text || '', ringDay).catch(() => false);
      if (!ok) {
        if (plan.task) res.stillWaiting.push(plan.task);
        continue;
      }
      done.add(want);
      changed = true;
      if (plan.task) {
        await updateTaskFields(plan.task.id, { alarmState: 'armed', alarmArmedAt: now }).catch(() => {});
        res.armed.push({ ...plan.task, alarmState: 'armed', alarmArmedAt: now });
      }
      console.warn(`[AlarmPlanner] set ${want}${plan.custom ? ' (her hour)' : ''} ← ${(plan.task?.text || '—').slice(0, 20)}`);
      if (!announce) continue;
      // Say it, and why — an alarm she did not see being set is one she cannot trust.
      const { title, body } = plan.task
        ? wakeAlarmWhy(plan.custom ? { ...plan.task, alarmAt: plan.at } : plan.task, plan.at, inputs.routineMinutes, lang)
        : { title: lang === 'he' ? `⏰ כיוונתי שעון מעורר ל-${plan.at}` : `⏰ Alarm set for ${plan.at}`,
            body: lang === 'he' ? 'כמו שביקשת.' : 'As you asked.' };
      await sendImmediate(title, body).catch((e) => console.warn('[AlarmPlanner] could not say it', e));
    }
    if (changed) await rememberAlarmsSet(done);
    // ONE trip to Clock: Samsung answers with its whole alarm list, so a second
    // intent only opened it again (her phone, 20.10). The note names every one.
    if (toDismiss.length && await dismissSystemAlarm(toDismiss[0])) {
      res.dismissed!.push(...toDismiss);
      console.warn(`[AlarmPlanner] asked Clock to take out ${toDismiss.map((t) => `Meira · ${t}`).join(', ')}`);
    }
    return res;
  }
}
