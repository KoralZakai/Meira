/**
 * scheduleQuestion — recognising a QUESTION about the diary, as opposed to an
 * instruction to change it.
 *
 * Everything Lumi could be told was a command: add this, move that, plan my
 * day. "What do I have to do on Tuesday 2/9?" fell through to the task parser,
 * which cheerfully created a task called "what do I have to do on Tuesday" —
 * and "can I fit a two-hour meeting in Haifa on Wednesday at 14:00?" created
 * one called that. The two shapes below are the questions worth answering
 * exactly rather than approximately, so they are matched here and answered
 * from the stored diary (ScheduleQueryService), not guessed at by a model:
 *
 *   day_agenda  — "what do I have on <date>", "מה יש לי ביום שלישי 2/9"
 *   feasibility — "can I have a 2 hour meeting in Haifa on 3/9 at 14:00?",
 *                 "אפשר פגישה של שעתיים בחיפה ב-3.9 ב-14:00?"
 *
 * Pure, synchronous, no LLM: the answer has to be right, and the diary is
 * local. Dates are resolved Israeli-style — 2/9 is the 2nd of September, never
 * February 9th.
 *
 * Dependencies: none. Consumed by services/ScheduleQueryService,
 * screens/CoachChatScreen. Tested by tests/run-schedule-question.ts.
 */

export interface DayAgendaQuestion {
  kind: 'day_agenda';
  /** YYYY-MM-DD. */
  date: string;
  raw: string;
}

export interface FeasibilityQuestion {
  kind: 'feasibility';
  date: string;
  /** How long the thing would take. */
  minutes: number;
  /** Where — free text, geocoded later ("Haifa", "חיפה", "Space Gym"). */
  place?: string;
  /** The hour she asked about, when she named one. */
  startTime?: string;
  /** The end of a window she asked about ("between 14:00 and 18:00"). */
  endTime?: string;
  /** What she'd be doing — "meeting", "פגישה", "coffee". */
  what?: string;
  /** Moving an existing task: judge the day without its old self (it is not in the way of itself). */
  ignoreId?: string;
  raw: string;
}

export type ScheduleQuestion = DayAgendaQuestion | FeasibilityQuestion | null;

const WEEKDAYS_EN = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
// Hebrew weekdays are written as "יום ראשון" or just "ראשון"; שבת has no יום.
const WEEKDAYS_HE = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

const pad = (n: number) => String(n).padStart(2, '0');
const key = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Shift a YYYY-MM-DD by whole days on the LOCAL calendar. */
function shift(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return key(new Date(y, m - 1, d + days));
}

/**
 * The date a question is about, or null.
 *
 * Day-first on purpose: "2/9" from an Israeli user is the 2nd of September.
 * A bare day/month that has already passed this year is read as NEXT year —
 * asking about 2/1 in December means the January coming, not the one gone.
 */
export function resolveQuestionDate(text: string, today: string): string | null {
  const lower = text.toLowerCase();

  const explicit = text.match(/\b(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\b/);
  if (explicit) {
    const day = Number(explicit[1]);
    const month = Number(explicit[2]);
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      let year = explicit[3]
        ? Number(explicit[3].length === 2 ? `20${explicit[3]}` : explicit[3])
        : Number(today.slice(0, 4));
      const candidate = `${year}-${pad(month)}-${pad(day)}`;
      if (!explicit[3] && candidate < today) year += 1;
      return `${year}-${pad(month)}-${pad(day)}`;
    }
  }

  // No \b around Hebrew anywhere in this file: JS word boundaries are ASCII,
  // so /\bמחר\b/ never matches — which is exactly why "מה יש לי מחר" used to
  // come back as today. Hebrew words are bounded with an explicit
  // [^א-ת] class instead.
  if (/\bday after tomorrow\b/.test(lower) || /מחרתיים/.test(text)) return shift(today, 2);
  if (/\btomorrow\b/.test(lower) || /מחר/.test(text)) return shift(today, 1);
  if (/\btoday\b/.test(lower) || /היום/.test(text)) return today;

  const weekday = WEEKDAYS_EN.findIndex((d) => lower.includes(d));
  const weekdayHe = WEEKDAYS_HE.findIndex((d) =>
    new RegExp(`יום\\s*${d}|(?:^|[^א-ת])${d}(?:[^א-ת]|$)`).test(text));
  const target = weekday !== -1 ? weekday : weekdayHe;
  if (target !== -1) {
    const [y, m, d] = today.split('-').map(Number);
    const current = new Date(y, m - 1, d).getDay();
    let ahead = (target - current + 7) % 7;
    // "next Tuesday" said ON Tuesday means the one coming, not today.
    if (ahead === 0 && /\bnext\b|הבא/.test(lower)) ahead = 7;
    return shift(today, ahead);
  }

  return null;
}

