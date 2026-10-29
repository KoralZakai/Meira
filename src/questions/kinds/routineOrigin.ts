/**
 * routineOrigin — "After the meeting you have yoga at 19:00. Home first, or straight there?"
 * (21.10, Koral: the way home ignored a routine later the same day.)
 *
 * A routine with a place that starts after the day's last trip: is the way home owed or not?
 * Meira does not guess — she asks once per (day, trip, routine):
 *
 *   🏠 Home first         → the way home stays; the routine is planned from home
 *   ➡️ Straight there     → no way home after that trip (ReturnHomeTasks removes it)
 *   Later                 → QuestionService's snooze
 *
 * WHEN IT RUNS (rule 7). detectRoutineOrigin is part of QuestionService.refresh, so it runs on
 * every trigger tripOrigin has: Today coming into view, the app returning to the front, every
 * foreground calendar sweep (incl. the 10-minute heartbeat), the closed-app task, and
 * You → "Meira's questions". It looks at today and tomorrow, is DERIVED each time and never
 * queued, so it cannot outlive its cause (the trip moved, the routine was waved off, she answered).
 *
 * Every "no question" says why (rule 1): decideRoutineOrigin returns the reason; unreadable inputs
 * are warned, never read as "nothing to ask".
 */
import type { Task } from '../../types/index';
import {
  ROUTINE_ORIGIN_KIND, decideRoutineOrigin, routineOriginKey,
  type RoutineOriginChoice, type RoutineOriginData,
} from '../../utils/routineOrigin';
import type { RoutineRow } from '../../utils/routineRows';
import { hePrefix } from '../../utils/tripStart';
import type { MeiraQuestion, QuestionApply, RoutineOriginAnswer } from '../types';

export const KIND = ROUTINE_ORIGIN_KIND;

export function askText(d: RoutineOriginData): { en: string; he: string } {
  // 21.10, Koral: "if there is a training suggestion, check with the user: are you going?" — Meira roots
  // for her, and asks. Where she goes from (home or straight there) is the second half of the answer.
  return {
    en: `After ${d.fromTitle} you have ${d.routineTitle} at ${d.routineStart}. Are you going? 💪`,
    he: `אחרי ${d.fromTitle} יש לך ${d.routineTitle} ב-${d.routineStart}. הולכת? 💪`,
  };
}

/** Every string the sheet draws for this kind, both languages (tests/run-routine-origin.ts). */
export function sheetText(d: RoutineOriginData): {
  ask: { en: string; he: string };
  home: { en: string; he: string };
  direct: { en: string; he: string };
  skip: { en: string; he: string };
  later: { en: string; he: string };
} {
  return {
    ask: askText(d),
    direct: { en: `✅ Yes, straight to ${d.routineTitle}`, he: `✅ כן, ישר ${hePrefix('ל', d.routineTitle)}` },
    home: { en: '🏠 Yes, but home first', he: '🏠 כן, אבל קודם הביתה' },
    skip: { en: 'Not today', he: 'לא היום' },
    later: { en: 'Later', he: 'אחר כך' },
  };
}

export function questionOf(d: RoutineOriginData): MeiraQuestion {
  return {
    key: routineOriginKey(d.date, d.fromId, d.routineKey),
    kind: KIND,
    subject: `${d.date}:${d.fromId}:${d.routineKey}`,
    title: d.routineTitle,
    ask: askText(d),
    context: { line: d.routineTitle, origin: [] },
    routineOrigin: d,
  };
}

export interface DetectDeps {
  now?: () => Date;
  home(): Promise<string | null>;
  tasksFor(date: string): Promise<Task[]>;
  /** Her routine rows for that date (routineRowsFor, skips applied). A throw = could not read. */
  rowsFor(date: string, nowHHMM?: string): Promise<RoutineRow[]>;
  answers(): Promise<Record<string, RoutineOriginChoice | undefined>>;
}

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Today and tomorrow: the evening the routine falls in is the day it matters. */
export async function detectRoutineOrigin(deps: DetectDeps): Promise<MeiraQuestion[]> {
  const clock = (deps.now ?? (() => new Date()))();
  let answers: Record<string, RoutineOriginChoice | undefined>;
  let home: string | null;
  try {
    [answers, home] = await Promise.all([deps.answers(), deps.home()]);
  } catch (e) {
    // Unreadable is not "no answers": asking again could undo what she said.
    console.warn('[Questions] routineOrigin: could not read her answers or home — not asking', e);
    return [];
  }
  const out: MeiraQuestion[] = [];
  for (let i = 0; i < 2; i += 1) {
    const day = new Date(clock.getFullYear(), clock.getMonth(), clock.getDate() + i);
    const date = ymd(day);
    try {
      const [tasks, rows] = await Promise.all([
        deps.tasksFor(date),
        deps.rowsFor(date, i === 0 ? `${pad(clock.getHours())}:${pad(clock.getMinutes())}` : undefined),
      ]);
      const d = decideRoutineOrigin({ date, tasks, rows, home, answers });
      if (d.ask) out.push(questionOf(d.data));
    } catch (e) {
      console.warn(`[Questions] routineOrigin: could not read ${date} — no question for it`, e);
    }
  }
  return out;
}

export interface ApplyDeps {
  save(key: string, choice: RoutineOriginChoice): Promise<void>;
  read(): Promise<Record<string, RoutineOriginChoice | undefined>>;
  /** "Not today": the routine's row is waved off for that date (the same memory as the row's own button). */
  skipToday(date: string, routineKey: string): Promise<void>;
  /** ensureReturnHomeTasks: the way home is added or removed for the new answer. Started, not awaited. */
  replan(): Promise<unknown>;
}

const local = (): QuestionApply => ({ result: { ok: false, savedLocally: false, reason: 'local' } });

/** Her answer → the store → the way home re-planned. Nothing is claimed that did not land (rule 3). */
export async function applyRoutineOrigin(q: MeiraQuestion, a: RoutineOriginAnswer, deps: ApplyDeps): Promise<QuestionApply> {
  const d = q.routineOrigin;
  if (q.kind !== KIND || !d) return local();
  try {
    if (a.choice === 'skip') await deps.skipToday(d.date, d.routineKey);
    await deps.save(q.key, a.choice);
  } catch (e) {
    console.warn('[Questions] routineOrigin: answer not saved', e);
    return local();
  }
  // Read it back before saying so: a write that did not land must not read ✓.
  const back = await deps.read().catch((e) => {
    console.warn('[Questions] routineOrigin: answer not readable after saving', e);
    return null;
  });
  if (!back || back[q.key] !== a.choice) {
    console.warn('[Questions] routineOrigin: answer did not stick');
    return local();
  }
  void Promise.resolve(deps.replan())
    .catch((e) => console.warn('[Questions] routineOrigin: way home not re-planned after the answer', e));
  return {
    result: {
      ok: true, savedLocally: true,
      effect: a.choice === 'skip'
        ? { en: `OK — ${d.routineTitle} is off for today.`, he: `בסדר — ${d.routineTitle} לא להיום.` }
        : a.choice === 'direct'
        ? { en: `OK — straight from ${d.fromTitle} to ${d.routineTitle}. No way home in between.`,
            he: `בסדר — ישר ${hePrefix('מ', d.fromTitle)} ${hePrefix('ל', d.routineTitle)}. בלי דרך הביתה באמצע.` }
        : { en: 'OK — home first, then the routine.', he: 'בסדר — קודם הביתה, ואז השגרה.' },
    },
  };
}
