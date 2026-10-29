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
import { correctPlaceName } from './fuzzyMatch';
import { DayGap } from './findGaps';
import { addMinutes, timeToMinutes, minutesToTime } from './timeUtils';
import { inferFromText } from './categorize';

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
  /**
   * Where `weekdays` came from (notes only). 'unsaid' keeps the old reading —
   * empty = every day — but it is a QUESTION for her, not a fact (6.10).
   * Absent = said (history, older callers).
   */
  daysFrom?: DaysFrom;
  /** "twice a week" with no days named. */
  perWeek?: number;
  /** Which text the line came from: her Routines box, what she told Meira, or both. */
  origin?: ('box' | 'told')[];
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

// ── Which days a line names (6.10) ────────────────────────────────────────────
// ONE spec with server/routine_match.read_days, pinned by the hand-written
// tests/fixtures/weekday-lines.json. The phone and the server used to read
// "בשלישי", "שני ורביעי", ranges and "Tuesdays" differently, and an empty list
// meant both "she never said" and "every day" (CLAUDE.md silent-state rule 1).
// `from` now says which: 'unsaid' is a question for her, not a fact.

/** Where a routine's days come from. 'rule' = a rule she confirmed filled them in. */
export type DaysFrom = 'said' | 'unsaid' | 'rule' | 'varies';

export interface DaysRead {
  /** 0=Sun … 6=Sat. Empty when no day was named, or when they vary. */
  days: number[];
  from: Exclude<DaysFrom, 'rule'>;
  /** "twice a week" with no days named. */
  perWeek?: number;
}

const WEEKDAYS_EN = [
  ['sunday', 'sundays', 'sun'], ['monday', 'mondays', 'mon'], ['tuesday', 'tuesdays', 'tue', 'tues'],
  ['wednesday', 'wednesdays', 'wed'], ['thursday', 'thursdays', 'thu', 'thur', 'thurs'],
  ['friday', 'fridays', 'fri'], ['saturday', 'saturdays', 'sat'],
];
const WEEKDAYS_HE = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
/** א׳ = Sunday … ו׳ = Friday, ש׳ = Saturday. */
const DAY_LETTERS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];
const EN_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const GERESH = "['׳’]";
// No \b around Hebrew: it is ASCII-only in JS. A day word must not touch
// another Hebrew letter ("שנייה" is not Monday, "ג׳ים" is not Tuesday).
const NOT_HE = '(?:^|[^א-ת])';

const EVERY_DAY_RE = /\b(?:every ?day|daily|each day|every (?:morning|evening|night))\b|כל יום|כל יומ|יומיומי|כל בוקר|כל ערב|כל לילה/i;
const VARIES_RE = /ימים משתנים|משתנה כל שבוע|\bdays vary\b|\bvaries (?:each|every) week\b/i;
/** Israel's working week: Sunday–Thursday. */
const WORKWEEK_RE = /\bweekdays\b|ימי חול|באמצע השבוע/i;
const WEEKEND_RE = /\bweekends?\b|סוף ה?שבוע|סופ["״]ש/i;
const HE_PER_WEEK = /(?:(\d+)\s*פעמים|(פעמיים)|(פעם אחת|פעם))\s*ב?שבוע/;
const EN_PER_WEEK = /\b(?:(\d+)\s*(?:x|times)|(twice)|(once))\s*(?:a|per|each|\/)?\s*week\b/i;

const EN_DAY = '(sun|mon|tue|wed|thu|fri|sat)[a-z]*';
const EN_RANGE = new RegExp(`\\b${EN_DAY}\\s*(?:-|–|to|until|through|thru)\\s*${EN_DAY}\\b`, 'gi');
const HE_NAMES = WEEKDAYS_HE.join('|');
const HE_RANGE = new RegExp(`${NOT_HE}[מב]?(${HE_NAMES})\\s*(?:-|–|עד)\\s*[הל]?(${HE_NAMES})(?![א-ת])`, 'g');
// "א-ה" and "א׳–ה׳" are ranges; "ו-ד׳" is "and Wednesday" — so both letters
// carry a geresh or neither does.
const LETTER_RANGE = new RegExp(`${NOT_HE}([אבגדהוש])(${GERESH})?\\s*(?:-|–|עד)\\s*([אבגדהוש])(${GERESH})?(?![א-ת])`, 'g');
// A single letter is a day only WITH its geresh: "ב 8 וחצי" is not Monday.
const LETTER_DAY = new RegExp(`${NOT_HE}(?:ו-?)?([אבגדהוש])${GERESH}(?![א-ת])`, 'g');
const HE_DAY_RES = WEEKDAYS_HE.map((name) => new RegExp(`${NOT_HE}(?:וב|ומ|ול|[ובמל])?${name}(?![א-ת])`));
const EN_DAY_RES = WEEKDAYS_EN.map((names) => new RegExp(`\\b(?:${names.join('|')})\\b`, 'i'));

/** Weekday number of a YYYY-MM-DD on the local calendar. */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}

