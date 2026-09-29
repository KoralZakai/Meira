/**
 * GapFillService — what to do with an hour that just opened up.
 *
 * The old free-slot suggestion was one line: rotate an aspiration by day of
 * month into the first hole of the day. It never looked at WHERE she was,
 * what she had already done, what was coming, or what she never finished — so
 * it offered "learn guitar" while she was standing in Haifa with two errands
 * three streets away.
 *
 * The ranking below is the human decision written down, strongest signal
 * first. Her standing week comes before anything else, because it is the part
 * a calendar cannot see (utils/routines):
 *  0. habit    — what she DOES on this weekday, at roughly this hour: the
 *                Monday gym, the Sunday review. Read from her own routine
 *                notes and, more reliably, from her task history. A habit
 *                already on today's list is never offered twice.
 *     …and the matching constraint — the school run, "no mornings" — never
 *     appears as a suggestion at all: those hours are cut out of the free
 *     windows upstream (constrainGaps), and nothing social is offered in the
 *     ninety minutes before a pickup.
 *  1. nearby   — an unfinished task whose place is within walking/short-drive
 *                distance of where she IS during the gap. Being there is the
 *                scarce thing; the slot is worth more here than anywhere else.
 *  2. prep     — an interview/exam/deadline is coming (today after the gap, or
 *                tomorrow) and the slot is long enough to study for it.
 *  3. finish   — something left unfinished on an earlier day that fits.
 *  4. rest     — the morning was heavy (a lot of busy minutes or several tasks
 *                completed already). A break is a real suggestion, not filler.
 *  5. home     — she is at home: the untimed, place-less tasks that only get
 *                done at home.
 *  6. goal     — an active aspiration, rotated, so the wish list still moves.
 *
 * Deterministic on purpose: no LLM call. The slot is being offered WHILE she
 * looks at the screen, it must work on a train with no signal, and every one
 * of these signals is already in local storage. The LLM's job in this app is
 * language, not arithmetic on a list she can see.
 *
 * rankGapIdeas is pure (all context passed in) so tests/run-gap-fill.ts can
 * drive every branch. suggestForGap is the thin async wrapper that gathers the
 * context from storage.
 *
 * Dependencies: TaskStorage, UserProfileStorage, LocationService, findGaps.
 * Consumed by screens/TodaySchedule (gap rows).
 */
import {
  Task, TaskCategory, TaskPriority, Goal, TaskLocation, AppLanguage, UserProfile,
} from '../types/index';
import { isPrepBlock } from '../utils/interviewPrep';
import { DayGap } from '../utils/findGaps';
import { addMinutes, getTodayString, timeToMinutes } from '../utils/timeUtils';
import { normalizeProfile } from '../utils/profileShape';
import { travelBetween } from './TravelEstimator';
import {
  Routine, alreadyPlanned, blockedForGap, habitsFromHistory, parseRoutineNotes,
  routinesForDate, weekdayLabel, weekdayOf,
} from '../utils/routines';
import {
  getTasksForDate, getOverdueTasks, getAllTasks, loadGoals, addTask, updateTaskFields, moveTasksToDate,
} from './TaskStorage';
import { loadProfile } from './UserProfileStorage';

/** Anything closer than this counts as "you're already there". */
const NEAR_RADIUS_KM = 3;
/** Busy minutes before the gap that make a break the honest suggestion. */
const HEAVY_MORNING_MINUTES = 180;
/** …or this many things already ticked off. */
const HEAVY_MORNING_DONE = 3;

const PREP_RE = /interview|exam|test|deadline|presentation|ראיון|מבחן|בחינה|דדליין|הגשה|מצגת/i;

/** A task that IS the preparation. Never prepare for one of these. */
const ALREADY_PREP_RE = /^\s*(?:prepare for|להתכונן ל)\s*:/i;

/**
 * A prep block must not fill a window to its last minute.
 *
 * `Math.min(slot, 120)` took the whole gap, so a window that ended at a
 * departure left her walking out of the door the second the block finished —
 * no getting ready, no bag, no margin. Leaving the tail free is what makes the
 * suggestion usable rather than merely legal.
 */
