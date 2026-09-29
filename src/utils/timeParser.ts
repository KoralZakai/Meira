/**
 * Pure time expression parser - no dependencies
 * Works in both React Native and Node.js
 */

export interface TimeExpression {
  type: 'fixed_time' | 'deadline' | 'recurring' | 'relative' | 'none';
  fixedTime?: string; // HH:MM (start)
  endTime?: string; // HH:MM (end of a "from X to Y" range)
  durationMinutes?: number; // length of a parsed time range
  deadline?: string; // YYYY-MM-DD
  recurringDays?: number; // 5 days, 7 days, etc.
  recurringType?: 'daily' | 'weekly' | 'monthly';
  recurringEndDate?: string; // YYYY-MM-DD
  daysFromNow?: number; // for relative dates
  display?: string; // human readable
}

/**
 * YYYY-MM-DD on the LOCAL calendar.
 *
 * `toISOString().split('T')[0]` is UTC: at 01:00 in Israel (UTC+3) it is still
 * yesterday in UTC, so "מחר" typed after midnight came back as today. Every
 * relative date here goes through this instead.
 */
function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Parse time expressions like "tomorrow", "in 2 days", "at 10am", "by Friday", etc.
 */
/**
 * Relative-date detection, shared so a sentence can carry BOTH a date and a
 * time. Returns days-from-now, or null.
 *
 * The parser is a chain of early returns, so "tomorrow yoga at 11:00" used to
 * come back as a bare 11:00 with no date, and "מחר יוגה ב-11:00" as a bare
 * date with no time. One sentence, one of its two facts silently dropped.
 */
function detectRelativeDays(text: string): number | null {
  if (/day\s+after\s+tomorrow/i.test(text) || /מחרתיים/.test(text)) return 2;
  if (/tomorrow/i.test(text) || /מחר/.test(text)) return 1;
  if (/(?:בעוד|עוד)\s*שבוע/.test(text) || /שבוע\s*הבא/.test(text)) return 7;
  if (/(?:בעוד|עוד)\s*יומיים/.test(text)) return 2;
  const en = text.match(/in\s+(\d+)\s+days?/i) || text.match(/(?:בעוד|עוד)\s*(\d+)\s*ימים?/);
  if (en) return parseInt(en[1], 10);
  const wk = text.match(/in\s+(\d+)\s+weeks?/i) || text.match(/(?:בעוד|עוד)\s*(\d+)\s*שבועות?/);
  if (wk) return parseInt(wk[1], 10) * 7;
  return null;
}

/**
 * A single clock time, English or Hebrew.
 *
 * Hebrew had no pattern at all: "יוגה ב-11:00" parsed to nothing, because the
 * only rule was /\b(at|by)\s+…/. `ב-?` is anchored on a following digit so it
 * cannot fire inside ordinary words ("ביגאל", "בעוד").
 */
const MONTHS_HE = 'ינואר|פברואר|מרץ|מרס|אפריל|מאי|יוני|יולי|אוגוסט|ספטמבר|אוקטובר|נובמבר|דצמבר';
const MONTHS_EN = 'january|february|march|april|may|june|july|august|september|october'
  + '|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec';

