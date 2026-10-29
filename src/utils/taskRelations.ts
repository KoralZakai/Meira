/**
 * taskRelations — the pure logic behind task nesting.
 *
 * Split out of services/TaskHierarchy so it can be imported without pulling in
 * AsyncStorage (and therefore all of react-native): this is the part worth
 * testing, and a Node test harness cannot load the service.
 *
 * Dependencies: utils/fuzzyMatch. Consumed by services/TaskHierarchy and by
 * MyTasks for rendering.
 */
import { Task } from '../types/index';
import { textSimilarity } from './fuzzyMatch';

/** Score above which a parent is worth offering at all. */
export const SUGGEST_THRESHOLD = 0.34;

/**
 * Above this, don't ask — just file it.
 *
 * Being asked to confirm something obvious is worse than useless: it trains
 * the user to tap "yes" without reading, and once one pair is confirmed the
 * next card looks identical, so the whole thing reads as "nothing happened".
 * Confirmation is only worth the interruption when the answer is genuinely in
 * doubt.
 *
 * 1.00 is "every meaningful word of the parent reappears in the child", so
 * 0.75 still demands most of it.
 */
export const AUTO_FILE_THRESHOLD = 0.75;

/**
 * Words too common to imply a relationship. Without this, every Hebrew task
 * "matches" every other one through its prepositions.
 */
const STOPWORDS = new Set([
  'את', 'של', 'עם', 'על', 'אל', 'מן', 'כל', 'זה', 'זו', 'הוא', 'היא', 'יש',
  'לא', 'גם', 'אני', 'ל', 'ב', 'ה', 'ו',
  'the', 'a', 'an', 'to', 'of', 'in', 'on', 'at', 'for', 'and', 'with', 'my',
]);

/** Meaningful words of a task title, normalized. */
function keywords(text: string): Set<string> {
  return new Set(
    (text || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .map((w) => w.replace(/^[ולבהכשמ]-/, ''))   // strip a leading Hebrew prefix + maqaf
      .filter((w) => w.length > 1 && !STOPWORDS.has(w)),
  );
}

/**
 * Still on her plate: not ticked off, and not archived.
 *
 * 'moved' is how the app records "this is no longer the live copy" — a
 * duplicate folded into another by StoreMigration's merge, a rollover, a
 * let-go. Anything showing the user her real workload must exclude both.
 *
 * This existed as an inline expression in four places, and the one screen
 * that wrote it as `status !== 'complete'` alone showed three archived copies
 * of the same conference as if all three were real, while the Today screen
 * showed the one survivor. Two screens disagreeing about what exists is worse
 * than either answer, so the rule gets one name.
 */
export function isLiveTask(t: Task): boolean {
  // A "Set a new time: X" note waits on the 🔔, not in the task lists (28.10).
  return t.status !== 'complete' && t.status !== 'moved' && !/^(?:לקבוע מועד חדש|Set a new time):/.test(String(t.text || '').trim());
}

/** A task that can hold children: not itself a child, not finished. */
export function canBeParent(t: Task): boolean {
  return !t.parentId && isLiveTask(t);
}

/**
 * How strongly `child` reads as work inside `parent`, 0..1.
 *
 * Rewards shared meaningful words, and rewards them more when they are most of
 * what the PARENT says — "לומי" carrying over from a two-word project title is
 * a strong signal; one shared word out of a ten-word title is not.
 */
export function relatednessScore(child: Task, parent: Task): number {
  if (!canBeParent(parent) || child.id === parent.id) return 0;

  const c = keywords(child.text);
  const p = keywords(parent.text);
  if (!c.size || !p.size) return 0;

  let shared = 0;
  for (const w of p) if (c.has(w)) shared += 1;

  // Fraction of the parent's own vocabulary that reappears in the child.
  const coverage = shared / p.size;

  // Whole-title similarity catches rewordings that share few exact tokens.
  const similarity = textSimilarity(child.text, parent.text);

  // Same subgroup is corroboration, never enough on its own.
  const sameSubgroup =
    Boolean(parent.subgroup?.trim()) && parent.subgroup === child.subgroup ? 0.15 : 0;

  return Math.min(1, coverage * 0.7 + similarity * 0.3 + sameSubgroup);
}
export interface TaskTreeNode {
  task: Task;
  children: Task[];
}

/**
 * Flat list → one level of nesting, preserving the caller's ordering.
 *
 * A child whose parent is missing from `tasks` (deleted, or filtered out by the
 * current view) is shown as top-level rather than hidden — a task that silently
 * disappears because of its parent is exactly the failure this app cannot have.
 */
export function buildTaskTree(tasks: Task[]): TaskTreeNode[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const childrenOf = new Map<string, Task[]>();
  const roots: Task[] = [];

  for (const t of tasks) {
    const parentId = t.parentId && byId.has(t.parentId) ? t.parentId : undefined;
    if (parentId) {
      if (!childrenOf.has(parentId)) childrenOf.set(parentId, []);
      childrenOf.get(parentId)!.push(t);
    } else {
      roots.push(t);
    }
  }
  return roots.map((task) => ({ task, children: childrenOf.get(task.id) ?? [] }));
}

/** "2 of 5 done" for a parent row. */
export function childProgress(children: Task[]): { done: number; total: number } {
  return {
    done: children.filter((c) => c.status === 'complete').length,
    total: children.length,
  };
}
