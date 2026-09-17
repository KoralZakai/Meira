/**
 * ScheduleQueryService — answering a question about the diary EXACTLY.
 *
 * Two questions, both of which were previously either turned into a task or
 * handed to a model that guessed:
 *
 *   "What do I have to do on Tuesday 1/9?"
 *       → the day, read back in clock order, with the leave time for anything
 *         that needs travelling to.
 *
 *   "Can I have a 2-hour meeting in Haifa on 2/9 at 14:00?"
 *       → a yes or a no, and the reason. The reason is the part that matters,
 *         and it is arithmetic, not opinion: does the block overlap something;
 *         can she GET there from wherever the previous appointment leaves her;
 *         can she get from there to whatever comes next. Travel is asked of
 *         Google for that date and hour, not assumed.
 *
 * A "no" always comes with the nearest window that WOULD work, because
 * "no" on its own sends her back to the calendar to do the search by hand.
 *
 * Her standing week counts as much as the diary does: a 16:00 school run is
 * never written down as a task, so a purely calendar-based "yes, 16:00 is
 * free" is exactly the answer that gets someone in trouble. Constrained hours
 * are removed from the windows, and a request that lands on one is refused by
 * name (utils/routines).
 *
 * When the travel legs can't be checked (no Maps key, no home address, no
 * network) the answer says so instead of quietly pretending the road is
 * clear — a confident wrong yes is how you miss a meeting.
 *
 * Dependencies: scheduleQuestion (parsing), findGaps, routines, TaskStorage,
 * UserProfileStorage, TravelEstimator. Consumed by screens/CoachChatScreen.
 */
import { AppLanguage, Task, TaskLocation, UserProfile } from '../types/index';
import { fitsInDay, findDayGaps } from '../utils/findGaps';
import { addMinutes, formatShortDate, getTodayString, timeToMinutes } from '../utils/timeUtils';
import { normalizeProfile } from '../utils/profileShape';
import {
  FeasibilityQuestion, DayAgendaQuestion, ScheduleQuestion, parseScheduleQuestion,
} from '../utils/scheduleQuestion';
import { Routine, constrainGaps, routinesForDate } from '../utils/routines';
import { loadRoutines } from './GapFillService';
import { getTasksForDate } from './TaskStorage';
import { loadProfile } from './UserProfileStorage';
import { travelBetween } from './TravelEstimator';

export interface QueryAnswer {
  text: string;
  /** What was asked, for the caller's logs/telemetry. */
  question: Exclude<ScheduleQuestion, null>;
}

const asLoc = (t?: Task): TaskLocation | undefined =>
  t && t.location && typeof t.location === 'object' ? (t.location as TaskLocation) : undefined;

/** A task's place as an address Google can route to, if it has one. */
function placeOf(task?: Task): string | undefined {
  const loc = asLoc(task);
  if (loc) return loc.address || loc.displayName || undefined;
  if (task && typeof task.location === 'string' && task.location.trim()) return task.location;
  return undefined;
}

const timeOf = (t: Task): string | undefined => t.fixedTime || t.scheduledTime || undefined;

/**
 * Travel minutes between two addresses, or null when it cannot be established
 * at all. Delegates to TravelEstimator, which asks Google first and falls back
 * to a coordinate estimate — shared with the free-window suggestions so both
 * answers use the same numbers and the same cache.
 */
async function travelMinutes(
  from: string | undefined,
  to: string | undefined,
  arriveBy: string,
  date: string,
  profile: UserProfile,
): Promise<number | null> {
  if (!from || !to) return null;
  const estimate = await travelBetween(
    { address: from }, { address: to }, arriveBy, date, profile,
  ).catch(() => null);
  return estimate ? estimate.minutes : null;
}

/** "Tue 1/9" — the date, said the way she asked it. */
function dateLabel(date: string, language: AppLanguage): string {
  return formatShortDate(date, language);
}

