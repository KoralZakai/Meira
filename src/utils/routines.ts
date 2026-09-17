/**
 * routines — the standing shape of a week: what she always does, and what she
 * is never free for.
 *
 * Onboarding has been collecting this since the beginning. The prompt asks for
 * "constraints / habits: anything true about their days that a calendar will
 * never show — a school pickup, a standing class, an hour that is never free"
 * and stores the answer verbatim in profile.routinesNotes. Exactly one line of
 * code has ever read it: a regex looking for the word "gym". Everything else
 * she told Lumi about her week was write-only.
 *
 * So a free-time suggestion could offer her a two-hour window at 16:00 on a
 * Monday — the school run — and never once suggest the gym she goes to every
 * Monday evening. Both failures come from the same missing layer, and both are
 * fixed here:
 *
 *   habit      — something she does on this weekday, at roughly this hour.
 *                Sourced from her own notes AND from her task history, which
 *                is the more honest of the two (what she did beats what she
 *                said she does).
 *   constraint — an hour that is not hers. It is REMOVED from the free
 *                windows rather than suggested around, because a window she
 *                cannot use is not a window; and the hour before a pickup is
 *                no time to start anything social.
 *
 * Everything here is pure and synchronous: parsing text, grouping history,
 * and interval arithmetic. GapFillService.loadRoutines does the storage.
 *
 * Dependencies: findGaps (DayGap), timeUtils, types.
 * Consumed by services/GapFillService, screens/TodaySchedule.
 * Tested by tests/run-gap-slots.ts.
 */
import { Task, TaskCategory } from '../types/index';
import { DayGap } from './findGaps';
import { addMinutes, timeToMinutes, minutesToTime } from './timeUtils';

export type RoutineKind = 'habit' | 'constraint';

export interface Routine {
  id: string;
  kind: RoutineKind;
  /** In her words (notes) or the task text (history). */
  text: string;
  /** 0=Sun … 6=Sat. Empty means every day. */
  weekdays: number[];
  /** HH:MM when it usually happens, when that is known. */
  time?: string;
  durationMinutes: number;
  category?: TaskCategory;
  source: 'notes' | 'history' | 'repeat';
  /** How many times it has actually happened (history only). */
  occurrences?: number;
}

/** Words that make a line an obligation rather than a habit. */
const CONSTRAINT_RE = new RegExp(
  [
    'kids?', 'children', 'school ?run', 'pick ?up', 'drop ?off', 'daycare', 'nursery',
    "can'?t", 'cannot', 'never free', 'not available', 'no ?meetings', 'busy',
    'ילדים', 'ילד', 'הילדים', 'לאסוף', 'להסיע', 'גן', 'בית ספר', 'צהרון',
    'לא יכול', 'לא פנוי', 'לא זמין', 'אסור', 'חייב', 'צריכה לקחת', 'צריך לקחת',
  ].join('|'),
  'i',
);

/** Categories that are wrong to propose in the shadow of an obligation. */
const SOCIAL_CATEGORIES: TaskCategory[] = ['leisure', 'hobby_class', 'aspiration'];
/** How long before an obligation a social suggestion stops making sense. */
const SOCIAL_SHADOW_MINUTES = 90;
/** A constraint with no stated length still owns this much of the day. */
const DEFAULT_CONSTRAINT_MINUTES = 60;
const DEFAULT_HABIT_MINUTES = 60;

const WEEKDAYS_EN = [
  ['sunday', 'sun'], ['monday', 'mon'], ['tuesday', 'tue', 'tues'], ['wednesday', 'wed'],
  ['thursday', 'thu', 'thur', 'thurs'], ['friday', 'fri'], ['saturday', 'sat'],
];
const WEEKDAYS_HE = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

const EVERY_DAY_RE = /every ?day|daily|each day|כל יום|כל יומ|יומיומי/i;

/** Weekday number of a YYYY-MM-DD on the local calendar. */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}

