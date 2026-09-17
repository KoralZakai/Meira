/**
 * findGaps — every REAL free window in a day, not just the first one.
 *
 * TodaySchedule had a private findGap() that returned a single hole between
 * two timed tasks, used once to place a wish-list suggestion. So a day with
 * three hours free in the morning, an hour after lunch and a whole evening
 * offered exactly one slot, and nothing at all before the first task or after
 * the last one — the two places where free time actually piles up.
 *
 * "Real" is the whole point:
 * - A window ends when she has to LEAVE, not when the next task starts. A
 *   13:00 meeting in Haifa with leaveHomeBy 12:10 does not leave an hour free
 *   at 12:00; it leaves ten minutes.
 * - …and it OPENS when she can actually be somewhere she can use, not the
 *   minute the last thing ended. The gym finishes at 21:00 in another
 *   neighbourhood; studying does not start at 21:00, it starts when she walks
 *   through the door. The return trip is taken from the task's own stored
 *   route (transitPlan / travelMinutes), the same number the travel chain
 *   uses for the way home, so this stays pure — no network in a render.
 * - Nothing before `now` is free — it is gone.
 * - Overlapping tasks (the clash case) count as one busy block, so a clash
 *   never invents a gap between its two halves.
 * - A window under `minMinutes` is not offered: proposing a 10-minute task
 *   between two meetings is noise.
 *
 * Pure — no storage, no network, no clock of its own (`now` is passed in), so
 * tests/run-find-gaps.ts can drive it directly.
 *
 * Dependencies: timeUtils, types. Consumed by screens/TodaySchedule,
 * services/GapFillService, services/ScheduleQueryService.
 */
import { Task, TaskLocation } from '../types/index';
import { addMinutes, timeToMinutes, minutesToTime } from './timeUtils';

export interface DayGap {
  /** HH:MM the window opens. */
  start: string;
  /** HH:MM the window closes — the leave time for what comes next, if any. */
  end: string;
  minutes: number;
  /** The task that ends just before the window (absent at the start of a day). */
  before?: Task;
  /** The task the window runs up against (absent at the end of a day). */
  after?: Task;
  /**
   * True when `end` is a departure time rather than the next task's start —
   * the UI says "free until you leave at 12:10", which is a different promise
   * from "free until 13:00".
   */
  endsAtDeparture: boolean;
  /**
   * Minutes of travelling home that were cut off the FRONT of this window
   * because the previous task was somewhere else. Present only when it
   * happened, so the UI can say "free from 21:25 — once you're home".
   */
  travelHomeMinutes?: number;
}

export interface FindGapsOptions {
  /** Earliest the day can be used — wake time. Default 08:00. */
  dayStart?: string;
  /** Latest — sleep/wind-down time. Default 22:00. */
  dayEnd?: string;
  /** HH:MM. When given, no window may start before it (today's clock). */
  now?: string;
  /** Shortest window worth offering. Default 30. */
  minMinutes?: number;
  /**
   * Minutes to allow for packing up and setting off after a task at a place.
   * Default 5 — the same figure buildWayHome uses.
   */
  packUpMinutes?: number;
}

/** What a trip costs when nothing has computed the real route yet. */
const DEFAULT_TRAVEL_MINUTES = 30;

const asLoc = (t?: Task): TaskLocation | undefined =>
  t && t.location && typeof t.location === 'object' ? (t.location as TaskLocation) : undefined;

/** When this task takes her out of the window: leave time if it has one. */
function claimStart(task: Task): string | null {
  const start = task.fixedTime || task.scheduledTime;
  if (!start) return null;
  const leave = asLoc(task)?.leaveHomeBy;
  return leave && leave < start ? leave : start;
}

/** When this task's own block ends (before any travelling home). */
function claimEnd(task: Task): string | null {
  const start = task.fixedTime || task.scheduledTime;
  if (!start) return null;
  return addMinutes(start, task.durationMinutes || 30);
}

/**
 * Minutes between this task ending and her being home and usable.
 *
 * Zero for anything at home. For a task at a place it is the stored route
 * duration (the outbound trip, used symmetrically for the way back — exactly
 * what buildWayHome does), plus the pack-up minutes. A located task with no
 * route yet still gets the default estimate rather than zero: "we haven't
 * computed it" is not the same as "it's next door", and treating it as zero is
 * what puts a study block at 21:00 when she is still on the bus.
 */
export function returnTravelMinutes(task: Task | undefined, packUpMinutes = 5): number {
  const loc = asLoc(task);
  if (!loc) return 0;
  const travel = loc.transitPlan?.totalDurationMinutes ?? loc.travelMinutes ?? DEFAULT_TRAVEL_MINUTES;
  return travel + packUpMinutes;
}

/** Busy blocks of a day, merged, in clock order. */
function busyBlocks(tasks: Task[]): Array<{ start: string; end: string; task: Task }> {
  const claims = tasks
    .filter((t) => t.status !== 'moved')
    .map((t) => {
      const start = claimStart(t);
      const end = claimEnd(t);
      return start && end ? { start, end, task: t } : null;
    })
    .filter((c): c is { start: string; end: string; task: Task } => c !== null)
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

  const merged: Array<{ start: string; end: string; task: Task }> = [];
  for (const claim of claims) {
    const last = merged[merged.length - 1];
    if (last && timeToMinutes(claim.start) <= timeToMinutes(last.end)) {
      // Overlapping/touching — one block. Keep the LATER end, and let the
      // block keep the task that ends last: that is the one she is coming out
      // of when the window opens.
      if (timeToMinutes(claim.end) > timeToMinutes(last.end)) {
        last.end = claim.end;
        last.task = claim.task;
      }
      continue;
    }
    merged.push({ ...claim });
  }
  return merged;
}

