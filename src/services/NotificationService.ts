/**
 * NotificationService — ALL expo-notifications scheduling: daily check-ins,
 * transit wake/leave alerts, deadline warnings, instant messages, and the
 * notification-tap subscription.
 *
 * Dependencies: expo-notifications (EAS build only — every function no-ops in
 * Expo Go via utils/isExpoGo), utils/timeUtils (deadline/latest-start math).
 * Consumed by LumiCoachEngine.persistAndSchedule, task CRUD flows, and App
 * bootstrap. Cancel via cancelTaskNotifications before rescheduling a task.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { isExpoGo } from '../utils/isExpoGo';
import { AppSettings, CheckInType } from '../types/models';
import { Task, AppLanguage, TaskCategory } from '../types/index';
// Alert times, wording and tap-target live in one pure module (also used by
// tests/run-week-schedule.ts to verify the schedule without a device).
import { planTransitAlerts, planFixedTimeAlerts, taskNeedsAlerts } from '../utils/alertPlan';
import { identifiersToCancel } from '../utils/alertCancellation';
import { getDaysUntilDeadline, calculateLatestStartTime } from '../utils/timeUtils';
import { needsRearm, wakeAlarmMarker } from '../utils/alarmPlan';
import { normalizeProfile } from '../utils/profileShape';
import { setSystemAlarm } from './AlarmService';
import { getSettings, updateTaskFields } from './TaskStorage';

type NotificationsModule = typeof import('expo-notifications');

let Notifications: NotificationsModule | null = null;

try {
  Notifications = require('expo-notifications') as NotificationsModule;

  if (!isExpoGo) {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowAlert: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
        shouldShowBanner: true,
        shouldShowList: true,
      }),
    });
  }
} catch (error) {
  console.log('[MOCK] Notifications unavailable:', error);
}

function toMessage(type: CheckInType): { title: string; body: string } {
  if (type === 'morning') {
    return {
      title: 'Lumi morning check-in',
      body: 'Good morning! Tap to start your daily planning.',
    };
  }

  if (type === 'afternoon') {
    return {
      title: 'Lumi afternoon check-in',
      body: 'What have you completed this morning?',
    };
  }

  return {
    title: 'Lumi evening check-in',
    body: 'Wrap up your day with Lumi.',
  };
}

async function scheduleDailyCheckIn(type: CheckInType, hour: number, minute: number): Promise<string | null> {
  const message = toMessage(type);

  if (isExpoGo || !Notifications) {
    console.log('[MOCK] Notification scheduled:', message.title);
    return null;
  }

  return Notifications.scheduleNotificationAsync({
    content: {
      title: message.title,
      body: message.body,
      data: { checkInType: type },
      // Evening check-in gets a "Plan tomorrow" action button.
      ...(type === 'evening' ? { categoryIdentifier: 'evening-checkin' } : {}),
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DAILY,
      hour,
      minute,
    },
  });
}

/**
 * Set once the silent wake-alarm channel has been deleted and rebuilt. See the
 * repair block in initNotifications for why a delete is the only way.
 */
const WAKE_CHANNEL_REPAIRED_KEY = 'lumi.wakeChannelRepaired.v1';