function detectFixedTime(text: string): string | null {
  // "ברבע ל-9" — a quarter to nine. Checked first: it names the NEXT hour.
  const quarterTo = text.match(/(?:ב)?רבע\s*ל-?\s*(\d{1,2})(?![\d:])/);
  // The ב must START a word: "רחוב 8" is an address, not eight o'clock.
  // A number followed by a month is a DAY: "מילואים ב 8 באוקטובר" read as
  // 08:00. Mirrors task_extract._bare_hour / tz.MONTH_WORD_AFTER.
  const prep = text.match(new RegExp(
    String.raw`(?:\b(?:at|by)\s+|בשעה\s*|(?<![\u0590-\u05FF])ב-?\s*(?=\d))(\d{1,2})(?::(\d{2}))?`
    + String.raw`(?!\d)(?!\s*(?:ב|ל)?-?\s*(?:${MONTHS_HE})(?![\u0590-\u05FF])|(?:st|nd|rd|th)?\s+(?:of\s+)?(?:${MONTHS_EN})\b)`
    + String.raw`\s*(?:am|pm|a\.m\.|p\.m\.)?`,
    'i',
  ));
  // "ב 8 וחצי", "ב-7 ורבע" — how the half and the quarter are actually said.
  // Without this, "קיקבוקס ב 8 וחצי" kept the 8 and lost the half hour.
  const spokenMinute = (match: RegExpMatchArray | null): number | null => {
    if (!match || match[2] != null || match.index == null) return null;
    const tail = text.slice(match.index + match[0].length);
    if (/^\s*ו?חצי/.test(tail)) return 30;
    if (/^\s*ו?רבע/.test(tail)) return 15;
    return null;
  };
  if (quarterTo && (!prep || (quarterTo.index ?? 0) <= (prep.index ?? 0))) {
    return detectFixedTime(text.replace(quarterTo[0], `ב-${parseInt(quarterTo[1], 10) - 1}:45`));
  }
  const spoken = spokenMinute(prep);
  if (prep && spoken != null) {
    return detectFixedTime(text.replace(prep[0], `ב-${prep[1]}:${spoken}`).replace(/\s*ו?(?:חצי|רבע)/, ''));
  }
  const m = prep
    // A BARE CLOCK TIME, with no preposition in front of it.
    //
    // Every pattern above needs one — "at", "by", "בשעה", or the Hebrew ב
    // glued to the number. Hebrew therefore always has one ("ב 11"), and
    // English very often does not: "yoga tomorrow 11:00 at Yigal Alon 94"
    // parsed the place and lost the hour, while the identical Hebrew sentence
    // kept both.
    //
    // Koral, 2026-09-17: "All features must support both english and Hebrew —
    // the language doesn't matter, the behavior!" She is right, and this was a
    // case where the behaviour quietly did depend on it.
    //
    // A COLON is required. "yoga 11" could be eleven of something; "11:00" is
    // a clock and nothing else, which is what makes this safe to accept with
    // no preposition at all.
    || text.match(/\b(\d{1,2}):(\d{2})\b/);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  if (hour > 23 || minute > 59) return null;

  hour = to24h(hour, meridiemOf(text));
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * Which half of the day a phrase names. 'night' is its own answer: "11 בלילה"
 * is 23:00 but "1 בלילה" is 01:00 — treating בלילה as "pm" put a 1 a.m. call
 * at 13:00. Mirrors task_extract._meridiem on the server.
 */
type Meridiem = 'am' | 'pm' | 'night' | '';
function meridiemOf(text: string): Meridiem {
  // "3pm" has no \b between the 3 and the p, and a bare /am/ fired inside
  // "team" — so: not preceded or followed by another letter.
  if (/(?<![a-z])(?:pm|p\.m\.)(?![a-z])/i.test(text) || /בערב|אחה["״]?צ|אחר\s*הצהריים|בצהריים/.test(text)) return 'pm';
  if (/בלילה|tonight/i.test(text)) return 'night';
  if (/(?<![a-z])(?:am|a\.m\.)(?![a-z])/i.test(text) || /בבוקר/.test(text)) return 'am';
  return '';
}

/**
 * A spoken hour → 24h. With no marker, 1–6 is the afternoon ("ב6" is 18:00:
 * nobody books a workout at six in the morning by saying just "six").
 */
function to24h(hour: number, mer: Meridiem): number {
  if (mer === 'pm') return hour < 12 ? hour + 12 : hour;
  if (mer === 'night') return hour >= 6 && hour < 12 ? hour + 12 : hour === 12 ? 0 : hour;
  if (mer === 'am') return hour === 12 ? 0 : hour;
  return hour >= 1 && hour <= 6 ? hour + 12 : hour;
}

export function parseTimeExpression(text: string, referenceDate: string = getTodayString()): TimeExpression {
  console.log('[TIME_PARSER] Parsing:', text);

  if (!text || text.trim().length < 2) {
    return { type: 'none' };
  }

  const lower = text.toLowerCase();
  const ref = new Date(referenceDate);

  // First check for explicit dates - MUST come before fixed time
  const dateMatch = text.match(/(?:on\s+)?(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (dateMatch) {
    let [, month, day, year] = dateMatch;
    if (year.length === 2) year = '20' + year;
    const deadline = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    console.log('[TIME_PARSER] Explicit date detected:', deadline);

    // Also check if there's a fixed time with this date
    const timeMatch = text.match(/(\d{1,2}):?(\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?/i);
    if (timeMatch) {
      let hour = parseInt(timeMatch[1], 10);
      const minute = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
      if (text.match(/pm|p\.m\./i) && hour < 12) hour += 12;
      if (text.match(/am|a\.m\./i) && hour === 12) hour = 0;
      const fixedTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
      return { type: 'deadline', deadline, fixedTime, display: `on ${deadline} at ${fixedTime}` };
    }

    return { type: 'deadline', deadline, display: `on ${deadline}` };
  }

  // 0. Check for a time RANGE first: "from 15:00 to 23:00", "15:00-23:00",
  //    "between 2pm and 6pm", "9 to 11am". Must come before the single fixed-time
  //    check so the start time isn't grabbed on its own.
  // Hebrew connectors included: "מ20:00 עד 00:00", "בין 14:00 ל-16:00".
  // Hebrew markers count as much as am/pm: "אימון ב 6 בערב עד 8 בערב" was
  // read as a single 18:00 with no length, because only English ones did. The
  // ב/בשעה in front of the first number is what makes "ב6 עד 7" a clock
  // rather than a count.
  const MER = String.raw`(am|pm|a\.m\.|p\.m\.|בערב|בבוקר|בלילה|בצהריים|אחה["״]?צ)?`;
  const rangeMatch = text.match(new RegExp(
    String.raw`(from\s+|between\s+|(?<![֐-׿])(?:ב|בשעה|מ)-?\s*|בין\s+)?(\d{1,2})(?::(\d{2}))?\s*${MER}\s*`
    + String.raw`(?:-|–|—|to|until|till|and|עד|ל-?)\s*(\d{1,2})(?::(\d{2}))?(?!\d)\s*${MER}`
    + String.raw`(?!\s*(?:שעות|דקות|ימים|שבועות|hours?|mins?|minutes?|days?|weeks?))`,
    'i',
  ));
  if (rangeMatch) {
    const hadPrep = Boolean(rangeMatch[1]);
    const startHadMin = rangeMatch[3] != null;
    const endHadMin = rangeMatch[6] != null;
    const startMer = meridiemOf(rangeMatch[4] || '');
    const endMer = meridiemOf(rangeMatch[7] || '');
    // Avoid false positives like "2 to 3 days": only treat as a time range when
    // at least one side has minutes (a colon), a day-half marker, or a
    // preposition that makes it a clock.
    if (startHadMin || endHadMin || startMer || endMer || hadPrep) {
      const startH = to24h(parseInt(rangeMatch[2], 10), startMer || endMer);
      const startMin = startHadMin ? parseInt(rangeMatch[3], 10) : 0;
      let endH = to24h(parseInt(rangeMatch[5], 10), endMer || startMer);
      // "ב6 עד 7": the end is in the same half of the day as the start.
      if (!endMer && !startMer && startH >= 12 && endH < 12) endH += 12;
      const endMin = endHadMin ? parseInt(rangeMatch[6], 10) : 0;
      if (startH <= 23 && endH <= 23 && startMin <= 59 && endMin <= 59) {
        const fixedTime = `${String(startH).padStart(2, '0')}:${String(startMin).padStart(2, '0')}`;
        const endTime = `${String(endH).padStart(2, '0')}:${String(endMin).padStart(2, '0')}`;
        let duration = endH * 60 + endMin - (startH * 60 + startMin);
        if (duration <= 0) duration += 24 * 60; // wrap past midnight
        console.log('[TIME_PARSER] Time range detected:', fixedTime, '→', endTime, `(${duration}m)`);
        return {
          type: 'fixed_time',
          fixedTime,
          endTime,
          durationMinutes: duration,
          display: `${fixedTime} – ${endTime}`,
        };
      }
    }
  }

  // 1. Check for fixed times (at 10am, 3:30pm, 14:00, etc.)
  // But NOT if it's part of a date (already handled above)
  const fixedTime = detectFixedTime(text);
  if (fixedTime) {
    // "tomorrow yoga at 11:00" carries both facts; returning only the time
    // filed the task on TODAY.
    const relDays = detectRelativeDays(text);
    if (relDays !== null) {
      const d = new Date(ref);
      d.setDate(d.getDate() + relDays);
      console.log('[TIME_PARSER] Fixed time + relative date:', fixedTime, localDateKey(d));
      return {
        type: 'relative',
        fixedTime,
        deadline: localDateKey(d),
        daysFromNow: relDays,
        display: `${localDateKey(d)} at ${fixedTime}`,
      };
    }
    console.log('[TIME_PARSER] Fixed time detected:', fixedTime);
    return { type: 'fixed_time', fixedTime, display: `at ${fixedTime}` };
  }

  // 2. Check for recurring patterns
  const recurringMatch = text.match(/(?:every|each)\s+day|daily|for\s+(?:the\s+)?next\s+(\d+)\s+days?|for\s+(\d+)\s+days?|(\d+)\s+days?\s+in\s+a\s+row/i);
  if (recurringMatch) {
    let recurringDays = 7; // default
    if (recurringMatch[1]) recurringDays = parseInt(recurringMatch[1], 10);
    else if (recurringMatch[2]) recurringDays = parseInt(recurringMatch[2], 10);
    else if (recurringMatch[3]) recurringDays = parseInt(recurringMatch[3], 10);

    console.log('[TIME_PARSER] Recurring detected:', recurringDays, 'days');
    const endDate = new Date(ref);
    endDate.setDate(endDate.getDate() + recurringDays);

    return {
      type: 'recurring',
      recurringDays,
      recurringType: 'daily',
      recurringEndDate: endDate.toISOString().split('T')[0],
      display: `every day for ${recurringDays} days`,
    };
  }

  // 3. Check for "from today for next X days"
  const fromTodayMatch = text.match(/from\s+today\s+(?:and\s+)?for\s+(?:the\s+)?next\s+(\d+)\s+days?/i);
  if (fromTodayMatch) {
    const days = parseInt(fromTodayMatch[1], 10);
    const endDate = new Date(ref);
    endDate.setDate(endDate.getDate() + days);
    console.log('[TIME_PARSER] From today for next X days:', days);
    return {
      type: 'recurring',
      recurringDays: days,
      recurringType: 'daily',
      recurringEndDate: endDate.toISOString().split('T')[0],
      display: `starting today for ${days} days`,
    };
  }

  // 4. Check for relative dates: "in X days", "in 2 weeks", "tomorrow", "day after tomorrow"
  // IMPORTANT: Check "day after tomorrow" BEFORE "tomorrow"
  let relativeDateMatch = null;
  let daysToAdd = 0;

  // Hebrew first: "מחרתיים" contains "מחר", so the longer word must win, the
  // same reason "day after tomorrow" is tested before "tomorrow".
  if (text.match(/day\s+after\s+tomorrow/i) || /מחרתיים/.test(text)) {
    daysToAdd = 2;
    relativeDateMatch = true;
  } else if (text.match(/tomorrow/i) || /מחר/.test(text)) {
    daysToAdd = 1;
    relativeDateMatch = true;
  } else if (/(?:בעוד|עוד)\s*שבוע/.test(text) || /שבוע\s*הבא/.test(text)) {
    daysToAdd = 7;
    relativeDateMatch = true;
  } else if (/(?:בעוד|עוד)\s*יומיים/.test(text)) {
    daysToAdd = 2;
    relativeDateMatch = true;
  } else {
    relativeDateMatch = text.match(/(?:in\s+(\d+)\s+days?|in\s+(\d+)\s+weeks?)/i)
      // "בעוד 3 ימים" / "בעוד 2 שבועות"
      || text.match(/(?:בעוד|עוד)\s*(\d+)\s*ימים?/)
      || text.match(/(?:בעוד|עוד)\s*(\d+)\s*שבועות?/);
    if (relativeDateMatch) {
      const weeks = /שבוע/.test(relativeDateMatch[0] ?? '') || Boolean(relativeDateMatch[2]);
      const n = parseInt(relativeDateMatch[1] ?? relativeDateMatch[2] ?? '0', 10);
      daysToAdd = weeks ? n * 7 : n;
    }
  }

  if (relativeDateMatch) {

    const deadline = new Date(ref);
    deadline.setDate(deadline.getDate() + daysToAdd);
    const deadlineStr = localDateKey(deadline);

    // A time in the same sentence belongs to this date, not to a separate
    // parse — "מחר יוגה ב-11:00" is one appointment, not a date and an orphan.
    const withTime = detectFixedTime(text);
    console.log('[TIME_PARSER] Relative date detected:', daysToAdd, 'days from now',
      withTime ? `at ${withTime}` : '');
    return {
      type: 'relative',
      deadline: deadlineStr,
      daysFromNow: daysToAdd,
      ...(withTime ? { fixedTime: withTime } : {}),
      display: `in ${daysToAdd} days (${deadline.toLocaleDateString()})`
        + (withTime ? ` at ${withTime}` : ''),
    };
  }

  // 5. Check for day of week: "on Monday", "by Friday", "next Tuesday"
  const dayOfWeekMatch = text.match(/(?:on|by|next)\s+(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/i);
  if (dayOfWeekMatch) {
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const targetDay = days.indexOf(dayOfWeekMatch[1].toLowerCase());
    const currentDay = ref.getDay();
    let daysToAdd = (targetDay - currentDay + 7) % 7;

    // "next Monday" always means next occurrence (7 days if today is Monday)
    // "by Friday" or "on Friday" means this week's Friday (could be 0, 1, 2... days)
    if (text.match(/\bnext\s+/i) && daysToAdd === 0) {
      daysToAdd = 7; // next occurrence
    }

    const deadline = new Date(ref);
    deadline.setDate(deadline.getDate() + daysToAdd);
    const deadlineStr = localDateKey(deadline);

    console.log('[TIME_PARSER] Day of week detected:', dayOfWeekMatch[1]);
    return {
      type: 'relative',
      deadline: deadlineStr,
      daysFromNow: daysToAdd,
      display: `by ${dayOfWeekMatch[1]} (${deadline.toLocaleDateString()})`,
    };
  }

  console.log('[TIME_PARSER] No time expression detected');
  return { type: 'none' };
}

function getTodayString(): string {
  return new Date().toISOString().split('T')[0];
}
