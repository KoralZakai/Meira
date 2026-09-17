/**
 * timelineLayout — the day as geometry.
 *
 * The old timeline drew every task as the same fixed-height row, so a
 * nine-hour conference and a fifteen-minute call looked identical and the day
 * carried no sense of shape. This turns tasks into positioned blocks: height
 * proportional to duration, overlapping ones side by side, and each one told
 * whether it is behind her, under her, or ahead.
 *
 * Two compromises, both deliberate:
 *
 *   MIN_BLOCK_PX — strict proportionality makes a 15-minute task 8 px tall,
 *   which cannot hold a title. Short blocks are floored, so the scale is
 *   honest for everything long enough to read and generous below that.
 *
 *   Columns, not overlap-by-pixels — two clashing tasks are laid side by side
 *   like a calendar rather than stacked, because the point of drawing a clash
 *   is that BOTH stay readable.
 *
 * Pure: no clock of its own (`now` is passed), no storage, no RN imports, so
 * tests/run-timeline-layout.ts drives every branch.
 */
import { Task } from '../types/index';
import { timeToMinutes, addMinutes } from './timeUtils';

/**
 * Vertical scale. At 0.55 px/min a one-hour task came to 33 px — under the
 * floor — so an ordinary day of hour-long meetings rendered as identical
 * blocks and the proportion was invisible exactly when it should be doing its
 * work. 0.8 differentiates from an hour up: 1h = 48px, 2h = 96px, 9h = 432px.
 */
export const PX_PER_MIN = 0.8;
/**
 * No block shorter than this, whatever its duration.
 *
 * 44, not 52: at 0.8 px/min an hour is 48 px, so a 52 px floor would swallow
 * it and one-hour meetings would go on rendering identically to half-hour
 * ones — the exact thing the new scale exists to fix. 44 is also the smallest
 * comfortable touch target, so it is the lowest floor worth having.
 *
 * Below ~55 min everything flattens to the floor. That is unavoidable: making
 * 30 min visibly shorter than 1 h needs a floor of ~24 px, which cannot hold a
 * title. The scale earns its keep from an hour upwards.
 */
export const MIN_BLOCK_PX = 44;
/** Gap between a block and the next thing under it. */
export const BLOCK_GAP_PX = 10;

export interface TimelineBlock {
  task: Task;
  /** Minutes from midnight. */
  startMin: number;
  endMin: number;
  /** Rendered height in px. */
  height: number;
  /** Column index inside its overlap group, and the group's width. */
  column: number;
  columns: number;
  /** Entirely behind her. */
  past: boolean;
  /** `now` falls inside it. */
  active: boolean;
  /** 0..1 through the block; 0 unless active. */
  progress: number;
  /** The first block that is still ahead — the one to highlight. */
  next: boolean;
}

const startOf = (t: Task): string | undefined => t.fixedTime || t.scheduledTime || undefined;

/** Blocks in clock order, positioned, with overlaps resolved into columns. */
export function layoutDay(
  tasks: Task[],
  opts: { now?: string; pxPerMin?: number; minBlockPx?: number } = {},
): TimelineBlock[] {
  const pxPerMin = opts.pxPerMin ?? PX_PER_MIN;
  const minBlockPx = opts.minBlockPx ?? MIN_BLOCK_PX;
  const now = opts.now ? timeToMinutes(opts.now) : undefined;

  const timed = tasks
    .filter((t) => startOf(t) && t.status !== 'moved')
    .map((task) => {
      const start = startOf(task)!;
      const startMin = timeToMinutes(start);
      const endMin = timeToMinutes(addMinutes(start, task.durationMinutes || 30));
      return { task, startMin, endMin };
    })
    .filter((b) => Number.isFinite(b.startMin) && b.endMin > b.startMin)
    .sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);

  // Overlap groups: walk in order, and start a new group whenever a task
  // begins after everything before it has finished.
  const groups: (typeof timed)[] = [];
  let current: typeof timed = [];
  let groupEnd = -1;
  for (const block of timed) {
    if (current.length && block.startMin >= groupEnd) {
      groups.push(current);
      current = [];
      groupEnd = -1;
    }
    current.push(block);
    groupEnd = Math.max(groupEnd, block.endMin);
  }
  if (current.length) groups.push(current);

  const out: TimelineBlock[] = [];
  for (const group of groups) {
    // Within a group, give each task the first column whose last task has
    // finished — the standard calendar packing.
    const columnEnds: number[] = [];
    const placed = group.map((block) => {
      let column = columnEnds.findIndex((end) => end <= block.startMin);
      if (column === -1) { column = columnEnds.length; columnEnds.push(block.endMin); }
      else columnEnds[column] = block.endMin;
      return { ...block, column };
    });
    const columns = columnEnds.length;
    for (const b of placed) {
      const minutes = b.endMin - b.startMin;
      const active = now !== undefined && now >= b.startMin && now < b.endMin;
      out.push({
        ...b,
        columns,
        height: Math.max(minBlockPx, Math.round(minutes * pxPerMin)),
        past: now !== undefined && now >= b.endMin,
        active,
        progress: active ? (now! - b.startMin) / minutes : 0,
        next: false,
      });
    }
  }

  // "Next" is the earliest block that has not started. Marked after the fact so
  // it is one block across the whole day, not one per overlap group.
  const upcoming = out
    .filter((b) => now === undefined || b.startMin > now)
    .sort((a, b) => a.startMin - b.startMin)[0];
  if (upcoming) upcoming.next = true;

  return out;
}

/** Does this day contain a genuine clash? */
export function hasClash(blocks: TimelineBlock[]): boolean {
  return blocks.some((b) => b.columns > 1);
}