function addRange(found: Set<number>, from: number, to: number): void {
  if (from < 0 || to < 0) return;
  for (let i = 0; i < 7; i += 1) {
    const day = (from + i) % 7;
    found.add(day);
    if (day === to) break;
  }
}

const enIndex = (word: string) =>
  WEEKDAYS_EN.findIndex((names) => names.some((n) => word.toLowerCase().startsWith(n)));

/** Which days a line names, and whether it named any. See DaysRead. */
export function readDays(text: string): DaysRead {
  if (VARIES_RE.test(text)) return { days: [], from: 'varies' };
  const found = new Set<number>();
  for (const m of text.matchAll(EN_RANGE)) addRange(found, enIndex(m[1]), enIndex(m[2]));
  for (const m of text.matchAll(HE_RANGE)) addRange(found, WEEKDAYS_HE.indexOf(m[1]), WEEKDAYS_HE.indexOf(m[2]));
  for (const m of text.matchAll(LETTER_RANGE)) {
    if (Boolean(m[2]) === Boolean(m[4])) addRange(found, DAY_LETTERS.indexOf(m[1]), DAY_LETTERS.indexOf(m[3]));
  }
  for (const m of text.matchAll(LETTER_DAY)) found.add(DAY_LETTERS.indexOf(m[1]));
  HE_DAY_RES.forEach((re, i) => { if (re.test(text)) found.add(i); });
  EN_DAY_RES.forEach((re, i) => { if (re.test(text)) found.add(i); });
  if (WORKWEEK_RE.test(text)) [0, 1, 2, 3, 4].forEach((d) => found.add(d));
  if (WEEKEND_RE.test(text)) [5, 6].forEach((d) => found.add(d));
  // Named days first: "כל יום שלישי" is every TUESDAY, not every day.
  if (found.size) return { days: [...found].sort((a, b) => a - b), from: 'said' };
  if (EVERY_DAY_RE.test(text)) return { days: [0, 1, 2, 3, 4, 5, 6], from: 'said' };
  const he = text.match(HE_PER_WEEK);
  const en = text.match(EN_PER_WEEK);
  const perWeek = he ? (he[1] ? Number(he[1]) : he[2] ? 2 : 1)
    : en ? (en[1] ? Number(en[1]) : en[2] ? 2 : 1) : undefined;
  return perWeek ? { days: [], from: 'unsaid', perWeek } : { days: [], from: 'unsaid' };
}

/** Which days a fragment names. Empty array = it named none. */
function weekdaysIn(text: string): number[] {
  return readDays(text).days;
}

// ── Writing her answer back into her line ─────────────────────────────────────
// "Every day or which days?" → "קיקבוקס 20:30-21:30 יגאל אלון 94 · ימי ג׳".
// The phrase is written in the line's own script, parses back to exactly the
// days chosen (all 127 combinations, in the fixture test), and never contains a
// comma — commas split one line into two routines.

const DAYS_PHRASE_RE = /\s*·\s*(?:ימי\s[^·]+|כל יום|ימים משתנים|every day|days vary|(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)(?:\s*[&/–-]\s*(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat))*)\s*$/;