const PREP_TAIL_MINUTES = 15;

export type GapIdeaKind = 'habit' | 'nearby' | 'prep' | 'finish' | 'open' | 'rest' | 'home' | 'goal';

export interface GapIdea {
  id: string;
  kind: GapIdeaKind;
  icon: string;
  /** What she'd be doing. */
  title: string;
  titleHe: string;
  /** WHY Lumi is offering it — one short clause, never a paragraph. */
  reason: string;
  reasonHe: string;
  /** How much of the slot it takes. */
  minutes: number;
  /**
   * When it can REALISTICALLY start — the top of the window plus the trip to
   * get there. Equal to gap.start for anything at home. Set by the travel pass
   * in suggestForGap; rankGapIdeas alone leaves it undefined.
   */
  startAt?: string;
  /** Minutes of travelling to reach it, when it is somewhere else. */
  travelMinutes?: number;
  /** Where it happens, so the travel pass can price the trip. */
  place?: { address?: string; lat?: number; lng?: number };
  /** Pull an existing task into the slot… */
  taskId?: string;
  /** …or create this one. */
  draft?: {
    text: string;
    category: TaskCategory;
    priority: TaskPriority;
    durationMinutes: number;
  };
}

export interface GapPlace {
  lat?: number;
  lng?: number;
  label?: string;
  isHome: boolean;
}

export interface GapContext {
  gap: DayGap;
  today: string;
  /** Everything on today, completed included — the morning's weight is in here. */
  todayTasks: Task[];
  /** Pending tasks stranded on earlier dates. */
  overdue: Task[];
  /** Tomorrow's tasks — a prep block today only makes sense against them. */
  tomorrowTasks: Task[];
  /**
   * Everything still OPEN: pending, not ticked off, and holding no slot on
   * today's timeline — today's untimed items and anything parked on a later
   * date. These are the things she meant to do, and until now the only way
   * one could reach a free window was by being overdue, or near her, or by
   * her happening to be at home. That is why a free hour so often offered
   * nothing but the wish list.
   */
  openTasks?: Task[];
  goals: Goal[];
  /** Her standing week — habits to offer, constraints to respect. */
  routines?: Routine[];
  /** Language for the habit line ("your Monday routine"). */
  language?: AppLanguage;
  /** Where she is (or will be) when the gap starts. */
  place?: GapPlace;
  /** Day-of-month, for rotating the aspiration. Defaults to the real one. */
  rotation?: number;
}

const asLoc = (t: Task): TaskLocation | undefined =>
  t.location && typeof t.location === 'object' ? (t.location as TaskLocation) : undefined;

/** Straight-line km between two points (good enough to rank "is it close"). */
function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

/** Coordinates of a task's place, whichever field carries them. */
function taskPoint(task: Task): { lat: number; lng: number } | null {
  const loc = asLoc(task);
  if (loc && typeof loc.lat === 'number' && typeof loc.lng === 'number') {
    return { lat: loc.lat, lng: loc.lng };
  }
  if (typeof task.locationLat === 'number' && typeof task.locationLng === 'number') {
    return { lat: task.locationLat, lng: task.locationLng };
  }
  return null;
}

/** A task's place as coordinates + address, for pricing the trip to it. */
function taskPlace(task: Task): { address?: string; lat?: number; lng?: number } | undefined {
  const loc = asLoc(task);
  const point = taskPoint(task);
  const address = loc?.address || loc?.displayName
    || (typeof task.location === 'string' ? task.location : undefined);
  if (!address && !point) return undefined;
  return { address, ...(point ?? {}) };
}

/** A task's place as text, for "you're near X". */
function placeLabel(task: Task): string {
  const loc = asLoc(task);
  if (loc) return loc.displayName || loc.address || '';
  return typeof task.location === 'string' ? task.location : '';
}

/** Unscheduled work that could take the slot: no clock time, not done. */
function isLoose(task: Task): boolean {
  return task.status === 'pending' && !task.fixedTime && !task.scheduledTime;
}

/** How much of the task fits — the whole thing, or as much as the slot holds. */
function fitMinutes(task: Task, gapMinutes: number): number {
  return Math.min(task.durationMinutes || 30, gapMinutes);
}

