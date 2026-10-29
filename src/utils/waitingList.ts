/**
 * waitingList — what the 🔔 on Today counts and lists (canvas v4, 27.10).
 *
 * Koral: "notifications — what was not finished, conflicts, what is missing".
 * Three kinds, in the order she has to act on them: a clash in the day (it
 * needs a decision), something from an earlier day that was never closed
 * ("did you go?"), and a task today that needs a place before Meira can say
 * when to leave. The bell says the count; the sheet lists them; each row
 * opens the fix. Pure: the screen passes what it already computed.
 */
import type { Task } from '../types/index';
import type { DayProblem } from './dayProblems';
import { followUpOriginal } from './liveRoutePlan';

export type WaitingKind = 'change' | 'followup' | 'unscheduled' | 'clash' | 'unclosed' | 'place';

export interface WaitingItem {
  kind: WaitingKind;
  key: string;
  title: string;
  /** HH:MM or a date — what to show beside it. */
  when?: string;
  taskId?: string;
  problemKey?: string;
}

const at = (t: Task) => t.fixedTime || t.scheduledTime || '';

export function waitingList(input: {
  problems: DayProblem[];
  overdue: Task[];
  today: Task[];
  /** True when this task needs a place to be planned (not online, not flexible, no place yet). */
  needsPlace: (t: Task) => boolean;
  /** What the calendar moved or cancelled (ChangeRecordStore) — on the bell, not on the day (28.10). */
  changes?: Array<{ key: string; title: string; when?: string; taskId?: string }>;
  /** Open "set a new time" follow-ups, from any day — she said "later" (28.10). */
  followUps?: Task[];
  /** Today's open tasks with no hour (28.10: "homework — when will you do it? find you a free slot?"). */
  unscheduled?: Task[];
}): WaitingItem[] {
  const out: WaitingItem[] = [];
  for (const c of input.changes ?? []) {
    out.push({ kind: 'change', key: `change:${c.key}`, title: c.title, when: c.when, taskId: c.taskId });
  }
  const followIds = new Set<string>();
  for (const t of input.followUps ?? []) {
    if (t.status === 'complete' || !followUpOriginal(t.text)) continue;
    followIds.add(t.id);
    out.push({ kind: 'followup', key: `followup:${t.id}`, title: followUpOriginal(t.text)!, when: t.date, taskId: t.id });
  }
  for (const t of input.unscheduled ?? []) {
    if (t.status !== 'pending' || t.fixedTime || t.scheduledTime || followUpOriginal(t.text) || followIds.has(t.id)) continue;
    out.push({ kind: 'unscheduled', key: `unscheduled:${t.id}`, title: t.text, taskId: t.id });
  }
  for (const p of input.problems) {
    const [a, b] = p.kind === 'travel' ? [p.from, p.to] : p.kind === 'overlap' ? [p.fixed, p.work] : [p.a, p.b];
    out.push({ kind: 'clash', key: `clash:${p.key}`, title: `${a.text} × ${b.text}`, when: at(a), taskId: a.id, problemKey: p.key });
  }
  for (const t of input.overdue) {
    if (followIds.has(t.id) || followUpOriginal(t.text)) continue;   // said once, as a follow-up
    out.push({ kind: 'unclosed', key: `unclosed:${t.id}`, title: t.text, when: t.date, taskId: t.id });
  }
  for (const t of input.today) {
    if (t.status === 'complete' || !input.needsPlace(t) || followUpOriginal(t.text)) continue;
    out.push({ kind: 'place', key: `place:${t.id}`, title: t.text, when: at(t), taskId: t.id });
  }
  return out;
}
