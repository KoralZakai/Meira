/**
 * overlapNote — which overlaps deserve a notification, and what it says.
 *
 * Pure half of services/OverlapNotifyService, so the choice ("a NEW pair, not
 * one she answered, not one already told, not one already over") is tested
 * without a phone. The words are short — Meira speaks in one or two lines.
 */
import type { Task } from '../types/index';
import { dayProblems } from './dayProblems';
import { collapseSameMeetings } from './calendarEventTask';
import { adviseOverlap, PairAdvice } from './pairAdvice';
import { timeToMinutes } from './timeUtils';

export interface OverlapFound { key: string; date: string; advice: PairAdvice }

const LIVE = (t: Task) => !['complete', 'missed', 'moved'].includes(String(t.status));

/**
 * `answered[date][key]` is what Today stores when she picks or dismisses;
 * `told` is the keys we already notified. `now` is HH:MM of today.
 */
export function newOverlaps(
  tasks: Task[],
  opts: {
    today: string; now: string; horizonDays?: number;
    answered: Record<string, Record<string, string>>;
    told: Record<string, number>;
    home?: { lat: number; lng: number };
  },
): OverlapFound[] {
  const last = new Date(`${opts.today}T12:00:00`);
  last.setDate(last.getDate() + (opts.horizonDays ?? 7));
  const lastKey = last.toISOString().slice(0, 10);
  const byDate = new Map<string, Task[]>();
  for (const t of tasks) {
    if (!LIVE(t) || !t.date || t.date < opts.today || t.date > lastKey || !(t.fixedTime || t.scheduledTime)) continue;
    byDate.set(t.date, [...(byDate.get(t.date) || []), t]);
  }
  const out: OverlapFound[] = [];
  for (const [date, raw] of [...byDate.entries()].sort()) {
    const day = collapseSameMeetings(raw);
    for (const p of dayProblems(day, '23:00')) {
      if (p.kind !== 'spatial' && p.kind !== 'double') continue;
      if (opts.told[p.key] || opts.answered[date]?.[p.key]) continue;
      const startsAt = timeToMinutes(p.a.fixedTime || p.a.scheduledTime || '00:00');
      if (date === opts.today && startsAt < timeToMinutes(opts.now)) continue; // already begun: advice about the past
      out.push({ key: p.key, date, advice: adviseOverlap(p.a, p.b, day, opts.home) });
    }
  }
  return out;
}

/** "Tue 27.10" / "יום ג׳ 27.10" — the date is always shown (rule 4). */
export function shortDate(date: string, he: boolean): string {
  const d = new Date(`${date}T12:00:00`);
  const wd = d.toLocaleDateString(he ? 'he-IL' : 'en-US', { weekday: 'short' });
  return `${wd} ${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** One notification for one or more overlaps. */
export function overlapNotification(found: OverlapFound[], he: boolean): { title: string; body: string } {
  const f = found[0];
  const pick = f.advice.pick === 'a' ? f.advice.a : f.advice.b;
  const other = f.advice.pick === 'a' ? f.advice.b : f.advice.a;
  const at = pick.task.fixedTime || pick.task.scheduledTime || '';
  const why = pick.pros[0];
  const title = he
    ? `⚠️ שני אירועים חופפים · ${shortDate(f.date, true)} ${at}`
    : `⚠️ 2 events overlap · ${shortDate(f.date, false)} ${at}`;
  let body = he
    ? `מאירה ממליצה: "${pick.task.text}"${why ? ` — ${why.he}` : ''}. או "${other.task.text}".`
    : `Meira suggests "${pick.task.text}"${why ? ` — ${why.en}` : ''}. Or "${other.task.text}".`;
  if (found.length > 1) body += he ? ` (ועוד ${found.length - 1})` : ` (+${found.length - 1} more)`;
  return { title, body };
}