/** Busy minutes and completions before this gap opens. */
function morningWeight(todayTasks: Task[], gapStart: string): { minutes: number; done: number } {
  let minutes = 0;
  let done = 0;
  for (const task of todayTasks) {
    const start = task.fixedTime || task.scheduledTime;
    if (!start || timeToMinutes(start) >= timeToMinutes(gapStart)) continue;
    minutes += task.durationMinutes || 30;
    if (task.status === 'complete') done += 1;
  }
  return { minutes, done };
}

/**
 * Rank what to offer for one gap. Pure — everything it knows is in `ctx`.
 * Returns at most `limit` ideas, best first, never two for the same task.
 */
export function rankGapIdeas(ctx: GapContext, limit = 4): GapIdea[] {
  const { gap, today, todayTasks, overdue, tomorrowTasks, goals, place } = ctx;
  const routines = ctx.routines ?? [];
  const he = ctx.language === 'he';
  const slot = gap.minutes;
  const ideas: GapIdea[] = [];
  const used = new Set<string>();

  // An obligation on this day rules some things out of this window entirely —
  // you do not start a social hour forty minutes before the school run.
  const blocked = new Set<TaskCategory>(blockedForGap(routines, today, gap));

  const add = (idea: GapIdea, category?: TaskCategory) => {
    if (idea.taskId && used.has(idea.taskId)) return;
    if (category && blocked.has(category)) return;
    if (idea.taskId) used.add(idea.taskId);
    ideas.push(idea);
  };

  const candidates = [...overdue, ...todayTasks.filter(isLoose)];

  // 0. Her standing week. A habit whose usual hour falls inside this window is
  // the single best thing to put in it — it is what she was going to do
  // anyway, and the reason it keeps slipping is that nothing ever offered it.
  const dueHabits = routinesForDate(routines, today)
    .filter((r) => r.kind === 'habit' && !alreadyPlanned(r, todayTasks))
    .map((r) => {
      const usual = Boolean(r.time
        && r.time >= gap.start
        && timeToMinutes(r.time) + Math.min(r.durationMinutes, slot) <= timeToMinutes(gap.end));
      return { routine: r, usual };
    })
    .sort((a, b) => Number(b.usual) - Number(a.usual)
      || (b.routine.occurrences ?? 0) - (a.routine.occurrences ?? 0));

  for (const { routine, usual } of dueHabits.slice(0, 2)) {
    const day = weekdayLabel(weekdayOf(today), he ? 'he' : 'en');
    add({
      id: `habit-${routine.id}`,
      kind: 'habit',
      icon: '🔁',
      title: routine.text,
      titleHe: routine.text,
      reason: usual && routine.time
        ? `You usually do this on ${day}s around ${routine.time}`
        : `Part of your ${day} routine`,
      reasonHe: usual && routine.time
        ? `בדרך כלל את עושה את זה בימי ${day} בסביבות ${routine.time}`
        : `זה חלק מהשגרה שלך בימי ${day}`,
      minutes: Math.min(routine.durationMinutes, slot),
      draft: {
        text: routine.text,
        category: routine.category ?? 'general',
        priority: 'need_to',
        durationMinutes: Math.min(routine.durationMinutes, slot),
      },
    }, routine.category);
  }

  // 1. Near where she already is.
  const here = place && typeof place.lat === 'number' && typeof place.lng === 'number'
    ? { lat: place.lat, lng: place.lng }
    : null;
  if (here) {
    const nearby = candidates
      .map((task) => {
        const point = taskPoint(task);
        return point ? { task, km: distanceKm(here, point) } : null;
      })
      .filter((n): n is { task: Task; km: number } => n !== null && n.km <= NEAR_RADIUS_KM)
      .sort((a, b) => a.km - b.km);
    for (const { task, km } of nearby.slice(0, 2)) {
      const where = placeLabel(task) || (place?.label ?? '');
      add({
        id: `near-${task.id}`,
        kind: 'nearby',
        icon: '📍',
        title: task.text,
        titleHe: task.text,
        reason: where
          ? `You're ${km < 1 ? 'right by' : `${km.toFixed(1)} km from`} ${where}`
          : "It's close to where you are",
        reasonHe: where
          ? `את ${km < 1 ? 'ממש ליד' : `${km.toFixed(1)} ק״מ מ`}${where}`
          : 'זה קרוב לאיפה שאת',
        minutes: fitMinutes(task, slot),
        taskId: task.id,
        place: taskPlace(task),
      }, task.category);
    }
  }

  // 2. Something big is coming — use the slot to prepare for it.
  //
  // Not preparation for a preparation. PREP_RE looks for "interview" in the
  // task text, and once "Prepare for: Your phone interview with Ceva" has been
  // accepted it IS a task whose text contains "interview" — so the next gap
  // offered "Prepare for: Prepare for: Your phone interview with Ceva", which
  // is what her timeline showed on 2026-09-17, twice over, two hours each.
  // Two prep blocks for one interview is not more preparation, it is a day
  // with four hours missing from it.
  // "Already prepping" is two different things now. This file's own blocks
  // announce themselves with "Prepare for: " — and `utils/interviewPrep`
  // creates its own, automatically, for every interview on the calendar, with
  // titles of its own ("Final review for Ceva"). Offering a third one in a gap
  // is not more preparation; it is two systems booking the same afternoon, and
  // the two titles are similar enough that the store then folds them together.
  const alreadyPrepping = (t: Task) => ALREADY_PREP_RE.test(t.text) || isPrepBlock(t);
  const hasPrepFor = (t: Task) => [...todayTasks, ...tomorrowTasks].some(
    (other) => other.status !== 'complete' && alreadyPrepping(other)
      && (other.text.includes(t.text) || (other as { prepForTaskId?: string }).prepForTaskId === t.id),
  );
  const upcomingBig = [
    ...todayTasks.filter((t) => {
      const start = t.fixedTime || t.scheduledTime;
      return t.status !== 'complete' && start !== undefined && start >= gap.end && PREP_RE.test(t.text);
    }),
    ...tomorrowTasks.filter((t) => t.status !== 'complete' && PREP_RE.test(t.text)),
  ].filter((t) => !alreadyPrepping(t) && !hasPrepFor(t))[0];
  if (upcomingBig && slot >= 45) {
    // Leave the end of the window alone: a gap that closes at a departure is
    // a gap she has to be getting ready in, not working to the last second of.
    const prepMinutes = Math.max(45, Math.min(slot - (gap.endsAtDeparture ? PREP_TAIL_MINUTES : 0), 120));
    add({
      id: `prep-${upcomingBig.id}`,
      kind: 'prep',
      icon: '📚',
      title: `Prepare for: ${upcomingBig.text}`,
      titleHe: `להתכונן ל: ${upcomingBig.text}`,
      reason: tomorrowTasks.includes(upcomingBig) ? "It's tomorrow" : "It's later today",
      reasonHe: tomorrowTasks.includes(upcomingBig) ? 'זה מחר' : 'זה עוד היום',
      minutes: prepMinutes,
      draft: {
        text: `Prepare for: ${upcomingBig.text}`,
        category: 'course',
        priority: 'must',
        durationMinutes: prepMinutes,
      },
    }, 'course');
  }

  // 3. Unfinished from an earlier day.
  for (const task of overdue.slice(0, 3)) {
    if ((task.durationMinutes || 30) > slot && slot < 30) continue;
    add({
      id: `finish-${task.id}`,
      kind: 'finish',
      icon: '↩️',
      title: task.text,
      titleHe: task.text,
      reason: `Left over from ${task.date.slice(8)}/${task.date.slice(5, 7)}`,
      reasonHe: `נשאר מ-${task.date.slice(8)}/${task.date.slice(5, 7)}`,
      minutes: fitMinutes(task, slot),
      taskId: task.id,
      place: taskPlace(task),
    }, task.category);
  }

  // 3b. Still open, and nothing is stopping it. An unfinished task is a
  // better answer to a free hour than an aspiration: she already decided it
  // mattered. Today's untimed work first, then whatever is parked on a later
  // date and could just as well happen now.
  const stillOpen = (ctx.openTasks ?? []).filter(
    (task) => task.status === 'pending' && !used.has(task.id),
  );
  // Today's own unplaced work first, then anything parked on a later date —
  // both are things she meant to do, and a free hour can take either.
  const openHere = [
    ...stillOpen.filter((task) => task.date === today),
    ...stillOpen.filter((task) => task.date !== today),
  ];
  for (const task of openHere.slice(0, 3)) {
    if ((task.durationMinutes || 30) > slot && slot < 30) continue;
    const later = task.date !== today;
    add({
      id: `open-${task.id}`,
      kind: 'open',
      icon: '📋',
      title: task.text,
      titleHe: task.text,
      reason: later ? 'On your list — you could do it now' : "Still open on today's list",
      reasonHe: later ? 'ברשימה שלך — אפשר לעשות את זה עכשיו' : 'עדיין פתוח ברשימה של היום',
      minutes: fitMinutes(task, slot),
      taskId: task.id,
      place: taskPlace(task),
    }, task.category);
  }

  // 4. A heavy morning earns a break — and saying so is a suggestion.
  const weight = morningWeight(todayTasks, gap.start);
  if (weight.minutes >= HEAVY_MORNING_MINUTES || weight.done >= HEAVY_MORNING_DONE) {
    add({
      id: 'rest',
      kind: 'rest',
      icon: '☕',
      title: 'Take a break',
      titleHe: 'לנוח קצת',
      reason: weight.done >= HEAVY_MORNING_DONE
        ? `${weight.done} done already this morning`
        : 'Busy morning behind you',
      reasonHe: weight.done >= HEAVY_MORNING_DONE
        ? `כבר סיימת ${weight.done} הבוקר`
        : 'היה לך בוקר עמוס',
      minutes: Math.min(slot, 30),
      draft: { text: 'Break', category: 'leisure', priority: 'nice_to_do', durationMinutes: Math.min(slot, 30) },
    });   // a break is never blocked: resting IS what an obligation leaves room for
  }

  // 5. At home → the things that only happen at home.
  if (place?.isHome) {
    const homeTasks = candidates.filter((t) => !taskPoint(t) && !placeLabel(t));
    for (const task of homeTasks.slice(0, 2)) {
      add({
        id: `home-${task.id}`,
        kind: 'home',
        icon: '🏠',
        title: task.text,
        titleHe: task.text,
        reason: "You're home — this needs no travel",
        reasonHe: 'את בבית — לזה לא צריך לנסוע',
        minutes: fitMinutes(task, slot),
        taskId: task.id,
      }, task.category);
    }
  }

  // 6. The wish list, so it keeps moving.
  const aspirations = goals.filter((g) => g.status === 'active' && g.type === 'aspiration');
  if (aspirations.length) {
    const rotation = ctx.rotation ?? new Date().getDate();
    const goal = aspirations[rotation % aspirations.length];
    add({
      id: `goal-${goal.id}`,
      kind: 'goal',
      icon: '⭐',
      title: goal.text,
      titleHe: goal.text,
      reason: 'From your wish list',
      reasonHe: 'מרשימת השאיפות שלך',
      minutes: Math.min(slot, 45),
      draft: {
        text: goal.text,
        category: goal.category,
        priority: 'nice_to_do',
        durationMinutes: Math.min(slot, 45),
      },
    }, goal.category);
  }

  return ideas.slice(0, limit);
}

