/**
 * calendarTime — the one place a calendar instant becomes a clock on the wall.
 *
 * Google returns an offset-bearing RFC-3339 string ("…T11:00:00+03:00" or a
 * UTC "…Z"). Slicing characters 11–16 off it only worked while that offset
 * happened to match the phone; this parses the instant and reads the LOCAL
 * clock instead, so the zone database — not a hard-coded +2 or +3 — decides.
 *
 * Why it is its own module: it lived as a closure inside
 * GoogleService.fetchCalendarEvents, which meant nothing could test it without
 * a Google token, and tests/run-ceva-interview.ts ended up testing a COPY of
 * it. Israel leaves summer time on 2026-10-25: 09:00 local is 06:00Z before
 * that and 07:00Z after it. Any `local + fixed_offset` arithmetic is wrong on
 * one side of that line, and this is the function that has to be right on both.
 *
 * Pure apart from the process time zone (the phone's), which is exactly the
 * zone the rest of the app renders in.
 *
 * Dependencies: none. Consumed by services/GoogleService.
 */

/** HH:MM on the local clock for an RFC-3339 instant, or null if unparseable. */
export function localClockOf(dateTime?: string | null): string | null {
  if (!dateTime) return null;
  const parsed = new Date(dateTime);
  if (Number.isNaN(parsed.getTime())) return null;
  return `${String(parsed.getHours()).padStart(2, '0')}:${String(parsed.getMinutes()).padStart(2, '0')}`;
}