/** Request permission + Android channel setup. Call once at app start; no-op in Expo Go. */
export async function initNotifications() {
  if (isExpoGo || !Notifications) {
    console.log('[MOCK] Notifications disabled in Expo Go');
    return;
  }

  /**
   * One-time repair of the broken wake-alarm channel.
   *
   * Android channels are IMMUTABLE once created: after the first launch, the
   * OS ignores sound and importance on every later setNotificationChannelAsync
   * for that id. So fixing the config above only helps a fresh install — every
   * phone that has already run Lumi keeps the silent alarm channel forever.
   * The only way to change it is to delete the channel and let it be recreated,
   * which is what this does, once, behind a flag.
   *
   * The cost of deleting is that the user's own tweaks to that channel (if she
   * opened Android settings and changed them) are lost. That is worth it here:
   * the channel exists to make one sound at 07:00 and it cannot currently make
   * any sound at all.
   */
  try {
    const repaired = await AsyncStorage.getItem(WAKE_CHANNEL_REPAIRED_KEY);
    if (repaired !== '1') {
      await Notifications.deleteNotificationChannelAsync('wake-alarm').catch(() => {});
      await AsyncStorage.setItem(WAKE_CHANNEL_REPAIRED_KEY, '1');
    }
  } catch {
    // A failed repair must never stop notifications initialising.
  }

  const permissions = await Notifications.getPermissionsAsync();
  if (!permissions.granted) {
    await Notifications.requestPermissionsAsync();
  }

  await Notifications.setNotificationChannelAsync('default', {
    name: 'default',
    importance: Notifications.AndroidImportance.DEFAULT,
    vibrationPattern: [0, 200, 200, 200],
    lightColor: '#FFD166',
  });

  /**
   * Dedicated MAX-importance channel so the morning wake-up call rings + shows
   * on the lock screen like an alarm (the default channel is too quiet).
   *
   * NOTE THE ABSENT `sound`. It used to say `sound: 'default'`, which reads
   * like "the default sound" and is not: on a CHANNEL the field is a bundled
   * FILENAME, so Android went looking for a sound resource called "default",
   * found none, and gave the alarm channel no sound at all. expo-notifications
   * logged an error on every launch, which LogBox then threw full-screen over
   * the app in dev builds. From the native source
   * (AndroidXNotificationsChannelManager.createSoundUriFromArguments):
   *
   *     omitted  → Settings.System.DEFAULT_NOTIFICATION_URI   ← what we want
   *     null     → no sound at all
   *     a string → resolved as a filename
   *
   * So the fix is to leave the key OUT. Do not "fix" this by passing null —
   * that is the one value that silences a wake-up alarm.
   */
  await Notifications.setNotificationChannelAsync('wake-alarm', {
    name: 'Wake-up call',
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 400, 250, 400],
    lightColor: '#FFD166',
    bypassDnd: false,
  });

  // "Did you go?" leave-home nags carry an "I left ✓" action button that
  // cancels the remaining nags and records the departure (see
  // subscribeNotificationTap → LiveRoute.confirmDeparture).
  // The label follows the app language: the notification body it sits under is
  // Hebrew, and an English button under a Hebrew sentence reads as someone
  // else's app. Falls back to English if settings can't be read.
  const heUi = await getSettings().then((s) => s.language === 'he').catch(() => false);
  await Notifications.setNotificationCategoryAsync('leave-check', [
    {
      identifier: 'i_left',
      buttonTitle: heUi ? 'יצאתי ✓' : 'I left ✓',
      options: { opensAppToForeground: false },
    },
  ]);

  // The 20:00 evening check-in carries a "Plan tomorrow" action that opens
  // the PlanTomorrow screen (routed in App.tsx's subscribeNotificationTap).
  await Notifications.setNotificationCategoryAsync('evening-checkin', [
    { identifier: 'plan_tomorrow', buttonTitle: '🌙 Plan tomorrow', options: { opensAppToForeground: true } },
  ]);
}

/** Remove repeated copies left by older scheduling paths that did not persist IDs. */
export async function removeDuplicateTaskNotifications(): Promise<void> {
  if (isExpoGo || !Notifications) return;
  try {
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    const seen = new Set<string>();
    for (const item of scheduled) {
      const data = item.content.data as Record<string, unknown> | undefined;
      const taskId = data?.taskId;
      if (!taskId) continue;
      const kind = String(data?.notificationType || (data?.focusCheckIn ? 'focus_check_in' : 'task'));
      const key = `${String(taskId)}:${kind}`;
      if (seen.has(key)) {
        await Notifications.cancelScheduledNotificationAsync(item.identifier).catch(() => {});
      } else {
        seen.add(key);
      }
    }
  } catch (e) {
    console.log('[Notifications] duplicate cleanup failed:', e);
  }
}

const leaveNagsKey = (taskId: string) => `leave_nags:${taskId}`;
const wakeAlarmArmedKey = (taskId: string) => `wake_alarm_armed:${taskId}`;

/**
 * The absolute moment an alert fires: HH:MM on the task's own date, shifted by
 * the alert's dayOffset (see utils/alertPlan). Returns null when that moment
 * has already passed, so the caller skips it instead of scheduling the past.
 *
 * Task alerts used to be scheduled with the legacy `{ hour, minute }` trigger,
 * which ignores the date entirely — Thursday's interview warned you on Monday,
 * or never. Everything date-bound goes through here now.
 */
function alertDate(dateStr: string, hhmm: string, dayOffset = 0): Date | null {
  const [y, mo, d] = (dateStr || '').split('-').map(Number);
  const [hh, mm] = (hhmm || '').split(':').map(Number);
  if ([y, mo, d, hh, mm].some((n) => !Number.isFinite(n))) return null;
  const when = new Date(y, mo - 1, d + dayOffset, hh, mm, 0, 0);
  return when.getTime() > Date.now() ? when : null;
}