/** The one-line label for a slot's ideas, in her language. */
export function ideaTitle(idea: GapIdea, language: AppLanguage): string {
  return language === 'he' ? idea.titleHe : idea.title;
}

export function ideaReason(idea: GapIdea, language: AppLanguage): string {
  return language === 'he' ? idea.reasonHe : idea.reason;
}

/**
 * Her standing week, from both sources that know about it.
 *
 * The notes are what she TOLD onboarding ("gym Mon/Wed 18:00, kids at 16:00");
 * the history is what she actually did. Both are returned — history first,
 * since a habit with four occurrences behind it outranks a sentence typed
 * once — and the screens use them to cut the hours she does not have out of
 * the timeline before a single suggestion is made.
 */
export async function loadRoutines(): Promise<Routine[]> {
  const [profile, tasks] = await Promise.all([
    loadProfile().catch(() => null),
    getAllTasks().catch(() => [] as Task[]),
  ]);
  const notes = parseRoutineNotes(
    (profile as any)?.routinesNotes,
    (profile as any)?.hobbies,
  );
  return [...habitsFromHistory(tasks), ...notes];
}

/**
 * Price the trip to each idea, drop what cannot fit, and give the rest an
 * honest start time.
 *
 * This is the difference between "you have an hour" and "you have an hour, and
 * that errand is twenty minutes each way, so it isn't an hour". Three things
 * happen per idea:
 *   - the trip from where she is (or where the previous task leaves her) to
 *     the idea's place, priced for THIS date and hour;
 *   - the trip onward — back home, or to whatever the window runs into — so a
 *     suggestion can never make her late for the next thing;
 *   - startAt = the top of the window plus the trip there, which is what
 *     actually gets written on the task.
 *
 * An idea that no longer fits is shortened if at least 15 minutes of it
 * survive, and dropped otherwise. Something at home costs nothing and passes
 * through untouched.
 */
