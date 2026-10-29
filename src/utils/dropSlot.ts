/**
 * dropSlot — where a task dragged from the tray lands.
 *
 * Koral, 27.10: "today's tasks that are not in the diary yet — drag one to a
 * place and everything arranges itself". The drop targets are the day's free
 * windows; the finger's height inside a window picks the hour, snapped to 5
 * minutes, and the task never spills past the window's end (which is already
 * the NEXT thing's leave time — findGaps). A task longer than the window does
 * not fit there, and says so instead of overlapping.
 *
 * Pure: rectangles and HH:MM in, HH:MM out.
 */
import { addMinutes, timeToMinutes } from './timeUtils';

export interface DropZone {
  id: string;
  /** Window coordinates, as measureInWindow reports them. */
  y: number;
  height: number;
  start: string;
  end: string;
}

/** The zone under the finger, or null. */
export function zoneAt(pageY: number, zones: DropZone[]): DropZone | null {
  return zones.find((z) => pageY >= z.y && pageY <= z.y + z.height) ?? null;
}

export type DropResult = { ok: true; time: string } | { ok: false; reason: 'too_long' };

/**
 * The start time for a task of `minutes` dropped at fraction `frac` (0 = top,
 * 1 = bottom) of a window. The latest start is the window's end minus the task.
 */
export function timeInWindow(zone: Pick<DropZone, 'start' | 'end'>, frac: number, minutes: number, snap = 5): DropResult {
  const s = timeToMinutes(zone.start);
  const e = timeToMinutes(zone.end);
  const room = e - s - Math.max(5, minutes);
  if (room < 0) return { ok: false, reason: 'too_long' };
  const f = Math.max(0, Math.min(1, frac));
  const raw = s + room * f;
  const snapped = Math.min(s + room, Math.ceil(raw / snap) * snap);
  return { ok: true, time: addMinutes('00:00', Math.max(s, snapped)) };
}