/** Cancel any still-pending "did you go?" nags for a task (user confirmed they left). */
export async function cancelLeaveNags(taskId: string): Promise<void> {
  if (!Notifications) return;
  const raw = await AsyncStorage.getItem(leaveNagsKey(taskId)).catch(() => null);
  if (!raw) return;
  try {
    for (const id of JSON.parse(raw) as string[]) {
      await Notifications.cancelScheduledNotificationAsync(id).catch(() => {});
    }
  } finally {
    await AsyncStorage.removeItem(leaveNagsKey(taskId)).catch(() => {});
  }
}

/**
 * Schedule a one-off alarm-style notification at an absolute time on the
 * MAX-importance 'wake-alarm' channel. `data` is echoed back on tap so App.tsx
 * can react (e.g. speak the briefing aloud). Consumed by MorningBriefingService.
 */
// Pending wake-briefing marker: when a wake alarm is scheduled, remember its
// time so that opening the app after it fired auto-speaks the (freshly
// recomposed) briefing — no tap on the notification needed. Read by
// MorningBriefingService.maybeSpeakWakeBriefing on AppState 'active'.
export const PENDING_WAKE_BRIEFING_KEY = 'lumi.pendingWakeBriefing.v1';

export async function registerPendingWakeBriefing(when: Date): Promise<void> {
  try {
    await AsyncStorage.setItem(PENDING_WAKE_BRIEFING_KEY, when.toISOString());
  } catch { /* best-effort */ }
}

export async function scheduleWakeAlarm(
  title: string,
  body: string,
  when: Date,
  data: Record<string, unknown> = {},
): Promise<string | null> {
  await registerPendingWakeBriefing(when);
  if (isExpoGo || !Notifications) {
    console.log('[MOCK] Wake alarm:', title, body, when.toISOString());
    return null;
  }
  return Notifications.scheduleNotificationAsync({
    content: { title, body, data, priority: 'max', sound: 'default' } as any,
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: when,
      channelId: 'wake-alarm',
    } as any,
  });
}

/**
 * Ids of the 3 daily check-ins, so re-registering them cancels ONLY them.
 *
 * This used to be `cancelAllScheduledNotificationsAsync()`, which App.tsx runs
 * on every cold start — so every wake / leave / hour-before / deadline alert a
 * task had scheduled was destroyed the next time the app opened, and only the
 * check-ins came back. That is why a "class at 16:30" never alerted.
 */
const CHECKIN_IDS_KEY = 'lumi.checkInNotificationIds.v1';

/** Re-register the morning/afternoon/evening check-in notifications from settings. */
export async function rescheduleDailyNotifications(settings: AppSettings) {
  if (isExpoGo || !Notifications) {
    console.log('[MOCK] Notification scheduled:', toMessage('morning').title);
    console.log('[MOCK] Notification scheduled:', toMessage('afternoon').title);
    console.log('[MOCK] Notification scheduled:', toMessage('evening').title);
    return;
  }

  // Cancel only the previous check-ins — never the task alerts.
  try {
    const raw = await AsyncStorage.getItem(CHECKIN_IDS_KEY);
    if (raw) {
      for (const id of JSON.parse(raw) as string[]) {
        await Notifications.cancelScheduledNotificationAsync(id).catch(() => {});
      }
    }
  } catch { /* best-effort */ }

  const ids = (await Promise.all([
    scheduleDailyCheckIn('morning', settings.morningTime.hour, settings.morningTime.minute),
    scheduleDailyCheckIn('afternoon', settings.afternoonTime.hour, settings.afternoonTime.minute),
    scheduleDailyCheckIn('evening', settings.eveningTime.hour, settings.eveningTime.minute),
  ])).filter((id): id is string => Boolean(id));

  await AsyncStorage.setItem(CHECKIN_IDS_KEY, JSON.stringify(ids)).catch(() => {});
}

// Focus-task engagement: Lumi checks in on today's most important task during
// the day ("how's it going?" + encouragement). Scheduled once per day from
// TodaySchedule; taps open the task (taskId routing in subscribeNotificationTap).
const FOCUS_PINGS_KEY = 'lumi.focusPingsDate.v1';
const FOCUS_PING_TIMES: Array<[number, number]> = [[13, 0], [16, 30]];