/** Which days a fragment names. Empty array = it named none. */
function weekdaysIn(text: string): number[] {
  if (EVERY_DAY_RE.test(text)) return [0, 1, 2, 3, 4, 5, 6];

  const found = new Set<number>();

  // Ranges first: "Mon-Fri", "ראשון עד חמישי", "א-ה".
  const enRange = text.match(/\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\s*(?:-|–|to|until)\s*(sun|mon|tue|wed|thu|fri|sat)[a-z]*/i);
  const heRange = text.match(/(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)\s*(?:-|–|עד)\s*(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)/);
  const shortHeRange = text.match(/(?:^|[^א-ת])([אבגדהו])['׳]?\s*(?:-|–|עד)\s*([אבגדהו])['׳]?(?:[^א-ת]|$)/);
  const HE_LETTERS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו'];

  const range = (from: number, to: number) => {
    for (let i = 0; i < 7; i += 1) {
      const day = (from + i) % 7;
      found.add(day);
      if (day === to) break;
    }
  };
  if (enRange) {
    range(
      WEEKDAYS_EN.findIndex((names) => names.some((n) => enRange[1].toLowerCase().startsWith(n))),
      WEEKDAYS_EN.findIndex((names) => names.some((n) => enRange[2].toLowerCase().startsWith(n))),
    );
  } else if (heRange) {
    range(WEEKDAYS_HE.indexOf(heRange[1]), WEEKDAYS_HE.indexOf(heRange[2]));
  } else if (shortHeRange) {
    range(HE_LETTERS.indexOf(shortHeRange[1]), HE_LETTERS.indexOf(shortHeRange[2]));
  }

  // …then individual days, so "gym Mon/Wed" keeps both.
  WEEKDAYS_EN.forEach((names, index) => {
    if (names.some((n) => new RegExp(`\\b${n}\\b`, 'i').test(text))) found.add(index);
  });
  WEEKDAYS_HE.forEach((name, index) => {
    // No \b — it is ASCII-only and never matches Hebrew (see scheduleQuestion).
    if (new RegExp(`(?:^|[^א-ת])${name}(?:[^א-ת]|$)`).test(text)) found.add(index);
  });

  return [...found].sort();
}

/** A clock time and, if it is written as a range, how long it lasts. */
function timeIn(text: string): { time?: string; minutes?: number } {
  const range = text.match(/(\d{1,2}):(\d{2})\s*(?:-|–|to|until|עד)\s*(\d{1,2}):(\d{2})/);
  if (range) {
    const start = `${range[1].padStart(2, '0')}:${range[2]}`;
    const end = `${range[3].padStart(2, '0')}:${range[4]}`;
    return { time: start, minutes: Math.max(15, timeToMinutes(end) - timeToMinutes(start)) };
  }
  const exact = text.match(/(?:\b(?:at|from)\s+|בשעה\s*|ב-?\s*(?=\d))?(\d{1,2}):(\d{2})/);
  if (exact) return { time: `${exact[1].padStart(2, '0')}:${exact[2]}` };
  const loose = text.match(/\b(?:at|בשעה|ב-)\s*(\d{1,2})\s*(am|pm)?/i);
  if (loose) {
    let hour = parseInt(loose[1], 10);
    if (loose[2]?.toLowerCase() === 'pm' && hour < 12) hour += 12;
    if (hour <= 23) return { time: `${String(hour).padStart(2, '0')}:00` };
  }
  return {};
}

/** A rough category for a routine, so a habit can become a real task. */
function categoryFor(text: string): TaskCategory {
  if (/gym|workout|training|run|yoga|pilates|אימון|כושר|יוגה|ריצה/i.test(text)) return 'gym';
  if (/class|course|lesson|study|שיעור|קורס|ללמוד|חוג/i.test(text)) return 'hobby_class';
  if (/work|office|shift|עבודה|משמרת/i.test(text)) return 'work';
  if (/kids?|school|pick ?up|ילדים|גן|בית ספר|לאסוף|להסיע/i.test(text)) return 'general';
  return 'general';
}

/**
 * Read profile.routinesNotes (and hobbies) into structured routines.
 *
 * Split on the punctuation people actually use for lists — commas, semicolons,
 * newlines — so "gym Mon/Wed 18:00, kids 16:00 every day" is two routines and
 * not one confused one.
 */
