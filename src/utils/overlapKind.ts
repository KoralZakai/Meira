/**
 * overlapKind — not every collision is a conflict.
 *
 * The timeline drew any two tasks sharing an hour in warning red, which is
 * wrong often enough to be noise: a phone call during a drive is not a
 * problem, it is a normal Tuesday. Treating it as one teaches her to ignore
 * the colour, and then the real conflict — being due in two places at once —
 * arrives in a shade she has learned to skip.
 *
 * Four verdicts:
 *
 *   parallel   one side needs no PLACE (a call, a Zoom, anything with a
 *              meeting link). It can happen while the other is happening,
 *              including in transit. Drawn quietly, never as an alert.
 *   displaced  one side needs no place, BUT it covers the moment the other
 *              side has to be LEFT FOR. Added 2026-09-17, from Koral's own
 *              evening: a two-hour "prepare for the interview" block running
 *              18:18-20:18 over a 19:00 yoga class in Charles Clore. The app
 *              called it parallel — no address, so portable — and printed
 *              "You can take the call on the way". Following that advice
 *              means missing the class. Floating means it can go anywhere in
 *              the DAY; it does not mean it can happen at the same time as
 *              something else. See utils/yieldToFixed for what moves.
 *   same-place both are at the same address: double-booked, but no journey is
 *              impossible. A soft warning — she may genuinely intend both.
 *   spatial    two different places at once. This is the hard one, and it is
 *              the only kind that gets the red border and a decision.
 *
 * For a spatial conflict there are exactly two honest answers, and which is
 * right depends on what matters to her today, so BOTH are offered:
 *   A. leave the first early enough to arrive on time
 *   B. stay to the end and arrive late — by a stated number of minutes
 *
 * Pure: no storage, no network, no clock. Travel minutes are passed in by the
 * caller (only Google knows the roads), with a deliberately small non-zero
 * fallback rather than pretending teleportation.
 */
import { Task } from '../types/index';
import { timeToMinutes, minutesToTime, addMinutes } from './timeUtils';
import { isRemoteTask } from './meetingLink';
import { isFlexibleTask, isStudyTask } from './taskShape';

/** What a trip costs when no route has been computed. */
export const ASSUMED_TRAVEL_MINUTES = 15;

/**
 * Placeless work sharing this much of an appointment is not riding along.
 *
 * "An hour of the CV inside a four-hour conference" is parallel, and stays so.
 * A two-hour business plan laid exactly over a 90-minute meetup is not: there
 * is no hour of that meetup left to write it in (Koral, 30.9). The line is
 * drawn on the HOST: an appointment of two hours or less has no slack to lend.
 */
export const OCCUPIED_OVERLAP_MINUTES = 30;
export const SHORT_HOST_MINUTES = 120;
/** Her own work that needs her attention — a call cannot ride along with it. */
export const FOCUS_CATEGORIES = ['course', 'work'];

export type OverlapKind = 'parallel' | 'displaced' | 'same-place' | 'spatial';

export interface OverlapVerdict {
  kind: OverlapKind;
  overlapMinutes: number;
  /** Minutes needed between the two places. 0 when none is needed. */
  travelMinutes: number;
  /** parallel only: the remote task, which can ride along. */
  remoteTaskId?: string;
  /** parallel + the other side is a journey: do it on the way. */
  suggestDuringTravel?: boolean;
  /** displaced only: the placeless block that has to give way. */
  displacedTaskId?: string;
  /**
   * displaced only: the departure it was covering. Absent when the block is
   * displaced because it fills a short appointment rather than a departure.
   */
  departureAt?: string;
  /** spatial: leave the earlier one at this time to arrive on time. */
  leaveEarlyAt?: string;
  /** spatial: stay to the end and arrive this late (minutes). */
  arriveLateBy?: number;
  /** spatial: …which lands you at the second at this time. */
  arriveLateAt?: string;
}

const startOf = (t: Task): string | undefined => t.fixedTime || t.scheduledTime || undefined;
const endOf = (t: Task): string => addMinutes(startOf(t)!, t.durationMinutes || 30);