export async function scheduleFocusCheckIns(
  task: Task,
  lang: AppLanguage,
  /** Today's fixed-time tasks, so a ping never lands on top of one. */
  busyTimes: string[] = [],
): Promise<void> {
  if (isExpoGo || !Notifications) return;
  try {
    const today = new Date().toISOString().slice(0, 10);
    if ((await AsyncStorage.getItem(FOCUS_PINGS_KEY)) === today) return;
    await AsyncStorage.setItem(FOCUS_PINGS_KEY, today);
    const he = lang === 'he';
    // "How's it going?" while you're walking into the thing is noise — one of
    // these slots is 16:30, which is exactly when a 16:30 class starts.
    const busy = busyTimes
      .map((t) => { const [bh, bm] = t.split(':').map(Number); return bh * 60 + bm; })
      .filter((n) => Number.isFinite(n));
    for (const [h, m] of FOCUS_PING_TIMES) {
      if (busy.some((b) => Math.abs(b - (h * 60 + m)) < 30)) continue;
      const when = new Date();
      when.setHours(h, m, 0, 0);
      if (when.getTime() <= Date.now()) continue; // that slot already passed
      await Notifications.scheduleNotificationAsync({
        content: {
          title: he ? `💪 איך הולך עם: ${task.text}?` : `💪 How's it going: ${task.text}?`,
          body: he ? 'זו המשימה הכי חשובה היום — אני איתך! ✨' : "Today's big one — you've got this! ✨",
          data: { taskId: task.id, focusCheckIn: true },
        },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: when } as any,
      });
    }
  } catch (e) {
    console.log('[Notifications] focus check-ins failed:', e);
  }
}

/**
 * A plain one-off reminder at an absolute moment. Returns the notification id,
 * or null if it could not be scheduled — callers use that to decide whether
 * they are allowed to tell the user it worked.
 */
export async function scheduleReminderAt(
  when: Date,
  text: string,
  data: Record<string, unknown> = {},
): Promise<string | null> {
  if (when.getTime() <= Date.now()) return null;
  if (isExpoGo || !Notifications) {
    console.log('[NOTIF_MOCK] reminder:', text, when.toISOString());
    return `mock-${when.getTime()}`;
  }
  try {
    return await Notifications.scheduleNotificationAsync({
      content: {
        title: text ? `🔔 ${text}` : '🔔 תזכורת',
        body: `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`,
        data: { ...data, notificationType: 'reminder' },
        priority: 'max',
        sound: 'default',
      } as any,
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: when,
        channelId: 'wake-alarm',
      } as any,
    });
  } catch (e) {
    console.log('[Notifications] reminder scheduling failed:', e);
    return null;
  }
}

/** Cancel one scheduled notification by id. Safe on unknown/mock ids. */
export async function cancelScheduled(id: string): Promise<void> {
  if (!Notifications || !id || id.startsWith('mock-')) return;
  await Notifications.cancelScheduledNotificationAsync(id).catch(() => {});
}

/** Fire a notification right now (nearby nudges, alerts). */
export async function sendInstantNotification(
  title: string,
  body: string,
  data: Record<string, unknown> = {},
  /** Seconds to wait before firing. Omit (or 0) for immediate — snooze-style
   *  callers (LeaveNowScreen "+5 min") need a real delay. */
  delaySeconds = 0,
) {
  if (isExpoGo || !Notifications) {
    console.log('[MOCK] Instant notification:', title, body, data, delaySeconds);
    return;
  }

  await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      data,
    },
    trigger: delaySeconds > 0
      ? { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: delaySeconds } as any
      : null,
  });
}

/** Listen for notification taps and route to the matching screen; returns unsubscribe.
 *  onPlanTomorrow — evening notification's "Plan tomorrow" action.
 *  onOpenTask — any task-scoped notification (wake / leave / "did you go?" /
 *  arrival / focus check-in) opens that task's detail, where the route + hours
 *  live. Before this, those taps opened nothing. */
export function subscribeNotificationTap(
  onOpenCheckIn: (type?: CheckInType) => void,
  onPlanTomorrow?: () => void,
  /** screen: where the alert wants to land ('TaskDetail' | 'LeaveNow'). */
  onOpenTask?: (taskId: string, screen?: string) => void,
) {
  if (isExpoGo || !Notifications) {
    return {
      remove: () => undefined,
    };
  }

  return Notifications.addNotificationResponseReceivedListener((response) => {
    const data = response.notification.request.content.data ?? {};
    // "I left ✓" on a leave-home/nag notification → stop the remaining nags.
    if (response.actionIdentifier === 'i_left') {
      if (data.taskId) {
        // One implementation, shared with LeaveNowScreen's "✓ יצאתי" button:
        // cancel the nags AND take a GPS fix, so the departure is recorded from
        // where she actually is. Dynamically imported because LiveRoute imports
        // this module — a static import here would close the cycle.
        import('./LiveRoute')
          .then((m) => m.confirmDeparture(String(data.taskId)))
          .catch((e) => console.warn('[NotificationService] confirmDeparture failed', e));
      }
      return;
    }
    // "Plan tomorrow" on the evening check-in → PlanTomorrow screen.
    if (response.actionIdentifier === 'plan_tomorrow') {
      onPlanTomorrow?.();
      return;
    }
    if (data.taskId) {
      onOpenTask?.(String(data.taskId), data.screen ? String(data.screen) : undefined);
      return;
    }
    const checkInType = data.checkInType as CheckInType | undefined;
    onOpenCheckIn(checkInType);
  });
}

