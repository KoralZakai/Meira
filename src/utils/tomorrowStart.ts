/**
 * tomorrowStart — "will you leave tomorrow from where you are now?"
 *
 * Koral, 17.10: "Tomorrow I have an interview at מכון דוד but now my location
 * is different from what is already calculated — Meira needs to ask: will you
 * leave tomorrow from your current location?" She was near Nahariya; home is
 * Tel Aviv; tomorrow's route (and its leave time, and its wake alarm) had been
 * worked out from home, because that is where a day that has not begun starts
 * (utils/tripStart). Meira KNEW where the phone was and did not say that the
 * plan assumed otherwise — the silent state (CLAUDE.md).
 *
 * This file decides WHETHER to ask. Pure: the clock, the fix, home and
 * tomorrow's tasks come in; a question payload or the reason for not asking
 * goes out. questions/kinds/tripOrigin.ts words it and applies the answer;
 * QuestionService decides when a popup may show.
 *
 * Ask when ALL of these hold:
 *   - she has not answered for that date (key `tripOrigin:<date>`),
 *   - tomorrow has a located, timed first trip,
 *   - that trip is planned from HOME (or from an older plan that does not say),
 *     not from somewhere she already chose,
 *   - it is the evening before (from 16:00) OR the trip leaves before 12:00,
 *     and not in the small hours (nobody wants a nudge at 03:00),
 *   - she is more than 3 km from home.
 * Every other case returns a REASON (rule 1): "no" and "I could not tell where
 * you are" must not look alike — the caller logs the second kind.
 */
import type { TripOriginQuestionData } from '../questions/types';
import type { Task } from '../types/index';
import { addrOf, locOf, sortTimed, timeOf } from './dayPlanning';
import { isRemoteTask } from './meetingLink';
import { timeToMinutes } from './timeUtils';
import { straightKm } from './travelLadder';
import { asCoords, DayStart, SAME_ORIGIN_M, sameOrigin } from './tripStart';

type LatLng = { lat: number; lng: number };

/** Farther than this from home, tomorrow's start is a real question. */
export const FAR_FROM_HOME_M = 3000;
/** From this hour on it is "the evening before". */
export const EVENING_FROM_MIN = 16 * 60;
/** A trip leaving before this hour is asked about at ANY time of the day. */
export const EARLY_DEPARTURE_MIN = 12 * 60;
/** Before this hour it is the night, not the evening before: no question, no nudge. */
export const NIGHT_UNTIL_MIN = 6 * 60;

export const TRIP_ORIGIN_KIND = 'tripOrigin' as const;
/** One question per day: what "later" and the answer are kept under. */
export const tripOriginKey = (date: string): string => `${TRIP_ORIGIN_KIND}:${date}`;

export type NoAsk =
  /** She has answered for that date. */
  | 'answered'
  /** Tomorrow has no located, timed trip (nothing to plan from anywhere). */
  | 'no_trip'
  /** She already told Meira where tomorrow starts. */
  | 'start_set'
  /** The first trip is already planned from somewhere that is not home. */
  | 'planned_elsewhere'
  /** Not the evening before, and the trip leaves after noon. */
  | 'too_early'
  /** The small hours. */
  | 'night'
  /** No clock reading. */
  | 'no_clock'
  /** Home is not known (could not tell how far she is). */
  | 'no_home'
  /** Her position is not known (could not tell how far she is). */
  | 'no_fix'
  /** Within 3 km of home: tomorrow's from-home plan is right. */
  | 'near_home'
  /** The tasks could not be read (set by the caller). */
  | 'tasks_unreadable'
  /** What she may have said about that date could not be read (set by the caller). */
  | 'start_unreadable';

/** The reasons that mean "I could not find out", not "nothing to ask" — the caller logs these. */
export const COULD_NOT_TELL: ReadonlySet<NoAsk> = new Set<NoAsk>([
  'no_home', 'no_fix', 'tasks_unreadable', 'start_unreadable', 'no_clock',
]);

export type TripOriginDecision =
  | { ask: true; data: TripOriginQuestionData }
  | { ask: false; reason: NoAsk; detail?: string };

