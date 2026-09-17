/**
 * AlarmService — sets a REAL Android system alarm (Clock app) via the
 * AlarmClock.ACTION_SET_ALARM intent, so wake-ups ring even if the app is
 * killed. Notification scheduling stays in NotificationService; this is the
 * extra "actually ring like an alarm" layer on top of the wake-up notification.
 *
 * Dependencies: expo-intent-launcher (EAS build only — no-ops in Expo Go),
 * android.permissions must include com.android.alarm.permission.SET_ALARM
 * (app.json). Consumed by NotificationService.scheduleTransitNotifications —
 * the single hook point all wake-up flows route through.
 */
import { Platform } from 'react-native';

import { ALARM_REACH_MS } from '../utils/alarmPlan';
import * as IntentLauncher from 'expo-intent-launcher';
import { isExpoGo } from '../utils/isExpoGo';

/**
 * Set a system alarm at `hhmm` ("HH:MM"). `date` (YYYY-MM-DD) is only a guard:
 * ACTION_SET_ALARM has no date extra — it rings at the NEXT occurrence of
 * HH:MM, so anything more than 24h away is skipped.
 * Returns true if the alarm intent was fired.
 */
export async function setSystemAlarm(hhmm: string, message: string, date?: string): Promise<boolean> {
  if (Platform.OS !== 'android' || isExpoGo) return false;
  const [h, m] = hhmm.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return false;

  // Resolve the intended ring time; a past time means "next occurrence of HH:MM"
  // (same roll-forward rule as the notification triggers).
  let target = date ? new Date(`${date}T${hhmm}:00`) : new Date();
  if (!date || target.getTime() <= Date.now()) {
    target = new Date();
    target.setHours(h, m, 0, 0);
    if (target.getTime() <= Date.now()) target.setDate(target.getDate() + 1);
  }
  // >24h-out alarms fall back to notification only (SET_ALARM has no date extra).
  // AlarmPlanner re-checks these once they come into reach and arms them then,
  // so a far-future task still ends up with a real alarm — see alarmState.
  if (target.getTime() - Date.now() > ALARM_REACH_MS) return false;

  try {
    await IntentLauncher.startActivityAsync('android.intent.action.SET_ALARM', {
      extra: {
        'android.intent.extra.alarm.HOUR': h,
        'android.intent.extra.alarm.MINUTES': m,
        'android.intent.extra.alarm.MESSAGE': message,
        'android.intent.extra.alarm.SKIP_UI': true,
      },
    });
    return true;
  } catch (e) {
    console.warn('[AlarmService] set alarm failed', e);
    return false;
  }
}