/**
 * Schedule the travel alerts for a task that has a route: wake-up (+ a real
 * Android system alarm), leave-home, and the "did you go?" nags.
 * WHEN/WHAT/WHERE-it-opens comes from utils/alertPlan.planTransitAlerts — the
 * same plan the week harness prints, so a tested schedule is the fired schedule.
 */
export async function scheduleTransitNotifications(
  task: Task,
  lang: AppLanguage,
  /** The user's normal wake hour — suppresses "wake up!" for evening trips. */
  usualWakeTime?: string,
): Promise<void> {
  const plan = typeof task.location === 'object' ? task.location?.transitPlan : undefined;
  if (isExpoGo || !Notifications || !plan) return;
  const alerts = planTransitAlerts(task, plan, lang, usualWakeTime);
  const ids: string[] = [];
  const nagIds: string[] = [];

  for (const alert of alerts) {
    // The alert's real calendar moment — the task's own date, not "today".
    const when = alertDate(task.date, alert.at, alert.dayOffset);
    if (!when) continue;

    if (alert.kind === 'wake_up') {
      // A REAL Android system alarm too — rings even if the app is killed.
      // Gated by the user's toggle: the wake NOTIFICATION still fires, but the
      // loud clock alarm on top of it is optional (some keep their own alarm).
      if (await wakeAlarmEnabled()) {
        setSystemAlarm(alert.at, task.text, task.date).catch(() => {});
      }
      // Opening the app after this alarm auto-speaks the morning briefing.
      registerPendingWakeBriefing(when).catch(() => {});
    }
    const id = await Notifications.scheduleNotificationAsync({
      content: {
        title: alert.title,
        body: alert.body,
        // taskId + screen are what route the tap (see alertPlan.ALERT_SCREEN).
        data: { taskId: alert.taskId, notificationType: alert.kind, screen: alert.screen, language: lang },
        ...(alert.urgent ? { priority: 'max' } : {}),
        ...(alert.category ? { categoryIdentifier: alert.category } : {}),
      } as any,
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: when,
        ...(alert.urgent ? { channelId: 'wake-alarm' } : {}),
      } as any,
    });
    ids.push(id);
    // "I left ✓" cancels the leave alert and every nag after it.
    if (alert.category === 'leave-check') nagIds.push(id);
  }

  await AsyncStorage.setItem(leaveNagsKey(task.id), JSON.stringify(nagIds)).catch(() => {});

  if (task.notificationIds) {
    task.notificationIds.push(...ids);
  } else {
    task.notificationIds = ids;
  }
}

