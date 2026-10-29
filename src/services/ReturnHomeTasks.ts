/**
 * ReturnHomeTasks — the way home is a TASK (21.10, Koral: "every task with nothing after it
 * must plan the trip home, and leave the user free to change the destination — but the trip
 * back is a task!").
 *
 * After the day's last trip, nothing following it, Meira adds "🏠 heading home": it starts
 * when that trip ends, lasts as long as the way there did, and says when she is home.
 * Add something later in the day and that one is no longer the last: its way-home task is
 * removed and the NEW last trip gets its own — and the ordinary travel chain already
 * plans the way from the previous place to the next one. Give the task a place and it is
 * routed like any other trip, so the destination stays hers to change.
 *
 * Trigger (rule 7): after the travel chain, which every calendar sync path runs — launch,
 * foreground, the 10-minute heartbeat, pull-to-refresh and the closed-app task.
 */
import type { AppLanguage, Task } from '../types/index';
import { getTodayString } from '../utils/timeUtils';
import { isReturnHomeTask, returnHomeId, returnHomeWhy } from '../utils/returnHome';
import { goesStraightToRoutine } from '../utils/routineOrigin';
import { deleteTasks, getAllTasks, mergeExternalTasks } from './TaskStorage';
import { loadProfile } from './UserProfileStorage';

const DAYS_AHEAD = 7;

const dateAfter = (from: string, n: number): string => {
  const d = new Date(`${from}T12:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export async function ensureReturnHomeTasks(lang: AppLanguage): Promise<boolean> {
  try {
    const profile: any = await loadProfile();
    const home: string | undefined = profile?.homeAddress || undefined;
    if (!home) return false;          // no home, no way home — and the travel chain already says so
    const all = await getAllTasks();
    const today = getTodayString();
    // "Straight to the routine" (questions/kinds/routineOrigin): she said she does not go home
    // between this trip and the routine that follows it. Unreadable answers keep the way home —
    // asking again is safer than dropping a trip she needs — and say so.
    let answers: Awaited<ReturnType<typeof import('./RoutineOriginStore').readRoutineOrigins>> = {};
    let rowsFor: ((date: string) => Promise<import('../utils/routineRows').RoutineRow[]>) | null = null;
    try {
      const [{ readRoutineOrigins }, { detectDeps }] = await Promise.all([
        import('./RoutineOriginStore'), import('../questions/kinds/routineOriginDeps'),
      ]);
      answers = await readRoutineOrigins();
      rowsFor = (date) => detectDeps.rowsFor(date);
    } catch (e) {
      console.warn('[ReturnHomeTasks] routine answers unreadable; every way home stays', e);
    }
    const wanted = new Map<string, Task>();
    for (let i = 0; i < DAYS_AHEAD; i += 1) {
      const date = dateAfter(today, i);
      const why = returnHomeWhy(all, date, home);
      if (!('ret' in why)) {
        // Said, not silent (rule 1): "none" has three different causes. 'no_trip' is just a day at home.
        if (why.why !== 'no_trip') console.warn(`[ReturnHomeTasks] ${date}: no way home — ${JSON.stringify(why)}`);
        continue;
      }
      const ret = why.ret;
      if (rowsFor && Object.values(answers).includes('direct')) {
        const rows = await rowsFor(date).catch((e) => {
          console.warn('[ReturnHomeTasks] routines unreadable for', date, e);
          return null;
        });
        if (rows && goesStraightToRoutine(all, rows, date, home, answers)) continue;
      }
      const he = lang === 'he';
      wanted.set(returnHomeId(ret.fromId), {
        id: returnHomeId(ret.fromId),
        text: he ? '🏠 בדרך הביתה' : '🏠 Heading home',
        category: 'general', priority: 'need_to', isFixed: false,
        fixedTime: ret.leaveAt, scheduledTime: ret.leaveAt,
        durationMinutes: Math.max(10, ret.minutes),
        date, status: 'pending', source: 'suggested',
        progress: he ? `בבית ~${ret.arriveAt} · אפשר לשנות יעד` : `Home ~${ret.arriveAt} · tap to change where to`,
        historicalDurations: [], createdAt: Date.now(),
      } as unknown as Task);
    }
    const have = new Map(all.filter(isReturnHomeTask).map((t) => [t.id, t]));
    // A way home whose trip is no longer the day's last (something was added after it), or that
    // went away: removed — only while still pending; one she ticked or moved is hers.
    const stale = [...have.values()]
      .filter((t) => t.status === 'pending' && t.date >= today && !wanted.has(t.id))
      .map((t) => t.id);
    const fresh = [...wanted.values()].filter((t) => !have.has(t.id));
    let changed = false;
    if (stale.length) changed = (await deleteTasks(stale)) > 0 || changed;
    if (fresh.length) changed = (await mergeExternalTasks(fresh, { fuzzyMerge: false })) > 0 || changed;
    return changed;
  } catch (e) {
    console.warn('[ReturnHomeTasks] could not plan the way home', e);
    return false;
  }
}
