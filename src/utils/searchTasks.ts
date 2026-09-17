/**
 * Finding a task again.
 *
 * The list had four filters — Today / All / Upcoming / Done — and no way to
 * ask "where was that interview?" or "show me everything sporty". With a
 * hundred-plus tasks in the cloud that is the difference between a list and an
 * archive you cannot use.
 *
 * Two independent axes, deliberately:
 *   text  — a substring of anything written on the task
 *   topic — a GROUP of categories, because "sport" means gym and hobby_class,
 *           and nobody thinks in the app's internal category names
 *
 * Pure and synchronous so the list can filter as the user types.
 */
import { Task, TaskCategory } from '../types/index';

export interface TaskTopic {
  id: string;
  labelEn: string;
  labelHe: string;
  icon: string;
  categories: TaskCategory[];
  /** Words that mean this topic even when the category was guessed wrong. */
  keywords: string[];
}

/**
 * Topics are what a person searches by. They are unions of categories, not a
 * new taxonomy — the categories already exist and are already assigned; this
 * only groups them the way the question gets asked.
 */
export const TASK_TOPICS: TaskTopic[] = [
  {
    id: 'interviews', labelEn: 'Interviews', labelHe: 'ראיונות', icon: '🎯',
    categories: ['interview'],
    keywords: ['interview', 'ראיון', 'ראיונות', 'משרה', 'hr', 'recruit'],
  },
  {
    id: 'sport', labelEn: 'Sport', labelHe: 'ספורט', icon: '💪',
    categories: ['gym', 'hobby_class'],
    keywords: ['gym', 'כושר', 'אימון', 'יוגה', 'yoga', 'pilates', 'פילאטיס',
      'ריצה', 'run', 'שחייה', 'swim', 'קיקבוקס', 'crossfit'],
  },
  {
    id: 'social', labelEn: 'Going out', labelHe: 'יציאות', icon: '🎉',
    categories: ['leisure'],
    keywords: ['party', 'מסיבה', 'הופעה', 'concert', 'ערב', 'drinks', 'בר',
      'מסעדה', 'dinner', 'יום הולדת', 'birthday', 'אפטר'],
  },
  {
    id: 'work', labelEn: 'Work', labelHe: 'עבודה', icon: '💼',
    categories: ['work', 'meeting', 'conference', 'zoom', 'call'],
    keywords: ['meeting', 'פגישה', 'עבודה', 'work', 'כנס', 'zoom', 'זום', 'שיחה'],
  },
  {
    id: 'study', labelEn: 'Studies', labelHe: 'לימודים', icon: '📚',
    categories: ['course', 'class'],
    keywords: ['course', 'קורס', 'שיעור', 'מבחן', 'exam', 'הרצאה', 'lecture',
      'תרגיל', 'homework', 'לימודים'],
  },
  {
    id: 'health', labelEn: 'Health', labelHe: 'בריאות', icon: '⚕️',
    categories: ['doctor'],
    keywords: ['doctor', 'רופא', 'תור', 'שיניים', 'dentist', 'clinic', 'קופת חולים'],
  },
];

/** Everything written on a task that a person might search by. */
function haystack(task: Task): string {
  const loc = typeof task.location === 'string'
    ? task.location
    : (task.location as any)?.address || (task.location as any)?.displayName || '';
  return [
    task.text, loc, task.category, (task as any).contactName,
    (task as any).contactEmail, (task as any).progress, (task as any).how,
    (task as any).why, ...((task as any).tags || []),
    ...(task.subtasks || []).map((s) => s.text),
  ].filter(Boolean).join(' ').toLowerCase();
}

/** Does this task belong to the topic — by category, or by what it says? */
export function matchesTopic(task: Task, topic: TaskTopic): boolean {
  if (task.category && topic.categories.includes(task.category)) return true;
  // Categories are auto-assigned and often wrong, so a task that plainly says
  // "yoga" counts as sport even when it was filed as 'general'.
  const hay = haystack(task);
  return topic.keywords.some((k) => hay.includes(k.toLowerCase()));
}

/**
 * Filter by free text and/or a topic. Both are optional; passing neither
 * returns the list untouched, so the caller can always run it.
 */
export function searchTasks(tasks: Task[], query: string, topicId?: string | null): Task[] {
  const q = query.trim().toLowerCase();
  const topic = topicId ? TASK_TOPICS.find((t) => t.id === topicId) : undefined;
  if (!q && !topic) return tasks;
  return tasks.filter((task) => {
    if (topic && !matchesTopic(task, topic)) return false;
    if (q && !haystack(task).includes(q)) return false;
    return true;
  });
}