export interface TomorrowStartInput {
  /** Tomorrow, YYYY-MM-DD. */
  tomorrow: string;
  /** The time now, HH:MM local. */
  nowHHMM: string;
  /** Her last known position (null/undefined when unknown or refused). */
  here: LatLng | null | undefined;
  /** In words, when the caller already has it; asked for only after a "yes". */
  hereLabel?: string | null;
  home: { lat?: number; lng?: number } | null | undefined;
  homeAddress?: string | null;
  /** Tomorrow's tasks (anything dated otherwise is ignored). */
  tasks: Task[];
  /** AskState.answered — key → when. */
  answered?: Record<string, unknown> | null;
  /** What she already said about that date, if anything. */
  dayStart?: DayStart | null;
}

/** The first located, timed trip of `date` — the one the day's chain starts with. */
export function firstLocatedTrip(tasks: Task[], date: string): Task | null {
  const open = (tasks ?? []).filter((t) =>
    t && t.date === date && t.status !== 'complete' && t.status !== 'moved'
    && Boolean(addrOf(t)) && !isRemoteTask(t as unknown as { meetingUrl?: string; category?: string; location?: unknown }));
  return sortTimed(open)[0] ?? null;
}

const norm = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Is this plan's start her home? A plan from before the field existed names no
 * origin and was made from home; a text equals the home address; a bare
 * "lat,lng" within SAME_ORIGIN_M of home is home too (a coordinates-only home).
 */
export function originIsHome(
  origin: string | undefined | null,
  homeAddress: string | undefined | null,
  home: { lat?: number; lng?: number } | null | undefined,
): boolean {
  const o = String(origin ?? '').trim();
  if (!o) return true;
  const h = String(homeAddress ?? '').trim();
  if (h && (norm(o) === norm(h) || sameOrigin(o, h))) return true;
  const at = asCoords(o);
  if (at && home) {
    const km = straightKm(at, home);
    if (km !== undefined && km * 1000 <= SAME_ORIGIN_M) return true;
  }
  return false;
}

/** Local YYYY-MM-DD of the day after `now`. */
export function tomorrowOf(now: Date): string {
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

/** Local HH:MM of `now`. */
export function hhmmOf(now: Date): string {
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

/** Should Meira ask where tomorrow's first trip starts? */
export function decideTripOrigin(i: TomorrowStartInput): TripOriginDecision {
  const no = (reason: NoAsk, detail?: string): TripOriginDecision => ({ ask: false, reason, ...(detail ? { detail } : {}) });

  if (i.answered && i.answered[tripOriginKey(i.tomorrow)]) return no('answered');

  const trip = firstLocatedTrip(i.tasks, i.tomorrow);
  if (!trip) return no('no_trip', 'no located, timed task tomorrow');
  if (i.dayStart) return no('start_set');

  const loc = locOf(trip);
  const plan = loc?.transitPlan;
  if (plan && !originIsHome(plan.originAddress, i.homeAddress, i.home)) return no('planned_elsewhere');

  const time = timeOf(trip);
  const leaveAt = plan?.leaveHomeAt || loc?.leaveHomeBy || undefined;
  const nowMin = timeToMinutes(i.nowHHMM);
  if (!Number.isFinite(nowMin)) return no('no_clock', i.nowHHMM);
  if (nowMin < NIGHT_UNTIL_MIN) return no('night');
  const when = leaveAt ?? time;
  const whenMin = when ? timeToMinutes(when) : NaN;
  const evening = nowMin >= EVENING_FROM_MIN;
  const early = Number.isFinite(whenMin) && whenMin < EARLY_DEPARTURE_MIN;
  if (!evening && !early) return no('too_early');

  // Only now does it matter where she is — so "could not tell" is reported only
  // when asking was warranted, and not on every sweep of every quiet day.
  const hasHome = i.home && Number.isFinite(i.home.lat) && Number.isFinite(i.home.lng)
    && !(i.home.lat === 0 && i.home.lng === 0);
  if (!hasHome) return no('no_home');
  if (!i.here || !Number.isFinite(i.here.lat) || !Number.isFinite(i.here.lng)) return no('no_fix');
  const km = straightKm(i.here, i.home);
  if (km === undefined) return no('no_fix', 'position not usable');
  if (km * 1000 <= FAR_FROM_HOME_M) return no('near_home');

  return {
    ask: true,
    data: {
      date: i.tomorrow,
      taskId: trip.id,
      taskTitle: trip.text,
      ...(time ? { time } : {}),
      ...(leaveAt ? { leaveAt } : {}),
      hereLabel: String(i.hereLabel ?? '').trim(),
      here: { lat: i.here.lat, lng: i.here.lng },
    },
  };
}
