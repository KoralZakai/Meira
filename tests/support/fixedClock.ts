/**
 * fixedClock — "now" for the fixture-month simulations, set BEFORE that month.
 *
 * The sims replay 4.10–29.10 through the real app code, which (rightly)
 * refuses to plan a trip or a wake alarm for an hour that has gone. On the
 * real clock that made them fail on any day inside the month they replay:
 * from 21.10 every Fly deploy was blocked by run-feasibility-differential and
 * run-meira-sim-users, and the server stayed six days behind master (27.10).
 * A test's verdict must not depend on the day CI happens to run.
 *
 * Import FIRST: it replaces the global Date before any module reads it.
 */
const FIXED_MS = Date.parse('2026-10-01T06:00:00+03:00');
const RealDate = Date;

class FixedDate extends RealDate {
  constructor(...args: any[]) {
    if (args.length === 0) super(FIXED_MS);
    else super(...(args as [any]));
  }
  static now(): number {
    return FIXED_MS;
  }
}

(globalThis as any).Date = FixedDate;
export const FIXED_NOW_MS = FIXED_MS;
