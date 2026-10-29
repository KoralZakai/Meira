/**
 * dayGoal — "what matters most today?", her answer, and whether it is done.
 *
 * Koral's pick (19.10, option B): a card at the top of Today. Until she
 * answers it offers the day's three weightiest tasks (or her own words); once
 * set it stays pinned there, and doing it is celebrated. Pure; the card and
 * DayGoalService hold the state.
 */
import { Task } from '../types/index';

export interface DayGoal {
  date: string;
  text: string;
  /** Set when she picked one of her tasks — then ITS completion is the goal's. */
  taskId?: string;
  /** Done by hand, for a goal in her own words. */
  done?: boolean;
}

const WEIGHTY = /interview|exam|test|deadline|ראיון|מבחן|בחינה|דדליין|הגשה/i;

/** Same weighting Today used for its focus task: big words, then priority, then a fixed hour. */
export function goalWeight(t: Task): number {
  return (WEIGHTY.test(t.text) ? 4 : 0)
    + (t.priority === 'must' ? 2 : t.priority === 'have_to' ? 1 : 0)
    + (t.isFixed ? 1 : 0);
}

/** Up to three of today's open tasks to offer, weightiest first. */
export function goalCandidates(tasks: Task[], date: string, max = 3): Task[] {
  return tasks
    .filter((t) => t.date === date && t.status === 'pending')
    .sort((a, b) => goalWeight(b) - goalWeight(a)
      || String(a.fixedTime || a.scheduledTime || '99').localeCompare(String(b.fixedTime || b.scheduledTime || '99')))
    .slice(0, max);
}

/** 'unset' | 'open' | 'done' — a task goal is done when its task is. */
export function goalState(goal: DayGoal | null, tasks: Task[], date: string): 'unset' | 'open' | 'done' {
  if (!goal || goal.date !== date) return 'unset';
  if (goal.taskId) {
    const t = tasks.find((x) => x.id === goal.taskId);
    if (t?.status === 'complete') return 'done';
  }
  return goal.done ? 'done' : 'open';
}