function isRun(days: number[]): boolean {
  return days.length >= 3 && days.every((d, i) => i === 0 || d === days[i - 1] + 1);
}

/** The days as a short phrase in her script ('he' | 'en'), or 'varies'. */
export function daysPhrase(days: number[] | 'varies', script: 'he' | 'en'): string {
  if (days === 'varies') return script === 'he' ? '· ימים משתנים' : '· days vary';
  const sorted = [...new Set(days)].filter((d) => d >= 0 && d <= 6).sort((a, b) => a - b);
  if (!sorted.length) return '';
  if (sorted.length === 7) return script === 'he' ? '· כל יום' : '· every day';
  if (script === 'he') {
    const L = (d: number) => `${DAY_LETTERS[d]}׳`;
    if (isRun(sorted)) return `· ימי ${L(sorted[0])}–${L(sorted[sorted.length - 1])}`;
    if (sorted.length === 1) return `· ימי ${L(sorted[0])}`;
    return `· ימי ${sorted.slice(0, -1).map(L).join(' ')} ו-${L(sorted[sorted.length - 1])}`;
  }
  if (isRun(sorted)) return `· ${EN_ABBR[sorted[0]]}–${EN_ABBR[sorted[sorted.length - 1]]}`;
  if (sorted.length === 2) return `· ${EN_ABBR[sorted[0]]} & ${EN_ABBR[sorted[1]]}`;
  return `· ${sorted.map((d) => EN_ABBR[d]).join('/')}`;
}

/** Her line without a days phrase Meira appended (her own words are kept). */
export function stripDaysPhrase(text: string): string {
  return text.replace(DAYS_PHRASE_RE, '').trim();
}

/** Her line with these days written into it, in the line's own script. */
export function withDays(line: string, days: number[] | 'varies'): string {
  const base = stripDaysPhrase(line);
  const phrase = daysPhrase(days, /[֐-׿]/.test(base) ? 'he' : 'en');
  return phrase ? `${base} ${phrase}` : base;
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
  // "יוגה ב 11 ימי שישי", "ב-8 בערב" (13.10): \b never matches before a Hebrew
  // letter, so the line above missed every Hebrew hour without a colon. A bare
  // number counts only right after ב / בשעה, so "יגאל אלון 94" is never 94:00.
  const he = text.match(/(?:^|[^\u0590-\u05FF\w])(?:בשעה|ו?ב)-?\s*(\d{1,2})(?![\d:])\s*(בבוקר|בערב|בלילה|בצהריים|אחה"צ)?/);
  if (he) {
    let hour = parseInt(he[1], 10);
    if (he[2] && he[2] !== 'בבוקר' && hour < 12) hour += 12;
    if (hour >= 1 && hour <= 23) return { time: `${String(hour).padStart(2, '0')}:00` };
  }
  return {};
}

/**
 * A category for a routine, so a habit can become a real task.
 *
 * ONE table, not a fifth copy (15.10): this used to be three regexes of its
 * own, and `workout` was written without the optional space — so "work out"
 * missed the gym line, hit /work|office|shift/ on the next one, and her
 * workout was filed under 💼 Work. A workout is a workout in every spelling
 * `routineConcept` already knows (FITNESS_RE: "work out", אימון, מתאמן…);
 * everything else is `categorize.inferFromText`, the same table the server
 * and the calendar import read.
 */
export function categoryFor(text: string): TaskCategory {
  return routineConcept(text) === 'fitness' ? 'gym' : inferFromText(text).category;
}

/**
 * A workout that was filed as work (the bug above) is a gym task again.
 *
 * Pure. Returns the SAME object when there is nothing to heal, so a caller can
 * tell by identity whether anything changed. Used by TaskStorage's read path
 * and by the routine card.
 */
export function healWorkoutCategory<T extends { text: string; category?: TaskCategory | string }>(task: T): T {
  if (task.category !== 'work') return task;
  if (routineConcept(task.text || '') !== 'fitness') return task;
  return { ...task, category: 'gym' };
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
    // "עיגל אלון 96" is how speech heard יגאל אלון — read it as she meant it.
    const text = correctPlaceName(fragment.trim());
    if (text.length < 3) return;
    const read = readDays(text);
    const weekdays = read.days;
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
      daysFrom: read.from,
      ...(read.perWeek ? { perWeek: read.perWeek } : {}),
    });
  };

  // One routine per LINE, not per comma (11.10, Koral: "אימון · ראשון, שני,
  // שלישי · 20:00 · יגאל אלון 94" showed tomorrow THREE times — the days list
  // was cut into three routines, and only the last one kept the address).
  routineLines(notes).forEach(push);
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
    // An obligation whose days change week to week cannot block every day.
    .filter((r) => r.kind === 'constraint' && r.time && r.daysFrom !== 'varies')
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

