/**
 * interviewBrief — which interviews get a brief, and what the card says when
 * it cannot.
 *
 * Koral, 17.10, the evening before an interview: "do you want to prepare?
 * what about collecting knowledge about the interviewer? about the job!
 * search for questions that were asked there."
 *
 * Until then the brief was drawn for ONE thing: whatever the gold "next up"
 * pill pointed at. Tomorrow's 13:30 interview is not next while today still
 * has things in it, so it was never researched, and the chip she would have
 * tapped did not exist. This file decides WHICH interviews are worth
 * researching (the next two, within three days — each costs Tavily searches
 * and a model call) and WHAT TO SAY when the server could not make a brief.
 *
 * THE SILENT-STATE RULE, applied. For an interview the answer "no brief" is
 * never drawn as "no card": the server returns a reason (no company on the
 * event, search down, nothing citable) and `briefReasonLine` turns it into a
 * sentence in both languages. The one case that is still null — the phone
 * could not reach the server at all — is turned into the reason `unreachable`
 * by the service, so nothing arrives here as a bare null.
 *
 * Pure. tests/run-interview-brief.ts covers every branch with no network.
 */
import { Task } from '../types/index';
import { isInterview } from './interviewPrep';
import { isSameMeeting } from './calendarEventTask';
import { timeOf } from './dayPlanning';
import { timeToMinutes } from './timeUtils';

/** Interviews researched at once. Each costs up to six searches and a model call. */
export const MAX_INTERVIEW_BRIEFS = 2;
/** Today plus the next two days: far enough for the D-2 study block, no further. */
export const INTERVIEW_BRIEF_DAYS = 3;

const isDone = (t: Task): boolean => t.status === 'complete' || t.status === 'moved';
const isCalendarRow = (t: Task): boolean => /^(gcal|dcal|ocal)-/.test(t.id || '');

/** YYYY-MM-DD, `n` local days later. */
export function addDaysKey(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const out = new Date(y, (m || 1) - 1, (d || 1) + n);
  return `${out.getFullYear()}-${String(out.getMonth() + 1).padStart(2, '0')}-${String(out.getDate()).padStart(2, '0')}`;
}

function byWhen(a: Task, b: Task): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const ta = timeOf(a) || '99:99';
  const tb = timeOf(b) || '99:99';
  if (ta !== tb) return ta < tb ? -1 : 1;
  // The calendar's row owns the meeting (it carries the event id the brief is
  // looked up by); then the older row.
  return Number(isCalendarRow(b)) - Number(isCalendarRow(a)) || (a.createdAt ?? 0) - (b.createdAt ?? 0);
}

/**
 * The first interview of ONE day that is still ahead — "tomorrow's first
 * interview". Done and moved rows never qualify, nor do our own study blocks
 * (isInterview refuses them: their titles say "interview" and they are not one).
 */
export function pickInterviewForDate(tasks: Task[], date: string): Task | null {
  return tasks.filter((t) => t.date === date && !isDone(t) && isInterview(t)).sort(byWhen)[0] ?? null;
}

/**
 * The interviews worth researching now: from today through `days` days, not
 * started, at most `max`, twins collapsed (the calendar row and the one she
 * typed are ONE interview, and researching both would bill twice).
 */
export function pickUpcomingInterviews(
  all: Task[], nowMs: number, today: string,
  days = INTERVIEW_BRIEF_DAYS, max = MAX_INTERVIEW_BRIEFS,
): Task[] {
  const last = addDaysKey(today, days - 1);
  const nowDate = new Date(nowMs);
  const nowHHMM = `${String(nowDate.getHours()).padStart(2, '0')}:${String(nowDate.getMinutes()).padStart(2, '0')}`;
  const picked: Task[] = [];
  const candidates = all
    .filter((t) => t.date && t.date >= today && t.date <= last && !isDone(t) && isInterview(t))
    .filter((t) => {
      // Today's interview whose time has gone is a thing to remember, not prepare.
      const time = timeOf(t);
      return !(t.date === today && time && timeToMinutes(time) <= timeToMinutes(nowHHMM));
    })
    .sort(byWhen);
  for (const t of candidates) {
    if (picked.some((p) => isSameMeeting(p, t) || (p.date === t.date && Boolean(timeOf(p)) && timeOf(p) === timeOf(t)))) continue;
    picked.push(t);
    if (picked.length >= max) break;
  }
  return picked;
}

/** A study block that exists for an interview — the one "⏱" on the chip points at. */
export interface PrepSlot { date: string; time: string; minutes: number }

/**
 * The next study block still ahead for this interview, from the blocks
 * utils/interviewPrep already minted. Nothing is invented here: if no block
 * exists (booked an hour ago, or the morning window does not fit) there is no
 * slot and the chip simply does not promise one.
 */
export function prepSlotFor(interview: Task, all: Task[], today: string, nowHHMM: string): PrepSlot | null {
  const mine = all.filter((t) => {
    const parent = (t as { prepForTaskId?: string }).prepForTaskId;
    return (parent === interview.id || (t.id || '').endsWith(`-${interview.id}`) && /^prep-\d+d-/.test(t.id || ''))
      && !isDone(t) && t.date >= today && Boolean(timeOf(t));
  });
  const ahead = mine
    .filter((t) => !(t.date === today && timeToMinutes(timeOf(t)!) < timeToMinutes(nowHHMM)))
    .sort(byWhen)[0];
  return ahead ? { date: ahead.date, time: timeOf(ahead)!, minutes: ahead.durationMinutes || 0 } : null;
}

