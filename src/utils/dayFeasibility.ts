/**
 * dayFeasibility — will this day actually work, transition by transition?
 *
 * resolveClashes answers "what collides, and what could she do about it". It
 * has no notion of COMFORT: a 20-minute gap for a 14-minute trip is "fine",
 * although she habitually leaves six minutes late and wants ten in hand —
 * she will walk in late, every time, and the app will have said nothing. And
 * nothing anywhere asked whether a trip needs her up before she is willing to
 * be: the app armed a 04:49 alarm for Ronen's Haifa site visit without a word.
 *
 * The rule, checked against an independently written scheduler (tests/
 * fixtures/meira-sim, run-feasibility-differential):
 *
 *   Walk the day in start order. Her POSITION is the last physical place —
 *   home before anything; a video call occupies time but does not move her.
 *   For each commitment:
 *     gap    = its start − the latest end so far
 *     travel = the trip from her position (0 for a call)
 *     margin = buffer + max(0, her habitual departure delay) (0 for a call)
 *
 *     OVERLAP            gap < 0
 *     INFEASIBLE_TRAVEL  gap < travel
 *     TIGHT              gap < travel + margin   — possible, not comfortable
 *     OK                 otherwise
 *
 *   The day's first commitment, if physical, is judged on the WAKE instead:
 *     WAKE_CONFLICT      the wake it needs is before her earliest wake time
 *
 * Each verdict carries the arithmetic as reasoning steps, so she can see why
 * — and say where it is wrong.
 *
 * Pure: no storage, no network. Travel is read off the route the chain already
 * stored on each task (GoogleSync.ensureTravelChain routes each stop from the
 * previous physical one), or passed in by the caller (a proposed slot).
 * Consumers: utils/dayPlanning.dayWarnings, services/ScheduleQueryService.
 */
import { Task, TaskLocation } from '../types/index';
import { isMeetingLink, isRemoteTask } from './meetingLink';
import { minutesToTime, timeToMinutes } from './timeUtils';
import type { ReasonStep } from './travelLadder';

export type FeasibilityStatus = 'OK' | 'TIGHT' | 'INFEASIBLE_TRAVEL' | 'OVERLAP' | 'WAKE_CONFLICT';

/** Worst first — the order a verdict over several transitions is taken in. */
export const SEVERITY: FeasibilityStatus[] = ['OVERLAP', 'INFEASIBLE_TRAVEL', 'WAKE_CONFLICT', 'TIGHT', 'OK'];

export const worstOf = (statuses: FeasibilityStatus[]): FeasibilityStatus =>
  statuses.reduce<FeasibilityStatus>(
    (w, s) => (SEVERITY.indexOf(s) < SEVERITY.indexOf(w) ? s : w), 'OK');

/** Nobody is woken before this unless she says she will be (Profile). */
export const DEFAULT_EARLIEST_WAKE = '05:00';
export const DEFAULT_TRAVEL_BUFFER_MINUTES = 10;
/** Different places, no stored route: some travel, never teleportation. */
const UNKNOWN_TRAVEL_MINUTES = 15;

export interface FeasibilityOptions {
  /** Minutes of slack she wants on arrival. */
  bufferMinutes?: number;
  /** Her habitual departure delay (learned). Only lateness counts. */
  departDelayMinutes?: number;
  /** HH:MM — the earliest she is willing to be woken. */
  earliestWake?: string;
  /** Morning routine + wake buffer: waking to walking out of the door. */
  prepMinutes?: number;
}

/** The options a profile implies. */
export function feasibilityOptionsOf(profile: any): FeasibilityOptions {
  return {
    bufferMinutes: typeof profile?.travelBufferMinutes === 'number'
      ? profile.travelBufferMinutes : DEFAULT_TRAVEL_BUFFER_MINUTES,
    departDelayMinutes: typeof profile?.departDelayMinutes === 'number' ? profile.departDelayMinutes : 0,
    earliestWake: profile?.earliestWakeTime || DEFAULT_EARLIEST_WAKE,
    prepMinutes: (profile?.morningRoutineMinutes ?? 30) + (profile?.wakeBufferMinutes ?? 10),
  };
}

export function marginOf(opts: FeasibilityOptions): number {
  return (opts.bufferMinutes ?? DEFAULT_TRAVEL_BUFFER_MINUTES) + Math.max(0, opts.departDelayMinutes ?? 0);
}

export interface Transition {
  /** The commitment being reached. */
  taskId: string;
  text: string;
  /** The commitment right before it in the day, if any. */
  prevTaskId?: string;
  prevText?: string;
  /** The last PHYSICAL commitment before it — where she is coming from. Undefined = home. */
  fromTaskId?: string;
  fromText?: string;
  /** Minutes between the latest end so far and this start. Undefined for the day's first. */
  gap?: number;
  travel: number;
  /** True when travel is a guess (no stored route). */
  travelGuessed?: boolean;
  margin: number;
  /** The day's first physical trip: the wake it needs. */
  wake?: string;
  earliestWake?: string;
  status: FeasibilityStatus;
  reasonEn: string;
  reasonHe: string;
  steps: ReasonStep[];
}

const startOf = (t: Task): string | undefined => t.fixedTime || t.scheduledTime || undefined;
const locOf = (t: Task): TaskLocation | undefined =>
  t.location && typeof t.location === 'object' ? (t.location as TaskLocation) : undefined;

/** Where this commitment is, as words — '' when it has no place to travel to. */
export function placeText(t: Task): string {
  const raw = typeof t.location === 'string'
    ? t.location
    : locOf(t)?.address || locOf(t)?.displayName || '';
  return isMeetingLink(raw) ? '' : (raw || '').trim();
}