// Deadline notifications
export async function scheduleDeadlineNotifications(task: Task, lang: AppLanguage): Promise<void> {
  if (isExpoGo || !Notifications || !task.deadline) return;
  const ids: string[] = [];
  const deadlineTime = task.deadlineTime || '23:59';
  const daysLeft = getDaysUntilDeadline(task.deadline);
  const latestStart = task.estimatedWorkMinutes
    ? calculateLatestStartTime(task.deadline, deadlineTime, task.estimatedWorkMinutes)
    : null;

  const dateTrigger = (when: Date) => ({
    type: Notifications!.SchedulableTriggerInputTypes.DATE,
    date: when,
  }) as any;

  // Day before at 18:00
  const dayBefore = alertDate(task.deadline, '18:00', -1);
  if (daysLeft >= 1 && dayBefore) {
    const id = await Notifications.scheduleNotificationAsync({
      content: {
        title: `📚 ${lang === 'he' ? 'מחר הדדליין' : 'Deadline tomorrow'}: ${task.text}`,
        body: lang === 'he'
          ? `הגשה מחר ב-${deadlineTime}. צריך ~${task.estimatedWorkMinutes || 60} דקות.`
          : `Due tomorrow at ${deadlineTime}. Need ~${task.estimatedWorkMinutes || 60} min.`,
        data: { taskId: task.id, notificationType: 'deadline_reminder' },
      },
      trigger: dateTrigger(dayBefore),
    });
    ids.push(id);
  }

  // Day of at 09:00
  const dayOf = alertDate(task.deadline, '09:00');
  if (daysLeft <= 1 && dayOf) {
    const id = await Notifications.scheduleNotificationAsync({
      content: {
        title: `🔴 ${lang === 'he' ? 'היום הדדליין' : 'Deadline today'}: ${task.text}`,
        body: lang === 'he'
          ? `חייב להגיש עד ${deadlineTime}!${latestStart ? ` התחל לכל המאוחר ב-${latestStart.time}` : ''}`
          : `Must submit by ${deadlineTime}!${latestStart ? ` Start by ${latestStart.time} at latest` : ''}`,
        priority: 'max',
        data: { taskId: task.id, notificationType: 'deadline_today' },
      },
      trigger: dateTrigger(dayOf),
    });
    ids.push(id);
  }

  // Latest start alert
  const startWhen = latestStart ? alertDate(latestStart.date, latestStart.time) : null;
  if (startWhen) {
    const id = await Notifications.scheduleNotificationAsync({
      content: {
        title: `🔴 ${lang === 'he' ? 'התחל עכשיו' : 'Start NOW'}: ${task.text}`,
        body: lang === 'he'
          ? `אם לא תתחיל עכשיו לא תספיק! דדליין ב-${deadlineTime}`
          : `If you don't start now you won't finish! Deadline at ${deadlineTime}`,
        priority: 'max',
        data: { taskId: task.id, notificationType: 'latest_start' },
      },
      trigger: dateTrigger(startWhen),
    });
    ids.push(id);
  }

  if (task.notificationIds) {
    task.notificationIds.push(...ids);
  } else {
    task.notificationIds = ids;
  }
}

/**
 * Auto-schedule every local reminder a task needs. Called immediately after a
 * task is saved, and again for the whole week at launch (rehydrateTaskAlerts).
 *
 * Covers: 1-hour-before / 15-min-before, the route-derived travel alerts, and
 * deadline warnings — each on its own merits.
 *
 * This used to `return` on `!task.fixedTime` BEFORE reaching the travel and
 * deadline blocks, so a trip with a real route but no appointment hour got no
 * wake, no leave and no "still at home?" alert, and a deadline with no clock
 * time got no warning at all. Only the lead-time alerts actually need a
 * fixedTime; they are the ones gated now.
 */
export async function scheduleTaskReminders(
  task: Task,
  lang: AppLanguage,
): Promise<void> {
  if (isExpoGo || !Notifications) {
    console.log('[NOTIF_MOCK] Would schedule reminders for:', task.text, task.fixedTime);
    return;
  }
  if (!taskNeedsAlerts(task)) return;

  const ids: string[] = [];
  // Times + wording from the shared plan (utils/alertPlan): 1 h before and
  // 15 min before. No travel guesses here — travel alerts come from the real
  // route via scheduleTransitNotifications below.
  const leaveAt = typeof task.location === 'object' ? task.location?.leaveHomeBy : undefined;
  // resolveLeadMinutes has accepted learned per-category lead times since it was
  // written, but nothing ever passed them, so profile.learnedLeadMinutes was
  // inert and every task got the category default.
  // planFixedTimeAlerts already returns [] without a fixedTime; the loop simply
  // does not run for a route-only task.
  for (const alert of planFixedTimeAlerts(
    task, lang, leaveAt, await learnedLeads(), await prepInputs(),
  )) {
    const when = alertDate(task.date, alert.at, alert.dayOffset);
    if (!when) continue; // already past — don't warn about what already happened
    const id = await Notifications.scheduleNotificationAsync({
      content: {
        title: alert.title,
        body: alert.body,
        data: { taskId: alert.taskId, notificationType: alert.kind, screen: alert.screen, language: lang },
        priority: alert.urgent ? 'max' : 'default',
      } as any,
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: when,
        ...(alert.urgent ? { channelId: 'wake-alarm' } : {}),
      } as any,
    });
    ids.push(id);
  }

  // Also run transit-specific ones if transit plan is available
  if (typeof task.location === 'object' && task.location?.transitPlan) {
    await scheduleTransitNotifications(task, lang, await usualWakeTime());
  }

  // Deadline reminders
  if (task.deadline) {
    await scheduleDeadlineNotifications(task, lang);
  }

  if (ids.length) {
    task.notificationIds = [...(task.notificationIds ?? []), ...ids];
  }
}

