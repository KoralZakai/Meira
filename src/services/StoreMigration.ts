/**
 * StoreMigration — one-time repair of a task store that grew under the bugs.
 *
 * Fixing the causes (the write race, the notification ids, the calendar window)
 * stops NEW damage. It does nothing about the duplicates, stale tasks and
 * orphaned alarms already sitting on the device — those were created while the
 * bugs were live and will stay forever unless something removes them.
 *
 * Three passes, in this order:
 *   1. merge duplicates by MEANING, not exact text
 *   2. archive pending tasks whose date is long past
 *   3. cancel scheduled notifications with no live task behind them
 *
 * Nothing is deleted. Losers become `status: 'moved'`, which `getTasksForDate`
 * already filters out and which the user can still find — a migration that
 * destroys data is not one you can safely ship to a phone you cannot inspect.
 *
 * Runs once, behind a version key, so bumping MIGRATION_VERSION re-runs it.
 * Reports what it did so the result can be shown rather than silently applied.
 *
 * Dependencies: TaskStorage (locked writes), NotificationService, fuzzyMatch.
 * Consumed by App.tsx at startup.
 */
import AsyncStorage from './EncryptedStorage';  // AES-256-GCM at rest (7.10)
import { Task } from '../types/index';
import { getAllTasks, saveAllTasks, withTaskLock } from './TaskStorage';
import { mergeByMeaning } from '../utils/taskMerge';

// The merge decision lives in utils/taskMerge (importable without
// react-native, therefore actually testable).
export { mergeByMeaning } from '../utils/taskMerge';

const MIGRATION_KEY = 'lumi.storeMigration.v1';
const MIGRATION_VERSION = 1;

/** Older than this and still pending: the moment has passed. */
const STALE_DAYS = 30;

/** YYYY-MM-DD `days` before today, on the local calendar. */
function daysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export interface MigrationReport {
  ran: boolean;
  duplicatesMerged: number;
  staleArchived: number;
  orphanAlertsCancelled: number;
  tasksBefore: number;
  tasksAfter: number;
}

const EMPTY: MigrationReport = {
  ran: false,
  duplicatesMerged: 0,
  staleArchived: 0,
  orphanAlertsCancelled: 0,
  tasksBefore: 0,
  tasksAfter: 0,
};

/** Has the migration already run at this version? */
export async function migrationDone(): Promise<boolean> {
  const raw = await AsyncStorage.getItem(MIGRATION_KEY).catch(() => null);
  return Number(raw) >= MIGRATION_VERSION;
}

/**
 * Repair the store. Safe to call on every launch — it no-ops after the first.
 */
export async function runStoreMigration(): Promise<MigrationReport> {
  if (await migrationDone()) return EMPTY;

  const report: MigrationReport = { ...EMPTY, ran: true };

  try {
    const before = await getAllTasks();
    report.tasksBefore = before.length;

    // ── 1 + 2: merge duplicates, then archive what is long past ──
    const { kept, mergedIds } = mergeByMeaning(before);
    report.duplicatesMerged = mergedIds.length;

    const cutoff = daysAgo(STALE_DAYS);
    const merged = new Set(mergedIds);
    let staleArchived = 0;

    const next = before.map((t) => {
      if (merged.has(t.id)) return { ...t, status: 'moved' as const };
      if (t.status === 'pending' && t.date < cutoff) {
        staleArchived += 1;
        return { ...t, status: 'moved' as const };
      }
      return t;
    });
    report.staleArchived = staleArchived;
    void kept;

    await saveAllTasks(next);
    report.tasksAfter = next.filter((t) => t.status !== 'moved').length;

    // ── 3: alarms with nothing behind them ──
    report.orphanAlertsCancelled = await cancelOrphanAlerts(next);

    await AsyncStorage.setItem(MIGRATION_KEY, String(MIGRATION_VERSION));
  } catch (err) {
    // A failed migration must not be recorded as done, so the next launch
    // retries rather than leaving the store half-repaired forever.
    console.warn('[StoreMigration] failed; will retry next launch', err);
  }
  return report;
}

/**
 * Cancel every scheduled notification whose task is gone or no longer live.
 *
 * These are the leftovers from the duplicate-alert bug: alerts scheduled by
 * launches that could not cancel them afterwards. Without this they keep
 * firing for tasks that no longer exist.
 */
async function cancelOrphanAlerts(tasks: Task[]): Promise<number> {
  try {
    const Notifications = require('expo-notifications');
    const live = new Set(
      tasks.filter((t) => t.status === 'pending').map((t) => t.id),
    );
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    let cancelled = 0;
    for (const n of scheduled) {
      const taskId = n?.content?.data?.taskId;
      if (!taskId) continue;               // daily check-ins carry no taskId
      if (live.has(taskId)) continue;
      await Notifications.cancelScheduledNotificationAsync(n.identifier).catch(() => {});
      cancelled += 1;
    }
    return cancelled;
  } catch {
    // Expo Go has no notification module — nothing scheduled, nothing to clean.
    return 0;
  }
}

/** Re-run on the next launch. For debugging, and for a future version bump. */
export async function resetMigration(): Promise<void> {
  await withTaskLock(async () => {
    await AsyncStorage.removeItem(MIGRATION_KEY).catch(() => {});
  });
}
