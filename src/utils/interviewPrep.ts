/**
 * interviewPrep — an interview on the calendar means preparation days, and
 * Meira does not ask whether she would like some.
 *
 * Koral's words: "והסקה מזה שיש מחר ראיון אז מאירה מחייבת!!! ללמוד יומיים
 * לפני" — inferring from the fact that there is an interview, Meira REQUIRES
 * studying two days before. That is a rule, not a suggestion, so the prep
 * blocks are created as `must` and they are created automatically.
 *
 * WHAT THIS DOES
 *
 * For an interview at date D, three study blocks:
 *
 *   D-2   the long one. Company, role, the actual material.
 *   D-1   the short one. Review, questions to ask, what to wear, the route.
 *   D-0   the morning of, ending before she leaves the house.
 *
 * Koral, 2026-09-22: "on the interview day on the morning Meira suggests to
 * wake up early and learn before leaving home". The first two sit at a fixed
 * evening hour; the third cannot, because it is defined by the door — it ends
 * a get-ready buffer before `leaveHomeBy` and runs backwards from there. It
 * carries a `fixedTime`, which is what makes `plannedAlarmTime` derive a wake
 * hour from it, so the morning it belongs to actually starts earlier.
 *
 * Both carry the interview's own words so she knows WHICH interview she is
 * preparing for, and both link back to it by id.
 *
 * WHY IT IS PURE
 *
 * Every date and duration decision is arithmetic on strings. Keeping it out of
 * GoogleSync means the rule can be tested against a real interview without an
 * Expo runtime, a network, or a device — which is the only reason the travel
 * chain's own arithmetic is trustworthy today.
 *
 * IDEMPOTENCE
 *
 * The ids are derived from the interview's id, so running this on every sync —
 * which is what happens, every 15 minutes, forever — produces the same two
 * tasks and never a third. `mergeExternalTasks` dedups on exactly that id.
 *
 * Consumers: services/GoogleSync (after the calendar import).
 */
import { Task, TaskCategory, AppLanguage } from '../types/index';
import { timeToMinutes, minutesToTime } from './timeUtils';

const HHMM = /^\d{1,2}:\d{2}$/;

export type PrepKind = 'deep' | 'review' | 'morning';

/**
 * How long before the interview each prep block sits, how long it runs, and
 * what it is anchored to.
 *
 *   'evening'        — a fixed hour on a day that is otherwise hers.
 *   'before_leaving' — the door. Placed backwards from `leaveHomeBy`, because
 *                      "before leaving home" is not an hour, it is a deadline.
 */
export const PREP_SPEC: Array<{
  daysBefore: number;
  minutes: number;
  kind: PrepKind;
  anchor: 'evening' | 'before_leaving';
}> = [
  { daysBefore: 2, minutes: 90, kind: 'deep', anchor: 'evening' },
  { daysBefore: 1, minutes: 45, kind: 'review', anchor: 'evening' },
  { daysBefore: 0, minutes: 90, kind: 'morning', anchor: 'before_leaving' },
];

/** The hour a prep block lands on when the day is otherwise unplanned. */
const DEFAULT_PREP_TIME = '19:00';

/**
 * Between the last page of revision and the front door: dressing, eating,
 * papers, shoes. Studying up to the second she has to leave is how she leaves
 * late, so the morning block stops short of the departure on purpose.
 */
export const GET_READY_BUFFER_MIN = 30;

/** No prep block starts before this. An alarm at 04:40 is not preparation. */
export const EARLIEST_PREP_START = '06:00';

/** Below this there is no study session, only a reason to feel rushed. */
export const MIN_MORNING_PREP_MIN = 30;

/** YYYY-MM-DD, `n` days earlier, in the local calendar. */
export function daysBefore(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() - n);
  // Local, not UTC: toISOString() on a local noon rolls back a day west of
  // Greenwich. Every date key in this app is a local calendar day.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The shape of an id this file mints: `prep-<n>d-<the interview's id>`. */
const PREP_ID_RE = /^prep-(\d+)d-(.+)$/;

/**
 * The OTHER kind of prep block, and the one that kept the runaway alive.
 *
 * `services/GapFillService` offers "Prepare for: <the interview>" in a free
 * window, and accepting one calls `addTask`, which mints a RANDOM id. So it
 * carries no `prep-` id, no `prepForTaskId` — and a title containing the word
 * "interview", because the title is the interview's. Guarding our own ids was
 * not enough: the log still said `created 5 interview prep block(s)`, and the
 * three it named were "Prepare for: Your in-person in…", "Prepare for:
 * להתכונן לראיון מח…" and "Final review for להתכונן לראיו…" — our block built
 * on top of its block built on top of ours.
 *
 * GapFillService has had this exact regex since 2026-09-17, for the identical
 * reason on its own side ("Prepare for: Prepare for: …"). Same prefix, same
 * rule, stated here too.
 */
