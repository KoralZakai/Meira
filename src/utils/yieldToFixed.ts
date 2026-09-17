/**
 * yieldToFixed — a class you have to be at beats a block of work you can move.
 *
 * Koral, 2026-09-17, looking at her own evening:
 *
 *   "there is a bad overlap here. see how the prepare for call is overlapping
 *    yoga. i expected that the preparation time would get shorter, a time to
 *    get ready will appear, travel time by bike will appear and calculate
 *    ahead the time and tasks to get the yoga done."
 *
 * What her screen actually showed: a 2-hour "Prepare for: Your phone interview
 * with Ceva" running 18:18–20:18, a yoga class at 19:00 in Charles Clore, and
 * a cheerful yellow note underneath reading "You can take the call on the way".
 *
 * Every part of that is wrong, and none of it was a crash:
 *
 *   - The prep block did not overlap the class. It SWALLOWED it — the class,
 *     the bike ride there, and the getting ready before it.
 *   - classifyOverlap called the pair `parallel` because the prep block has no
 *     address, and a task with no address was treated as portable. It is not.
 *     "Floating" means it can go anywhere in the DAY, not that it can happen
 *     at the same time as something else.
 *   - So the app's advice was to keep working through the departure. Following
 *     it means missing the class.
 *
 * THE RULE, and it is a narrow one on purpose:
 *
 *     A flexible block that covers the moment she has to LEAVE must yield.
 *
 * Not "a flexible block that overlaps anything" — sitting in a four-hour
 * conference and spending an hour of it sending your CV is fine, and the app
 * was right about that. The thing that cannot be shared is a DEPARTURE. You
 * cannot be at a desk preparing for an interview and on a bike to Charles
 * Clore at 18:40. One of them has to move, and the one that can move is the
 * work.
 *
 * WHAT IS PROTECTED is therefore not just the appointment. It is the whole
 * approach to it:
 *
 *     get ready  →  travel  →  be there
 *      18:30        18:40       19:00 ── 20:00
 *     └──────────── protected ─────────────────┘
 *
 * The get-ready window is what she asked to see and what nothing drew:
 * buildWayThere adds one only for the FIRST trip of the day, so an evening
 * class got a leave time with nothing before it. Changing and packing a bag
 * is not the morning routine and must not borrow its length — 45 minutes of
 * "getting ready" before a bike ride is nonsense, and nonsense that large
 * teaches her to ignore the row.
 *
 * Pure: no storage, no network, no clock of its own. Travel minutes come from
 * the task's own stored route; when there is none, an explicit assumption is
 * used and SAID, never quietly folded in.
 *
 * Consumed by screens/TodaySchedule + components/DayTimeline.
 * Tested by tests/run-yield-to-fixed.ts and tests/run-day-evolution.ts.
 */
import { Task, TaskLocation, UserProfile } from '../types/index';
import { timeToMinutes, minutesToTime } from './timeUtils';
import { isRemoteTask } from './meetingLink';

/**
 * Getting out of the door for something mid-day: change, pack, keys.
 *
 * Deliberately NOT morningRoutineMinutes. That number is showering and
 * breakfast, and spending it on a 19:00 yoga class would push the whole
 * evening an hour earlier for no reason.
 */
export const OUTING_PREP_MINUTES = 10;

/** What a journey costs when nothing has routed it yet. Stated, never hidden. */
export const ASSUMED_TRAVEL_MINUTES = 15;

/** The shortest useful remnant of a work block. Below this, move it whole. */
export const MIN_USEFUL_BLOCK_MINUTES = 25;

const locOf = (t?: Task): TaskLocation | undefined =>
  t && t.location && typeof t.location === 'object' ? (t.location as TaskLocation) : undefined;

const startOf = (t: Task): string | undefined => t.fixedTime || t.scheduledTime || undefined;

const endMinutes = (t: Task): number =>
  timeToMinutes(startOf(t)!) + (t.durationMinutes || 30);

/** Anything she must be somewhere for, at an hour she does not choose. */
export function isAnchored(task: Task): boolean {
  return Boolean(task.isFixed && startOf(task));
}

/**
 * The window a departure owns: get ready, travel, and the appointment itself.
 *
 * `leaveAt` is the stored route's leave time when there is one. Without a
 * route the window still exists — she still has to get there — so it is
 * derived from an explicit travel assumption rather than skipped. Skipping it
 * is what let a work block be planned straight through a departure.
 */
