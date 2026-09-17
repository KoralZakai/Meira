/**
 * TaskMatcher — fuzzy-matches spoken text ("done with the gym") to an
 * existing task so users can complete/update tasks by voice.
 *
 * Dependencies: TaskParser.extractTaskTags, types/models. Pure — returns a
 * scored TaskMatchResult; caller decides the action.
 */
import { Task } from '../types/models';
import { extractTaskTags } from './TaskParser';

/** Best-matching task plus score/confidence for a spoken reference. */
export interface TaskMatchResult {
  matches: Task[];
  ambiguous: Task[];
}

function overlapScore(a: string[] | undefined, b: string[] | undefined): number {
  // Tasks from WhatsApp sync / older storage may have no tags — treat as no overlap.
  if (!a?.length || !b?.length) {
    return 0;
  }

  let score = 0;
  for (const left of a) {
    for (const right of b) {
      if (left === right || left.includes(right) || right.includes(left)) {
        score += 1;
        break;
      }
    }
  }

  return score;
}

/** Fuzzy-match spoken text to one of the candidate tasks (complete-by-voice). */
export function matchTasksFromSpeech(speech: string, candidates: Task[]): TaskMatchResult {
  const keywords = extractTaskTags(speech);
  const scored = candidates
    .filter((task) => task.status === 'pending')
    .map((task) => ({
      task,
      score: overlapScore(keywords, task.tags),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) {
    return { matches: [], ambiguous: [] };
  }

  const top = scored[0].score;
  const tiedTop = scored.filter((entry) => entry.score === top).map((entry) => entry.task);

  if (tiedTop.length > 1) {
    return {
      matches: [],
      ambiguous: tiedTop,
    };
  }

  const threshold = Math.max(1, Math.ceil(keywords.length * 0.34));
  const matches = scored
    .filter((entry) => entry.score >= threshold)
    .map((entry) => entry.task)
    .slice(0, 5);

  return {
    matches,
    ambiguous: [],
  };
}