/** Does this commitment move her? A call, a link, or no place at all does not. */
export function isPhysical(t: Task): boolean {
  if (isRemoteTask(t as any)) return false;
  return Boolean(placeText(t));
}

/** Minutes of the trip INTO this task, as the route chain stored it. */
function storedTravel(t: Task): number | undefined {
  const loc = locOf(t);
  const v = loc?.travelMinutes ?? loc?.transitPlan?.totalDurationMinutes;
  return typeof v === 'number' && v >= 0 ? v : undefined;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Judge every transition of the day.
 *
 * `travelInto` overrides the stored trip into a task — the caller asking
 * "what if I put something here?" knows the new legs; nothing else does.
 */
export function judgeDay(
  tasks: Task[],
  opts: FeasibilityOptions = {},
  travelInto: Map<string, number> = new Map(),
): Transition[] {
  const day = tasks
    .filter((t) => t.status !== 'complete' && t.status !== 'moved' && startOf(t))
    .sort((a, b) => timeToMinutes(startOf(a)!) - timeToMinutes(startOf(b)!));
  const margin = marginOf(opts);
  const earliest = opts.earliestWake || DEFAULT_EARLIEST_WAKE;
  const prep = opts.prepMinutes ?? 40;
  const out: Transition[] = [];

  let position: Task | undefined;           // last physical commitment
  let prev: Task | undefined;               // previous commitment of any kind
  let freeAt: number | undefined;           // latest end so far

  for (const t of day) {
    const start = timeToMinutes(startOf(t)!);
    const end = start + (t.durationMinutes || 30);
    const physical = isPhysical(t);
    const steps: ReasonStep[] = [];
    const from = position ? `"${position.text}"` : 'home';

    let travel = 0;
    let travelGuessed = false;
    if (physical) {
      const override = travelInto.get(t.id);
      const stored = storedTravel(t);
      if (typeof override === 'number') travel = override;
      else if (position && same(placeText(position), placeText(t))) travel = 0;
      else if (typeof stored === 'number') travel = stored;
      else { travel = UNKNOWN_TRAVEL_MINUTES; travelGuessed = true; }
      steps.push({
        thought: `"${t.text}" at ${startOf(t)} is in person; she comes from ${from}.`,
        observation: `trip ${travel} min${travelGuessed ? ' (no route stored — a guess)' : ''}`,
      });
    } else {
      steps.push({ thought: `"${t.text}" at ${startOf(t)} needs no trip (call / no place) — she stays where she is.` });
    }
    const useMargin = physical ? margin : 0;

    const base = {
      taskId: t.id, text: t.text,
      prevTaskId: prev?.id, prevText: prev?.text,
      fromTaskId: position?.id, fromText: position?.text,
      travel, travelGuessed: travelGuessed || undefined, margin: useMargin,
    };

    if (freeAt === undefined) {
      if (physical) {
        const wakeMin = start - travel - useMargin - prep;
        const storedWake = locOf(t)?.wakeUpBy;
        // The alarm the phone will actually ring, when one is armed; the
        // arithmetic otherwise.
        const wake = storedWake && !travelInto.has(t.id) ? storedWake : minutesToTime(wakeMin);
        const conflict = timeToMinutes(wake) < timeToMinutes(earliest) && timeToMinutes(wake) >= 0;
        steps.push({
          thought: `First trip of the day: wake = start − trip − margin − getting ready = ${wake}`
            + `${storedWake && !travelInto.has(t.id) ? ' (the alarm that is armed)' : ''}; her earliest is ${earliest}.`,
          observation: conflict ? 'WAKE_CONFLICT — earlier than she is willing to get up' : 'OK',
        });
        out.push({
          ...base, wake, earliestWake: earliest,
          status: conflict ? 'WAKE_CONFLICT' : 'OK',
          reasonEn: conflict
            ? `"${t.text}" needs you up at ${wake} — before your ${earliest}`
            : '',
          reasonHe: conflict
            ? `"${t.text}" דורש לקום ב-${wake} — לפני ${earliest} שלך`
            : '',
          steps,
        });
      }
      // A first commitment with no trip has nothing to judge.
    } else {
      const gap = start - freeAt;
      const status: FeasibilityStatus = gap < 0 ? 'OVERLAP'
        : gap < travel ? 'INFEASIBLE_TRAVEL'
          : gap < travel + useMargin ? 'TIGHT' : 'OK';
      const spare = gap - travel;
      steps.push({
        thought: `Free from ${minutesToTime(freeAt)}; gap ${gap} min vs trip ${travel} + margin ${round1(useMargin)}.`,
        observation: status,
      });
      const prevName = prev ? `"${prev.text}"` : '';
      out.push({
        ...base, gap, status,
        reasonEn: status === 'OVERLAP' ? `${prevName} and "${t.text}" overlap by ${-gap} min`
          : status === 'INFEASIBLE_TRAVEL' ? `${gap} min between ${prevName} and "${t.text}" but the trip takes ${travel}`
            : status === 'TIGHT' ? `only ${spare} min spare before "${t.text}" — you want ${Math.ceil(useMargin)}`
              : '',
        reasonHe: status === 'OVERLAP' ? `${prevName} ו"${t.text}" חופפות ב-${-gap} דק׳`
          : status === 'INFEASIBLE_TRAVEL' ? `${gap} דק׳ בין ${prevName} ל"${t.text}" אבל הנסיעה ${travel}`
            : status === 'TIGHT' ? `רק ${spare} דק׳ רזרבה לפני "${t.text}" — צריך ${Math.ceil(useMargin)}`
              : '',
        steps,
      });
    }

    if (physical) position = t;
    prev = t;
    freeAt = freeAt === undefined ? end : Math.max(freeAt, end);
  }
  return out;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
