/**
 * AddSuggestionSources — reads what "Suggested for you" is made from, and acts
 * on the row she taps. The RANKING is utils/addSuggestions (pure, tested);
 * this is the I/O around it.
 *
 *   tomorrow  tomorrow's and today's tasks, her wake rule (alarmPlan)
 *   gap       the day's free windows (findDayGaps) and what GapFillService
 *             would put in each — rankGapIdeas, no travel pricing (a list that
 *             opens with the + must be instant, and a Directions call per idea
 *             is not)
 *   open      overdue and parked tasks
 *   way       an errand with no place, against her planned journeys — ONE
 *             server question, answered by the words (rules_only: no model, no
 *             web search per place), and remembered for three hours because the
 *             Places lookup behind it is the one expensive thing here
 *
 * EVERY source is read on its own and comes back as `{ ok, data }` or
 * `{ ok: false, reason }`: one that fails is named and contributes no row, and
 * the other three still show (silent-state rule 1 — "nothing to suggest" and
 * "I could not look" are different, and the log says which).
 *
 * Triggers (rule 7): opening the Add screen with an empty input. That is the
 * only one this list needs — it is the moment it is on screen.
 */
import type { Task, Goal } from '../types/index';
import {
  getTasksForDate, getAllTasks, getOverdueTasks, getSettings, loadGoals, moveTasksToDate, updateTaskFields,
} from './TaskStorage';
import { loadProfile } from './UserProfileStorage';
import { normalizeProfile } from '../utils/profileShape';
import { findDayGaps, PLUS_MIN_MINUTES } from '../utils/findGaps';
import { rankGapIdeas, loadRoutines } from './GapFillService';
import { wakeInputs } from '../utils/alarmPlan';
import { isPrepBlock } from '../utils/interviewPrep';
import { getTodayString, getTomorrowString, timeToMinutes } from '../utils/timeUtils';
import { plannedTrips } from '../components/OnYourWayCard';
import { errandsOnTheWay } from './AddUnderstandService';
import AsyncStorage from './EncryptedStorage';
import {
  placelessErrands, type GapFact, type SourceResult, type SuggestionAction, type SuggestionInput, type WayFact,
} from '../utils/addSuggestions';

const pad = (n: number) => String(n).padStart(2, '0');

