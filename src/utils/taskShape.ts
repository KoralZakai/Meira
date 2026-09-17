/**
 * taskShape — is this an appointment, or is it work?
 *
 * The timeline treats every task the same: give it an hour, draw it as a block,
 * let it collide with its neighbours. But a day is made of two different
 * things, and conflating them is why her screen looked crowded and why
 * "Submit CV" appeared to be double-booked against a party.
 *
 *   TIME-BOUND — a commitment at an hour, usually with other people or a
 *   place. Miss it and it is gone. It belongs on the timeline, where the
 *   travel to it can be drawn and its collisions actually matter.
 *
 *   FLEXIBLE — work she has to do today, parked in a slot by Lumi rather than
 *   agreed with anyone. "Prepare the lean canvas" at 13:00 is a plan, not an
 *   appointment; doing it at 15:00 costs nothing. Blocking five hours of
 *   calendar for it and then warning that it clashes is the app arguing with
 *   its own guess.
 *
 * The distinction is rules, not a model call — every signal here is already on
 * the task, and a classification that needs the network cannot run while the
 * list is being drawn. Nothing here reads the clock or storage, so
 * tests/run-task-shape.ts drives every branch.
 */
import { Task, TaskCategory } from '../types/index';

/**
 * Categories that ARE an appointment by their nature. You do not reschedule a
 * doctor by deciding to; someone else is holding the slot.
 */
const APPOINTMENT_CATEGORIES: TaskCategory[] = [
  'interview', 'meeting', 'call', 'doctor', 'class', 'course',
  'conference', 'zoom', 'hobby_class',
];

/** Sources that mean somebody else put this in the diary. */
const EXTERNAL_SOURCES = ['calendar', 'gcal', 'email', 'gmail'];

export type TaskShape = 'time-bound' | 'flexible';

export interface ShapeVerdict {
  shape: TaskShape;
  /** Why — so the UI can explain itself and a test can assert the reason. */
  reason:
    | 'has-place'        // she has to physically be somewhere
    | 'appointment-kind' // its category is an appointment
    | 'external'         // it came from a calendar or an email
    | 'no-anchor';       // nothing holds it to this hour
}

/** The place this task requires her to be, as text. '' when it needs none. */
function placeOf(task: Task): string {
  const loc: any = task.location;
  if (!loc) return '';
  const text = typeof loc === 'string' ? loc : (loc.address || loc.displayName || '');
  return String(text).trim();
}

/**
 * Which of the two this task is, and why.
 *
 * Three tests, in order: somewhere she must BE, a kind of thing that is an
 * appointment, or a diary entry somebody else made. An hour on the task is
 * deliberately not one of them — see the note at the bottom.
 */
export function classifyShape(task: Task): ShapeVerdict {
  if (placeOf(task)) return { shape: 'time-bound', reason: 'has-place' };
  if (task.category && APPOINTMENT_CATEGORIES.includes(task.category)) {
    return { shape: 'time-bound', reason: 'appointment-kind' };
  }
  if (task.source && EXTERNAL_SOURCES.includes(task.source)) {
    return { shape: 'time-bound', reason: 'external' };
  }
  /**
   * And that is the whole list. An hour on the task is NOT an anchor.
   *
   * This used to fall through to `isFixed && fixedTime`, which sounds
   * reasonable and was wrong on her actual data: "להגיש קורות חיים" and
   * "לעשות תכנית עסקית" both carry a fixedTime, so both came back time-bound
   * and the flexible card was left holding a single finished task called
   * "nothing" — the exact two tasks the split was built for, classified into
   * the wrong half.
   *
   * The reason it is wrong: half the creation paths set isFixed, and Lumi's
   * own optimiser writes an hour into fixedTime when it parks a job in a slot.
   * So the field records "something put this here", not "this is agreed with
   * anybody". The three tests above are the ones that mean a commitment —
   * somewhere to be, a kind of thing that is an appointment, or a diary entry
   * someone else made. Everything else is work, whatever hour is written on it.
   */
  return { shape: 'flexible', reason: 'no-anchor' };
}

export const isTimeBound = (task: Task): boolean =>
  classifyShape(task).shape === 'time-bound';

export const isFlexibleTask = (task: Task): boolean =>
  classifyShape(task).shape === 'flexible';

/**
 * Split a day into the timeline and the flexible list.
 *
 * Completed work stays with its own group rather than being hidden: ticking
 * something off and watching it vanish from the list you are working through
 * removes the only evidence that you did it.
 */
export function splitDayTasks(tasks: Task[]): { timed: Task[]; flexible: Task[] } {
  const timed: Task[] = [];
  const flexible: Task[] = [];
  for (const t of tasks) {
    (isTimeBound(t) ? timed : flexible).push(t);
  }
  return { timed, flexible };
}

/**
 * Flexible tasks in the order she should look at them: unfinished first, then
 * by priority, then by whatever hour Lumi guessed — a stable order, so a list
 * she is ticking through does not rearrange itself under her thumb.
 */
const PRIORITY_RANK: Record<string, number> = {
  must: 0, have_to: 1, need_to: 2, nice_to_do: 3,
};

export function sortFlexible(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const doneA = a.status === 'complete' ? 1 : 0;
    const doneB = b.status === 'complete' ? 1 : 0;
    if (doneA !== doneB) return doneA - doneB;
    const pA = PRIORITY_RANK[a.priority ?? ''] ?? 9;
    const pB = PRIORITY_RANK[b.priority ?? ''] ?? 9;
    if (pA !== pB) return pA - pB;
    const tA = a.scheduledTime || a.fixedTime || '99:99';
    const tB = b.scheduledTime || b.fixedTime || '99:99';
    return tA.localeCompare(tB);
  });
}