/** "2 hours", "90 min", "שעתיים", "שעה וחצי" → minutes. */
export function parseDurationMinutes(text: string): number | null {
  if (/שעתיים\s*וחצי/.test(text)) return 150;
  if (/שעה\s*וחצי/.test(text)) return 90;
  if (/שעתיים/.test(text)) return 120;
  if (/חצי\s*שעה/.test(text)) return 30;

  const hours = text.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h\b|שעות|שעה)/i);
  if (hours) return Math.round(parseFloat(hours[1]) * 60);
  const mins = text.match(/(\d+)\s*(?:minutes?|mins?|m\b|דקות|דק)/i);
  if (mins) return parseInt(mins[1], 10);
  if (/(?:^|[^א-ת])שעה(?:[^א-ת]|$)/.test(text)) return 60;
  return null;
}

/** First clock time in the text ("at 14:00", "ב-14:00", "at 2pm"). */
function parseClock(text: string, skip = 0): { time: string; index: number } | null {
  const re = /(?:\b(?:at|from|between)\s+|בשעה\s*|ב-?\s*(?=\d)|מ-?\s*(?=\d))?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/gi;
  let found = 0;
  let m: RegExpExecArray | null = re.exec(text);
  while (m) {
    const hasColon = m[2] !== undefined;
    const hasMeridiem = Boolean(m[3]);
    const explicitPrefix = /at|from|between|בשעה|^ב-|^מ-/i.test(m[0]);
    // A bare number is a duration or a date fragment far more often than a
    // clock time; require a colon, an am/pm, or an "at/בשעה" in front.
    if (hasColon || hasMeridiem || (explicitPrefix && m[0].trim() !== m[1])) {
      let hour = parseInt(m[1], 10);
      const minute = m[2] ? parseInt(m[2], 10) : 0;
      if (hour <= 23 && minute <= 59) {
        if (m[3]?.toLowerCase() === 'pm' && hour < 12) hour += 12;
        if (m[3]?.toLowerCase() === 'am' && hour === 12) hour = 0;
        if (found === skip) return { time: `${pad(hour)}:${pad(minute)}`, index: m.index };
        found += 1;
      }
    }
    m = re.exec(text);
  }
  return null;
}

const AGENDA_RE = new RegExp(
  [
    'what (?:do|does) i (?:have|need|got)',
    'what(?:\'s| is) (?:on|planned|scheduled)',
    "what am i doing",
    'what do i have to do',
    'מה יש לי',
    'מה אני צריכ[הת]? לעשות',
    'מה התוכנית',
    'מה מתוכנן',
    'מה קורה ב',
  ].join('|'),
  'i',
);

const FEASIBILITY_RE = new RegExp(
  [
    'can i (?:have|fit|do|take|schedule|book|make)',
    'could i (?:have|fit|do|take|schedule|book)',
    'do i have (?:time|room|space)',
    'is there (?:time|room)',
    'will i (?:have|make) it',
    'אפשר (?:לקבוע|לשבץ|להכניס|לעשות)?',
    'האם אני יכול[הת]?',
    'יש לי זמן',
    'יוצא לי',
    'אני יכול[הת]? (?:לקבוע|להגיע)',
  ].join('|'),
  'i',
);

