/**
 * likelySameTask — "interview in cpp", "interview in Kfar Vitkin", "interview
 * at uVision". One interview, three rows, three different hours and places.
 *
 * That is what a conversation produces: the same appointment mentioned again
 * as more of it becomes known, each mention landing as a new task because the
 * words changed. The existing merge (utils/taskMerge) cannot help — it needs
 * 0.82 text similarity and these share one word — and it should not: merging
 * rows that disagree about WHERE and WHEN would silently pick an hour, and the
 * wrong hour on an interview is the worst failure this app has.
 *
 * So this does not merge. It ASKS. It finds the groups that are probably one
 * thing, names exactly how they disagree, and lets her say which version is
 * right; the rest are then folded into it.
 *
 * The bar for asking is deliberately different from the bar for merging:
 *   - the same day (a weekly class is not a duplicate of itself), and
 *   - the same category, and that category has to be one that happens ONCE
 *     ("interview", "doctor" — not "work" or "general", where three rows are
 *     three real errands), and
 *   - a shared distinctive word — the thing they are both about.
 *
 * Text similarity is used only to EXCLUDE the pairs the merger already handles
 * silently, so the user is never asked about something that was going to be
 * cleaned up anyway.
 *
 * Pure. Dependencies: fuzzyMatch, types. Consumed by screens/TodaySchedule via
 * components/SameThingCard. Tested by tests/run-same-thing.ts.
 */
import { Task, TaskCategory } from '../types/index';
import { textSimilarity } from './fuzzyMatch';

/**
 * Categories where two rows on one day are almost certainly one event.
 * 'work' and 'general' are deliberately absent: three of those in a day is a
 * normal day, not a duplicate.
 */
const ONCE_A_DAY: TaskCategory[] = ['interview', 'doctor', 'conference', 'hobby_class'];

/** Above this the silent merger takes it; asking would be noise. */
const ALREADY_MERGED = 0.82;

/** Words too common to prove two tasks are about the same thing. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'at', 'in', 'on', 'for', 'with', 'to', 'of', 'my', 'and',
  'את', 'של', 'עם', 'אל', 'על', 'לי', 'זה', 'יש', 'ב', 'ל', 'מ',
  'task', 'משימה', 'today', 'היום', 'tomorrow', 'מחר',
]);

export interface SameThingGroup {
  /** Every task that looks like the same thing, richest first. */
  tasks: Task[];
  /** The word they are all about ("interview", "ראיון"). */
  subject: string;
  /** What they disagree about — this is what makes it worth asking. */
  differs: Array<'time' | 'place' | 'duration'>;
}

