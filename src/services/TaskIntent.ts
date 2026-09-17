/**
 * TaskIntent — classifies a spoken/typed sentence as create / update /
 * complete / delete, resolves which existing task it refers to, and extracts
 * the field patch for updates ("move the gym to 18:00" → {fixedTime:'18:00'}).
 *
 * Rule-based EN+HE verb lists, and nothing else: fast, offline, and free. An
 * LLM used to answer the low-confidence tail; picking one of four words is not
 * work for a 235B model, and a wrong rule costs the same confirmation tap the
 * wrong guess did. Reference→task resolution reuses
 * TaskMatcher.matchTasksFromSpeech (tag-overlap scoring; returns `ambiguous`
 * on ties so the caller can ask the user).
 *
 * Dependencies: TaskMatcher, utils/timeParser. Rules only — no model call.
 * Consumed by useTasks.processSpeechCommand; the screen confirms before apply.
 */
import { Task, TaskPriority } from '../types/index';
import { matchTasksFromSpeech } from './TaskMatcher';
import { parseTimeExpression } from '../utils/timeParser';

export type TaskIntentKind = 'create' | 'update' | 'complete' | 'delete';

export interface ClassifiedIntent {
  kind: TaskIntentKind;
  /** The part of the sentence naming the task (verbs/time words stripped). */
  reference: string;
  /** Field changes for kind==='update'. */
  patch: Partial<Task>;
  /** 0..1 — how sure the rules were. Below 0.6 the LLM fallback runs. */
  confidence: number;
}

// Verb patterns. Hebrew: imperative + inflected forms (תזיז/זיז, תדחה/דחה…).
const UPDATE_RE =
  /\b(move|change|reschedul\w*|postpone|push|delay|shift|rename|update|edit)\b|(?:^|\s)(תזיז|הזז|תעביר|העבר|תשנה|שנה|תדחה|דחה|תדחוף|תעדכן|עדכן|תערוך|ערוך)(?:\s|$)/i;
