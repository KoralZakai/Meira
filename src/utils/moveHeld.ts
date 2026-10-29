/**
 * moveHeld — a move she made must survive the calendar's next import.
 *
 * "My interview moved to Tuesday": Meira moves the task (movedFromDate = the old
 * day). Google still says the OLD day — the recruiter's invite did not change —
 * and `reconcileExternalTask` owns date/time, so the next sync, ten minutes
 * later, put it back. Her move is held for as long as Google keeps saying what
 * it said when she moved it; the day Google says something NEW, Google wins.
 *
 * Pure. tests/run-move-held.ts.
 */
export const MOVE_HELD_FIELDS: readonly string[] = ['date', 'fixedTime', 'scheduledTime'];

export function heldByHerMove(
  current: { date?: string; movedFromDate?: string | null } | null | undefined,
  incoming: { date?: string } | null | undefined,
): boolean {
  if (!current?.movedFromDate || !incoming?.date) return false;
  return incoming.date === current.movedFromDate && current.date !== incoming.date;
}