// ── routineForTask — "קיקבוקס" is already in her week ─────────────────────
//
// The phone-side twin of server/routine_match.py, for a task typed into the +
// screen. Koral, 2026-09-28: "I added 'קיקבוקס' — I expected Meira to know
// where it is, Yigal Alon 94, and it has a time, 20:30-21:30 — it's in my
// routines!" parseRoutineNotes above read the day and the hour and threw the
// address away; nothing at all matched a new task against the result.
//
//   exact   — the task names the routine's activity: hour AND address.
//   concept — same kind of activity (yoga vs a kickboxing line): the ADDRESS
//             only. Same gym, different class, different hour.
// Tested by tests/run-routine-task.ts, with the same cases as the Python.

const ROUTINE_WHEN_WORDS = new Set([
  'כל', 'יום', 'ימי', 'בימי', 'ביום', 'בשעה', 'שעה', 'עד', 'בין', 'בערב', 'בבוקר',
  'בצהריים', 'בלילה', 'ערב', 'בוקר', 'וחצי', 'ורבע', 'רבע', 'every', 'at', 'from',
  'to', 'until', 'on', 'evening', 'morning', 'weekly', 'שבועי', 'פעם', 'בשבוע', 'פעמיים',
]);
const ADDRESS_LEAD_WORDS = new Set(['רחוב', 'רח', "רח'", 'רח׳', 'שדרות', 'שד', 'כתובת', 'street', 'st']);
const ROUTINE_CITIES = [
  'תל אביב-יפו', 'תל אביב', 'ת"א', 'ת״א', 'רמת גן', 'גבעתיים', 'הרצליה', 'רעננה',
  'חיפה', 'ירושלים', 'בני ברק', 'חולון', 'בת ים', 'פתח תקווה', 'ראשון לציון',
  'tel aviv', 'ramat gan', 'givatayim', 'herzliya', 'raanana', 'haifa', 'jerusalem',
];
/** One activity, two alphabets. */
const ACTIVITY_ALIASES: Record<string, string> = {
  kickbox: 'קיקבוקס', kickboxing: 'קיקבוקס', boxing: 'איגרוף', אגרוף: 'איגרוף',
  yoga: 'יוגה', pilates: 'פילאטיס', gym: 'כושר', crossfit: 'קרוספיט',
  swim: 'שחייה', swimming: 'שחייה', run: 'ריצה', running: 'ריצה',
  dance: 'ריקוד', ריקודים: 'ריקוד', guitar: 'גיטרה', piano: 'פסנתר',
};
const ROUTINE_STOP = new Set([
  'the', 'a', 'an', 'at', 'in', 'on', 'to', 'with', 'my', 'for', 'and', 'class',
  'של', 'עם', 'את', 'אל', 'לי', 'לה', 'לו', 'היום', 'מחר',
]);
/** Kinds of activity — the same table as utils/knownPlaces, fitness only matters here. */
const FITNESS_RE = /gym|work ?out|training|\btrain\b|fitness|yoga|pilates|kickbox|boxing|crossfit|חדר כושר|כושר|אימו[נן]|להתאמן|מתאמ[נן]|יוגה|פילאטיס|קיקבוקס|קיק בוקס|איגרוף|אגרוף|קרוספיט/i;

