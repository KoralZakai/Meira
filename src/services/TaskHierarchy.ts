/**
 * TaskHierarchy — deciding which task belongs under which.
 *
 * "לשפר את לומי" is a project; "לשפר את ה-UX UI של לומי" and "לתקן את הבאג
 * בנוטיפיקציות" are work inside it. Today they land as three unrelated rows and
 * the project reads as noise.
 *
 * Two mechanisms, because one is not enough:
 *
 *  1. **Wording.** "לשפר את ה-UX של לומי" shares its meaningful words with
 *     "לשפר את לומי", so a lexical score finds it. Cheap, offline, works in
 *     Hebrew, and never surprises anyone.
 *  2. **What you were just doing.** "לתקן את הבאג בנוטיפיקציות" shares NO words
 *     with "לשפר את לומי" — no amount of string matching will relate them. What
 *     relates them is that you were filing work under that project a minute
 *     ago. So a recent parent stays "active" for a while and is offered.
 *
 * Everything here only ever *suggests*. Filing a task under the wrong project
 * silently is worse than not filing it: the task becomes hard to find and the
 * user stops trusting the list. One tap accepts.
 *
 * One level deep, always. A parent never has a parent — a list you cannot scan
 * in one pass is the opposite of what this app is for.
 *
 * Dependencies: TaskStorage (read/write), utils/fuzzyMatch (textSimilarity).
 * Consumed by MyTasks, AddTask flows.
 */
import AsyncStorage from './EncryptedStorage';  // AES-256-GCM at rest (7.10)
import { Task } from '../types/index';
import { getAllTasks, updateTaskFields } from './TaskStorage';
import {
  canBeParent, relatednessScore, SUGGEST_THRESHOLD, AUTO_FILE_THRESHOLD,
} from '../utils/taskRelations';

/** The parent most recently filed into, and when. */
const ACTIVE_PARENT_KEY = 'lumi.activeParent.v1';

/** How long a just-used parent keeps being offered. Mirrors the server's
 *  session TTL (server/session.py), which solves the same problem for chat. */
const ACTIVE_PARENT_TTL_MS = 45 * 60 * 1000;

// Pure helpers live in utils/taskRelations — importable without react-native.
export {
  canBeParent, relatednessScore, buildTaskTree, childProgress,
  SUGGEST_THRESHOLD, AUTO_FILE_THRESHOLD,
} from '../utils/taskRelations';
export type { TaskTreeNode } from '../utils/taskRelations';

/** Remember that the user just filed something under this parent. */
export async function setActiveParent(parentId: string | null): Promise<void> {
  if (!parentId) {
    await AsyncStorage.removeItem(ACTIVE_PARENT_KEY).catch(() => {});
    return;
  }
  await AsyncStorage.setItem(
    ACTIVE_PARENT_KEY, JSON.stringify({ id: parentId, at: Date.now() }),
  ).catch(() => {});
}

/** The parent recently filed into, if it hasn't gone stale. */
export async function getActiveParent(): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem(ACTIVE_PARENT_KEY);
    if (!raw) return null;
    const { id, at } = JSON.parse(raw);
    if (!id || Date.now() - at > ACTIVE_PARENT_TTL_MS) return null;
    return id as string;
  } catch {
    return null;
  }
}

export interface ParentSuggestion {
  parent: Task;
  score: number;
  /** Why it is being offered — shown to the user, never guessed at. */
  reason: 'wording' | 'recent';
}

/**
 * The best parent for `child`, or null.
 *
 * Wording wins when it is confident. Otherwise the recently-used parent is
 * offered, which is the only thing that can relate "fix the notifications bug"
 * to "improve Lumi" — they share no words at all.
 */
export async function suggestParent(
  child: Task,
  all?: Task[],
): Promise<ParentSuggestion | null> {
  const tasks = all ?? await getAllTasks();
  const candidates = tasks.filter((t) => canBeParent(t) && t.id !== child.id);

  let best: ParentSuggestion | null = null;
  for (const parent of candidates) {
    const score = relatednessScore(child, parent);
    if (score >= SUGGEST_THRESHOLD && (!best || score > best.score)) {
      best = { parent, score, reason: 'wording' };
    }
  }
  if (best) return best;

  const activeId = await getActiveParent();
  if (activeId && activeId !== child.id) {
    const parent = candidates.find((t) => t.id === activeId);
    if (parent) return { parent, score: 0, reason: 'recent' };
  }
  return null;
}

/** Children the user has already declined to file. Never ask twice. */
const DECLINED_KEY = 'lumi.parentDeclined.v1';

async function declinedIds(): Promise<string[]> {
  try {
    return JSON.parse((await AsyncStorage.getItem(DECLINED_KEY)) || '[]');
  } catch {
    return [];
  }
}

/** Remember that this task should stop being offered a parent. */
export async function declineParent(childId: string): Promise<void> {
  const ids = await declinedIds();
  if (ids.includes(childId)) return;
  await AsyncStorage.setItem(DECLINED_KEY, JSON.stringify([...ids, childId].slice(-200)))
    .catch(() => {});
}

/**
 * The one nesting offer worth showing right now, or null.
 *
 * Only un-parented, unfinished tasks are considered, newest first — the task
 * just added is the one the user has in mind. Anything already declined is
 * skipped: being asked twice about the same task is how a helpful prompt turns
 * into nagging.
 */
export async function nextParentSuggestion(
  tasks: Task[],
): Promise<{ child: Task; suggestion: ParentSuggestion } | null> {
  const declined = new Set(await declinedIds());
  const candidates = tasks
    .filter((t) => !t.parentId && t.status === 'pending' && !declined.has(t.id))
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    .slice(0, 12);

  for (const child of candidates) {
    const suggestion = await suggestParent(child, tasks);
    // Only the genuinely uncertain band reaches a question. Anything the
    // scorer is confident about was already filed by autoFileConfident, and
    // asking about it would just be a quiz with an obvious answer.
    if (suggestion && suggestion.score < AUTO_FILE_THRESHOLD) {
      return { child, suggestion };
    }
  }
  return null;
}

export interface AutoFiled {
  child: Task;
  parent: Task;
}

/**
 * File everything the scorer is sure about, without asking.
 *
 * Returns what it did so the caller can say so and offer an undo — filing
 * silently and filing without recourse are different things, and only the
 * second one is a problem.
 */
export async function autoFileConfident(tasks: Task[]): Promise<AutoFiled[]> {
  const declined = new Set(await declinedIds());
  const filed: AutoFiled[] = [];

  for (const child of tasks) {
    if (child.parentId || child.status !== 'pending' || declined.has(child.id)) continue;

    let best: { parent: Task; score: number } | null = null;
    for (const parent of tasks) {
      if (!canBeParent(parent) || parent.id === child.id) continue;
      const score = relatednessScore(child, parent);
      if (score >= AUTO_FILE_THRESHOLD && (!best || score > best.score)) {
        best = { parent, score };
      }
    }
    if (best) {
      await updateTaskFields(child.id, { parentId: best.parent.id }).catch(() => {});
      filed.push({ child, parent: best.parent });
    }
  }
  return filed;
}

/** File `childId` under `parentId` (or detach it when parentId is null). */
export async function setParent(childId: string, parentId: string | null): Promise<void> {
  await updateTaskFields(childId, { parentId: parentId ?? undefined });
  await setActiveParent(parentId);
  // Belt and braces: an answered question must never come back, even if the
  // parentId itself fails to survive a round trip through storage.
  if (parentId) await declineParent(childId);
}

