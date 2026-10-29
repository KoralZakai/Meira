/**
 * arrivalDone — she got there, so it is done.
 *
 * Koral, 16.10: "when the user arrives at the place he needs to be at, sign
 * the meeting as done, complete ✓". markArrivals (services/LiveRoute) already
 * knew she had arrived — it stamped verifiedArrival and cancelled the leave
 * alerts — and the task stayed an open circle among "11 unfinished".
 *
 * Pure: which arrivals complete a task, and the line that says so. Tests:
 * tests/run-arrival-done.ts.
 */
import { Task } from '../types/index';

/** Arriving completes a task that has a PLACE and is still open. */
export function completesOnArrival(task: Pick<Task, 'status'> & { location?: unknown }): boolean {
  const loc: any = task.location && typeof task.location === 'object' ? task.location : null;
  return task.status === 'pending' && Boolean(loc)
    && Number.isFinite(loc.lat) && Number.isFinite(loc.lng) && !(loc.lat === 0 && loc.lng === 0);
}

/** "✓ הגעת — אימון סומן כבוצע" — said once, with how to undo it. */
export function arrivalDoneLine(title: string, he: boolean): { title: string; body: string } {
  const t = String(title || '').trim();
  return he
    ? { title: '✓ הגעת', body: `${t} — סימנתי כבוצע. טעות? לחצי על ✓ בכרטיס.` }
    : { title: '✓ You made it', body: `${t} — marked done. Wrong? Tap the ✓ on its card.` };
}
