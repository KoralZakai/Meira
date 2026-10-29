/**
 * historyCoach — when Meira brings her history up herself, and the words (Feature 2, 20.10).
 *
 * Koral picked three moments, all FIRM (name the number, name the gap, one next step):
 *  - Sunday from 20:00: last week in numbers + this week's goal.
 *  - Wednesday from 13:00: only when she is behind a goal she set.
 *  - The 3rd move of the same task: "now, smaller, or drop it?" (said by the server's streaks).
 * Each fires once per week (or once per task + count), recorded by the caller.
 * Pure — tests/run-history-coach.ts.
 */
import type { HistoryWeek } from '../services/LumiServer';

export type CoachMoment = 'sunday' | 'wednesday';

export interface CoachSent {
  sunday?: string;      // the week (its Sunday, YYYY-MM-DD) the summary was sent for
  wednesday?: string;
  streaks?: string[];   // `${taskId}:${moves}` already said
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The Sunday that starts this week (Israel's week starts on Sunday). */
export function weekOf(now: Date): string {
  const d = new Date(now);
  d.setDate(d.getDate() - d.getDay());
  return ymd(d);
}

export function dueMoment(now: Date, sent: CoachSent): CoachMoment | null {
  const week = weekOf(now);
  const day = now.getDay();
  const mins = now.getHours() * 60 + now.getMinutes();
  if (day === 0 && mins >= 20 * 60 && sent.sunday !== week) return 'sunday';
  // Wednesday's nudge may still go out Thursday morning if the phone slept through it.
  if ((day === 3 && mins >= 13 * 60) || (day === 4 && mins < 12 * 60)) {
    if (sent.wednesday !== week) return 'wednesday';
  }
  return null;
}

function hm(min: number, he: boolean): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (he) return h && m ? `${h} ש׳ ${m} דק׳` : h ? `${h} ש׳` : `${m} דק׳`;
  return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m} min`;
}

/** Sunday: last week in one line, then this week's goal in one line. */
export function sundaySummary(week: HistoryWeek, he: boolean): { title: string; body: string } | null {
  const c = week.current;
  if (!week.ok || !c) return null;
  const parts = he
    ? [`${c.workouts} אימונים`, `${hm(c.learning_minutes, true)} למידה`,
       `${c.road_minutes ? (c.road_estimated ? '~' : '') + hm(c.road_minutes, true) : '0'} בדרכים`,
       `${c.reschedules} דחיות`]
    : [`${c.workouts} workouts`, `${hm(c.learning_minutes, false)} learning`,
       `${c.road_minutes ? (c.road_estimated ? '~' : '') + hm(c.road_minutes, false) : '0'} on the road`,
       `${c.reschedules} reschedules`];
  const t = week.targets || {};
  const goal = t.workouts
    ? (he ? `השבוע: ${t.workouts} אימונים. משבצים את הראשון?` : `This week: ${t.workouts} workouts. Book the first one?`)
    : t.learning_minutes
      ? (he ? `השבוע: ${hm(t.learning_minutes, true)} למידה. משבצים בלוק?` : `This week: ${hm(t.learning_minutes, false)} of learning. Book a block?`)
      : (he ? 'מה הדבר האחד שחייב לקרות השבוע?' : "What's the one thing that must happen this week?");
  return {
    title: he ? '📊 השבוע שעבר' : '📊 Last week',
    body: `${parts.join(' · ')}\n${goal}`,
  };
}

/** Wednesday: only when behind a goal — the server's firm line, or nothing. */
export function wednesdayNudge(week: HistoryWeek, he: boolean): { title: string; body: string } | null {
  if (!week.ok || !week.line || !week.current) return null;
  const t = week.targets || {};
  const behind = (t.workouts && week.current.workouts < t.workouts)
    || (t.learning_minutes && week.current.learning_minutes < t.learning_minutes);
  if (!behind) return null;
  return { title: he ? '💪 אמצע השבוע' : '💪 Midweek', body: week.line };
}

export function streakKey(s: { taskId: string; moves: number }): string {
  return `${s.taskId}:${s.moves}`;
}

export function streakPush(s: { text?: string; moves: number }, he: boolean): { title: string; body: string } {
  const what = s.text || (he ? 'המשימה' : 'This task');
  return he
    ? { title: `🔁 נדחה ${s.moves} פעמים`, body: `'${what}' — עכשיו, בקטן, או מוותרים?` }
    : { title: `🔁 Moved ${s.moves} times`, body: `'${what}' — now, smaller, or drop it?` };
}