/** A workout with a name of its own: Pilates on Sunday is not "a workout" on Sunday. */
const NAMED_FITNESS: Array<[string, RegExp]> = [
  ['yoga', /yoga|יוגה/i], ['pilates', /pilates|פילאטיס/i], ['kickbox', /kickbox|קיקבוקס|קיק בוקס/i],
  ['boxing', /boxing|איגרוף|אגרוף/i], ['crossfit', /crossfit|קרוספיט/i],
];

/** What a routine IS, across languages and spellings: 'fitness' for any workout. */
export function routineConcept(text: string): string {
  if (FITNESS_RE.test(text)) return 'fitness';
  return significant(stripDaysPhrase(text)).sort().join(' ');
}

const namedKind = (text: string) => NAMED_FITNESS.find(([, re]) => re.test(text))?.[0] ?? null;

/**
 * Two lines that are ONE routine (11.10, Koral: the same workout, told to
 * Meira five ways, was five cards on "Tomorrow"): the same kind of thing, on
 * a shared day (or one has no day), at the same hour (or one has none).
 * Two named workouts must be the same kind; a named one and a plain "workout"
 * are one only on the same day at the same hour ("yoga at 11 on Friday" and
 * "morning workout Friday 11:00").
 */
export function sameRoutine(a: Routine, b: Routine): boolean {
  if (routineConcept(a.text) !== routineConcept(b.text) || !routineConcept(a.text)) return false;
  const ka = namedKind(a.text);
  const kb = namedKind(b.text);
  if (ka && kb && ka !== kb) return false;
  const strict = Boolean(ka) !== Boolean(kb);
  if (strict && !(a.time && a.time === b.time)) return false;
  if (a.time && b.time && a.time !== b.time) return false;
  const shared = a.weekdays.some((d) => b.weekdays.includes(d));
  if (strict && !shared) return false;
  if (a.weekdays.length && b.weekdays.length && !shared) return false;
  return true;
}

const cleanWord = (t: string) => t.replace(/^[.,;:!?()"[\]]+|[.,;:!?()"[\]]+$/g, '');
const scriptOf = (w: string) => (/[֐-׿]/.test(w) ? 'he' : 'latin');

/**
 * What she calls the place: the words before its address, minus hours, days
 * and when-words. "Space Gym - Yigal Alon 94" → "Space Gym". The address is
 * what gets geocoded, the name is what the card shows — they travel separately.
 * Mirrors routine_match.name_before on the server.
 */
export function nameBeforeAddress(text: string, address: string): string | null {
  const street = String(address || '').split(',')[0].trim();
  const at = street ? text.indexOf(street) : -1;
  if (at <= 0) return null;
  const head = text.slice(0, at)
    .replace(/(\d{1,2})[:.](\d{2})\s*(?:-|–|—|עד|to|until)\s*(\d{1,2})[:.](\d{2})/g, ' ')
    .replace(/(^|[^\d])\d{1,2}:\d{2}(?!\d)/g, '$1 ');
  // length > 1: the ב of "ביגאל" is left behind when the street is found inside it.
  const keep = head.split(/\s+/).map(cleanWord).filter((w) => w.length > 1
    && !/^[-–—:|/]+$/.test(w)
    && !ROUTINE_WHEN_WORDS.has(w.toLowerCase()) && !ADDRESS_LEAD_WORDS.has(w.toLowerCase())
    && !weekdaysIn(w).length);
  const name = keep.join(' ').replace(/^[\s\-–—,:]+|[\s\-–—,:]+$/g, '');
  return name || null;
}

/** Her words for the activity, folded to one spelling across languages. */
function significant(text: string): string[] {
  const toks = String(text || '').toLowerCase().match(/[\p{L}]+/gu) || [];
  return toks
    .filter((t) => t.length > 2 && !ROUTINE_WHEN_WORDS.has(t) && !ROUTINE_STOP.has(t) && !weekdaysIn(t).length)
    .map((t) => ACTIVITY_ALIASES[t] ?? t);
}

/**
 * A street address in a routine line — "<street words> <house number>" — or
 * null. Needs the house number: without one, any two words look like a street.
 * The preposition ב is peeled off the street's first word, as utils/hebrewPlace does.
 */