/**
 * Cancel every alert outstanding for a task.
 *
 * Deliberately NOT limited to `task.notificationIds`. Four paths schedule
 * travel alerts for the same task and each persists its own ids, so a caller
 * holding an object loaded before another path wrote its ids used to cancel
 * nothing and then schedule a second full set — the "time to start getting
 * ready ×4" bug. utils/alertCancellation explains the shape; the OS's own list
 * is the authoritative record and cannot go stale.
 */
export async function cancelTaskNotifications(task: Task): Promise<void> {
  if (!Notifications) return;
  let scheduled: any[] = [];
  try {
    scheduled = await Notifications.getAllScheduledNotificationsAsync();
  } catch {
    scheduled = []; // fall back to the stored ids alone
  }
  for (const id of identifiersToCancel(scheduled, task.id, task.notificationIds)) {
    await Notifications.cancelScheduledNotificationAsync(id).catch(() => {});
  }
  await AsyncStorage.removeItem(leaveNagsKey(task.id)).catch(() => {});
}

/**
 * Per-category lead times Lumi has learned for this user.
 *
 * Loaded through a dynamic import on purpose: UserProfileStorage reaches
 * NearbyTaskReminderService, which imports this module, so a static import
 * here would close a require cycle. Never throws — no profile just means
 * "assume nothing" and alertPlan falls back to its defaults.
 */
export async function learnedLeads(): Promise<Partial<Record<TaskCategory, number>> | undefined> {
  try {
    const { loadProfile } = await import('./UserProfileStorage');
    const profile: any = await loadProfile();
    return normalizeProfile(profile)?.learnedLeadMinutes || undefined;
  } catch {
    return undefined;
  }
}

/** Whether the loud system alarm is enabled (default on; the notification fires regardless). */
export async function wakeAlarmEnabled(): Promise<boolean> {
  try {
    const s = await getSettings();
    return s.wakeAlarmEnabled !== false;
  } catch {
    return true;
  }
}

/**
 * The hour this user normally gets up, for suppressing pointless wake alarms.
 * Dynamically imported for the same require-cycle reason as learnedLeads.
 */
