/**
 * timelineRows — the ORDER of the day, as a list.
 *
 * layoutDay answers the geometry question (how tall is each block, which
 * column, is it past). This answers the other half, and the half the user has
 * complained about twice: in what sequence do the things appear, and what sits
 * between them.
 *
 * It lived inside DayTimeline's render, so the one property that matters most
 * on this screen — that a day reads top to bottom in clock order, with nothing
 * above something earlier than it — was asserted by nobody. Both timeline bugs
 * she has reported were ordering bugs, and both were found by looking at a
 * phone rather than by a test, because there was no seam to put a test on.
 *
 * Deliberate choices, and why this is not simply "sort by time":
 *
 *   overlapping tasks are ONE row-group, emitted at the earliest start in the
 *   group. A conference from 09:00 to 17:00 swallows everything inside it; the
 *   things inside are drawn under it, each at its own hour, rather than
 *   scattered between unrelated rows. Google Calendar solves this with
 *   columns; a phone is too narrow for columns (three abreast leaves ~100 px
 *   and the title clips to nothing — "the tasks are not seen, the text
 *   disappears"), so the same information is stacked and each block keeps its
 *   own clock.
 *
 *   a gap is emitted BEFORE the group it precedes, never after. Free time
 *   belongs to the space it actually occupies, and a gap row drawn below the
 *   task it precedes is the timeline lying about the order.
 *
 *   `now` is placed as its own row only when no visible block contains it —
 *   otherwise the active block draws its own marker and two would be a
 *   contradiction on screen.
 *
 * Pure: no clock of its own, no RN, so tests/run-timeline-chronology.ts can
 * assert the ordering rules on any day it likes.
 */
import { Task } from '../types/index';
import { TimelineBlock } from './timelineLayout';
import { DayGap } from './findGaps';
import { timeToMinutes } from './timeUtils';

export type TimelineRow =
  | { kind: 'gap'; gap: DayGap }
  | { kind: 'blocks'; group: TimelineBlock[] }
  | { kind: 'now' };

/** Minutes from midnight at which a row begins; `now` sorts to the end. */
export function rowStartMin(row: TimelineRow): number {
  if (row.kind === 'blocks') return row.group[0].startMin;
  if (row.kind === 'gap') return timeToMinutes(row.gap.start);
  return Number.POSITIVE_INFINITY;
}

export function buildTimelineRows(opts: {
  /** Tasks that have a time, already in clock order. */
  scheduled: Task[];
  /** Their geometry, from layoutDay. */
  blocks: TimelineBlock[];
  /** Free windows, each optionally tagged with the task it precedes. */
  gaps: DayGap[];
  /** Minutes from midnight, or null when the day being drawn is not today. */
  nowMin?: number | null;
}): TimelineRow[] {
  const { scheduled, blocks, gaps, nowMin = null } = opts;
  const byTask = new Map(blocks.map((b) => [b.task.id, b]));
  const trailing = gaps.filter((g) => !g.after);

  const rows: TimelineRow[] = [];
  const emitted = new Set<string>();

  for (const task of scheduled) {
    const block = byTask.get(task.id);
    if (!block || emitted.has(task.id)) continue;

    // Everything sharing this clock space: the same start minute, or a genuine
    // overlap in another column. Taken from `blocks`, which layoutDay returns
    // in clock order, so the group is in clock order too — the group is what
    // renders as consecutive rows, and it is where "כולם ביחד באותו בלוק" came
    // from when every one of them was labelled with the lead's time.
    const group = blocks
      .filter((b) => b.startMin === block.startMin
        || (b.columns > 1 && b.column !== block.column
          && b.startMin < block.endMin && b.endMin > block.startMin))
      .filter((b) => !emitted.has(b.task.id));
    const finalGroup = group.length ? group : [block];

    // The free window before this group, drawn where it happens.
    const before = gaps.find((g) => g.after?.id === task.id);
    if (before && !finalGroup.some((b) => emitted.has(b.task.id))) {
      rows.push({ kind: 'gap', gap: before });
    }

    finalGroup.forEach((b) => emitted.add(b.task.id));
    rows.push({ kind: 'blocks', group: finalGroup });
  }

  for (const gap of trailing) rows.push({ kind: 'gap', gap });

  // The heartbeat, when nothing is running. An active block draws its own
  // marker; without one the day loses the mark that says where she is on it.
  if (nowMin !== null && !blocks.some((b) => b.active)) {
    const at = rows.findIndex((r) => rowStartMin(r) > nowMin);
    rows.splice(at === -1 ? rows.length : at, 0, { kind: 'now' });
  }

  return rows;
}

/**
 * Does this list read top-to-bottom in clock order?
 *
 * The one rule the screen must never break, and the one that broke twice. A
 * row whose start time is earlier than the row above it means a task has
 * jumped the queue, which on a day view is not a cosmetic defect: it is the
 * screen telling her the wrong thing about what comes next.
 *
 * Returns the offending pair rather than a bare false, so a test — or a
 * future assertion in development — can say WHICH rows.
 */
export function outOfOrderRows(rows: TimelineRow[]): Array<{ at: number; prev: number; next: number }> {
  const bad: Array<{ at: number; prev: number; next: number }> = [];
  let prev = -Infinity;
  rows.forEach((row, i) => {
    if (row.kind === 'now') return;   // placed by position, has no time of its own
    const start = rowStartMin(row);
    if (start < prev) bad.push({ at: i, prev, next: start });
    prev = start;
  });
  return bad;
}