export function parseRoutineNotes(notes?: string, hobbies?: string): Routine[] {
  const out: Routine[] = [];
  const push = (fragment: string, index: number) => {
    const text = fragment.trim();
    if (text.length < 3) return;
    const weekdays = weekdaysIn(text);
    const { time, minutes } = timeIn(text);
    const isConstraint = CONSTRAINT_RE.test(text);
    // A fragment that names neither a day nor an hour is context, not a
    // routine — "I hate mornings" cannot be placed on a timeline.
    if (!weekdays.length && !time && !isConstraint) return;
    out.push({
      id: `notes-${index}-${text.slice(0, 12)}`,
      kind: isConstraint ? 'constraint' : 'habit',
      text,
      weekdays,
      time,
      durationMinutes: minutes ?? (isConstraint ? DEFAULT_CONSTRAINT_MINUTES : DEFAULT_HABIT_MINUTES),
      category: categoryFor(text),
      source: 'notes',
    });
  };

  (notes || '').split(/[,;\n•]/).forEach(push);
  // Hobbies are habits with no day of their own — kept only when she wrote a
  // day or an hour next to one ("climbing Tuesdays").
  (hobbies || '').split(/[,;\n•]/).forEach((f, i) => push(f, 1000 + i));
  return out;
}

/** Normalised task text, for grouping the same thing across weeks. */
const normalize = (text: string) =>
  text.trim().toLowerCase().replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '').replace(/\s+/g, ' ');

/** The median of a list of numbers (even counts round down). */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

/**
 * Habits inferred from what she has ACTUALLY done, which beats what she once
 * told onboarding she does.
 *
 * A habit is the same task text on the same weekday at least `minWeeks` times.
 * Explicit repeatDays are taken at face value — she set those by hand.
 */
export function habitsFromHistory(tasks: Task[], minWeeks = 2): Routine[] {
  const groups = new Map<string, Task[]>();
  for (const task of tasks) {
    if (!task.text?.trim()) continue;
    const key = normalize(task.text);
    groups.set(key, [...(groups.get(key) ?? []), task]);
  }

  const out: Routine[] = [];
  for (const [key, group] of groups) {
    const sample = group[0];
    const explicit = group.find((t) => (t.repeatDays?.length ?? 0) > 0);
    const times = group
      .map((t) => t.fixedTime || t.scheduledTime)
      .filter((t): t is string => Boolean(t))
      .map(timeToMinutes);

    if (explicit) {
      out.push({
        id: `repeat-${key}`,
        kind: 'habit',
        text: sample.text,
        weekdays: explicit.repeatDays!,
        time: times.length ? minutesToTime(median(times)) : undefined,
        durationMinutes: sample.durationMinutes || DEFAULT_HABIT_MINUTES,
        category: sample.category,
        source: 'repeat',
        occurrences: group.length,
      });
      continue;
    }

    // Same weekday, different weeks — one task on two dates that happen to be
    // the same day of the week is a pattern; the same date twice is a
    // duplicate, so count DISTINCT dates.
    const byWeekday = new Map<number, Set<string>>();
    for (const task of group) {
      if (!task.date) continue;
      const day = weekdayOf(task.date);
      byWeekday.set(day, (byWeekday.get(day) ?? new Set()).add(task.date));
    }
    for (const [day, dates] of byWeekday) {
      if (dates.size < minWeeks) continue;
      const dayTimes = group
        .filter((t) => t.date && weekdayOf(t.date) === day)
        .map((t) => t.fixedTime || t.scheduledTime)
        .filter((t): t is string => Boolean(t))
        .map(timeToMinutes);
      out.push({
        id: `hist-${key}-${day}`,
        kind: 'habit',
        text: sample.text,
        weekdays: [day],
        time: dayTimes.length ? minutesToTime(median(dayTimes)) : undefined,
        durationMinutes: median(group.map((t) => t.durationMinutes || DEFAULT_HABIT_MINUTES)),
        category: sample.category,
        source: 'history',
        occurrences: dates.size,
      });
    }
  }
  return out.sort((a, b) => (b.occurrences ?? 0) - (a.occurrences ?? 0));
}

const WEEKDAY_LABEL_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAY_LABEL_HE = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

/** "Monday" / "שני" — for saying WHY a habit is being offered. */
export function weekdayLabel(day: number, language: 'en' | 'he' = 'en'): string {
  return language === 'he' ? WEEKDAY_LABEL_HE[day] : WEEKDAY_LABEL_EN[day];
}

/** The routines that apply to one date. */
export function routinesForDate(routines: Routine[], date: string): Routine[] {
  const day = weekdayOf(date);
  return routines.filter((r) => r.weekdays.length === 0 || r.weekdays.includes(day));
}

/** Is this routine already on the day's list (so it must not be suggested again)? */
export function alreadyPlanned(routine: Routine, tasks: Task[]): boolean {
  const key = normalize(routine.text);
  return tasks.some((t) => {
    const other = normalize(t.text);
    return other === key || other.includes(key) || key.includes(other);
  });
}

