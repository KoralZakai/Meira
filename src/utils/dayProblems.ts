/**
 * dayProblems — the day's problems, once each, in the order she meets them.
 *
 * On 30.9 the Today screen drew two cards for one fact: "⚠️ Clash at 12:15 —
 * see it ›" from resolveClashes and "⚠️ 15 min to reach "Coffee with Dana" —
 * the ride is 54 · arrive 12:54 (39 min late) ›" from tightTransfers. Both were
 * right; together they read as two problems, and five numbers in one line.
 * Meanwhile the one she most needed to see — a business plan laid over the
 * 18:30 meetup — was on neither.
 *
 * This is the single list the screen draws from:
 *   - one entry per PAIR of tasks, whichever detector found it first;
 *   - a travel problem only from the ride she will actually take
 *     (tightTransfers never guesses), never from the resolver's 15-minute
 *     stand-in for an unrouted leg — a warning that cannot be trusted teaches
 *     her to skip the colour;
 *   - `kind` decides the card: travel → the one-question card (3C), overlap →
 *     "which one?" (2D), spatial / double → the hard pair.
 *
 * Pure: no storage, no clock. Pinned by tests/run-day-problems.ts.
 */
import { Task } from '../types/index';
import { resolveClashes, Clash } from './resolveClashes';
import { classifyOverlap, tightTransfers } from './overlapKind';
import { timeToMinutes, minutesToTime } from './timeUtils';
import { findDayGaps } from './findGaps';
import { isFlexibleTask } from './taskShape';

interface ProblemBase {
  /** Stable per pair, so an answer to it can be remembered. */
  key: string;
}

/** Two places, not enough time between them. The 3C card. */
export interface TravelProblem extends ProblemBase {
  kind: 'travel';
  from: Task;
  to: Task;
  gapMinutes: number;
  travelMinutes: number;
  /** How late she lands at `to` if she stays to the end of `from`. */
  lateBy: number;
  /** …at this time. */
  arriveAt: string;
  /** A round time to ask the other person for — "Ask Dana for 13:00". */
  askFor: string;
  /** How the planned ride goes, when the leg says. */
  mode?: string;
  /** The resolver's options for the same pair, when it found it too. */
  clash?: Clash;
}

/** Her own movable work sitting on an appointment. The 2D card. */
export interface OverlapProblem extends ProblemBase {
  kind: 'overlap';
  work: Task;
  fixed: Task;
  overlapMinutes: number;
  clash: Clash;
}

/** Two appointments at once — two places (spatial) or one (double). */
export interface PairProblem extends ProblemBase {
  kind: 'spatial' | 'double';
  a: Task;
  b: Task;
  overlapMinutes: number;
  clash: Clash;
}

export type DayProblem = TravelProblem | OverlapProblem | PairProblem;

export const problemKey = (a: Task, b: Task): string => [a.id, b.id].sort().join('×');

const startOf = (t: Task): string => t.fixedTime || t.scheduledTime || '23:59';

/** Round UP to the quarter hour: nobody asks a friend for 12:54. */
const ceilQuarter = (minutes: number): number => Math.ceil(minutes / 15) * 15;

/** The moment she meets this problem, for ordering. */
function whenOf(p: DayProblem): number {
  if (p.kind === 'travel') return timeToMinutes(startOf(p.to));
  if (p.kind === 'overlap') return timeToMinutes(startOf(p.fixed));
  return Math.min(timeToMinutes(startOf(p.a)), timeToMinutes(startOf(p.b)));
}

export function dayProblems(tasks: Task[], dayEnd = '23:00'): DayProblem[] {
  const found = new Map<string, DayProblem>();

  // 1. The rides she will actually take.
  for (const tt of tightTransfers(tasks)) {
    const key = problemKey(tt.from, tt.to);
    const loc: any = typeof tt.to.location === 'object' ? tt.to.location : undefined;
    found.set(key, {
      kind: 'travel', key, from: tt.from, to: tt.to,
      gapMinutes: tt.gapMinutes, travelMinutes: tt.travelMinutes,
      lateBy: tt.lateBy, arriveAt: tt.arriveAt,
      askFor: minutesToTime(ceilQuarter(timeToMinutes(tt.arriveAt))),
      mode: loc?.transportType,
    });
  }

  // 2. Everything else the resolver sees — once per pair.
  for (const clash of resolveClashes(tasks, dayEnd)) {
    if (clash.kind === 'parallel') continue;
    const key = problemKey(clash.a, clash.b);
    const seen = found.get(key);
    if (seen) {
      if (seen.kind === 'travel') seen.clash = clash;
      continue;
    }
    // A travel shortfall the planned rides did not show rests on the
    // resolver's 15-minute stand-in for an unrouted leg. Not drawn: the route
    // arrives, and then tightTransfers says so with a real number.
    if (clash.kind === 'travel') continue;
    if (clash.kind === 'overlap') {
      const verdict = classifyOverlap(clash.a, clash.b);
      const work = verdict?.displacedTaskId === clash.b.id ? clash.b : clash.a;
      const fixed = work === clash.a ? clash.b : clash.a;
      found.set(key, { kind: 'overlap', key, work, fixed, overlapMinutes: clash.overlapMinutes, clash });
      continue;
    }
    found.set(key, {
      kind: clash.kind, key, a: clash.a, b: clash.b, overlapMinutes: clash.overlapMinutes, clash,
    });
  }

  return [...found.values()].sort((x, y) => whenOf(x) - whenOf(y));
}

/**
 * Where a piece of work goes when she keeps the appointment it sat on: the
 * first free window that fits it WHOLE, counted to each departure (the same
 * windows Today draws), or 'tomorrow' when the day has none left. Server twin:
 * day_plan._slot_for.
 */
export function moveSlotFor(
  work: Task, tasks: Task[], opts: { now?: string; dayStart?: string; dayEnd?: string } = {},
): string {
  const need = work.durationMinutes || 30;
  const others = tasks.filter((t) => t.id !== work.id && t.status !== 'complete' && !isFlexibleTask(t));
  // stayOut: work that can be done anywhere starts where she already is — the
  // hour after coffee in Herzliya is usable without riding home first.
  const gap = findDayGaps(others, { ...opts, minMinutes: need, stayOut: true }).find((g) => g.minutes >= need);
  return gap ? gap.start : 'tomorrow';
}