/** The day, read back in clock order. */
export async function answerDayAgenda(
  q: DayAgendaQuestion,
  language: AppLanguage,
): Promise<QueryAnswer> {
  const he = language === 'he';
  const tasks = (await getTasksForDate(q.date).catch(() => [] as Task[]))
    .filter((t) => t.status !== 'moved');

  if (!tasks.length) {
    return {
      question: q,
      text: he
        ? `${dateLabel(q.date, language)} פנוי לגמרי — אין כלום ביומן ✨`
        : `${dateLabel(q.date, language)} is completely clear — nothing in the diary ✨`,
    };
  }

  const timed = tasks.filter(timeOf).sort((a, b) => timeToMinutes(timeOf(a)!) - timeToMinutes(timeOf(b)!));
  const untimed = tasks.filter((t) => !timeOf(t));

  const lines = timed.map((t) => {
    const leave = asLoc(t)?.leaveHomeBy;
    const where = placeOf(t);
    return `${timeOf(t)} · ${t.text}`
      + (where ? ` 📍${where}` : '')
      + (leave ? (he ? ` (יציאה ${leave})` : ` (leave ${leave})`) : '');
  });
  for (const t of untimed) lines.push(he ? `ללא שעה · ${t.text}` : `no time set · ${t.text}`);

  const head = he
    ? `${dateLabel(q.date, language)} — ${tasks.length} דברים:`
    : `${dateLabel(q.date, language)} — ${tasks.length} thing${tasks.length === 1 ? '' : 's'}:`;

  return { question: q, text: [head, ...lines].join('\n') };
}

/** Does [start, start+minutes) collide with anything already on that day? */
function collisions(tasks: Task[], start: string, minutes: number): Task[] {
  const from = timeToMinutes(start);
  const to = from + minutes;
  return tasks.filter((t) => {
    const s = timeOf(t);
    if (!s) return false;
    const tStart = timeToMinutes(s);
    const tEnd = tStart + (t.durationMinutes || 30);
    return tStart < to && tEnd > from;
  });
}