async function usualWakeTime(): Promise<string | undefined> {
  try {
    const { loadProfile } = await import('./UserProfileStorage');
    const profile: any = await loadProfile();
    return normalizeProfile(profile)?.defaultWakeTime || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The two numbers a "start getting ready" alert needs, for a task with NO route.
 *
 * Read together in one call because they are useless apart: the routine
 * without the usual wake time cannot tell an alarm from a nudge, and the wake
 * time without the routine has no prep window to offer. The routine is
 * morning-routine PLUS buffer — forgetting the buffer moves every prep alert
 * fifteen minutes late, which is the whole margin on a tight morning.
 */
async function prepInputs(): Promise<{ routineMinutes?: number; usualWakeTime?: string }> {
  try {
    const { loadProfile } = await import('./UserProfileStorage');
    const profile = normalizeProfile(await loadProfile() as any);
    if (!profile) return {};
    const routine = (profile.morningRoutineMinutes ?? 0) + (profile.wakeBufferMinutes ?? 0);
    return {
      routineMinutes: routine > 0 ? routine : undefined,
      usualWakeTime: profile.defaultWakeTime || undefined,
    };
  } catch {
    return {};
  }
}

const taskAlertLocks = new Map<string, Promise<void>>();

/**
 * Serialize cancel-then-schedule for one task.
 *
 * Two paths re-planning the same task at once both cancel (seeing the other's
 * alerts as not-yet-scheduled), then both schedule — two full sets, and the
 * authoritative cancel cannot help because neither run has finished writing
 * when the other reads. TodaySchedule fires several of these concurrently, so
 * every caller that schedules task alerts must hold this.
 *
 * NOT re-entrant: `armTaskAlerts` already holds it while scheduleTaskReminders
 * runs, so the raw `scheduleTransitNotifications` it calls must stay unlocked.
 * External callers wrap their own cancel+schedule+persist block instead.
 */
export function withTaskAlertLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
  const previous = taskAlertLocks.get(taskId) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(fn);
  // The tail the NEXT caller waits on. Swallow rejection so one failed
  // re-plan cannot wedge every later one for this task.
  const tail = run.then(() => {}, () => {});
  taskAlertLocks.set(taskId, tail);
  void tail.then(() => {
    if (taskAlertLocks.get(taskId) === tail) taskAlertLocks.delete(taskId);
  });
  return run;
}

/**
 * Schedule a task's alerts AND persist the resulting ids.
 *
 * The ids used to be assigned onto the in-memory task and dropped on the floor,
 * so cancelTaskNotifications had nothing to cancel and every reschedule stacked
 * another copy of the same alert. This is the entry point callers should use;
 * `lang` defaults to the user's actual setting rather than a hardcoded 'en'.
 */
export async function armTaskAlerts(task: Task, lang?: AppLanguage): Promise<void> {
  await withTaskAlertLock(task.id, async () => {
    const language = lang ?? await getSettings().then((s) => s.language).catch(() => 'en' as AppLanguage);
    await cancelTaskNotifications(task);
    task.notificationIds = [];
    await scheduleTaskReminders(task, language);
    await updateTaskFields(task.id, { notificationIds: task.notificationIds ?? [] }).catch(() => {});
  });
}

/**
 * Arm alerts for tasks that have NONE outstanding — call whenever tasks load.
 *
 * `rehydrateTaskAlerts` runs once at cold start, but tasks arrive after that:
 * WhatsApp and Google rows are merged by the sync layer, which never armed
 * anything, so a meeting that landed at 10:00 had no alert until the app was
 * next killed and reopened. That was survivable while the server also reminded
 * over WhatsApp. With the backend allowed to sleep it is not — the phone is the
 * only thing awake, so anything that reaches the task list has to be armed the
 * moment it does.
 *
 * Cheap and idempotent: ONE read of the OS's scheduled list, and a task that
 * already has any alert outstanding is left completely alone (so this never
 * cancels-and-reschedules the alerts it just checked). Past dates are skipped —
 * every alert for them would resolve to a moment already gone.
 *
 * Returns the tasks it armed, so the caller can persist their new ids.
 */
export async function armMissingTaskAlerts(
  tasks: Task[],
  lang: AppLanguage,
  today = new Date().toISOString().slice(0, 10),
): Promise<Task[]> {
  if (isExpoGo || !Notifications) return [];
  let scheduled: Awaited<ReturnType<NonNullable<typeof Notifications>['getAllScheduledNotificationsAsync']>>;
  try {
    scheduled = await Notifications.getAllScheduledNotificationsAsync();
  } catch {
    return []; // can't tell what is outstanding — do nothing rather than double up
  }
  const alreadyArmed = new Set<string>();
  for (const entry of scheduled) {
    const owner = (entry?.content?.data as { taskId?: unknown } | undefined)?.taskId;
    if (owner !== undefined && owner !== null) alreadyArmed.add(String(owner));
  }

  const touched: Task[] = [];
  for (const task of tasks) {
    if (task.status !== 'pending') continue;
    if (task.date < today) continue;
    if (!taskNeedsAlerts(task)) continue;
    if (alreadyArmed.has(String(task.id))) continue;
    try {
      await armTaskAlerts(task, lang);
      touched.push(task);
    } catch (e) {
      console.log('[Notifications] arming missed task failed', task.id, e);
    }
  }
  if (touched.length) {
    console.log(`[Notifications] armed ${touched.length} task(s) that had no alerts`);
  }
  return touched;
}

/**
 * Re-arm every alert for the given tasks — call once at app start.
 *
 * Scheduled notifications do NOT survive a reinstall, an OS upgrade, or a
 * force-stop on some Android skins, and until now nothing ever put them back.
 * Rehydrating is idempotent: each task's stored ids are cancelled first, then
 * re-planned from utils/alertPlan, so running it twice changes nothing.
 *
 * Returns the tasks whose notificationIds changed — the caller persists them
 * (ids are useless if they only ever live in memory).
 */
export async function rehydrateTaskAlerts(tasks: Task[], lang: AppLanguage): Promise<Task[]> {
  if (isExpoGo || !Notifications) return [];
  const touched: Task[] = [];
  for (const task of tasks) {
    if (task.status !== 'pending') continue;
    // Not `fixedTime || deadline`: that skipped a trip whose route is the only
    // reason it needs an alert, so its leave time was never re-armed after a
    // reinstall or a force-stop.
    if (!taskNeedsAlerts(task)) continue;
    try {
      await cancelTaskNotifications(task);
      task.notificationIds = [];
      await scheduleTaskReminders(task, lang);
      touched.push(task);
    } catch (e) {
      console.log('[Notifications] rehydrate failed for', task.id, e);
    }
  }
  console.log(`[Notifications] rehydrated alerts for ${touched.length} task(s)`);
  return touched;
}

// Send immediate notification
export async function sendImmediate(title: string, body: string, data?: any): Promise<void> {
  if (isExpoGo) { console.log(`[NOTIF] ${title}: ${body}`); return; }
  if (!Notifications) return;
  await Notifications.scheduleNotificationAsync({
    content: { title, body, data },
    trigger: null,
  });
}