/**
 * Does this task need her to BE anywhere?
 *
 * "Send the CV", "call the clinic", "order the thing" have no place, cost no
 * travel, and cannot collide with a room across town — they are work that
 * fits in whatever time exists. Treating them as physical events is what
 * produced spatial warnings for a task you can do from a bus.
 *
 * A meeting link counts as floating even when the invite carried an address:
 * the link is the venue.
 */
export function isFloatingTask(task: Task): boolean {
  if (isRemoteTask(task)) return true;
  return !placeKey(task);
}

/** A task's place as comparable text. '' when it needs none. */
export function placeKey(task: Task): string {
  const loc: any = task.location;
  const text = typeof loc === 'string' ? loc : (loc?.address || loc?.displayName || '');
  return String(text).trim().toLowerCase();
}

/** Minutes the two genuinely share. 0 means no overlap. */
export function overlapMinutesOf(a: Task, b: Task): number {
  if (!startOf(a) || !startOf(b)) return 0;
  const aS = timeToMinutes(startOf(a)!); const aE = timeToMinutes(endOf(a));
  const bS = timeToMinutes(startOf(b)!); const bE = timeToMinutes(endOf(b));
  return Math.max(0, Math.min(aE, bE) - Math.max(aS, bS));
}

/**
 * Can she hold a conversation on the way to this?
 *
 * A bus or a train, yes — that is most of the value of the parallel verdict.
 * A bike, no, and neither does a walk through traffic with a phone to her ear
 * count as a meeting she can be present in. Driving is left as yes: hands-free
 * is normal and legal, and refusing it would take away the case this verdict
 * was built for.
 */
function travelAllowsTalking(task: Task): boolean {
  const loc: any = task.location;
  const mode = typeof loc === 'object' ? loc?.transportType : undefined;
  return mode !== 'bike';
}

/**
 * The minute she has to walk out for this task, when it has a place to go.
 *
 * The stored route is authoritative — Google worked backwards from a real
 * timetable. Without one there is still a departure; it is just estimated, and
 * an estimated departure is still a departure you cannot be at a desk for.
 */
function departureOf(task: Task): number | undefined {
  const loc: any = task.location;
  const start = startOf(task);
  if (!start || !placeKey(task) || isRemoteTask(task)) return undefined;
  const leave = typeof loc === 'object'
    ? (loc?.leaveHomeBy || loc?.transitPlan?.leaveHomeAt)
    : undefined;
  if (leave) return timeToMinutes(leave);
  const travel = typeof loc === 'object'
    ? (loc?.transitPlan?.totalDurationMinutes ?? loc?.travelMinutes)
    : undefined;
  return timeToMinutes(start)
    - (Number.isFinite(travel as number) && (travel as number) > 0
      ? (travel as number) : ASSUMED_TRAVEL_MINUTES);
}

/** Is this block running at `minute`? Strictly inside — touching is not covering. */
function coversMoment(task: Task, minute: number): boolean {
  const start = startOf(task);
  if (!start) return false;
  return timeToMinutes(start) < minute && timeToMinutes(endOf(task)) > minute;
}

/**
 * A task that is no longer going to happen: done, or moved to another day.
 *
 * Exported because every consumer of classifyOverlap wants the same answer —
 * the timeline, resolveClashes and the day warnings all used to count a
 * finished task as a live commitment.
 */
export function isSettled(t: Task): boolean {
  return t.status === 'complete' || t.status === 'moved';
}

/**
 * Classify one collision.
 *
 * `travelMinutes` is the real route between the two places when the caller
 * has one; omit it and a small non-zero estimate stands in.
 */
