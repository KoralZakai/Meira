/**
 * dayDiff — what moved in the day after she changed one trip.
 *
 * Koral, 27.10 (canvas v4, "All day — expanded"): "you can edit trips on the
 * day and see how the hours and the schedule update". A mode switch re-plans
 * the trip AND the chain after it (ensureTravelChain), so the leave time of
 * the next stop can move too. Without saying so, a time that changed on its
 * own reads as a bug (the reason liveNote exists). This takes a snapshot of
 * every task's clock times before the change and names the ones that moved.
 *
 * Pure: plain tasks in, plain records out.
 */
import type { Task } from '../types/index';

export interface TimesOf {
  start?: string;
  leave?: string;
  arrive?: string;
}

export interface DayChange {
  id: string;
  title: string;
  field: keyof TimesOf;
  from?: string;
  to?: string;
}

const loc = (t: Task) => (typeof t.location === 'object' ? t.location : undefined);

export function snapshotDay(tasks: Task[]): Record<string, TimesOf> {
  const out: Record<string, TimesOf> = {};
  for (const t of tasks) {
    out[t.id] = {
      start: t.fixedTime || t.scheduledTime || undefined,
      leave: loc(t)?.leaveHomeBy || undefined,
      arrive: loc(t)?.transitPlan?.arriveAt || undefined,
    };
  }
  return out;
}

/** Every clock time that is different now — tasks that appeared or vanished are not "changes". */
export function diffDay(before: Record<string, TimesOf>, after: Task[]): DayChange[] {
  const now = snapshotDay(after);
  const changes: DayChange[] = [];
  for (const t of after) {
    const was = before[t.id];
    if (!was) continue;
    for (const field of ['start', 'leave', 'arrive'] as const) {
      if ((was[field] || '') !== (now[t.id][field] || '')) {
        changes.push({ id: t.id, title: t.text, field, from: was[field], to: now[t.id][field] });
      }
    }
  }
  return changes;
}

/** The ids that moved, apart from the one she edited herself. */
export function knockOnIds(changes: DayChange[], editedId: string): string[] {
  return [...new Set(changes.filter((c) => c.id !== editedId).map((c) => c.id))];
}