const GAPFILL_PREP_RE = /^\s*(?:prepare for|להתכונן ל)\s*:/i;

/**
 * Our OWN titles, recognised as text.
 *
 * Normally the id is enough. But `mergeExternalTasks` had a fuzzy branch that
 * absorbed an incoming task into any existing row 0.7-similar to it on the
 * same date, taking whichever text was longer — so a block of ours was written
 * INTO a GapFill row, which kept its own random id. The result is a row
 * wearing our words with none of our markers, and her log named it:
 *
 *     no morning prep for "Final review for להתכונן לראיו…"
 *
 * isInterview saw "ראיון" in it and prepared for it, every sync. The absorption
 * is stopped at source (mergeExternalTasks `fuzzyMerge: false`), but the rows
 * it already made are in her store, and the only thing left on them that is
 * still ours is the title. So the titles are a test too.
 */
const OUR_TITLES =
  'prep for the |final review for |morning study for |study for '
  + '|הכנה לראיון |חזרה אחרונה ל|לימוד בוקר ל|לימוד ל';

const OUR_TITLE_RE = new RegExp(`^\\s*(?:${OUR_TITLES})`, 'i');

/** A block that IS the preparation. Never prepare for one of these. */
export function isPrepBlock(task: Task): boolean {
  return Boolean((task as { prepForTaskId?: string }).prepForTaskId)
    || PREP_ID_RE.test(task.id || '')
    || GAPFILL_PREP_RE.test(task.text || '')
    || OUR_TITLE_RE.test(task.text || '');
}

/**
 * A prep block minted FOR a prep block — the runaway.
 *
 * `isInterview` reads the task's words, and the D-2 block's own title is
 * "Prep for the Ceva interview — company, role, questions". It contains the
 * word "interview", so it matched, so it got prep of its own. That had been
 * true for as long as the rule existed and was invisible, because both of its
 * prep days (D-2 and D-1 of a block already dated D-2) land in the past and
 * `date < today` threw them away.
 *
 * Adding the morning block removed that accident: `daysBefore: 0` lands on the
 * SAME day, which is never in the past, so every sync minted another level —
 * "Morning study for Morning study for Morning study for …", five at a time,
 * four hours of her Wednesday. CLAUDE.md rule 8, exactly: a second reader of
 * a field the first reader already writes into.
 *
 * The words cannot settle this — the id can. Every one of these was minted as
 * `prep-<n>d-<parent>`, so a nested one is a prep id whose PARENT is a prep id.
 */
export function isNestedPrep(task: Task): boolean {
  const m = PREP_ID_RE.exec(task.id || '');
  return Boolean(m && PREP_ID_RE.test(m[2]));
}

/**
 * Every runaway already written to her store, at any depth and from either
 * source — ours (`prep-0d-prep-2d-…`) or one built on a GapFill block, whose
 * parent id is random and so can only be recognised by looking the parent up.
 *
 * Deliberately does NOT sweep the GapFill blocks themselves: she accepted
 * those from a gap suggestion, and they are hers. It removes only what THIS
 * file minted on top of them.
 */
/**
 * A row whose TEXT is our title, twice or more over.
 *
 *     "Morning study for Morning study for Morning study for …"
 *     "Final review for Final review for …"
 *
 * Still on her phone after the id guards shipped, because these were never
 * minted as rows at all: `mergeExternalTasks` absorbed our block into an
 * existing row and kept the longer text, so the id is the ORIGINAL row's and
 * nothing about it says "prep" except the words. runawayPrepIds cannot reach
 * them by id or by parent, and the recursion wrote a new layer onto the same
 * row every sync.
 *
 * Two of our own prefixes in one title is not something she can type by
 * accident and not something any correct pass produces. It is the fingerprint
 * of exactly this bug, so it is safe to sweep on.
 */
export function isCorruptedPrep(task: Task): boolean {
  const text = task.text || '';
  if (!OUR_TITLE_RE.test(text)) return false;
  // The same alternation, unanchored, counted everywhere in the string.
  const hits = text.match(new RegExp(`(?:${OUR_TITLES})`, 'gi'));
  return Boolean(hits && hits.length >= 2);
}

export function runawayPrepIds(all: Task[]): string[] {
  const byId = new Map(all.map((t) => [t.id, t]));
  const out: string[] = [];
  for (const task of all) {
    if (isNestedPrep(task) || isCorruptedPrep(task)) { out.push(task.id); continue; }
    const parentId = (task as { prepForTaskId?: string }).prepForTaskId;
    if (!parentId) continue;
    const parent = byId.get(parentId);
    if (parent && isPrepBlock(parent)) out.push(task.id);
  }
  return out;
}