export function classifyOverlap(
  a: Task, b: Task, travelMinutes?: number,
): OverlapVerdict | null {
  if (!startOf(a) || !startOf(b)) return null;
  // Something already done is not in anyone's way.
  //
  // Koral, 2026-09-22: a wedding she had ticked off was still generating
  // "⚠️ 'the exam' runs past 17:58, when you have to leave for 'חתונה של חני
  // ודני'" on today's timeline — a departure warning for a journey she was
  // never going to make, pushing real work around to protect it.
  //
  // `moved` is here for the same reason: the row is a tombstone pointing at a
  // copy on another day, and the copy is the one that can clash.
  //
  // This is rule 6 in spirit — the question has to fit the thing. You cannot
  // be late leaving for a wedding you have already been to.
  if (isSettled(a) || isSettled(b)) return null;
  const overlap = overlapMinutesOf(a, b);
  if (overlap <= 0) return null;

  // 0. Her own work during a call. A call rides along with a PLACE — the
  // office, a train — not with work that needs her. 6.10: the mock-interview
  // prep ran to 15:37 over the 15:00 Datadog call and nothing asked what to
  // shorten. Server twin: clashes.clash_kind.
  // Work that needs her attention only — study, work, prep (always 'course');
  // an after-office party can still carry a call.
  for (const [work, call] of [[a, b], [b, a]] as const) {
    if (isRemoteTask(call) && !isRemoteTask(work) && !placeKey(work) && isFlexibleTask(work)
        && (FOCUS_CATEGORIES.includes(String(work.category)) || isStudyTask(work))
        && overlap >= OCCUPIED_OVERLAP_MINUTES) {
      return { kind: 'displaced', overlapMinutes: overlap, travelMinutes: 0, displacedTaskId: work.id };
    }
  }

  // 1. Does either side need to BE anywhere? A call rides along.
  for (const [remote, other] of [[a, b], [b, a]] as const) {
    if (isRemoteTask(remote) && !isRemoteTask(other)) {
      return {
        kind: 'parallel',
        overlapMinutes: overlap,
        travelMinutes: 0,
        remoteTaskId: remote.id,
        // If the other side is somewhere else, the overlap IS the journey —
        // but only in a vehicle where a call is actually possible. She cycles.
        // "You can take the call on the way" over a bike ride is an
        // instruction to do something dangerous, printed in a friendly yellow.
        suggestDuringTravel: Boolean(placeKey(other)) && travelAllowsTalking(other),
      };
    }
  }
  // Two remote things at once is still only a clash of attention, not of place.
  if (isRemoteTask(a) && isRemoteTask(b)) {
    return { kind: 'parallel', overlapMinutes: overlap, travelMinutes: 0 };
  }

  // 2. Does either side float? Work with no place cannot be in the wrong one.
  //
  // With ONE exception, and it is the one that cost her a yoga class: a block
  // that covers the moment she has to walk out of the door is not sharing an
  // hour, it is consuming a departure. Sitting in a conference and spending an
  // hour of it sending your CV is fine and stays parallel. Preparing for an
  // interview straight through 18:40, when the bike ride to Charles Clore
  // leaves at 18:40, is not something you can also do.
  for (const [floating, other] of [[a, b], [b, a]] as const) {
    if (isFloatingTask(floating) && !isFloatingTask(other)) {
      const departure = departureOf(other);
      if (departure !== undefined && coversMoment(floating, departure)) {
        return {
          kind: 'displaced',
          overlapMinutes: overlap,
          travelMinutes: 0,
          displacedTaskId: floating.id,
          departureAt: minutesToTime(departure),
        };
      }
      // …and the one that hid 30.9's evening: work that takes real time out of
      // a short appointment. See OCCUPIED_OVERLAP_MINUTES.
      if (overlap >= OCCUPIED_OVERLAP_MINUTES && (other.durationMinutes || 30) <= SHORT_HOST_MINUTES) {
        return {
          kind: 'displaced',
          overlapMinutes: overlap,
          travelMinutes: 0,
          displacedTaskId: floating.id,
        };
      }
      return {
        kind: 'parallel',
        overlapMinutes: overlap,
        travelMinutes: 0,
        remoteTaskId: floating.id,
        suggestDuringTravel: Boolean(placeKey(other)),
      };
    }
  }

  // 3. Same address: double-booked, but nothing is physically impossible.
  const placeA = placeKey(a); const placeB = placeKey(b);
  if (placeA === placeB) {
    return { kind: 'same-place', overlapMinutes: overlap, travelMinutes: 0 };
  }

  // 4. Two places at once. The hard one.
  const [first, second] = timeToMinutes(startOf(a)!) <= timeToMinutes(startOf(b)!)
    ? [a, b] : [b, a];
  const travel = travelMinutes && travelMinutes > 0 ? travelMinutes : ASSUMED_TRAVEL_MINUTES;
  const mustLeaveBy = timeToMinutes(startOf(second)!) - travel;
  const stayThenArrive = timeToMinutes(endOf(first)) + travel;
  return {
    kind: 'spatial',
    overlapMinutes: overlap,
    travelMinutes: travel,
    leaveEarlyAt: minutesToTime(mustLeaveBy),
    arriveLateBy: Math.max(0, stayThenArrive - timeToMinutes(startOf(second)!)),
    arriveLateAt: minutesToTime(stayThenArrive),
  };
}