async function priceTravel(
  ideas: GapIdea[],
  gap: DayGap,
  opts: {
    date: string;
    profile: UserProfile | null;
    anchor?: { address?: string; lat?: number; lng?: number };
    home?: { address?: string; lat?: number; lng?: number };
  },
): Promise<GapIdea[]> {
  const priced = await Promise.all(ideas.map(async (idea): Promise<GapIdea | null> => {
    if (!idea.place) return { ...idea, startAt: gap.start };

    const there = await travelBetween(opts.anchor, idea.place, gap.start, opts.date, opts.profile)
      .catch(() => null);
    const toMinutes = there?.minutes ?? 0;

    // Where she has to be when this window closes: the next task's place if it
    // has one, otherwise home. At the end of the day there is nowhere to be,
    // so the return trip costs the window nothing.
    const onward = gap.after
      ? (taskPlace(gap.after) ?? opts.home)
      : opts.home;
    const back = onward
      ? await travelBetween(idea.place, onward, gap.end, opts.date, opts.profile).catch(() => null)
      : null;
    const backMinutes = gap.after ? (back?.minutes ?? 0) : 0;

    const room = gap.minutes - toMinutes - backMinutes;
    if (room < 15) return null;

    const minutes = Math.min(idea.minutes, room);
    const travelNote = toMinutes > 0
      ? { en: ` · ${toMinutes} min away`, he: ` · ${toMinutes} דק׳ נסיעה` }
      : { en: '', he: '' };

    return {
      ...idea,
      minutes,
      startAt: addMinutes(gap.start, toMinutes),
      travelMinutes: toMinutes || undefined,
      reason: idea.reason + travelNote.en,
      reasonHe: idea.reasonHe + travelNote.he,
    };
  }));

  return priced.filter((idea): idea is GapIdea => idea !== null);
}