/** Every free window in the day, earliest first. */
export function findDayGaps(tasks: Task[], opts: FindGapsOptions = {}): DayGap[] {
  const dayStart = opts.dayStart || '08:00';
  const dayEnd = opts.dayEnd || '22:00';
  const minMinutes = opts.minMinutes ?? 30;
  const floor = opts.now && timeToMinutes(opts.now) > timeToMinutes(dayStart) ? opts.now : dayStart;

  const blocks = busyBlocks(tasks);
  const gaps: DayGap[] = [];

  const push = (start: string, end: string, before?: Task, after?: Task) => {
    // The trip back from wherever `before` was. Nothing in this window can
    // begin until it is over.
    const travelHome = returnTravelMinutes(before, opts.packUpMinutes);
    const usableStart = travelHome ? addMinutes(start, travelHome) : start;
    const from = timeToMinutes(usableStart) < timeToMinutes(floor) ? floor : usableStart;
    const to = timeToMinutes(end) > timeToMinutes(dayEnd) ? dayEnd : end;
    const minutes = timeToMinutes(to) - timeToMinutes(from);
    if (minutes < minMinutes) return;
    const nextStart = after ? (after.fixedTime || after.scheduledTime) : undefined;
    gaps.push({
      start: from,
      end: to,
      minutes,
      before,
      after,
      endsAtDeparture: Boolean(nextStart && nextStart !== to && to !== dayEnd),
      ...(travelHome && timeToMinutes(from) > timeToMinutes(start)
        ? { travelHomeMinutes: travelHome }
        : {}),
    });
  };

  if (!blocks.length) {
    push(floor, dayEnd);
    return gaps;
  }

  push(floor, blocks[0].start, undefined, blocks[0].task);
  for (let i = 0; i < blocks.length - 1; i += 1) {
    push(blocks[i].end, blocks[i + 1].start, blocks[i].task, blocks[i + 1].task);
  }
  push(blocks[blocks.length - 1].end, dayEnd, blocks[blocks.length - 1].task);

  return gaps;
}

/**
 * Can a block of `minutes` (plus travel either side) fit in this day?
 *
 * Returns the windows that could hold it, longest first. `travelBefore` /
 * `travelAfter` are the minutes needed to reach the place and to get from it
 * to whatever comes next — the caller works those out (Google), because a
 * pure function cannot know the roads.
 */
export function fitsInDay(
  gaps: DayGap[],
  minutes: number,
  travelBefore = 0,
  travelAfter = 0,
): DayGap[] {
  const needed = minutes + travelBefore + travelAfter;
  return gaps
    .filter((g) => g.minutes >= needed)
    .sort((a, b) => b.minutes - a.minutes);
}

/** "12:00–13:00 · 1h free" — one line for a gap row. */
export function describeGap(gap: DayGap, language: 'en' | 'he' = 'en'): string {
  const h = Math.floor(gap.minutes / 60);
  const m = gap.minutes % 60;
  const len = h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
  const lenHe = h ? (m ? `${h} שעות ${m} דק׳` : `${h} שעות`) : `${m} דק׳`;
  return language === 'he'
    ? `${gap.start}–${gap.end} · ${lenHe} פנויות`
    : `${gap.start}–${gap.end} · ${len} free`;
}

/** Round a start time up to the next 5 minutes — a slot starting 12:07 reads as noise. */
export function roundSlotStart(hhmm: string): string {
  return minutesToTime(Math.ceil(timeToMinutes(hhmm) / 5) * 5);
}

// Self-check: npx tsx src/utils/findGaps.ts
if (typeof require !== 'undefined' && require.main === module) {
  const mk = (over: Partial<Task>): Task => ({
    id: Math.random().toString(36).slice(2),
    text: 'x', category: 'general', priority: 'need_to', isFixed: false,
    durationMinutes: 60, date: '2026-08-31', status: 'pending',
    createdAt: 0, historicalDurations: [], ...over,
  } as Task);

  const day = [
    mk({ text: 'standup', fixedTime: '09:00', durationMinutes: 30 }),
    mk({ text: 'meeting', fixedTime: '13:00', durationMinutes: 60 }),
  ];
  const gaps = findDayGaps(day, { now: '12:00', dayStart: '08:00', dayEnd: '22:00' });
  console.assert(gaps[0].start === '12:00' && gaps[0].end === '13:00', 'gap from now to next task');
  console.assert(gaps[1].start === '14:00' && gaps[1].end === '22:00', 'gap after the last task');

  // The gym is 25 minutes away: the evening does not start at 21:00.
  const evening = findDayGaps([mk({
    text: 'gym', fixedTime: '20:00', durationMinutes: 60,
    location: { address: 'Space Gym', lat: 32.1, lng: 34.8, confirmed: true, travelMinutes: 25 },
  })], { dayStart: '08:00', dayEnd: '23:00' });
  const afterGym = evening[evening.length - 1];
  console.assert(afterGym.start === '21:30' && afterGym.travelHomeMinutes === 30,
    `home at 21:30 (25 min ride + 5 packing up), got ${JSON.stringify(afterGym)}`);
  console.log('findGaps self-check OK:', gaps.map((g) => describeGap(g)));
}