async function settle<T>(p: Promise<T>): Promise<SourceResult<T>> {
  try {
    return { ok: true, data: await p };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

function plusDay(key: string, days = 1): string {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

export interface LocalSources {
  input: SuggestionInput;
  /** What the "on your way" source needs to pick an errand from. */
  tasks: Task[];
}

/** Everything but the errands: instant, all from storage. */
export async function loadLocalSources(target: string): Promise<LocalSources> {
  const clock = new Date();
  const today = getTodayString();
  const time = `${pad(clock.getHours())}:${pad(clock.getMinutes())}`;
  const tomorrow = getTomorrowString();
  const language: 'he' | 'en' = (await getSettings().catch(() => null))?.language === 'he' ? 'he' : 'en';

  const [todayR, tomorrowR, allR, profileR] = await Promise.all([
    settle(getTasksForDate(today)),
    settle(getTasksForDate(tomorrow)),
    settle(getAllTasks()),
    settle(loadProfile().then((p) => normalizeProfile(p))),
  ]);
  const profile = profileR.ok ? profileR.data : null;
  const all = allR.ok ? allR.data : [];

  // Open: overdue first (they are owed), then what was parked on a later date.
  const openR = await settle((async () => {
    if (!allR.ok) throw new Error(`tasks unreadable: ${allR.reason}`);
    const overdue = await getOverdueTasks(today, time);
    const parked = all.filter((t) => t.status === 'pending' && (t.date || '') >= today
      && !(t.fixedTime || t.scheduledTime) && !isPrepBlock(t));
    const seen = new Set<string>();
    return [...overdue, ...parked].filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true))).slice(0, 25);
  })());

  // Gaps: the target day's free windows, and the best idea for each.
  const gapsR = await settle<GapFact[]>((async () => {
    if (!allR.ok) throw new Error(`tasks unreadable: ${allR.reason}`);
    const dayTasks = target === today && todayR.ok ? todayR.data : await getTasksForDate(target);
    const gaps = findDayGaps(dayTasks, {
      dayStart: profile?.defaultWakeTime || '08:00',
      dayEnd: profile?.sleepTime || '22:00',
      now: target === today ? time : undefined,
      minMinutes: target === today ? PLUS_MIN_MINUTES : 30,
    })
      // Today, the window she is IN counts from now to the next event however
      // short (18.10: 29 minutes before a call is real; at 30 the + found "no
      // free window"). Later ones keep the 30-minute floor, so a few small
      // gaps never crowd out the afternoon.
      .filter((g) => target !== today || g.minutes >= 30 || timeToMinutes(g.start) <= timeToMinutes(time))
      .slice(0, 3);
    if (!gaps.length) return [];
    const [overdue, goals, routines, nextDay] = await Promise.all([
      getOverdueTasks(today, time),
      loadGoals().catch((e) => { console.warn('[AddSuggestions] goals unreadable', e); return [] as Goal[]; }),
      loadRoutines().catch((e) => { console.warn('[AddSuggestions] routines unreadable', e); return []; }),
      getTasksForDate(plusDay(target)).catch(() => [] as Task[]),
    ]);
    const openTasks = all.filter((t) => t.status === 'pending' && (t.date || '') >= today
      && !dayTasks.some((d) => d.id === t.id && (d.fixedTime || d.scheduledTime)));
    return gaps.map((gap): GapFact => {
      const ideas = rankGapIdeas({
        gap, today: target, todayTasks: dayTasks, overdue, tomorrowTasks: nextDay, openTasks, goals,
        routines, language, place: { isHome: true },
      }, 3)
        // Preparation is the "tomorrow" source's job — two rows for one interview is noise.
        .filter((i) => i.kind !== 'prep')
        .slice(0, 1);
      // Where she is when this window opens: the previous task's place, else home.
      const prevLoc = gap.before?.location as { lat?: number; lng?: number } | undefined;
      const anchor = typeof prevLoc?.lat === 'number' && typeof prevLoc?.lng === 'number' && !(prevLoc.lat === 0 && prevLoc.lng === 0)
        ? { lat: prevLoc.lat, lng: prevLoc.lng }
        : (typeof (profile as any)?.homeLat === 'number' && typeof (profile as any)?.homeLng === 'number'
          ? { lat: (profile as any).homeLat as number, lng: (profile as any).homeLng as number } : undefined);
      return {
        start: gap.start, end: gap.end, minutes: gap.minutes, ...(anchor ? { anchor } : {}),
        ideas: ideas.map((i) => ({
          title: i.title, titleHe: i.titleHe, reason: i.reason,
          reasonHe: i.reasonHe, icon: i.icon, minutes: i.minutes, taskId: i.taskId, draftText: i.draft?.text,
        })),
      };
    });
  })());

  return {
    tasks: all,
    input: {
      now: { date: today, time },
      target,
      today: todayR,
      tomorrow: tomorrowR,
      gaps: gapsR,
      open: openR,
      // Interviews 2–7 days out get their own prep row (17.10: Monday's Workday).
      upcoming: allR.ok
        ? { ok: true as const, data: all.filter((t) => t.status === 'pending' && (t.date || '') > tomorrow && (t.date || '') <= plusDay(today, 7)) }
        : { ok: false as const, reason: `tasks unreadable: ${allR.reason}` },
      wake: wakeInputs(profile),
    },
  };
}

// ── on your way ─────────────────────────────────────────────────────────────

const WAY_KEY = 'lumi.addSuggestions.way.v1';
const WAY_TTL_MS = 3 * 60 * 60 * 1000;
/** Answers that are answers — worth remembering so the next open costs nothing. */
const WAY_FINAL = new Set(['not_an_errand', 'nothing_on_route', 'nothing_open_when_passing']);