/**
 * Gather the context from storage and rank. `currentPoint` is optional: pass
 * the live GPS fix for a gap happening NOW, leave it out for a later slot,
 * where the anchor is the place the previous task leaves her at.
 *
 * `routines` can be passed in by a screen that already loaded them for the
 * timeline (they are needed there to trim the windows), so opening a slot
 * does not re-read the whole task store.
 */
export async function suggestForGap(
  gap: DayGap,
  opts: {
    today?: string;
    currentPoint?: { lat: number; lng: number } | null;
    routines?: Routine[];
    language?: AppLanguage;
  } = {},
): Promise<GapIdea[]> {
  const today = opts.today || getTodayString();
  const tomorrow = (() => {
    const [y, m, d] = today.split('-').map(Number);
    const dt = new Date(y, m - 1, d + 1);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  })();

  const [todayTasks, tomorrowTasks, overdue, allTasks, goals, profile, routines] = await Promise.all([
    getTasksForDate(today).catch(() => [] as Task[]),
    getTasksForDate(tomorrow).catch(() => [] as Task[]),
    getOverdueTasks(today).catch(() => [] as Task[]),
    getAllTasks().catch(() => [] as Task[]),
    loadGoals().catch(() => [] as Goal[]),
    loadProfile().catch(() => null),
    opts.routines ? Promise.resolve(opts.routines) : loadRoutines().catch(() => [] as Routine[]),
  ]);

  // Open = she still means to do it, and it is not already sitting on today's
  // timeline. Anything earlier than today is overdue and handled separately.
  // Offerable into a free window = still owed, and not ALREADY sitting on
  // today's timeline.
  //
  // The filter used to also demand no clock time at all, which quietly emptied
  // it: "Build schedule for today" assigns a scheduledTime to everything, so
  // the moment a day was built nothing qualified, and a task parked on a later
  // date was never a candidate either — even though pulling one into a free
  // hour today is precisely what the window is for. The result was a slot that
  // offered habits and aspirations and none of her actual list.
  const placedToday = new Set(
    todayTasks.filter((t) => t.fixedTime || t.scheduledTime).map((t) => t.id),
  );
  const openTasks = allTasks.filter(
    (task) => task.status === 'pending'
      && !placedToday.has(task.id)
      && task.date >= today,
  );

  const home = profile && typeof (profile as any).homeLat === 'number'
    ? { lat: (profile as any).homeLat as number, lng: (profile as any).homeLng as number }
    : null;

  // Anchor: the live fix when we have one, otherwise where the previous task
  // leaves her, otherwise home.
  const prevPoint = gap.before ? taskPoint(gap.before) : null;
  const anchor = opts.currentPoint || prevPoint || home;
  const isHome = Boolean(
    anchor && home && distanceKm(anchor, home) < 0.5,
  ) || (!anchor && !prevPoint);

  const place: GapPlace | undefined = anchor
    ? { lat: anchor.lat, lng: anchor.lng, label: gap.before ? placeLabel(gap.before) : undefined, isHome }
    : { isHome: true };

  const ideas = rankGapIdeas({
    gap, today, todayTasks, tomorrowTasks, overdue, openTasks, goals, place, routines,
    language: opts.language,
  });

  // Nothing is offered until the journey to it has been paid for.
  const homePlace = profile
    ? { address: (profile as any).homeAddress as string | undefined, ...(home ?? {}) }
    : undefined;
  return priceTravel(ideas, gap, {
    date: today,
    profile: normalizeProfile(profile),
    anchor: anchor
      ? { ...anchor, address: gap.before ? placeLabel(gap.before) : (profile as any)?.homeAddress }
      : homePlace,
    home: homePlace,
  });
}