/** Is this task an interview we should be preparing for? */
export function isInterview(task: Task): boolean {
  // Preparation is not a thing to prepare for. This guard is what makes the
  // rule terminate at all — see isNestedPrep.
  if (isPrepBlock(task)) return false;
  if (task.category === 'interview') return true;
  // A calendar event imported before the categoriser existed is still a row in
  // her store with `meeting` on it. Read the words too, so the rule applies to
  // the interview she already has and not only to the next one.
  return /\binterview\b|ראיון/i.test(task.text || '');
}

/** The interview's short name, for the prep block's title. */
export function subjectOf(task: Task): string {
  const text = (task.text || '').trim();
  // "Your in-person interview with Ceva" → "Ceva". The company is the thing
  // she is actually studying, and it is what makes two prep blocks for two
  // different interviews tell themselves apart on a timeline.
  const withCompany = text.match(/(?:interview\s+(?:with|at|for)|ראיון\s+(?:ב|עם|אצל))\s+(.+)$/i);
  if (withCompany) return withCompany[1].replace(/[.,;].*$/, '').trim();
  return text.replace(/^your\s+/i, '').slice(0, 40).trim();
}

/**
 * The block's title. `startsAt` exists for the one case that can honestly be
 * two things: a 07:00 block IS a morning she has to get up for, and a 12:30
 * one before an afternoon appointment is not — calling both "morning study"
 * makes half of them read as a mistake, which is how a suggestion stops being
 * believed.
 */
const STRINGS: Record<AppLanguage, Record<PrepKind, (subject: string, startsAt?: string) => string>> = {
  en: {
    deep: (s) => `Prep for the ${s} interview — company, role, questions`,
    review: (s) => `Final review for ${s} — questions to ask, what to wear, the route`,
    morning: (s, at) => (isMorning(at)
      ? `Morning study for ${s} — up early, then out the door`
      : `Study for ${s} — right up until you leave`),
  },
  he: {
    deep: (s) => `הכנה לראיון ב${s} — החברה, התפקיד, שאלות`,
    review: (s) => `חזרה אחרונה ל${s} — שאלות לשאול, מה ללבוש, הדרך`,
    morning: (s, at) => (isMorning(at)
      ? `לימוד בוקר ל${s} — לקום מוקדם ואז לצאת`
      : `לימוד ל${s} — עד הרגע שיוצאים`),
  },
};

/** Before noon — the hour at which "wake up early and study" is the truth. */
const isMorning = (hhmm?: string): boolean =>
  Boolean(hhmm && HHMM.test(hhmm) && timeToMinutes(hhmm) < 12 * 60);

/**
 * The hour she has to be out of the door for this interview.
 *
 * `leaveHomeBy` when a route exists — that is the real answer, computed from
 * the actual journey. For a task with a PLACE but no route yet, this returns
 * undefined on purpose: the alternative is guessing a departure from the
 * appointment hour, and because prep blocks are idempotent by id, a guess made
 * once is frozen forever. Better to wait one sync for the real number.
 *
 * A remote interview has no journey, so its own hour IS the deadline.
 */
export function departureTimeOf(task: Task): string | undefined {
  const loc = typeof task.location === 'object' && task.location ? task.location : undefined;
  if (loc?.leaveHomeBy && HHMM.test(loc.leaveHomeBy)) return loc.leaveHomeBy;
  const placed = Boolean(
    loc?.address || loc?.displayName || (typeof task.location === 'string' && task.location),
  );
  if (placed) return undefined;           // a route is coming — do not freeze a guess
  const start = task.fixedTime || task.scheduledTime;
  return start && HHMM.test(start) ? start : undefined;
}

export interface MorningWindow { start: string; minutes: number; endsAt: string }

/**
 * The study window on the morning of the interview, or null when there is not
 * one worth waking up for.
 *
 * Runs backwards from the door: end = departure − get-ready buffer, start =
 * end − the wanted length, never earlier than EARLIEST_PREP_START and never
 * earlier than `now` on the day itself. What is left has to be at least
 * MIN_MORNING_PREP_MIN or there is no block — half an hour of revision is
 * study, ten minutes is just an earlier alarm.
 */