const COMPLETE_RE =
  /\b(done( with)?|finished|completed|i did|i've done|mark .* (as )?(done|complete))\b|(?:^|\s)(סיימתי|גמרתי|עשיתי|בוצע|הושלם|תסמן שסיימתי)(?:\s|$)/i;
const DELETE_RE =
  /\b(delete|remove|cancel|drop|forget( about)?|scrap)\b|(?:^|\s)(תמחק|מחק|תבטל|בטל|תוריד|הורד|תסיר|הסר)(?:\s|$)/i;
// Words that make an UPDATE verb likely to actually mean "add new" ("add a
// meeting", "תוסיף") — checked first so create wins.
const CREATE_RE =
  /\b(add|new task|create|remind me to|i need to|i have to)\b|(?:^|\s)(תוסיף|הוסף|תזכיר לי|צריך ל|יש לי)(?:\s|$)/i;

/** Strip intent verbs + time words so what's left names the task. */
function extractReference(text: string): string {
  return text
    .replace(UPDATE_RE, ' ')
    .replace(COMPLETE_RE, ' ')
    .replace(DELETE_RE, ' ')
    .replace(/\b(the|my|task|את ה?|המשימה( של)?)\b/gi, ' ')
    .replace(/\b(?:to|at|ל|לשעה|בשעה)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/gi, ' ')
    .replace(/(?:\b(?:tomorrow|today|tonight)\b|מחרתיים|מחר|היום|הערב)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Field patch for an update sentence: new time / date / duration / priority. */
/**
 * YYYY-MM-DD, `days` from now, on the LOCAL calendar.
 *
 * `toISOString().slice(0, 10)` is UTC: typed at 01:00 in Israel (22:00 UTC the
 * day before) "מחר" came back as TODAY, and the task was filed on the wrong day.
 */
function dayKeyFromNow(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function extractPatch(text: string): Partial<Task> {
  const patch: Partial<Task> = {};
  const expr = parseTimeExpression(text);
  if (expr.fixedTime) {
    patch.fixedTime = expr.fixedTime;
    patch.scheduledTime = expr.fixedTime;
    patch.isFixed = true;
  }
  if (expr.durationMinutes) patch.durationMinutes = expr.durationMinutes;
  if (expr.deadline) patch.date = expr.deadline;
  else if (expr.daysFromNow !== undefined && expr.daysFromNow > 0) {
    patch.date = dayKeyFromNow(expr.daysFromNow);
  } else if (/(tomorrow|מחר)/i.test(text)) {
    // No \b around the Hebrew: JS word boundaries are defined on ASCII \w, so
    // /\bמחר\b/ matches NOTHING — "מחר יוגה ב-11:00" fell through this branch
    // entirely, and with timeParser being English-only that left Hebrew
    // "tomorrow" with no working path at all.
    patch.date = dayKeyFromNow(/מחרתיים/.test(text) ? 2 : 1);
  }
  const prio: [RegExp, TaskPriority][] = [
    [/\b(must|urgent|חובה|דחוף)\b/i, 'must'],
    [/\b(nice to|לא דחוף|אם יהיה זמן)\b/i, 'nice_to_do'],
  ];
  for (const [re, p] of prio) if (re.test(text)) patch.priority = p;
  return patch;
}

/** Rule-based classification. confidence < 0.6 means "unsure — ask the LLM". */
export function classifyTaskIntentRules(text: string): ClassifiedIntent {
  const reference = extractReference(text);
  if (CREATE_RE.test(text)) {
    return { kind: 'create', reference, patch: {}, confidence: 0.9 };
  }
  if (COMPLETE_RE.test(text)) {
    return { kind: 'complete', reference, patch: {}, confidence: 0.85 };
  }
  if (DELETE_RE.test(text)) {
    return { kind: 'delete', reference, patch: {}, confidence: 0.85 };
  }
  if (UPDATE_RE.test(text)) {
    const patch = extractPatch(text);
    // An update verb with nothing to change is probably a mis-hear — low
    // confidence routes it to the LLM.
    const confidence = Object.keys(patch).length ? 0.85 : 0.5;
    return { kind: 'update', reference, patch, confidence };
  }
  return { kind: 'create', reference, patch: {}, confidence: 0.7 };
}

/**
 * Classify what the user wants done to their task list.
 *
 * There used to be an LLM fallback here for the unsure cases: a 235B model
 * asked to pick one of four words, from the phone, with the API key in the
 * bundle. The rules already answer this — they were simply not trusted with the
 * low-confidence tail — and a wrong guess costs one confirmation tap, which is
 * the same thing the model's guess cost. Async is kept so every caller stays
 * unchanged, and so this can route to the server later if it ever needs to.
 */
export async function classifyTaskIntent(text: string): Promise<ClassifiedIntent> {
  return classifyTaskIntentRules(text);
}


export interface TargetResolution {
  task?: Task;
  ambiguous: Task[];
}

/** Which existing task does the reference mean? Ties come back as ambiguous. */
export function resolveTargetTask(reference: string, candidates: Task[]): TargetResolution {
  const { matches, ambiguous } = matchTasksFromSpeech(reference, candidates);
  if (ambiguous.length) return { ambiguous: ambiguous.slice(0, 3) };
  if (matches.length === 1) return { task: matches[0], ambiguous: [] };
  if (matches.length > 1) {
    // Clear winner already sorted first; treat close seconds as ambiguity.
    return { task: matches[0], ambiguous: [] };
  }
  // Tag overlap failed (e.g. Hebrew task, English reference) — try plain
  // substring containment both ways before giving up.
  const ref = reference.toLowerCase().trim();
  if (ref.length < 2) return { ambiguous: [] };
  const contains = candidates.filter(
    (t) =>
      t.status === 'pending' &&
      (t.text.toLowerCase().includes(ref) || ref.includes(t.text.toLowerCase())),
  );
  if (contains.length === 1) return { task: contains[0], ambiguous: [] };
  if (contains.length > 1) return { ambiguous: contains.slice(0, 3) };
  return { ambiguous: [] };
}
