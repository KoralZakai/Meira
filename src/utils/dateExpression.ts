/**
 * dateExpression — "מחר", "ביום ראשון", "Sunday", "20.10", "8 באוקטובר" → the
 * calendar day, and WHERE in the sentence those words are.
 *
 * Why this exists. The Add screen shows what it understood on every keystroke,
 * and a date chip is only honest if it names the same day the save will use.
 * The server resolves dates in `server/tz.resolve_date` (one parser, shared by
 * the WhatsApp path and the task-save override). The phone had NO equivalent:
 * `timeParser` knows "tomorrow" and "in N days" and an English "on Monday", but
 * not "ביום ראשון", not "20.10", not "8 באוקטובר". So this is a port, not a new
 * idea — same vocabulary, same precedence, same "next occurrence, never today"
 * for a weekday — pinned by tests/fixtures/date-expression-golden.json, which
 * server/tests/test_date_expression_parity.py checks against the Python and
 * tests/run-live-parse.ts checks against this file. Two implementations of one
 * rule agree only while something compares them.
 *
 * Three deliberate differences from the server, all on the side of "do not
 * invent a chip":
 *   - A Hebrew weekday must be said as a weekday: "יום שני", "ביום ראשון",
 *     "בשבת". The server accepts the bare word anywhere in the string, which is
 *     fine for a model-fed override and wrong for a chip ("שני" is also "two"
 *     in "שניות", and "ראשון" is "first").
 *   - "3.5 hours" is a quantity, not the 3rd of May.
 *   - An impossible day.month ("13.30") is skipped, not fatal: the server gives
 *     up on the whole expression, a chip should keep looking.
 *
 * Pure: no clock of its own (`today` is passed in), no storage, no network.
 */

export interface DateSpan { start: number; end: number }

export interface DateHit {
  /** YYYY-MM-DD, local calendar. */
  key: string;
  /** Whole days from `today` (0 = today). */
  daysFromToday: number;
  /** The words that said it — so a chip can remove exactly them. */
  span: DateSpan;
  kind: 'relative' | 'numeric' | 'month' | 'weekday';
}

const HEB = '\\u0590-\\u05FF';

const pad = (n: number) => String(n).padStart(2, '0');

/** YYYY-MM-DD on the LOCAL calendar — never toISOString (UTC: wrong after midnight in Israel). */
export function localKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function plusDays(d: Date, n: number): Date {
  const out = startOfDay(d);
  out.setDate(out.getDate() + n);
  return out;
}

const DAY_MS = 86_400_000;
const diffDays = (target: Date, today: Date): number =>
  Math.round((startOfDay(target).getTime() - startOfDay(today).getTime()) / DAY_MS);

// Monday-based, like server/tz.py (_DAYS_EN / _DAYS_HE).
const DAYS_EN = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const DAYS_HE = ['שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת', 'ראשון'];
export const MONTHS_HE_LIST = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט',
  'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const MONTHS_EN_LIST = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december'];
const MONTH_HE_ALT = [...MONTHS_HE_LIST, 'מרס'].join('|');
const MONTH_EN_ALT = 'january|february|march|april|may|june|july|august|september|october'
  + '|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec';

/** Python's weekday(): Monday = 0. */
const pyWeekday = (d: Date): number => (d.getDay() + 6) % 7;

interface Rel { re: RegExp; add: number }

// Longest form first: "מחרתיים" contains "מחר", "day after tomorrow" contains
// "tomorrow". Same order as tz.resolve_date.
const RELATIVE: Rel[] = [
  { re: new RegExp(`(?<![${HEB}])[בל]?מחרתיים(?![${HEB}])|day\\s+after\\s+tomorrow`, 'i'), add: 2 },
  { re: new RegExp(`(?<![${HEB}])בעוד\\s+יומיים(?![${HEB}])`), add: 2 },
  { re: new RegExp(`(?<![${HEB}])[בל]?מחר(?![${HEB}])|\\btomorrow\\b`, 'i'), add: 1 },
  { re: new RegExp(`(?<![${HEB}])היום(?![${HEB}])|\\btoday\\b`, 'i'), add: 0 },
  { re: new RegExp(`(?<![${HEB}])(?:ב?שבוע\\s+הבא|בעוד\\s+שבוע)(?![${HEB}])|\\bnext\\s+week\\b|\\bin\\s+a\\s+week\\b`, 'i'), add: 7 },
];

const IN_N_DAYS = new RegExp(`\\bin\\s+(\\d+)\\s+days?\\b|(?<![${HEB}])בעוד\\s+(\\d+)\\s+ימים(?![${HEB}])`, 'i');

// 20.10 / 20/10 / 20.10.26 — the day first, as it is said in Israel. A quantity
// ("3.5 hours") is not a date.
const NUMERIC = new RegExp(
  `(?<![\\d./])(?:(?<![${HEB}])[בל]-?)?(\\d{1,2})[./](\\d{1,2})(?:[./](\\d{2,4}))?(?![\\d])`
  + `(?!\\s*(?:שעות|שעה|דקות|hours?|hrs?|minutes?|mins?|%|km|ק"מ|ק״מ))`,
  'gi',
);

const DAY_MONTH_HE = new RegExp(
  `(?<![\\d.])(?:(?<![${HEB}])[בל]-?)?(\\d{1,2})\\s*(?:ב|ל)?-?\\s*(${MONTH_HE_ALT})(?![${HEB}])`);
const DAY_MONTH_EN = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_EN_ALT})\\b`, 'i');
const MONTH_DAY_EN = new RegExp(`\\b(${MONTH_EN_ALT})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i');