const norm = (text: string): string =>
  (text || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

/** Meaningful words of a task's text. */
function words(text: string): string[] {
  return norm(text).split(' ').filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/** A task's place, as text. */
function placeOf(task: Task): string {
  const loc: any = task.location;
  return norm(typeof loc === 'string' ? loc : (loc?.address || loc?.displayName || ''));
}

const timeOf = (task: Task): string => task.fixedTime || task.scheduledTime || '';

/** How much a row is worth keeping: the one that knows the most. */
function richness(task: Task): number {
  return (task.fixedTime ? 4 : 0)
    + (typeof task.location === 'object' && (task.location as any)?.transitPlan ? 3 : 0)
    + (task.location ? 2 : 0)
    + (task.text?.length ? Math.min(2, Math.floor(task.text.length / 25)) : 0);
}

/** Do these two read as the same appointment, worded differently? */
export function looksLikeSameThing(a: Task, b: Task): string | null {
  if (a.id === b.id || a.date !== b.date) return null;
  if (a.status === 'complete' || b.status === 'complete') return null;
  if (a.status === 'moved' || b.status === 'moved') return null;
  if (a.category !== b.category) return null;
  if (!ONCE_A_DAY.includes(a.category as TaskCategory)) return null;
  // Near-identical wording is merged silently — but ONLY when the two rows
  // also agree about the facts. Two that read almost the same and name
  // different hours or different places are the dangerous case: silently
  // keeping the "richer" one picks an hour on her behalf, and a wrong hour on
  // an interview is the worst thing this app can do. Those get asked about.
  const disagrees = timeOf(a) !== timeOf(b) || placeOf(a) !== placeOf(b);
  if (!disagrees && textSimilarity(a.text, b.text) >= ALREADY_MERGED) return null;

  const shared = words(a.text).filter((w) => words(b.text).includes(w));
  return shared.length ? shared[0] : null;
}

/**
 * Groups worth asking about, largest first. A group of one is not a question.
 */
export function findSameThingGroups(tasks: Task[]): SameThingGroup[] {
  const groups: SameThingGroup[] = [];
  const claimed = new Set<string>();

  for (const task of tasks) {
    if (claimed.has(task.id)) continue;
    // Grown transitively, not just against the seed. Two rows can be too
    // alike to ask about on their own ("ראיון ב C++" / "ראיון ב uVision", same
    // hour, no place) and still both belong to a group that a THIRD row —
    // naming a different hour — makes a real question. Matching only against
    // the first row made the answer depend on which one happened to be first.
    const members: Task[] = [task];
    let subject = '';
    for (let grew = true; grew;) {
      grew = false;
      for (const other of tasks) {
        if (claimed.has(other.id) || members.some((m) => m.id === other.id)) continue;
        const shared = members.map((m) => looksLikeSameThing(m, other)).find(Boolean);
        if (!shared) continue;
        subject = subject || shared;
        members.push(other);
        grew = true;
      }
    }
    if (members.length < 2) continue;
    members.forEach((m) => claimed.add(m.id));

    // Distinct VALUES, empty included: "this one has a place and that one has
    // none" is exactly the disagreement she needs to resolve, and filtering
    // the blanks out hid it.
    const differs: SameThingGroup['differs'] = [];
    const times = new Set(members.map(timeOf));
    const places = new Set(members.map(placeOf));
    const durations = new Set(members.map((m) => m.durationMinutes || 0));
    if (times.size > 1) differs.push('time');
    if (places.size > 1) differs.push('place');
    if (durations.size > 1) differs.push('duration');

    groups.push({
      tasks: [...members].sort((a, b) => richness(b) - richness(a)),
      subject,
      differs,
    });
  }

  return groups.sort((a, b) => b.tasks.length - a.tasks.length);
}

/**
 * What the survivor should look like once she picks one.
 *
 * The chosen row decides the disputed facts — that is the whole point of
 * asking — but anything it simply does not KNOW is taken from the others:
 * a place from the row that had one, a longer text that says more. Nothing is
 * overwritten, only filled in.
 */
export function mergedInto(chosen: Task, others: Task[]): Partial<Task> {
  const patch: Partial<Task> = {};
  if (!chosen.fixedTime) {
    const time = others.find((t) => t.fixedTime)?.fixedTime;
    if (time) { patch.fixedTime = time; patch.isFixed = true; }
  }
  if (!chosen.location) {
    const loc = others.find((t) => t.location)?.location;
    if (loc) { patch.location = loc as any; patch.hasLocation = true; }
  }
  // Keep what the others KNEW, not their whole sentence. "ראיון עבודה ב C++"
  // and "ראיון עבודה בכפר ויתקין" each add one fact; pasting both in full
  // would repeat "ראיון עבודה" twice and read like a bug. Only the words the
  // chosen row does not already have are appended.
  const own = new Set(words(chosen.text));
  const extra = others
    .flatMap((t) => words(t.text))
    .filter((w, i, all) => !own.has(w) && all.indexOf(w) === i);
  if (extra.length) {
    patch.text = `${chosen.text} · ${extra.join(' ')}`.slice(0, 140);
  }
  return patch;
}

// Self-check: npx tsx src/utils/likelySameTask.ts
if (typeof require !== 'undefined' && require.main === module) {
  const mk = (over: Partial<Task>): Task => ({
    id: Math.random().toString(36).slice(2), text: '', category: 'interview',
    priority: 'must', isFixed: true, durationMinutes: 60, date: '2026-09-01',
    status: 'pending', createdAt: 0, historicalDurations: [], ...over,
  } as Task);

  const groups = findSameThingGroups([
    mk({ text: 'ראיון עבודה ב C++', fixedTime: '13:00' }),
    mk({ text: 'ראיון עבודה בכפר ויתקין', fixedTime: '12:30', location: 'Kfar Vitkin' as any }),
    mk({ text: 'ראיון עבודה ב uVision', fixedTime: '13:00' }),
    mk({ text: 'אימון בחדר כושר', category: 'gym' as any, fixedTime: '18:00' }),
  ]);
  console.assert(groups.length === 1, `one question, got ${groups.length}`);
  console.assert(groups[0].tasks.length === 3, `all three interviews, got ${groups[0].tasks.length}`);
  console.assert(groups[0].differs.includes('time'), 'they disagree about the hour');
  console.assert(groups[0].differs.includes('place'), 'and about the place');
  console.log('likelySameTask self-check OK:', groups[0].subject, groups[0].differs);
}