/**
 * Where an unfinished task should go next.
 *
 * When a task's end time passes without being ticked off, "move it to
 * tomorrow" was the only offer — which is wrong at 11am, when the day it
 * belongs to still has six hours in it. Look for room TODAY first, and fall
 * back to tomorrow only when the day genuinely has none left.
 *
 * Pure: the caller supplies the day's other tasks, the clock and the day's
 * end, and does the writing.
 */
export interface RescheduleSuggestion {
  /** 'today' carries the slot; 'tomorrow' means the day has no room left. */
  when: 'today' | 'tomorrow';
  /** HH:MM, only for 'today'. */
  at?: string;
}

export function suggestReschedule(
  task: Task,
  dayTasks: Task[],
  opts: { now: string; dayEnd?: string },
): RescheduleSuggestion {
  const dayEnd = opts.dayEnd || '22:00';
  const minutes = task.durationMinutes || 30;

  // Busy blocks: everything still live today that holds a clock slot, minus
  // the task being rescheduled — it is not in its own way.
  const busy = dayTasks
    .filter((t) => t.id !== task.id && t.status === 'pending' && startOf(t))
    .map((t) => [timeToMinutes(startOf(t)!), timeToMinutes(endOf(t))] as const)
    .sort((a, b) => a[0] - b[0]);

  let cursor = timeToMinutes(opts.now);
  const limit = timeToMinutes(dayEnd);
  for (let guard = 0; guard < 100; guard += 1) {
    const hit = busy.find(([s, e]) => cursor < e && cursor + minutes > s);
    if (!hit) break;
    cursor = hit[1];
  }
  return cursor + minutes <= limit
    ? { when: 'today', at: minutesToTime(cursor) }
    : { when: 'tomorrow' };
}

/** Two consecutive places whose gap is shorter than the ride between them. */
export interface TightTransfer {
  from: Task;
  to: Task;
  /** Minutes between the end of `from` and the start of `to`. */
  gapMinutes: number;
  travelMinutes: number;
  /** How late she lands at `to` if she stays to the end of `from`. */
  lateBy: number;
  /** …at this time. */
  arriveAt: string;
}

/**
 * The clash that is not an overlap.
 *
 * Koral, 29.9: "if you insert a task in another place than the previous task
 * and the time is not enough to do that in real life" — a meeting at Azrieli
 * until 14:00 and coffee in Herzliya at 14:15 share no minute, so
 * classifyOverlap (which needs an overlap) said nothing, while the ride is
 * half an hour. dayWarnings knew this all along but only the week view read it.
 *
 * Pairs each PLACED task with the previous placed one (floating work in
 * between does not move her). Travel is the second task's own planned ride —
 * never a guess: an unplanned leg is not reported, so this cannot cry wolf.
 * Overlapping pairs are skipped; they are ordinary clashes already.
 */
export function tightTransfers(tasks: Task[]): TightTransfer[] {
  const placed = tasks
    .filter((t) => t.status === 'pending' && startOf(t) && !isFloatingTask(t))
    .sort((a, b) => timeToMinutes(startOf(a)!) - timeToMinutes(startOf(b)!));
  const out: TightTransfer[] = [];
  for (let k = 1; k < placed.length; k++) {
    const from = placed[k - 1];
    const to = placed[k];
    if (placeKey(from) === placeKey(to)) continue;
    const fromEnd = timeToMinutes(endOf(from));
    const toStart = timeToMinutes(startOf(to)!);
    const gap = toStart - fromEnd;
    if (gap < 0) continue;
    const loc: any = typeof to.location === 'object' ? to.location : undefined;
    const travel = Number(loc?.travelMinutes ?? loc?.transitPlan?.totalDurationMinutes);
    if (!Number.isFinite(travel) || travel <= 0) continue;
    if (gap >= travel) continue;
    out.push({
      from, to,
      gapMinutes: gap,
      travelMinutes: travel,
      lateBy: travel - gap,
      arriveAt: minutesToTime(fromEnd + travel),
    });
  }
  return out;
}