interface WayCache { key: string; at: number; facts?: WayFact[]; reason?: string }

async function readWayCache(key: string): Promise<WayCache | null> {
  try {
    const raw = await AsyncStorage.getItem(WAY_KEY);
    const c = raw ? (JSON.parse(raw) as WayCache) : null;
    return c && c.key === key && Date.now() - c.at < WAY_TTL_MS ? c : null;
  } catch (e) {
    console.warn('[AddSuggestions] way cache unreadable', e);
    return null;
  }
}

/**
 * One errand, against the journeys already planned. At most one server
 * question per three hours for the same errand and the same journeys.
 */
export async function loadWaySource(tasks: Task[]): Promise<SourceResult<WayFact[]>> {
  const errand = placelessErrands(tasks)
    .sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.createdAt || 0) - (b.createdAt || 0))[0];
  if (!errand) return { ok: true, data: [] };
  try {
    const trips = await plannedTrips();
    if (!trips.length) return { ok: false, reason: 'no_route' };
    const key = `${errand.id}|${trips.map((t) => `${t.date}${t.leave}${t.arrive}`).join(',')}`;
    const cached = await readWayCache(key);
    if (cached) return cached.facts ? { ok: true, data: cached.facts } : { ok: false, reason: cached.reason ?? 'cached' };

    const res = await errandsOnTheWay(errand.text, trips);
    if (!res.ok || !(res as any).candidates?.length) {
      const reason = (res as any).reason ?? 'no_candidates';
      if (WAY_FINAL.has(reason)) {
        AsyncStorage.setItem(WAY_KEY, JSON.stringify({ key, at: Date.now(), reason } as WayCache))
          .catch((e) => console.warn('[AddSuggestions] could not remember the answer', e));
      }
      return { ok: false, reason };
    }
    const r = res as any;
    const best = r.candidates.find((c: any) => c.recommended) ?? r.candidates[0];
    const facts: WayFact[] = [{
      task: { id: errand.id, text: errand.text },
      candidate: {
        name: best.name, address: best.address, lat: best.lat, lng: best.lng, pass_at: best.pass_at,
        date: best.date || errand.date, off_route_m: best.off_route_m,
        open_when_passing: best.open_when_passing, minutes: r.minutes,
      },
    }];
    AsyncStorage.setItem(WAY_KEY, JSON.stringify({ key, at: Date.now(), facts } as WayCache))
      .catch((e) => console.warn('[AddSuggestions] could not remember the answer', e));
    return { ok: true, data: facts };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

// ── acting on a tap ─────────────────────────────────────────────────────────

/** Move an EXISTING task to a day and an hour — as GapFillService.applyGapIdea does. */
export async function applyScheduleAction(a: Extract<SuggestionAction, { kind: 'schedule' }>): Promise<void> {
  const all = await getAllTasks();
  const t = all.find((x) => x.id === a.taskId);
  if (!t) throw new Error('task_not_found');
  if (t.date !== a.date) await moveTasksToDate([t.id], a.date);
  await updateTaskFields(t.id, {
    scheduledTime: a.time,
    // The hour she picked wins over a left-over one (5.10: "Add did nothing in the morning").
    ...(t.fixedTime ? { fixedTime: a.time } : {}),
    ...(a.durationMinutes ? { durationMinutes: a.durationMinutes } : {}),
    pickedAt: Date.now(),
    status: 'pending',
  });
}

/** Give an errand the place on her route, and the minute she passes it — as OnYourWayCard's "Plan it". */
export async function applyPlaceAction(a: Extract<SuggestionAction, { kind: 'place' }>): Promise<void> {
  await updateTaskFields(a.taskId, {
    location: {
      address: a.place.address || a.place.name, displayName: a.place.name,
      lat: a.place.lat, lng: a.place.lng, confirmed: true,
    } as any,
    date: a.date,
    scheduledTime: a.time,
    ...(a.durationMinutes ? { durationMinutes: a.durationMinutes } : {}),
    pickedAt: Date.now(),
  });
}