/**
 * Put an idea in the slot, and return what was scheduled.
 *
 * Both shapes end the same way — a task on TODAY with scheduledTime = the top
 * of the window. An existing task from an earlier day is MOVED (in place, same
 * id, stale route dropped — see moveTasksToDate) rather than copied, so
 * accepting a suggestion never forks a duplicate.
 */
export async function applyGapIdea(
  idea: GapIdea,
  gap: DayGap,
  today = getTodayString(),
): Promise<void> {
  if (idea.taskId) {
    const todays = await getTasksForDate(today).catch(() => [] as Task[]);
    const isOnToday = todays.some((t) => t.id === idea.taskId);
    if (!isOnToday) await moveTasksToDate([idea.taskId], today);
    // startAt, not gap.start: the window opens at 21:30 but an errand twenty
    // minutes away starts at 21:50, and the task must say so.
    await updateTaskFields(idea.taskId, {
      scheduledTime: idea.startAt || gap.start,
      status: 'pending',
    });
    return;
  }
  if (!idea.draft) return;
  await addTask({
    text: idea.draft.text,
    category: idea.draft.category,
    priority: idea.draft.priority,
    isFixed: false,
    durationMinutes: Math.min(idea.draft.durationMinutes, idea.minutes, gap.minutes),
    scheduledTime: idea.startAt || gap.start,
    date: today,
    status: 'pending',
    source: 'suggested',
    historicalDurations: [],
  } as unknown as Omit<Task, 'id' | 'createdAt' | 'completedAt'>);
}