/**
 * Remove the hours she does not actually have from the free windows.
 *
 * A constraint with a time takes its block out of every window it touches —
 * which can split one window into two, and can delete a window entirely. The
 * result is what "free" honestly means for her week, and it is what the
 * timeline draws.
 *
 * Constraints with no stated hour (e.g. "I can't do mornings") are left to
 * blockedForGap, which filters what may be SUGGESTED rather than pretending to
 * know which minutes are gone.
 */
export function constrainGaps(gaps: DayGap[], routines: Routine[], date: string): DayGap[] {
  const blocks = routinesForDate(routines, date)
    .filter((r) => r.kind === 'constraint' && r.time)
    .map((r) => ({ start: r.time!, end: addMinutes(r.time!, r.durationMinutes) }));
  if (!blocks.length) return gaps;

  let windows = gaps;
  for (const block of blocks) {
    const next: DayGap[] = [];
    for (const gap of windows) {
      const gapFrom = timeToMinutes(gap.start);
      const gapTo = timeToMinutes(gap.end);
      const blockFrom = timeToMinutes(block.start);
      const blockTo = timeToMinutes(block.end);
      if (blockTo <= gapFrom || blockFrom >= gapTo) {
        next.push(gap);
        continue;
      }
      // The piece before the obligation…
      if (blockFrom - gapFrom >= 15) {
        next.push({ ...gap, end: block.start, minutes: blockFrom - gapFrom, after: undefined });
      }
      // …and the piece after it.
      if (gapTo - blockTo >= 15) {
        next.push({ ...gap, start: block.end, minutes: gapTo - blockTo, before: undefined });
      }
    }
    windows = next;
  }
  return windows;
}

/**
 * Categories that must not be suggested for this window.
 *
 * Two rules, both from the same instinct: an obligation casts a shadow.
 *  - a timed obligation on this day → nothing social in the 90 minutes before
 *    it (you do not start a coffee at 15:40 when the kids are at 16:00), and
 *  - an untimed constraint that names a part of the day ("not in the
 *    mornings") → nothing social in that part.
 */
export function blockedForGap(
  routines: Routine[],
  date: string,
  gap: { start: string; end: string },
): TaskCategory[] {
  const today = routinesForDate(routines, date).filter((r) => r.kind === 'constraint');
  if (!today.length) return [];

  const gapEnd = timeToMinutes(gap.end);
  const gapStart = timeToMinutes(gap.start);

  for (const constraint of today) {
    if (constraint.time) {
      const start = timeToMinutes(constraint.time);
      if (gapEnd > start - SOCIAL_SHADOW_MINUTES && gapStart < start + constraint.durationMinutes) {
        return SOCIAL_CATEGORIES;
      }
      continue;
    }
    const morning = /morning|בבוקר|בקרים|בבקרים/i.test(constraint.text) && gapStart < 12 * 60;
    const evening = /evening|night|בערב|בלילה|ערבים/i.test(constraint.text) && gapStart >= 17 * 60;
    if (morning || evening) return SOCIAL_CATEGORIES;
  }
  return [];
}

// Self-check: npx tsx src/utils/routines.ts
if (typeof require !== 'undefined' && require.main === module) {
  const parsed = parseRoutineNotes('gym Mon/Wed 18:00, kids 16:00 every day, weekly review Sunday');
  console.assert(parsed.length === 3, `three routines, got ${parsed.length}`);
  const gym = parsed[0];
  console.assert(gym.kind === 'habit' && gym.weekdays.join() === '1,3' && gym.time === '18:00',
    `gym Mon/Wed 18:00, got ${JSON.stringify(gym)}`);
  const kids = parsed[1];
  console.assert(kids.kind === 'constraint' && kids.weekdays.length === 7 && kids.time === '16:00',
    `kids constraint daily, got ${JSON.stringify(kids)}`);
  const trimmed = constrainGaps(
    [{ start: '14:00', end: '19:00', minutes: 300, endsAtDeparture: false }],
    parsed,
    '2026-08-31',
  );
  console.assert(trimmed.length === 2 && trimmed[0].end === '16:00' && trimmed[1].start === '17:00',
    `the pickup splits the window, got ${JSON.stringify(trimmed)}`);
  console.log('routines self-check OK');
}
