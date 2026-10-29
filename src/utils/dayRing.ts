/**
 * dayRing — the geometry of the 24-hour ring on Focus (design canvas v3).
 *
 * Koral, 27.10: "don't lose the beating heart that says where you are in the
 * day". The ring is the day at a glance: a band for daylight, one arc per
 * event in its category colour, a gold arc for each trip out, an inner lane
 * for anything that overlaps the event before it, and the heart at now.
 *
 * Pure geometry (no React Native import, so node tests can load it), 00:00 at
 * the top, clockwise; the caller supplies the category colours. Coordinates are in a 150×150
 * viewBox; the component scales it.
 */
import type { Task } from '../types/index';
import { timeToMinutes } from './timeUtils';

export const RING = { c: 75, r: 62, inner: 49, width: 10 } as const;
export const TRIP_COLOR = '#F2B23A';

export interface RingArc {
  id: string;
  d: string;
  color: string;
  width: number;
  /** 0 = the main ring, 1 = the inner lane for an overlap. */
  lane: 0 | 1;
  kind: 'event' | 'trip';
}

/** Where minute `m` of the day sits on a circle of radius `r`. */
export function pointAt(m: number, r: number = RING.r, c: number = RING.c): [number, number] {
  const a = (m / 1440) * Math.PI * 2 - Math.PI / 2;
  return [c + r * Math.cos(a), c + r * Math.sin(a)];
}

/** An SVG arc from minute `from` to minute `to` (clockwise). Empty when it has no length. */
export function arcPath(from: number, to: number, r: number = RING.r): string {
  const a = Math.max(0, Math.min(1440, from));
  const b = Math.max(a, Math.min(1440, to));
  if (b - a < 1) return '';
  const end = b - a >= 1440 ? b - 0.01 : b;   // a full circle needs a hair of a gap
  const [x1, y1] = pointAt(a, r);
  const [x2, y2] = pointAt(end, r);
  const f = (n: number) => n.toFixed(1);
  return `M${f(x1)} ${f(y1)}A${r} ${r} 0 ${end - a > 720 ? 1 : 0} 1 ${f(x2)} ${f(y2)}`;
}

const startOf = (t: Task): number | null => {
  const at = t.fixedTime || t.scheduledTime;
  return at ? timeToMinutes(at) : null;
};

/**
 * The arcs for a day's tasks. Tasks with no hour are not drawn (they are not
 * anywhere in the day yet). An event that starts before the previous one on
 * the main ring has ended goes to the inner lane, so an overlap is visible as
 * two arcs side by side instead of one hiding the other.
 */
export function ringArcs(tasks: Task[], colorOf: (category: string) => string): RingArc[] {
  const timed = tasks
    .map((t) => ({ t, s: startOf(t) }))
    .filter((x): x is { t: Task; s: number } => x.s !== null && x.t.status !== 'moved')
    .sort((x, y) => x.s - y.s);
  const arcs: RingArc[] = [];
  let mainEnd = -1;
  for (const { t, s } of timed) {
    const e = s + Math.max(5, t.durationMinutes || 30);
    const leave = typeof t.location === 'object' ? t.location?.leaveHomeBy : undefined;
    if (leave) {
      const l = timeToMinutes(leave);
      const d = l < s ? arcPath(l, s) : '';
      if (d) arcs.push({ id: `${t.id}:trip`, d, color: TRIP_COLOR, width: RING.width, lane: 0, kind: 'trip' });
    }
    const lane: 0 | 1 = s < mainEnd ? 1 : 0;
    const d = arcPath(s, e, lane ? RING.inner : RING.r);
    if (d) {
      arcs.push({ id: t.id, d, color: colorOf(t.category ?? 'general'), width: lane ? 6 : RING.width, lane, kind: 'event' });
    }
    if (!lane) mainEnd = Math.max(mainEnd, e);
  }
  return arcs;
}
