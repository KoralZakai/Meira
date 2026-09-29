/**
 * planIntegrity — does this journey agree with itself?
 *
 * Koral, 2026-09-23, on the morning of her interview:
 *
 *   "have you checked the trains you're offering? i checked and i saw on
 *    13:15-14:01, 13:20-13:58, 13:30-14:16. you wrote: 13:51-14:13 ?!?! this
 *    it really bad! Meira - the app should be super Accurate, correct, and
 *    reliable. Must be tested and validated!"
 *
 * She is right, and the honest problem is that nothing in this app had any way
 * to tell a good journey from a nonsense one. A TransitPlan carries FOUR
 * separate accounts of the same trip — `leaveHomeAt`, `arriveAt`,
 * `totalDurationMinutes`, and the legs — each read out of a different field of
 * Google's response, and they were never once compared. Whatever came back was
 * rendered.
 *
 * So: compare them. Every number a plan claims has to be derivable from the
 * legs underneath it, and a plan that fails its own arithmetic is not shown.
 *
 * This is deliberately NOT a plausibility check ("22 minutes is too fast for
 * Tel Aviv to Ra'anana"). We do not know the geography and guessing at it
 * would be a second thing that can be wrong. What we can know for certain is
 * whether the plan contradicts itself, and that is what this asserts.
 *
 * Pure. tests/run-plan-integrity.ts drives every branch with no network.
 */
import { TransitPlan, TransitLeg } from '../types/index';

const HHMM = /^\d{1,2}:\d{2}$/;
const toMin = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** Minutes from a to b, allowing one midnight wrap. */
function spanMinutes(from: string, to: string): number {
  const d = toMin(to) - toMin(from);
  return d < 0 ? d + 24 * 60 : d;
}

export type PlanProblem =
  | 'no_legs'            // a journey with nothing in it
  | 'bad_times'          // a clock field that is not HH:MM
  | 'out_of_order'       // legs that go backwards in time
  | 'arrival_mismatch'   // arriveAt is not where the legs end
  | 'departure_mismatch' // leaveHomeAt is after the first thing she has to catch
  | 'duration_mismatch'; // totalDurationMinutes is not the span it claims

export interface PlanVerdict {
  ok: boolean;
  problems: PlanProblem[];
  /** One line naming what disagreed with what — for the log, and for her. */
  detail?: string;
}

/** The legs that are an actual vehicle. Walking to a platform is not a ride. */
const ridesOf = (plan: TransitPlan): TransitLeg[] =>
  (plan.legs ?? []).filter((l) => l.type !== 'walk');

/**
 * How far the clocks may disagree before it is a bug rather than rounding.
 *
 * Google rounds durations to the minute in several places and `leaveHomeAt`
 * carries a deliberate 5-minute safety margin, so a small gap is expected. Ten
 * minutes is not: at that point two of the plan's own fields are describing
 * different journeys.
 */
export const TOLERANCE_MIN = 10;

export function checkPlan(plan: TransitPlan | null | undefined): PlanVerdict {
  if (!plan) return { ok: false, problems: ['no_legs'], detail: 'no plan' };
  const problems: PlanProblem[] = [];
  const notes: string[] = [];

  const legs = plan.legs ?? [];
  if (!legs.length) {
    return { ok: false, problems: ['no_legs'], detail: 'a journey with no legs' };
  }

  const clocks = [plan.leaveHomeAt, plan.arriveAt, ...legs.flatMap(
    (l) => [l.departureTime, l.arrivalTime],
  )];
  if (clocks.some((t) => !HHMM.test(t ?? ''))) {
    problems.push('bad_times');
    notes.push(`a clock field is not HH:MM (${clocks.filter((t) => !HHMM.test(t ?? '')).join(', ')})`);
  }

  if (!problems.includes('bad_times')) {
    // 1. The legs must run forwards.
    for (let i = 1; i < legs.length; i += 1) {
      if (spanMinutes(legs[i - 1].arrivalTime, legs[i].departureTime) > 12 * 60) {
        problems.push('out_of_order');
        notes.push(
          `leg ${i} departs ${legs[i].departureTime} before leg ${i - 1} arrives `
          + `${legs[i - 1].arrivalTime}`,
        );
        break;
      }
    }

    // 2. The journey ends where its last leg ends. THIS is the one that catches
    //    a plan whose headline arrival came from a different field of the
    //    response than the itinerary did.
    const lastArrival = legs[legs.length - 1].arrivalTime;
    const arrivalGap = Math.abs(spanMinutes(lastArrival, plan.arriveAt) % (24 * 60));
    const arrivalOff = Math.min(arrivalGap, 24 * 60 - arrivalGap);
    if (arrivalOff > TOLERANCE_MIN) {
      problems.push('arrival_mismatch');
      notes.push(`says it arrives ${plan.arriveAt} but its last leg ends ${lastArrival}`);
    }

    // 3. She cannot leave after the first vehicle has gone.
    const firstRide = ridesOf(plan)[0];
    const board = HHMM.test(plan.firstBusDeparture ?? '')
      ? plan.firstBusDeparture
      : firstRide?.departureTime;
    if (board && spanMinutes(plan.leaveHomeAt, board) > 12 * 60) {
      problems.push('departure_mismatch');
      notes.push(`says leave ${plan.leaveHomeAt}, but the first vehicle goes at ${board}`);
    }

    // 4. The headline duration is the span it describes.
    const span = spanMinutes(plan.leaveHomeAt, plan.arriveAt);
    const claimed = plan.totalDurationMinutes;
    if (Number.isFinite(claimed) && Math.abs(span - claimed) > TOLERANCE_MIN) {
      problems.push('duration_mismatch');
      notes.push(
        `claims ${claimed} min but ${plan.leaveHomeAt}→${plan.arriveAt} is ${span} min`,
      );
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    detail: notes.length ? notes.join('; ') : undefined,
  };
}

/** True when this plan is safe to put in front of her. */
export const planIsSound = (plan: TransitPlan | null | undefined): boolean =>
  checkPlan(plan).ok;

/**
 * One log line naming the journey and what is wrong with it.
 *
 * Rule 2: the plan may be dropped, the reason may not be. A silently shorter
 * list of options is how "13:51-14:13" would simply have been replaced by
 * nothing, with no way to find out it had ever been offered.
 */
export function planProblemLine(plan: TransitPlan, verdict: PlanVerdict): string {
  const lines = ridesOf(plan).map((l) => l.lineNumber).filter(Boolean).join('+') || 'walk';
  return `[planIntegrity] dropped ${plan.leaveHomeAt}→${plan.arriveAt} (${lines}): `
    + `${verdict.problems.join(', ')} — ${verdict.detail ?? ''}`;
}
