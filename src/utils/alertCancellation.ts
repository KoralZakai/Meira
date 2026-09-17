/**
 * alertCancellation — which scheduled notifications belong to a task, and so
 * must be cancelled before it is re-planned.
 *
 * The reported bug: "time to start getting ready" arriving four times over.
 * The alert PLAN is idempotent (tests/run-alert-integrity proves it), so the
 * duplication was never in the wording or the times — it was in the cancel.
 *
 * `cancelTaskNotifications` used to cancel exactly `task.notificationIds`, the
 * ids carried on the in-memory object handed to it. Four independent paths
 * schedule travel alerts for the same task — ensureTravelChain, armTaskAlerts
 * (via scheduleTaskReminders, whenever a transitPlan exists), LumiCoachEngine,
 * and the launch-time rehydrate — and each persists its own ids. A caller
 * holding a task object loaded before a different path wrote its ids cancels
 * nothing, then schedules a full second set. Repeat per path: four copies.
 *
 * The fix is to stop trusting the object. Every alert this app schedules
 * carries `data.taskId` (alertPlan puts it there so taps can route), so the
 * OS's own list is an authoritative record of what is outstanding — one that
 * cannot go stale and that also catches orphans left by an earlier app version
 * whose ids nothing remembers.
 *
 * Pure so it can be tested without expo-notifications. The scheduling itself
 * stays in services/NotificationService.
 */

/**
 * The subset of a scheduled notification this decision needs.
 *
 * `data` stays open: the real payload also carries notificationType, screen and
 * language, and narrowing it here would reject the very objects it describes.
 */
export interface ScheduledLike {
  identifier: string;
  content?: { data?: ({ taskId?: unknown } & Record<string, unknown>) | null } | null;
}

/**
 * Every identifier that must be cancelled for `taskId`, de-duplicated.
 *
 * The union of two sources, because neither alone is complete:
 *   - `storedIds` covers alerts just scheduled by this run, which may not be
 *     visible in a list read taken moments earlier;
 *   - the OS list covers everything else, including alerts scheduled by another
 *     code path or a previous install that `storedIds` never knew about.
 *
 * Alerts belonging to other tasks are never returned — cancelling those is how
 * a "fix" for duplicates turns into silently missing reminders.
 */
export function identifiersToCancel(
  scheduled: ReadonlyArray<ScheduledLike> | null | undefined,
  taskId: string,
  storedIds?: ReadonlyArray<string> | null,
): string[] {
  const out = new Set<string>();

  for (const id of storedIds ?? []) {
    if (typeof id === 'string' && id) out.add(id);
  }

  if (!taskId) return [...out];

  for (const entry of scheduled ?? []) {
    if (!entry || typeof entry.identifier !== 'string' || !entry.identifier) continue;
    // Compared as strings: ids have travelled through JSON and AsyncStorage,
    // and a number that came back as "42" must still match its own task.
    const owner = entry.content?.data?.taskId;
    if (owner !== undefined && owner !== null && String(owner) === String(taskId)) {
      out.add(entry.identifier);
    }
  }

  return [...out];
}
