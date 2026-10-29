/**
 * openTaskRank — which open task deserves a free window? (21.10, Koral: "the suggestions are
 * not good enough — by location, by deadline, by importance").
 *
 * Both lists that fill a free hour — the + on Today (addSuggestions.openSuggestions) and the
 * ideas under a cancelled event or a gap row (GapFillService.rankGapIdeas) — used to order open
 * tasks by date or by `priority === 'must'` alone: a task due tomorrow lost to one parked for
 * next month, and a 40 km errand was offered as readily as one round the corner. One scorer now:
 *
 *   deadline   overdue 30 · today 24 (+6 when it is due within 3 h) · tomorrow 18 · ≤3 days 12 · ≤7 days 6
 *   importance must 12 · have_to 8 · need_to 3 · nice_to_do 0
 *   left over  a task from an earlier day, still open: +8
 *   location   where she will be when the window opens: ≤1 km +12 · ≤3 km +8 · ≤8 km +4 ·
 *              ≤25 km 0 · further −10 · no place on the task (or unknown anchor) 0 — a task with
 *              no place can be done anywhere, so it is never punished for it
 *
 * Every row says WHY in a clause ("Due tomorrow · 2 km from where you'll be"), so the order is
 * readable, not a mood. Pure. tests/run-open-rank.ts.
 */
import type { Task } from '../types/index';

export interface Point { lat: number; lng: number }

export interface Ranked { task: Task; score: number; reason: string; reasonHe: string; km?: number }

const PRIORITY_POINTS: Record<string, number> = { must: 12, have_to: 8, need_to: 3, nice_to_do: 0 };

function dayNumber(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round(Date.UTC(y, (m || 1) - 1, d || 1) / 86400000);
}

function mins(hhmm?: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function distanceKm(a: Point, b: Point): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

/** Coordinates of a task's place, whichever field carries them; null when it has none (or 0,0 — "unknown"). */
export function pointOf(task: Task): Point | null {
  const loc = task.location as { lat?: number; lng?: number } | undefined;
  const lat = typeof loc?.lat === 'number' ? loc.lat : (task as { locationLat?: number }).locationLat;
  const lng = typeof loc?.lng === 'number' ? loc.lng : (task as { locationLng?: number }).locationLng;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}

export function deadlinePoints(task: Task, today: string, nowHHMM: string): { points: number; en: string; he: string } {
  if (!task.deadline) return { points: 0, en: '', he: '' };
  const days = dayNumber(task.deadline) - dayNumber(today);
  if (days < 0) return { points: 30, en: 'Overdue', he: 'עבר הדדליין' };
  if (days === 0) {
    const due = mins(task.deadlineTime); const now = mins(nowHHMM);
    const soon = due !== null && now !== null && due - now <= 180;
    return { points: soon ? 30 : 24, en: task.deadlineTime ? `Due today ${task.deadlineTime}` : 'Due today',
      he: task.deadlineTime ? `להגיש היום עד ${task.deadlineTime}` : 'להגיש היום' };
  }
  if (days === 1) return { points: 18, en: 'Due tomorrow', he: 'להגיש מחר' };
  if (days <= 3) return { points: 12, en: `Due in ${days} days`, he: `להגיש בעוד ${days} ימים` };
  if (days <= 7) return { points: 6, en: `Due in ${days} days`, he: `להגיש בעוד ${days} ימים` };
  return { points: 0, en: '', he: '' };
}

export function nearnessPoints(task: Task, anchor: Point | null | undefined): { points: number; km?: number } {
  const p = pointOf(task);
  if (!p || !anchor) return { points: 0 };
  const km = distanceKm(anchor, p);
  const points = km <= 1 ? 12 : km <= 3 ? 8 : km <= 8 ? 4 : km <= 25 ? 0 : -10;
  return { points, km };
}

const kmWord = (km: number, he: boolean) => (km < 1 ? (he ? 'ממש קרוב' : 'right here') : he ? `${km.toFixed(km < 10 ? 1 : 0)} ק״מ` : `${km.toFixed(km < 10 ? 1 : 0)} km away`);

export function rankOne(task: Task, ctx: { today: string; nowHHMM: string; anchor?: Point | null }): Ranked {
  const dl = deadlinePoints(task, ctx.today, ctx.nowHHMM);
  const near = nearnessPoints(task, ctx.anchor);
  const leftOver = (task.date || ctx.today) < ctx.today;
  const score = dl.points + (PRIORITY_POINTS[task.priority || 'need_to'] ?? 3) + (leftOver ? 8 : 0) + near.points;
  const en: string[] = []; const he: string[] = [];
  if (dl.en) { en.push(dl.en); he.push(dl.he); }
  if (!dl.en && task.priority === 'must') { en.push('Must do'); he.push('חובה'); }
  if (leftOver && !dl.en) { en.push('Left over'); he.push('נשאר מקודם'); }
  if (near.km !== undefined && near.points >= 4) { en.push(kmWord(near.km, false)); he.push(kmWord(near.km, true)); }
  return { task, score, km: near.km,
    reason: en.join(' · ') || 'Still open', reasonHe: he.join(' · ') || 'עדיין פתוח' };
}

/** Best first. Ties: the shorter task (it fits anywhere), then the older id for stability. */
export function rankOpenTasks(tasks: Task[], ctx: { today: string; nowHHMM: string; anchor?: Point | null }): Ranked[] {
  return tasks.map((t) => rankOne(t, ctx)).sort((a, b) => b.score - a.score
    || (a.task.durationMinutes || 30) - (b.task.durationMinutes || 30)
    || String(a.task.id).localeCompare(String(b.task.id)));
}
