/**
 * TransitAlertService — the "before you leave" disruption check.
 *
 * Trigger (silent-state rule 7): `transitAlertTick` runs from
 * CalendarAutoSync.runCalendarSync — launch, AppState active, the heartbeat,
 * pull-to-refresh and the closed-app WorkManager job. For each trip leaving in
 * the next hour (utils/transitAlertWindow) it asks the server's news check and
 * stores the answer on the task (`location.transitAlerts`), so the trip card
 * can show it — including "couldn't check". A report she has not seen yet on
 * this trip is pushed once.
 */
import { getAllTasks, updateTaskFields } from './TaskStorage';
import { loadProfile } from './UserProfileStorage';
import { sendImmediate } from './NotificationService';
import { transitAlerts } from './LumiServer';
import {
  alertPush, locOf, newAlerts, routeTerms, tripsToRecheck,
} from '../utils/transitAlertWindow';
import { getTodayString } from '../utils/timeUtils';
import type { AppLanguage, TaskTransitAlerts } from '../types/index';

export interface TransitTickResult {
  checked: number;
  notified: number;
  error?: string;
}

export async function transitAlertTick(language: AppLanguage, now = new Date()): Promise<TransitTickResult> {
  const tasks = await getAllTasks();
  const due = tripsToRecheck(tasks, now, getTodayString());
  if (!due.length) return { checked: 0, notified: 0 };
  const home = (await loadProfile().catch(() => null))?.homeAddress;
  const he = language === 'he';
  let checked = 0;
  let notified = 0;
  const errors: string[] = [];
  for (const task of due) {
    const terms = routeTerms(task, home);
    if (!terms.places.length && !terms.stations.length && !terms.lines.length) continue;
    const loc = locOf(task);
    const prev = loc?.transitAlerts;
    const res = await transitAlerts(terms);
    let next: TaskTransitAlerts;
    if (res.ok && res.data.checked) {
      const alerts = (res.data.alerts ?? []).map((a) => ({
        title: a.title, link: a.link, published: a.published, matched: a.matched,
      }));
      next = { checkedAt: now.getTime(), alerts };
      checked += 1;
      const fresh = newAlerts(alerts, prev);
      if (fresh.length) {
        const { title, body } = alertPush(task, fresh[0], he);
        await sendImmediate(title, body, { taskId: task.id, url: fresh[0].link });
        notified += 1;
      }
    } else {
      // Could not look: keep what she was already told, and say why (rule 1).
      const reason = res.ok ? (res.data.reason || 'not_checked') : res.reason;
      console.warn('[TransitAlerts] check failed for', task.id, reason);
      errors.push(reason);
      next = { checkedAt: now.getTime(), alerts: prev?.alerts ?? [], reason };
    }
    if (loc) {
      await updateTaskFields(task.id, { location: { ...loc, transitAlerts: next } })
        .catch((e) => console.warn('[TransitAlerts] save failed', task.id, e));
    }
  }
  return { checked, notified, error: errors[0] };
}
