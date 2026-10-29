/**
 * homeBrief — the one line under "Hi Koral, how can I help?" on the chat home.
 *
 * Koral, 27.10 (canvas v4): "now — Community Builder. Next — interview at
 * 16:00, leave at 15:19." What is happening, what is next, and the moment to
 * walk out — the three things a secretary says first. Pure: the caller passes
 * today's tasks and the minute of the day.
 */
import type { Task } from '../types/index';
import { timeToMinutes } from './timeUtils';

export interface HomeBrief {
  now?: Task;
  next?: Task;
  /** HH:MM to leave for `next`, when it has a route. */
  leaveAt?: string;
  /** Everything with an hour that is still ahead or happening (done excluded). */
  left: number;
}

const startOf = (t: Task) => t.fixedTime || t.scheduledTime;
const leaveOf = (t: Task) => (typeof t.location === 'object' ? t.location?.leaveHomeBy : undefined);

export function homeBrief(tasks: Task[], nowMin: number): HomeBrief {
  const live = tasks
    .filter((t) => startOf(t) && t.status !== 'complete' && t.status !== 'moved' && t.status !== 'missed')
    .map((t) => {
      const s = timeToMinutes(startOf(t)!);
      return { t, s, e: s + Math.max(5, t.durationMinutes || 30) };
    })
    .sort((a, b) => a.s - b.s);
  const now = live.find((x) => x.s <= nowMin && nowMin < x.e)?.t;
  const nextX = live.find((x) => x.s > nowMin);
  return {
    now,
    next: nextX?.t,
    leaveAt: nextX ? leaveOf(nextX.t) : undefined,
    left: live.filter((x) => x.e > nowMin).length,
  };
}

/** "עכשיו — X. הבא — Y ב־16:00, צאי ב־15:19." — or what is true when there is less. */
export function briefLine(b: HomeBrief, he: boolean): string {
  const at = b.next ? startOf(b.next) : undefined;
  const parts: string[] = [];
  if (b.now) parts.push(he ? `עכשיו — ${b.now.text}.` : `Now — ${b.now.text}.`);
  if (b.next) {
    const leave = b.leaveAt ? (he ? `, צאי ב־${b.leaveAt}` : `, leave at ${b.leaveAt}`) : '';
    parts.push(he ? `הבא — ${b.next.text} ב־${at}${leave}.` : `Next — ${b.next.text} at ${at}${leave}.`);
  }
  if (!parts.length) return he ? 'אין עוד משהו בשעה קבועה היום.' : 'Nothing else with a set time today.';
  return parts.join(' ');
}