const HE_DAY_ALT = DAYS_HE.join('|');
// "יום שני", "ביום ראשון", "ליום שישי" — any day, said as a day.
const WEEKDAY_HE_YOM = new RegExp(`(?<![${HEB}])[בל]?יום\\s+(${HE_DAY_ALT})(?![${HEB}])`);
// "בראשון", "בשבת", "לחמישי" — the preposition glued on. NOT "בשני" (that is
// "in two" as often as it is "on Monday"), and never a bare "ראשון" ("first").
const WEEKDAY_HE_GLUED = new RegExp(
  `(?<![${HEB}])[בל](ראשון|שלישי|רביעי|חמישי|שישי|שבת)(?![${HEB}])`);
const WEEKDAY_EN = new RegExp(
  `\\b(?:(?:on|by|next|this|every)\\s+)?(${DAYS_EN.join('|')})\\b`, 'i');

function monthIndexHe(name: string): number {
  const canon = name === 'מרס' ? 'מרץ' : name;
  return MONTHS_HE_LIST.indexOf(canon) + 1;
}

function monthIndexEn(name: string): number {
  const low = name.toLowerCase();
  return MONTHS_EN_LIST.findIndex((full) => full.startsWith(low.slice(0, 3))) + 1;
}

/** A real calendar day, or null (Feb 30, month 13…). */
function validDay(year: number, month: number, day: number): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(year, month - 1, day);
  return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day ? d : null;
}

function hit(today: Date, target: Date, span: DateSpan, kind: DateHit['kind']): DateHit {
  return { key: localKey(target), daysFromToday: diffDays(target, today), span, kind };
}

const spanOf = (m: RegExpMatchArray): DateSpan =>
  ({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });

/**
 * The day this sentence names, or null. First rule that matches wins, in the
 * server's order: relative words, then day.month, then a month name, then a
 * weekday.
 */
export function findDateExpression(text: string, today: Date = new Date()): DateHit | null {
  const t = String(text || '');
  if (!t.trim()) return null;
  const base = startOfDay(today);

  for (const rel of RELATIVE) {
    const m = t.match(rel.re);
    if (m) return hit(base, plusDays(base, rel.add), spanOf(m), 'relative');
  }
  const n = t.match(IN_N_DAYS);
  if (n) return hit(base, plusDays(base, parseInt(n[1] ?? n[2], 10)), spanOf(n), 'relative');

  NUMERIC.lastIndex = 0;
  let num: RegExpExecArray | null;
  while ((num = NUMERIC.exec(t)) !== null) {
    const day = parseInt(num[1], 10);
    const month = parseInt(num[2], 10);
    let year = num[3] ? parseInt(num[3], 10) : base.getFullYear();
    if (year < 100) year += 2000;
    let target = validDay(year, month, day);
    if (!target) continue;                                  // "13.30" — keep looking
    if (diffDays(target, base) < 0 && !num[3]) target = validDay(year + 1, month, day);
    if (target) return hit(base, target, spanOf(num), 'numeric');
  }

  let day = 0;
  let month = 0;
  let mm: RegExpMatchArray | null = t.match(DAY_MONTH_HE);
  if (mm) { day = parseInt(mm[1], 10); month = monthIndexHe(mm[2]); }
  else {
    mm = t.match(DAY_MONTH_EN);
    if (mm) { day = parseInt(mm[1], 10); month = monthIndexEn(mm[2]); }
    else {
      mm = t.match(MONTH_DAY_EN);
      if (mm) { day = parseInt(mm[2], 10); month = monthIndexEn(mm[1]); }
    }
  }
  if (mm && day && month) {
    let target = validDay(base.getFullYear(), month, day);
    if (target && diffDays(target, base) < 0) target = validDay(base.getFullYear() + 1, month, day);
    if (target) return hit(base, target, spanOf(mm), 'month');
  }

  const weekday = (index: number, span: DateSpan): DateHit => {
    const delta = (((index - pyWeekday(base)) % 7) + 7) % 7 || 7;     // never today
    return hit(base, plusDays(base, delta), span, 'weekday');
  };
  const wh = t.match(WEEKDAY_HE_YOM) || t.match(WEEKDAY_HE_GLUED);
  if (wh) return weekday(DAYS_HE.indexOf(wh[1]), spanOf(wh));
  const we = t.match(WEEKDAY_EN);
  if (we) return weekday(DAYS_EN.indexOf(we[1].toLowerCase()), spanOf(we));
  return null;
}

/** Just the day, for callers that do not need the words (the golden test). */
export function resolveDateExpression(text: string, today: Date = new Date()): string | null {
  return findDateExpression(text, today)?.key ?? null;
}

const WEEKDAY_SHORT_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_SHORT_HE = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'שבת'];

/** "Today" / "Tomorrow" / "Sun 18.10" — what a date chip says. Both languages. */
export function describeDate(key: string, today: Date, he: boolean): string {
  const [y, m, d] = key.split('-').map(Number);
  if (!y || !m || !d) return key;
  const target = new Date(y, m - 1, d);
  const delta = diffDays(target, today);
  if (delta === 0) return he ? 'היום' : 'Today';
  if (delta === 1) return he ? 'מחר' : 'Tomorrow';
  const dm = `${d}.${m}`;
  return he
    ? `יום ${WEEKDAY_SHORT_HE[target.getDay()]} ${dm}`
    : `${WEEKDAY_SHORT_EN[target.getDay()]} ${dm}`;
}
