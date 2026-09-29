/**
 * ArrivedTaskPlanner — a task that arrives from the chat gets its route NOW.
 *
 * Koral, 2026-09-28: "the location was saved but it didn't really check where
 * it is — no transport option, because the place wasn't placed. After a few
 * minutes the route DID appear — why? It is terribly slow."
 *
 * Why: nothing ran it. The chat merged the task into storage and stopped; the
 * route, the leave time and the wake alarm are all built by ensureTravelChain,
 * and the only callers of that were a screen coming into focus and
 * CalendarAutoSync's heartbeat. So the route appeared whenever one of those
 * happened to fire — minutes later, or never if she stayed on the chat.
 * THE SILENT-STATE RULE, 7: a capability with no trigger is not a feature.
 *
 * The trigger is the arrival itself: LumiBrain calls this right after a turn
 * merges its tasks. Fire-and-forget from the chat's point of view (the reply
 * is not held for Google), and it tells the day on screen when it is done.
 *
 * Dependencies: GoogleSync.ensureTravelChain, NotificationService, TaskStorage,
 * DayEvents. Consumed by LumiBrain.
 */
import { ensureTravelChain } from './GoogleSync';
import { armMissingTaskAlerts } from './NotificationService';
import { getAllTasks, getSettings, updateTaskFields } from './TaskStorage';
import { emitDayChanged } from './DayEvents';
import { getTodayString } from '../utils/timeUtils';
import { AppLanguage, Task } from '../types/index';

/** Does this task have somewhere to go? A string or a placed object both count. */
function hasPlace(t: Task): boolean {
  const loc: any = t.location;
  if (typeof loc === 'string') return Boolean(loc.trim());
  return Boolean(loc && (loc.address || loc.displayName || (loc.lat && loc.lng)));
}

export async function planArrivedTasks(tasks: Task[]): Promise<{ planned: string[]; failed: string[] }> {
  const placed = tasks.filter(hasPlace);
  const planned: string[] = [];
  const failed: string[] = [];
  if (!placed.length) return { planned, failed };

  const language: AppLanguage = await getSettings()
    .then((s) => s.language).catch(() => 'he' as AppLanguage);
  const dates = [...new Set(placed.map((t) => t.date).filter(Boolean))].sort();

  for (const date of dates) {
    try {
      await ensureTravelChain(date, language);
      planned.push(date);
    } catch (e) {
      // Rule 2: the throw may be swallowed, the reason may not.
      console.warn('[ArrivedTaskPlanner] travel chain failed for', date, e);
      failed.push(date);
    }
  }

  // The chain wrote the leave / wake times; the alerts are armed from them.
  try {
    const ids = new Set(placed.map((t) => t.id));
    const fresh = (await getAllTasks()).filter((t) => ids.has(t.id));
    const armed = await armMissingTaskAlerts(fresh, language, getTodayString());
    for (const t of armed) {
      await updateTaskFields(t.id, { notificationIds: t.notificationIds }).catch(() => {});
    }
  } catch (e) {
    console.warn('[ArrivedTaskPlanner] arming failed', e);
  }

  for (const date of planned) emitDayChanged(date);
  console.warn(`[ArrivedTaskPlanner] routed ${placed.length} chat task(s) on ${planned.join(', ') || '—'}`
    + (failed.length ? `; FAILED on ${failed.join(', ')}` : ''));
  return { planned, failed };
}