/** Yes/no, with the arithmetic behind it. */
export async function answerFeasibility(
  q: FeasibilityQuestion,
  language: AppLanguage,
): Promise<QueryAnswer> {
  const he = language === 'he';
  const today = getTodayString();
  const profile = normalizeProfile(await loadProfile().catch(() => null));
  const tasks = (await getTasksForDate(q.date).catch(() => [] as Task[]))
    .filter((t) => t.status !== 'moved' && t.status !== 'complete');

  const dayStart = profile?.defaultWakeTime || '08:00';
  const dayEnd = (profile as any)?.sleepTime || '22:00';
  const routines: Routine[] = await loadRoutines().catch(() => []);
  const gaps = constrainGaps(
    findDayGaps(tasks, {
      dayStart,
      dayEnd,
      now: q.date === today ? new Date().toTimeString().slice(0, 5) : undefined,
      minMinutes: 15,
    }),
    routines,
    q.date,
  );
  // The obligations that own part of THIS date — the pickup, the standing
  // shift. They are not tasks, so nothing else in this file would see them.
  const obligations = routinesForDate(routines, q.date)
    .filter((r) => r.kind === 'constraint' && r.time);

  const home = profile?.homeAddress;
  const what = q.what || (he ? 'זה' : 'that');
  const where = q.place;

  // ── An hour was named: check THAT block. ───────────────────────────────────
  if (q.startTime) {
    const startTime = q.startTime;
    const end = addMinutes(startTime, q.minutes);
    const clash = collisions(tasks, startTime, q.minutes);

    // Who she is with before and after — those are the travel legs.
    const before = [...tasks]
      .filter((t) => timeOf(t) && addMinutes(timeOf(t)!, t.durationMinutes || 30) <= startTime)
      .sort((a, b) => (timeOf(a)! < timeOf(b)! ? 1 : -1))[0];
    const after = [...tasks]
      .filter((t) => timeOf(t) && timeOf(t)! >= end)
      .sort((a, b) => (timeOf(a)! < timeOf(b)! ? -1 : 1))[0];

    const [inbound, outbound] = await Promise.all([
      travelMinutes(placeOf(before) || home, where, startTime, q.date, profile as UserProfile),
      after
        ? travelMinutes(where, placeOf(after) || home, timeOf(after)!, q.date, profile as UserProfile)
        : Promise.resolve(null),
    ]);

    const problems: string[] = [];
    const standing = obligations.find((r) =>
      timeToMinutes(r.time!) < timeToMinutes(end)
      && timeToMinutes(addMinutes(r.time!, r.durationMinutes)) > timeToMinutes(startTime));
    if (standing) {
      problems.push(he
        ? `זה נופל על "${standing.text}" (${standing.time})`
        : `that's your "${standing.text}" (${standing.time})`);
    }
    if (clash.length) {
      problems.push(he
        ? `זה מתנגש עם "${clash[0].text}" ב-${timeOf(clash[0])}`
        : `it clashes with "${clash[0].text}" at ${timeOf(clash[0])}`);
    }
    if (before && inbound !== null) {
      const freeFrom = addMinutes(timeOf(before)!, before.durationMinutes || 30);
      if (timeToMinutes(freeFrom) + inbound > timeToMinutes(startTime)) {
        problems.push(he
          ? `"${before.text}" נגמר ב-${freeFrom} ו-${inbound} דק׳ נסיעה לא מספיקים`
          : `"${before.text}" ends at ${freeFrom} and the ${inbound}-min trip won't make it`);
      }
    }
    if (after && outbound !== null) {
      if (timeToMinutes(end) + outbound > timeToMinutes(timeOf(after)!)) {
        problems.push(he
          ? `לא תגיעי מ${where} ל"${after.text}" ב-${timeOf(after)} (${outbound} דק׳ נסיעה)`
          : `you wouldn't get from ${where} to "${after.text}" at ${timeOf(after)} (${outbound} min away)`);
      }
    }

    if (!problems.length) {
      const travelNote = inbound !== null && before
        ? (he ? ` נסיעה ${inbound} דק׳ מ"${before.text}".` : ` ${inbound} min from "${before.text}".`)
        : (inbound === null && where
          ? (he ? ' לא הצלחתי לבדוק את זמן הנסיעה.' : " I couldn't check the travel time.")
          : '');
      return {
        question: q,
        text: he
          ? `כן — ${startTime}–${end} פנוי${where ? ` ב${where}` : ''}.${travelNote}`
          : `Yes — ${startTime}–${end} is free${where ? ` in ${where}` : ''}.${travelNote}`,
      };
    }

    // No. Offer the nearest window that does work.
    const alternatives = fitsInDay(gaps, q.minutes, inbound ?? 0, outbound ?? 0);
    const alt = alternatives[0];
    return {
      question: q,
      text: (he
        ? `לא ב-${startTime} — ${problems[0]}.`
        : `Not at ${startTime} — ${problems[0]}.`)
        + (alt
          ? (he ? ` ${alt.start} כן עובד.` : ` ${alt.start} works.`)
          : (he ? ' אין חלון מתאים באותו יום.' : ' No window that day fits.')),
    };
  }

  // ── No hour named: find her one. ───────────────────────────────────────────
  const inbound = await travelMinutes(home, where, dayStart, q.date, profile as UserProfile);
  const options = fitsInDay(gaps, q.minutes, inbound ?? 0, inbound ?? 0);
  if (!options.length) {
    return {
      question: q,
      text: he
        ? `${dateLabel(q.date, language)} אין חלון של ${q.minutes} דק׳ ל${what}.`
        : `No ${q.minutes}-min window for ${what} on ${dateLabel(q.date, language)}.`,
    };
  }
  const best = options[0];
  const travelNote = inbound !== null && where
    ? (he ? ` (${inbound} דק׳ נסיעה)` : ` (${inbound} min travel)`)
    : '';
  return {
    question: q,
    text: he
      ? `כן — ${best.start}–${best.end} פנוי ב${dateLabel(q.date, language)}${where ? ` ל${where}` : ''}.${travelNote}`
      : `Yes — ${best.start}–${best.end} is free on ${dateLabel(q.date, language)}${where ? ` for ${where}` : ''}.${travelNote}`,
  };
}

/**
 * The single entry point: is this message one of the two questions, and if so
 * what is the answer? Returns null when it is not — the caller then handles
 * the message exactly as it did before.
 */
export async function tryAnswerScheduleQuestion(
  text: string,
  language: AppLanguage,
  today = getTodayString(),
): Promise<QueryAnswer | null> {
  const question = parseScheduleQuestion(text, today);
  if (!question) return null;
  return question.kind === 'day_agenda'
    ? answerDayAgenda(question, language)
    : answerFeasibility(question, language);
}
