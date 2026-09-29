/**
 * timeRange — what "until" becomes when she moves "from".
 *
 * Koral, 28.9: "if I change the from to 16:00 I expect the until to change to
 * 17:00". The task sheet kept the OLD end, so moving an hour-long 14:00–15:00
 * to 16:00 silently turned it into 16:00–15:00 — a 23-hour task. Moving the
 * start moves the whole block; only picking "until" changes its length.
 *
 * Pure, so tests/run-time-range.ts can pin it.
 */

const toMin = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
const pad = (n: number) => String(n).padStart(2, '0');
const fromMin = (t: number): string => {
  const w = ((t % 1440) + 1440) % 1440;
  return `${pad(Math.floor(w / 60))}:${pad(w % 60)}`;
};

/** How long the range lasts, wrapping past midnight; 0 when either end is missing. */
export function rangeMinutes(from?: string, until?: string): number {
  if (!from || !until) return 0;
  const d = toMin(until) - toMin(from);
  return d < 0 ? d + 1440 : d;
}

/**
 * The new "until" after "from" moves to `newFrom`: the same length as before,
 * or `fallbackMinutes` (the task's duration, else one hour) when there was no
 * range to keep.
 */
export function untilAfterFromChange(
  prevFrom: string | undefined,
  prevUntil: string | undefined,
  newFrom: string,
  fallbackMinutes = 60,
): string {
  const kept = rangeMinutes(prevFrom, prevUntil);
  const length = kept > 0 ? kept : (fallbackMinutes > 0 ? fallbackMinutes : 60);
  return fromMin(toMin(newFrom) + length);
}