export interface ProtectedWindow {
  taskId: string;
  /** HH:MM she starts getting ready — the top of the protected block. */
  readyAt: string;
  /** HH:MM she walks out. */
  leaveAt: string;
  /** HH:MM the appointment starts. */
  startAt: string;
  /** HH:MM it ends. */
  endAt: string;
  travelMinutes: number;
  prepMinutes: number;
  /** True when no route existed and the travel time is an assumption. */
  travelAssumed: boolean;
}

export function protectedWindowFor(
  task: Task,
  profile?: Pick<UserProfile, 'morningRoutineMinutes' | 'wakeBufferMinutes'> | null,
  opts: { prepMinutes?: number } = {},
): ProtectedWindow | null {
  const start = startOf(task);
  if (!start || !isAnchored(task)) return null;

  const loc = locOf(task);
  // A remote meeting needs no journey — but it DOES need her to stop what she
  // is doing and be at a screen, so the appointment itself is still protected.
  const remote = isRemoteTask(task);
  const address = !remote && (loc?.address || loc?.displayName
    || (typeof task.location === 'string' ? task.location : ''));

  let travelMinutes = 0;
  let travelAssumed = false;
  if (address) {
    const routed = loc?.transitPlan?.totalDurationMinutes ?? loc?.travelMinutes;
    if (Number.isFinite(routed as number) && (routed as number) > 0) {
      travelMinutes = routed as number;
    } else {
      travelMinutes = ASSUMED_TRAVEL_MINUTES;
      travelAssumed = true;
    }
  }

  const prepMinutes = address || remote
    ? (opts.prepMinutes ?? OUTING_PREP_MINUTES)
    : 0;

  // The route's own leave time is authoritative — Google worked backwards from
  // a real timetable, which is not the same as start minus duration.
  const leaveAt = loc?.leaveHomeBy
    ?? loc?.transitPlan?.leaveHomeAt
    ?? minutesToTime(timeToMinutes(start) - travelMinutes);

  return {
    taskId: task.id,
    readyAt: minutesToTime(timeToMinutes(leaveAt) - prepMinutes),
    leaveAt,
    startAt: start,
    endAt: minutesToTime(endMinutes(task)),
    travelMinutes,
    prepMinutes,
    travelAssumed,
  };
}

export type YieldAction = 'keep' | 'shorten' | 'move' | 'no-room';

export interface YieldPlan {
  taskId: string;
  action: YieldAction;
  /** Why it had to give way — the id of the appointment it was covering. */
  blockedBy: string;
  from: { start: string; end: string };
  /** Where it goes instead. Absent for 'no-room'. */
  to?: { start: string; end: string };
  /** Minutes it keeps. Less than it had when it was shortened. */
  minutes: number;
  /** Minutes it lost to make room, when shortening cost it any. */
  lostMinutes?: number;
}

/**
 * Free windows in a day once every protected block is taken out.
 *
 * `dayEnd` is a real boundary: pushing a two-hour block to 23:40 is not
 * planning, it is a way of pretending the work still fits.
 */
function freeWindows(
  windows: ProtectedWindow[], busy: Array<[number, number]>,
  from: number, dayEnd: number,
): Array<[number, number]> {
  const blocks = [
    ...windows.map((w) => [timeToMinutes(w.readyAt), timeToMinutes(w.endAt)] as [number, number]),
    ...busy,
  ].sort((a, b) => a[0] - b[0]);

  const free: Array<[number, number]> = [];
  let cursor = from;
  for (const [s, e] of blocks) {
    if (e <= cursor) continue;
    if (s > cursor) free.push([cursor, Math.min(s, dayEnd)]);
    cursor = Math.max(cursor, e);
    if (cursor >= dayEnd) break;
  }
  if (cursor < dayEnd) free.push([cursor, dayEnd]);
  return free.filter(([s, e]) => e > s);
}

/**
 * What every flexible block on this day has to do about the fixed ones.
 *
 * Only blocks that actually cover a departure are touched. A block that merely
 * shares an hour with an event she is already sitting in is left exactly as it
 * was — that was never the problem, and moving it would be the app inventing
 * work for itself.
 */