export function addressInRoutine(text: string): string | null {
  const tokens = String(text || '').split(/\s+/).filter(Boolean);
  for (let idx = 0; idx < tokens.length; idx++) {
    const num = cleanWord(tokens[idx]);
    if (!/^\d{1,4}[א-ת]?$/.test(num)) continue;
    const words: string[] = [];
    for (let j = idx - 1; j >= 0 && words.length < 3; j--) {
      const w = cleanWord(tokens[j]);
      const bare = /^ב-?[\u0590-\u05FF]{3,}/.test(w) ? w.replace(/^ב-?/, '') : w;
      if (!/^[\u0590-\u05FFA-Za-z'"׳״-]{2,}$/.test(w)
        || ROUTINE_WHEN_WORDS.has(w.toLowerCase()) || ROUTINE_WHEN_WORDS.has(bare)
        || ADDRESS_LEAD_WORDS.has(bare.toLowerCase()) || weekdaysIn(w).length
        // "Space Gym, יגאל אלון 94": a comma closes the name before the street,
        // and a street is written in one alphabet — without these the gym's
        // name became "Gym יגאל אלון 94".
        || /[,;]$/.test(tokens[j])
        || (words.length > 0 && scriptOf(w) !== scriptOf(words[0]))) break;
      words.unshift(w);
    }
    if (!words.length) continue;
    if (/^ב-?[\u0590-\u05FF]{3,}/.test(words[0])) words[0] = words[0].replace(/^ב-?/, '');
    const address = [...words, num].join(' ');
    const rest = tokens.slice(idx + 1, idx + 4).map(cleanWord).join(' ');
    const city = ROUTINE_CITIES.find((c) => rest.toLowerCase().startsWith(c.toLowerCase()));
    return city ? `${address}, ${rest.slice(0, city.length)}` : address;
  }
  return null;
}

export interface RoutineMatch {
  text: string;
  match: 'exact' | 'concept';
  weekdays: number[];
  time?: string;
  minutes?: number;
  address?: string;
  /** What she calls the place ("Space Gym"), when the line names it apart from the task. */
  name?: string;
  /** An exact match on a day the routine runs: the hour may be used. */
  timeApplies: boolean;
}

/** Split her notes into lines; a comma piece that is only a city stays with its line. */
/**
 * Her Routines box WITHOUT one routine — the delete (×) in You (21.10, Koral: "I can't delete a
 * routine that is already written in the profile").
 *
 * The old delete cut every line at its commas and kept the pieces that were not equal to the
 * routine's text. A routine is a whole LINE ("אימון · יום ראשון, שני ושלישי · 20:00 · יגאל אלון 76,
 * תל אביב" has two commas inside it), so no piece ever equalled it: nothing was removed, and
 * "removed" was still reported. And the text it compared with had been through correctPlaceName
 * on its way to the screen, so a line stored as "עיגל אלון 96" never matched at all.
 *
 * Same unit as routineLines: a line with " · " is ONE routine; any other line is a list of comma
 * pieces. `removed` = how many routines went; 0 means it was not there, and the caller says so.
 */
export function removeRoutineFromNotes(notes: string, routineText: string): { notes: string; removed: number } {
  const norm = (t: string) => correctPlaceName(String(t || '')).trim().replace(/\s+/g, ' ').toLowerCase();
  const target = norm(routineText);
  if (!target) return { notes: String(notes || ''), removed: 0 };
  let removed = 0;
  const rows: string[] = [];
  for (const row of String(notes || '').split('\n')) {
    if (row.includes(' · ')) {
      if (row.split(/[;•]+/).some((p) => norm(p) === target)) {
        const keep = row.split(/[;•]+/).filter((p) => norm(p) !== target);
        removed += row.split(/[;•]+/).length - keep.length;
        if (keep.join('').trim()) rows.push(keep.join('; ').trim());
      } else rows.push(row);
      continue;
    }
    const pieces = row.split(/[;•]+/).flatMap((chunk) => chunk.split(','));
    const keep = pieces.filter((p) => norm(p) !== target);
    removed += pieces.length - keep.length;
    const text = keep.map((p) => p.trim()).filter(Boolean).join(', ');
    if (text) rows.push(text);
    else if (!pieces.some((p) => p.trim())) rows.push(row);   // a blank line stays a blank line
  }
  return { notes: rows.join('\n'), removed };
}

function routineLines(notes?: string): string[] {
  const out: string[] = [];
  for (const line of String(notes || '').split(/[;\n•]+/)) {
    const pieces: string[] = [];
    // A line Meira wrote ("what · days · time · place") is ONE routine.
    if (line.includes(' · ')) {
      if (line.trim()) pieces.push(line.trim());
      out.push(...pieces.filter((p) => p.length >= 3));
      continue;
    }
    for (const raw of line.split(',')) {
      const piece = raw.trim();
      if (!piece) continue;
      const onlyCity = ROUTINE_CITIES.some((c) => c.toLowerCase() === piece.toLowerCase());
      // "Sunday, Monday, Tuesday at 8": a piece that starts with a day after a
      // piece that ended with one continues the same list of days.
      const prev = pieces.length ? pieces[pieces.length - 1].split(/\s+/).pop() || '' : '';
      const daysGoOn = weekdaysIn(cleanWord(prev)).length > 0 && weekdaysIn(cleanWord(piece.split(/\s+/)[0])).length > 0;
      if (pieces.length && (onlyCity || daysGoOn || !significant(piece).length)) pieces[pieces.length - 1] += `, ${piece}`;
      else pieces.push(piece);
    }
    out.push(...pieces.filter((p) => p.length >= 3));
  }
  return out;
}

/** The routine this task IS, or null. */
export function routineForTask(taskText: string, notes: string | undefined, date: string): RoutineMatch | null {
  const mine = significant(taskText);
  if (!mine.length) return null;
  const taskFitness = FITNESS_RE.test(taskText) || FITNESS_RE.test(mine.join(' '));
  const day = /^\d{4}-\d{2}-\d{2}/.test(date) ? weekdayOf(date.slice(0, 10)) : null;
  let exact: RoutineMatch | null = null;
  let concept: RoutineMatch | null = null;
  for (const text of routineLines(notes)) {
    const theirs = new Set(significant(text));
    const weekdays = weekdaysIn(text);
    const { time, minutes } = timeIn(text);
    const address = addressInRoutine(text) ?? undefined;
    const name = address ? nameBeforeAddress(text, address) ?? undefined : undefined;
    if (theirs.has(mine[0]) || mine.some((w) => w.length >= 4 && theirs.has(w))) {
      if (!exact) {
        exact = {
          text, match: 'exact', weekdays, time, minutes, address, name,
          timeApplies: Boolean(time) && (!weekdays.length || day == null || weekdays.includes(day)),
        };
      }
    } else if (taskFitness && FITNESS_RE.test(text) && address && !concept) {
      concept = { text, match: 'concept', weekdays, address, name, timeApplies: false };
    }
  }
  if (exact && !exact.address && concept) exact = { ...exact, address: concept.address, name: concept.name };
  const hit = exact ?? concept;
  // "קיקבוקס 20:30 ביגאל אלון 94" names the CLASS, not the place: no name for
  // the kickboxing task itself, and none for a yoga class borrowing the address
  // either. "Space Gym" has a word that is no activity.
  const words = hit?.name ? significant(hit.name) : [];
  if (hit?.name && (words.every((w) => mine.includes(w)) || words.every((w) => FITNESS_RE.test(w)))) {
    const { name: _drop, ...rest } = hit;
    return rest;
  }
  return hit;
}

/** Does "08:30" as she typed it name the routine's 20:30? Twelve-hour agreement. */
export function sameHourOfDay(said?: string | null, routineTime?: string): boolean {
  if (!said || !routineTime) return false;
  const [sh, sm] = said.split(':').map(Number);
  const [rh, rm] = routineTime.split(':').map(Number);
  return sm === rm && sh % 12 === rh % 12;
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
