/**
 * historyEvents — what changed in her task list, as history events (Feature 2, 20.10).
 *
 * The phone diffs the task list on EVERY write (TaskStorage.onTaskListChanged)
 * — chat, mic, (+), a move, a tick, a calendar import, a cloud pull — and turns
 * the change into events for her opt-in history log (server lumi_history).
 * Pure, so the rules are tested in node (tests/run-history-events.ts).
 *
 * dedupKey matches the server's backfill (history_store.events_from_tasks), so
 * the same move seen by both sides, or seen twice, is ONE row.
 */
import type { Task } from '../types/index';

export type HistoryKind = 'moved' | 'completed' | 'missed' | 'trip' | 'study';

export interface HistoryEvent {
  kind: HistoryKind;
  day: string;              // YYYY-MM-DD the event belongs to
  taskId?: string;
  text?: string;
  category?: string;
  minutes?: number;
  data?: Record<string, string>;
  dedupKey: string;
}

const MAX_TRIP_MIN = 300;

function base(t: Task) {
  return { taskId: t.id, text: t.text, category: t.category };
}

export function diffEvents(prev: Task[], next: Task[], now = Date.now()): HistoryEvent[] {
  const before = new Map(prev.map((t) => [t.id, t]));
  const out: HistoryEvent[] = [];
  for (const t of next) {
    const p = before.get(t.id);
    if (!p) continue;                       // a new task is not history yet
    if (p.date && t.date && p.date !== t.date) {
      out.push({
        ...base(t), kind: 'moved', day: p.date, data: { from: p.date, to: t.date },
        dedupKey: `moved:${t.id}:${p.date}:${t.date}`,
      });
    }
    if (t.status === 'complete' && p.status !== 'complete') {
      out.push({
        ...base(t), kind: 'completed', day: t.date,
        ...(typeof t.actualDurationMinutes === 'number' ? { minutes: t.actualDurationMinutes } : {}),
        dedupKey: `completed:${t.id}:${t.date}`,
      });
    }
    if (t.status === 'missed' && p.status !== 'missed') {
      out.push({ ...base(t), kind: 'missed', day: t.date, dedupKey: `missed:${t.id}:${t.date}` });
    }
    if (t.verifiedArrival && !p.verifiedArrival && typeof t.lastDepartureDetectedAt === 'number') {
      const minutes = Math.round((now - t.lastDepartureDetectedAt) / 60_000);
      if (minutes >= 1 && minutes <= MAX_TRIP_MIN) {
        out.push({ ...base(t), kind: 'trip', day: t.date, minutes, dedupKey: `trip:${t.id}:${t.date}` });
      }
    }
  }
  return out;
}

/** A running focus session, so far. The same dedupKey every tick: the row grows, never repeats. */
export function studyEvent(
  s: { id: string; title: string; startedAtMs: number; endsAtMs: number; taskId: string | null },
  now = Date.now(),
): HistoryEvent | null {
  const minutes = Math.round((Math.min(now, s.endsAtMs) - s.startedAtMs) / 60_000);
  if (minutes < 1) return null;
  const d = new Date(s.startedAtMs);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return {
    kind: 'study', day, minutes, text: s.title || undefined,
    ...(s.taskId ? { taskId: s.taskId } : {}), dedupKey: `study:${s.id}`,
  };
}