// ── words ───────────────────────────────────────────────────────────────────

/** Why there is no brief — one short sentence, both languages. */
export function briefReasonLine(reason: string | undefined, he: boolean): string {
  switch (reason) {
    case 'no_company':
    case 'nothing_to_research':
      return he ? 'לא מצאתי מידע על החברה — חסר שם חברה באירוע'
        : "I couldn't find info on the company — the event has no company name";
    case 'search_not_configured':
      return he ? 'החיפוש לא זמין כרגע — אין לי מאיפה להביא מידע'
        : 'Search is unavailable right now — nothing to fetch from';
    case 'search_failed':
      return he ? 'החיפוש נכשל כרגע — אפשר לרענן עוד מעט'
        : 'The search failed just now — refresh in a moment';
    case 'no_sources':
      return he ? 'החיפוש לא החזיר שום דבר על החברה'
        : 'The search found nothing about the company';
    case 'compose_failed':
      return he ? 'לא הצלחתי לסכם את מה שמצאתי — אפשר לרענן'
        : "I couldn't summarise what I found — refresh to retry";
    case 'nothing_cited':
      return he ? 'מצאתי עמודים, אבל אף שורה לא נתמכה במקור — לא מנחשת'
        : "I found pages, but no line could be tied to a source — I won't guess";
    case 'unreachable':
      return he ? 'אין חיבור לשרת של מאירה — אפשר לרענן כשיש רשת'
        : "Can't reach Meira's server — refresh when you're online";
    case 'no_event':
      return he ? 'אין מספיק פרטים באירוע' : 'The event has too little detail';
    default:
      return he ? 'לא הצלחתי להכין תדריך' : "I couldn't prepare a brief";
  }
}

export type InterviewSection = 'role' | 'likely_questions' | 'prep';

/**
 * What an EMPTY interview section says. `[]` could mean "nobody reported any"
 * or "the brief never looked"; the server names the sections that came out
 * empty (`missing`) and this is the sentence for each.
 */
export function missingLine(section: InterviewSection, he: boolean): string {
  switch (section) {
    case 'likely_questions':
      return he ? 'לא מצאתי שאלות שדווחו על הראיון הזה' : 'I found no reported questions for this interview';
    case 'role':
      return he ? 'לא מצאתי מידע על התפקיד' : 'I found nothing about the role';
    default:
      return he ? 'אין עדיין צעדי הכנה מהחומר שמצאתי' : 'No prep steps came out of what I found';
  }
}

const dayWord = (date: string, today: string, he: boolean): string => {
  if (date === today) return he ? 'היום' : 'today';
  if (date === addDaysKey(today, 1)) return he ? 'מחר' : 'tomorrow';
  const [, m, d] = date.split('-');
  return `${Number(d)}.${Number(m)}`;
};

/**
 * The line under an interview's card.
 *
 * "Want to prepare?" is the question she was asked in her own words; the
 * answer is one tap away (📄) and the time already set aside for it (⏱) is
 * the study block interviewPrep put on her day — named only when it exists.
 * When the brief could not be made the chip is still there, and says so: a
 * missing chip is exactly how "nothing to research" looked like "all fine".
 */
export function interviewChipLabel(
  he: boolean,
  opts: { ok: boolean; prep?: PrepSlot | null; today: string },
): string {
  if (!opts.ok) {
    return he ? '📄 תדריך לראיון — למה אין? ›' : '📄 Interview brief — why none? ›';
  }
  const slot = opts.prep
    ? ` · ⏱ ${he ? 'הכנה' : 'prep'} ${dayWord(opts.prep.date, opts.today, he)} ${opts.prep.time}`
    : '';
  return he ? `רוצה להתכונן? 📄 תדריך${slot} ›` : `Prepare? 📄 Brief${slot} ›`;
}

/** The chip on a study block: it opens the brief of the interview it is for. */
export function prepBlockChipLabel(he: boolean, ok: boolean): string {
  if (!ok) return he ? '📄 תדריך לראיון — למה אין? ›' : '📄 Interview brief — why none? ›';
  return he ? '📄 תדריך לראיון ›' : '📄 Interview brief ›';
}

/** Every other calendar event of tomorrow and the rest of today, for the day-before brief (see MeetingBriefService.upcomingEventBriefs). */
export const MAX_EVENT_BRIEFS = 6;
export const FROM_CALENDAR_RE = /^(gcal|dcal|ocal)-/;

export function pickEventsToBrief(all: Task[], today: string, tomorrow: string, nowHHMM: string): Task[] {
  return all
    .filter((t) => (t.date === tomorrow || t.date === today)
      && (Boolean(t.calendarEventId) || FROM_CALENDAR_RE.test(t.id))
      && t.status !== 'complete' && t.status !== 'moved'
      && !isInterview(t)
      && !(t.date === today && (t.fixedTime || t.scheduledTime || '') <= nowHHMM && Boolean(t.fixedTime || t.scheduledTime)))
    .sort((a, b) => `${a.date} ${a.fixedTime || a.scheduledTime || '99:99'}`.localeCompare(`${b.date} ${b.fixedTime || b.scheduledTime || '99:99'}`))
    .slice(0, MAX_EVENT_BRIEFS);
}