export function yieldToFixed(
  tasks: Task[],
  opts: {
    profile?: Pick<UserProfile, 'morningRoutineMinutes' | 'wakeBufferMinutes'> | null;
    /** Nothing may be scheduled before this. Defaults to the earliest task. */
    now?: string;
    dayEnd?: string;
    prepMinutes?: number;
  } = {},
): YieldPlan[] {
  const live = tasks.filter((t) => t.status !== 'complete' && startOf(t));
  const anchors = live.filter(isAnchored);
  const windows = anchors
    .map((t) => protectedWindowFor(t, opts.profile, { prepMinutes: opts.prepMinutes }))
    .filter((w): w is ProtectedWindow => w !== null);
  if (!windows.length) return [];

  const dayEnd = timeToMinutes(opts.dayEnd || '23:00');
  const flexible = live.filter((t) => !isAnchored(t));
  const plans: YieldPlan[] = [];

  for (const task of flexible) {
    const s = timeToMinutes(startOf(task)!);
    const e = endMinutes(task);
    const from = { start: minutesToTime(s), end: minutesToTime(e) };

    // THE test: does this block cover a moment she has to be leaving?
    // Not "does it overlap" — a shared hour inside an event is survivable;
    // a shared departure is not.
    const blocking = windows.find((w) => {
      const leave = timeToMinutes(w.leaveAt);
      const ready = timeToMinutes(w.readyAt);
      return (s < leave && e > ready) || (s >= ready && s < timeToMinutes(w.endAt));
    });
    if (!blocking) continue;

    const ready = timeToMinutes(blocking.readyAt);
    const kept = ready - s;

    if (kept >= MIN_USEFUL_BLOCK_MINUTES && kept < e - s) {
      // There is a real piece of work left before she has to move. Keep it,
      // stopping exactly when getting ready starts.
      plans.push({
        taskId: task.id,
        action: 'shorten',
        blockedBy: blocking.taskId,
        from,
        to: { start: from.start, end: blocking.readyAt },
        minutes: kept,
        lostMinutes: (e - s) - kept,
      });
      continue;
    }

    // Too little would survive to be worth starting. Move the whole block to
    // the first window that actually holds it — after the class, usually.
    const needed = e - s;
    const busy = live
      .filter((t) => t.id !== task.id && !isAnchored(t))
      .map((t) => [timeToMinutes(startOf(t)!), endMinutes(t)] as [number, number]);
    // WHERE it goes, and this is not "the first hole in the day".
    //
    // The first draft looked for the earliest window that fitted, which threw
    // a block she had put at 18:18 back to 11:23 — five hours EARLIER, for a
    // clash in the evening. That is not yielding, it is rescheduling her
    // morning on her behalf, and for a block already in progress it is not
    // even possible.
    //
    // A yield should be the smallest change that works: the nearest window at
    // or after where the block already was. Only when the rest of the day has
    // no room at all is it worth looking backwards, and then from `now` — the
    // past is not a slot.
    const earliest = opts.now ? timeToMinutes(opts.now) : s;
    const windowsFree = freeWindows(windows, busy, Math.min(earliest, s), dayEnd)
      .filter(([ws, we]) => we - ws >= needed);
    const slot = windowsFree.find(([ws]) => ws >= s)
      ?? windowsFree.find(([ws, we]) => we - Math.max(ws, earliest) >= needed);

    plans.push(slot
      ? {
        taskId: task.id,
        action: 'move',
        blockedBy: blocking.taskId,
        from,
        to: { start: minutesToTime(slot[0]), end: minutesToTime(slot[0] + needed) },
        minutes: needed,
      }
      : {
        taskId: task.id,
        action: 'no-room',
        blockedBy: blocking.taskId,
        from,
        minutes: needed,
      });
  }
  return plans;
}

/** One short line, in her language, for what the app did and why. */
export function describeYield(plan: YieldPlan, blockedByText: string, he: boolean): string {
  switch (plan.action) {
    case 'shorten':
      return he
        ? `קוצר ל-${plan.minutes} דק׳ — צריך לצאת ל"${blockedByText}"`
        : `Shortened to ${plan.minutes} min — you need to leave for "${blockedByText}"`;
    case 'move':
      return he
        ? `הוזז ל-${plan.to!.start} — "${blockedByText}" קודם`
        : `Moved to ${plan.to!.start} — "${blockedByText}" comes first`;
    case 'no-room':
      return he
        ? `אין לזה מקום היום אחרי "${blockedByText}"`
        : `No room left today after "${blockedByText}"`;
    default:
      return '';
  }
}
