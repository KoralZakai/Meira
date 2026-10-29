/**
 * myWeekView — what the "My week" card (option A, Koral 20.10) draws, in words.
 * Four tiles (this week vs last) + the one firm line. Pure: tests/run-history-coach.ts.
 *
 * Three states, never confused (silent-state rule 1/3):
 *  - off     she has not allowed history → where to turn it on
 *  - failed  we could not load it → says so, with the reason
 *  - ok      the numbers
 */
import type { HistoryWeek } from '../services/LumiServer';

export interface WeekTile { icon: string; label: string; value: string; before: string }
export type MyWeekView =
  | { state: 'off'; text: string }
  | { state: 'failed'; text: string }
  | { state: 'ok'; title: string; tiles: WeekTile[]; line?: string };

function hm(min: number): string {
  const h = Math.floor(min / 60);
  const m = String(min % 60).padStart(2, '0');
  return `${h}:${m}`;
}

function dm(iso?: string): string {
  return iso ? `${Number(iso.slice(8, 10))}.${Number(iso.slice(5, 7))}` : '';
}

export function myWeekView(res: { ok: true; data: HistoryWeek } | { ok: false; reason: string }, he: boolean): MyWeekView {
  if (!res.ok) {
    return { state: 'failed', text: he ? `לא הצלחתי לטעון את השבוע · ${res.reason}` : `Couldn't load your week · ${res.reason}` };
  }
  const w = res.data;
  if (!w.optedIn || w.reason === 'not_opted_in') {
    return { state: 'off', text: he ? 'הפעילי "ללמוד מההיסטוריה שלי" בתפריט ← עוד' : 'Turn on "Learn from my history" in Menu → More' };
  }
  if (!w.ok || !w.current || !w.previous) {
    return { state: 'failed', text: he ? `לא הצלחתי לטעון את השבוע · ${w.reason ?? ''}` : `Couldn't load your week · ${w.reason ?? ''}` };
  }
  const c = w.current;
  const p = w.previous;
  const t = w.targets || {};
  const before = he ? 'שעבר' : 'last';
  const tiles: WeekTile[] = [
    { icon: '💪', label: he ? 'אימונים' : 'Workouts',
      value: t.workouts ? `${c.workouts}/${t.workouts}` : String(c.workouts), before: `${before}: ${p.workouts}` },
    { icon: '📚', label: he ? 'למידה' : 'Learning',
      value: hm(c.learning_minutes) + (t.learning_minutes ? ` / ${hm(t.learning_minutes)}` : ''),
      before: `${before}: ${hm(p.learning_minutes)}` },
    { icon: '🚌', label: he ? 'בדרכים' : 'On the road',
      value: `${c.road_estimated ? '~' : ''}${hm(c.road_minutes)}`, before: `${before}: ${hm(p.road_minutes)}` },
    { icon: '🔁', label: he ? 'דחיות' : 'Reschedules', value: String(c.reschedules), before: `${before}: ${p.reschedules}` },
  ];
  const range = `${dm(c.from)}–${dm(c.to)}`;
  return {
    state: 'ok',
    title: he ? `השבוע שלי · ${range}` : `My week · ${range}`,
    tiles,
    ...(w.line ? { line: w.line } : {}),
  };
}
