/**
 * useApplySuggestion — what one tap on a Meira suggestion does, with Undo.
 *
 * Lifted out of SuggestPanel (17.10 picks: a tap APPLIES at once, 5-second
 * Undo; a new idea opens the Add screen with the words; an open task with no
 * window opens the task) so the chat home's "Meira suggests" card (27.10, v4)
 * behaves exactly like the + on Today — one rule, two places.
 */
import { useEffect, useRef, useState } from 'react';
import { applyPlaceAction, applyScheduleAction } from '../services/AddSuggestionSources';
import { getAllTasks, updateTaskFields } from '../services/TaskStorage';
import type { Suggestion, SuggestionAction } from '../utils/addSuggestions';
import type { Task } from '../types/index';

const UNDO_MS = 5000;

export type Prefill = Extract<SuggestionAction, { kind: 'prefill' }>;

/** The fields a schedule / place action writes — and therefore what Undo puts back. */
const snapshotOf = (t: Task): Partial<Task> => ({
  date: t.date,
  scheduledTime: t.scheduledTime,
  fixedTime: t.fixedTime,
  durationMinutes: t.durationMinutes,
  location: t.location,
  status: t.status,
  pickedAt: (t as any).pickedAt,
} as Partial<Task>);

interface Options {
  he: boolean;
  onPrefill: (a: Prefill) => void;
  onOpenTask: (taskId: string) => void;
  onChanged: () => Promise<void> | void;
}

export function useApplySuggestion({ he, onPrefill, onOpenTask, onChanged }: Options) {
  const [busyId, setBusyId] = useState<string | null>(null);
  // Rows already applied leave the list at once; the source hook does not re-run.
  const [used, setUsed] = useState<Set<string>>(() => new Set());
  const [undo, setUndo] = useState<{ rowId: string; taskId: string; before: Partial<Task>; line: string } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const onPick = async (row: Suggestion) => {
    const a = row.action;
    if (a.kind === 'prefill') { onPrefill(a); return; }
    if (a.kind === 'open') { onOpenTask(a.taskId); return; }
    setBusyId(row.id);
    setFailed(null);
    try {
      const before = (await getAllTasks()).find((t) => t.id === a.taskId);
      if (a.kind === 'schedule') await applyScheduleAction(a);
      else await applyPlaceAction(a);
      setUsed((prev) => new Set(prev).add(row.id));
      await onChanged();
      if (timer.current) clearTimeout(timer.current);
      setUndo(before ? {
        rowId: row.id, taskId: a.taskId, before: snapshotOf(before),
        line: he ? `✓ נקבע ל-${a.time}: ${row.titleHe}` : `✓ Set for ${a.time}: ${row.title}`,
      } : null);
      timer.current = setTimeout(() => setUndo(null), UNDO_MS);
    } catch (e) {
      // Rule 2: the reason is kept, and she is told it did not happen.
      console.warn('[Suggestion] could not apply the suggestion', row.id, e);
      setFailed(he ? 'לא הצלחתי לקבוע את זה — נסי שוב' : "Couldn't set that — try again");
    } finally {
      setBusyId(null);
    }
  };

  const takeBack = async () => {
    if (!undo) return;
    if (timer.current) clearTimeout(timer.current);
    const { taskId, before, rowId } = undo;
    setUndo(null);
    try {
      await updateTaskFields(taskId, before);
      setUsed((prev) => { const next = new Set(prev); next.delete(rowId); return next; });
      await onChanged();
    } catch (e) {
      console.warn('[Suggestion] undo failed', taskId, e);
      setFailed(he ? 'לא הצלחתי לבטל — אפשר לשנות במשימה עצמה' : "Couldn't undo — change it on the task itself");
    }
  };

  return { onPick, takeBack, busyId, used, undo, failed };
}