/** Where it would happen: "in Haifa", "at Space Gym", "בחיפה", "בתל אביב". */
function parsePlace(text: string): string | undefined {
  const en = text.match(/\b(?:in|at)\s+([A-Za-z][A-Za-z' -]{2,30}?)(?=\s+(?:on|at|from|between|next|tomorrow|today|this)\b|[?,.]|$)/);
  if (en) {
    const value = en[1].trim();
    if (!/^(the|a|an|my|morning|afternoon|evening|night)$/i.test(value)) return value;
  }
  // Hebrew: "ב" glued to the place name ("בחיפה", "בתל אביב"). Anchored on a
  // letter, so it cannot swallow "ב-14:00", and stopped at whatever says the
  // place name has ended — a day, an hour, a digit, or the end of the question.
  const he = text.match(
    /(?:^|\s)ב([א-ת][א-ת' ]{1,25}?)(?=\s*(?:ביום|בשעה|מחר|מחרתיים|היום|בין|ב-?\d|ל-?\d|\d)|[?,.!]|$)/,
  );
  if (he) {
    const value = he[1].trim();
    const noise = /^(עוד|שעה|שעתיים|בוקר|ערב|צהריים|לילה|שבוע|יום|שביל)/;
    if (value.length >= 2 && !noise.test(value)) return value;
  }
  return undefined;
}

/** What the thing is — used only to name it back to her. */
function parseWhat(text: string): string | undefined {
  const m = text.match(/\b(meeting|coffee|call|lunch|dinner|workout|gym|class|appointment)\b/i)
    || text.match(/(פגישה|קפה|שיחה|ארוחה|אימון|שיעור|תור)/);
  return m ? m[1] : undefined;
}

/**
 * Classify one message. Returns null for anything that is not one of the two
 * question shapes — the caller then carries on with its normal handling.
 */
export function parseScheduleQuestion(text: string, today: string): ScheduleQuestion {
  const raw = text.trim();
  if (!raw) return null;

  const feasible = FEASIBILITY_RE.test(raw);
  const agenda = AGENDA_RE.test(raw);
  if (!feasible && !agenda) return null;

  const date = resolveQuestionDate(raw, today);

  if (feasible) {
    const minutes = parseDurationMinutes(raw);
    // "Can I …?" with no duration and no place is not this question — it is
    // small talk, and answering it with a schedule audit would be worse than
    // passing it on.
    const place = parsePlace(raw);
    if (!minutes && !place) return null;
    // Clock times are read from the text with the DATE removed: "ב-2.9" is a
    // date whose leading 2 looked exactly like "at 02:00" to the clock parser,
    // so "בחיפה ב-2.9 בשעה 14:00" came back as a 2 a.m. meeting.
    const dateFree = raw.replace(/\b\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?\b/g, ' ');
    const first = parseClock(dateFree);
    const second = first ? parseClock(dateFree, 1) : null;
    return {
      kind: 'feasibility',
      date: date || today,
      minutes: minutes ?? 60,
      place,
      startTime: first?.time,
      endTime: /between|בין|-\s*\d|עד/.test(raw) ? second?.time : undefined,
      what: parseWhat(raw),
      raw,
    };
  }

  // An agenda question with no date at all means today.
  return { kind: 'day_agenda', date: date || today, raw };
}

// Self-check: npx tsx src/utils/scheduleQuestion.ts
if (typeof require !== 'undefined' && require.main === module) {
  const today = '2026-08-31'; // a Monday
  const q1 = parseScheduleQuestion('What do I have to do on Tuesday 1/9 ?', today);
  console.assert(q1?.kind === 'day_agenda' && q1.date === '2026-09-01', `day agenda, got ${JSON.stringify(q1)}`);
  const q2 = parseScheduleQuestion('מה יש לי ביום שלישי 1.9?', today);
  console.assert(q2?.kind === 'day_agenda' && q2.date === '2026-09-01', `he agenda, got ${JSON.stringify(q2)}`);
  const q3 = parseScheduleQuestion('Can I have a 2 hour meeting in Haifa on 2/9 at 14:00?', today);
  console.assert(q3?.kind === 'feasibility' && q3.date === '2026-09-02' && q3.minutes === 120
    && q3.place === 'Haifa' && q3.startTime === '14:00', `feasibility, got ${JSON.stringify(q3)}`);
  const q4 = parseScheduleQuestion('אפשר פגישה של שעתיים בחיפה ב-2.9 בשעה 14:00?', today);
  console.assert(q4?.kind === 'feasibility' && q4.minutes === 120 && q4.date === '2026-09-02',
    `he feasibility, got ${JSON.stringify(q4)}`);
  const q5 = parseScheduleQuestion('מה יש לי מחר?', today);
  console.assert(q5?.kind === 'day_agenda' && q5.date === '2026-09-01',
    `Hebrew "tomorrow" resolves (ASCII \\b never matches Hebrew), got ${JSON.stringify(q5)}`);
  const q6 = parseScheduleQuestion('אפשר לקבוע פגישה של שעה בתל אביב ביום רביעי ב-16:00?', today);
  console.assert(q6?.kind === 'feasibility' && q6.minutes === 60 && q6.place === 'תל אביב'
    && q6.date === '2026-09-02' && q6.startTime === '16:00', `he place+hour, got ${JSON.stringify(q6)}`);
  console.assert(parseScheduleQuestion('add gym tomorrow at 18:00', today) === null, 'a command is not a question');
  console.assert(parseScheduleQuestion('קניות בסופר מחר', today) === null, 'a Hebrew command is not a question');
  console.log('scheduleQuestion self-check OK');
}