export function morningPrepWindow(
  interview: Task,
  wantedMinutes: number,
  opts: { now?: string } = {},
): MorningWindow | null {
  const departure = departureTimeOf(interview);
  if (!departure) return null;
  const endsAt = timeToMinutes(departure) - GET_READY_BUFFER_MIN;
  let startMin = endsAt - wantedMinutes;
  const floor = timeToMinutes(EARLIEST_PREP_START);
  if (startMin < floor) startMin = floor;
  // On the day itself, a window that has already begun starts NOW. One that
  // has already closed is not offered at all.
  if (opts.now && HHMM.test(opts.now)) {
    const now = timeToMinutes(opts.now);
    if (now > startMin) startMin = now;
  }
  const minutes = endsAt - startMin;
  if (minutes < MIN_MORNING_PREP_MIN) return null;
  return { start: minutesToTime(startMin), minutes, endsAt: minutesToTime(endsAt) };
}

export interface PrepOptions {
  lang: AppLanguage;
  /** Today, so prep days that have already gone by are not invented. */
  today: string;
  /** The hour to place the EVENING prep blocks on. Defaults to 19:00. */
  at?: string;
  /**
   * The clock, HH:MM, used only on the interview day itself: a morning block
   * whose window has already closed is not offered. Omitted = not judged.
   */
  now?: string;
}

/**
 * The prep tasks an interview requires.
 *
 * Returns only the ones that are still in the future: an interview booked
 * tomorrow cannot be prepared for the day before yesterday, and a task dated
 * in the past would land in the overdue card as something she failed to do.
 * When only D-1 and the morning are left, that is what comes back — real
 * blocks beat impossible ones.
 *
 * The morning block additionally needs a departure to work backwards from, so
 * it appears on the first sync AFTER the route exists rather than being
 * guessed into the wrong hour and then frozen there by its own id.
 *
 * Returns [] for anything that is not an interview.
 */
export function prepTasksFor(interview: Task, opts: PrepOptions): Task[] {
  if (!isInterview(interview)) return [];
  if (!interview.date) return [];
  const subject = subjectOf(interview);
  const at = opts.at ?? DEFAULT_PREP_TIME;
  const out: Task[] = [];

  for (const spec of PREP_SPEC) {
    const date = daysBefore(interview.date, spec.daysBefore);
    if (date < opts.today) continue;          // that day is gone

    // WHEN, and for how long. An evening block is a fixed hour on a free
    // day; the morning one is measured backwards from the front door, so it
    // may not exist at all (no route yet, or no room left before she leaves).
    let time = at;
    let minutes = spec.minutes;
    let fixed = false;
    if (spec.anchor === 'before_leaving') {
      const window = morningPrepWindow(
        interview, spec.minutes, { now: date === opts.today ? opts.now : undefined },
      );
      if (!window) continue;
      time = window.start;
      minutes = window.minutes;
      // Fixed, because it is: it ends when she has to start getting ready.
      // And `fixedTime` is the third source plannedAlarmTime reads, which is
      // the whole mechanism by which this block moves the morning's alarm.
      fixed = true;
    } else if (date >= interview.date) {
      continue;                               // evening prep is never on the day
    }

    out.push({
      id: `prep-${spec.daysBefore}d-${interview.id}`,
      text: STRINGS[opts.lang][spec.kind](subject, time),
      category: 'course' as TaskCategory,
      // She said מחייבת — required. Not a suggestion, not a gap-filler.
      priority: 'must',
      isFixed: fixed,
      ...(fixed ? { fixedTime: time } : {}),
      scheduledTime: time,
      durationMinutes: minutes,
      date,
      status: 'pending',
      createdAt: Date.now(),
      historicalDurations: [],
      // 'suggested', not a new 'interview_prep': `tasks_source_check` in
      // Supabase allows six values, and a row carrying a seventh fails the
      // whole BATCH — one bad value stopped all 142 of her tasks reaching the
      // cloud. These are tasks Lumi proposed, so 'suggested' is honest as well
      // as accepted, and no migration is owed before they can sync.
      //
      // The real link is the id: it is derived from the interview's, which is
      // what makes this idempotent, and ids DO round-trip through the cloud.
      source: 'suggested',
      prepForTaskId: interview.id,
    } as unknown as Task);
  }
  return out;
}

/**
 * Prep for every interview in a set of tasks, deduped against what exists.
 *
 * `existing` is the store. Anything already carrying one of the generated ids
 * is left alone — including any edit she has made to it, which is the whole
 * point of matching on id rather than regenerating.
 */
export function missingPrepTasks(
  tasks: Task[],
  existing: Task[],
  opts: PrepOptions,
): Task[] {
  const have = new Set(existing.map((t) => t.id));
  const out: Task[] = [];
  for (const t of tasks) {
    for (const prep of prepTasksFor(t, opts)) {
      if (have.has(prep.id)) continue;
      have.add(prep.id);
      out.push(prep);
    }
  }
  return out;
}
