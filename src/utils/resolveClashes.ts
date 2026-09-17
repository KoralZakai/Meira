/**
 * Turning "these two collide" into "here is what you could do about it".
 *
 * dayWarnings already detects overlaps, but a warning is not help. Real days
 * are full of trade-offs, and the useful move is to lay the options out and —
 * when there is genuinely no good answer — ask which one matters more, rather
 * than silently picking.
 *
 * Deliberately pure: no storage, no network, no LLM. The suggestions are
 * derived from facts already on the task (does it need a place? is its time
 * fixed?), so they are always true and always explainable. The chat agent can
 * phrase them; it does not have to invent them.
 */
import { Task } from '../types/index';
import { timeToMinutes, addMinutes } from './timeUtils';
import { isRemoteTask } from './meetingLink';

export type ClashResolutionKind =
  | 'attend-remotely' | 'move' | 'shorten' | 'choose' | 'end-earlier' | 'delay-next';

export interface ClashOption {
  kind: ClashResolutionKind;
  /** The task this option acts on. */
  taskId: string;
  labelEn: string;
  labelHe: string;
  /** For 'move': the proposed new start, HH:MM. */
  newTime?: string;
}

export interface Clash {
  a: Task;
  b: Task;
  overlapMinutes: number;
  /** Minutes of travel still unaccounted for between the two places. */
  travelShortfall?: number;
  /** The trade-off, stated plainly. */
  questionEn: string;
  questionHe: string;
  options: ClashOption[];
}

const startOf = (t: Task): string | undefined => t.fixedTime || t.scheduledTime;

/**
 * Someone else is in the room, so the END of the slot is not hers to pick.
 * You cannot tell an interviewer or a doctor that you are leaving at half
 * time. Everything else — a conference, a class, a course, the gym — you can
 * walk out of early; that is the ordinary way a person makes two things fit.
 */
const HELD_WITH_HER: string[] = ['interview', 'doctor', 'meeting', 'call', 'zoom'];

/**
 * …and these START when they start, whatever she does. A conference does not
 * begin later because she is running late; she just misses the opening.
 */
const EXTERNALLY_TIMED: string[] = [...HELD_WITH_HER, 'conference', 'class', 'course'];

/** Can she leave this one before it finishes? */
function canLeaveEarly(task: Task): boolean {
  return !HELD_WITH_HER.includes(String(task.category));
}

/**
 * Can this one be pushed to a later start?
 *
 * `isFixed` is the wrong test: in this app it only means "has a clock time",
 * which is true of nearly every task. The real question is whether the time
 * was set by somebody else.
 */
function canStartLater(task: Task): boolean {
  if (EXTERNALLY_TIMED.includes(String(task.category))) return false;
  // A calendar invite is somebody else's arrangement too.
  return !['calendar', 'gcal'].includes(String((task as any).source ?? ''));
}

/**
 * Minutes of travel needed to get from `from`'s place to `to`'s place.
 *
 * Uses the route already computed for `to` when it exists. Two tasks in the
 * same place need no travel; two in different places always need SOME, so an
 * unknown gap falls back to a deliberately small non-zero number rather than
 * pretending teleportation.
 */
function travelMinutesBetween(from: Task, to: Task): number {
  const place = (t: Task): string => {
    const l: any = t.location;
    return (typeof l === 'string' ? l : l?.address || l?.displayName || '').trim().toLowerCase();
  };
  const a = place(from); const b = place(to);
  if (!a || !b || a === b) return 0;
  const loc: any = to.location;
  const known = typeof loc === 'object'
    ? (loc?.travelMinutes ?? loc?.transitPlan?.totalDurationMinutes)
    : undefined;
  return typeof known === 'number' && known > 0 ? known : 15;
}
const endOf = (t: Task): string => addMinutes(startOf(t)!, t.durationMinutes || 30);

/** Tasks with a clock time, earliest first. */
function timed(tasks: Task[]): Task[] {
  return tasks
    .filter((t) => t.status !== 'complete' && startOf(t))
    .sort((a, b) => timeToMinutes(startOf(a)!) - timeToMinutes(startOf(b)!));
}

/**
 * The earliest start at or after `notBefore` where `minutes` fits without
 * touching anything else. Returns undefined when the day has no room left.
 */
export function firstFreeSlot(
  tasks: Task[], minutes: number, notBefore: string, dayEnd = '23:00',
): string | undefined {
  const busy = timed(tasks).map((t) => [timeToMinutes(startOf(t)!), timeToMinutes(endOf(t))] as const);
  let cursor = timeToMinutes(notBefore);
  const limit = timeToMinutes(dayEnd);
  // Walk forward, jumping past anything we land inside, until the gap fits.
  for (let guard = 0; guard < 100; guard += 1) {
    const clash = busy.find(([s, e]) => cursor < e && cursor + minutes > s);
    if (!clash) break;
    cursor = clash[1];
  }
  if (cursor + minutes > limit) return undefined;
  const hh = String(Math.floor(cursor / 60)).padStart(2, '0');
  const mm = String(cursor % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** How many minutes two tasks genuinely share. 0 means no clash. */
export function overlapMinutes(a: Task, b: Task): number {
  const aS = timeToMinutes(startOf(a)!); const aE = timeToMinutes(endOf(a));
  const bS = timeToMinutes(startOf(b)!); const bE = timeToMinutes(endOf(b));
  return Math.max(0, Math.min(aE, bE) - Math.max(aS, bS));
}

/**
 * Every genuine collision in the day, each with what could be done about it.
 *
 * Options are ordered best-first:
 *   attend-remotely — one side needs no place, so it can happen in transit
 *   move            — one side has no fixed time and the day has room
 *   choose          — nothing else works; the user decides, and is asked to
 */
export function resolveClashes(tasks: Task[], dayEnd = '23:00'): Clash[] {
  const day = timed(tasks);
  const out: Clash[] = [];

  for (let i = 0; i < day.length; i += 1) {
    for (let j = i + 1; j < day.length; j += 1) {
      const a = day[i]; const b = day[j];
      const mins = overlapMinutes(a, b);
      // Back-to-back is not the same as compatible. A gym ending at 20:00 and a
      // beach starting at 20:00 overlap by ZERO minutes and are still
      // impossible if the two are 25 minutes apart — that case was skipped
      // entirely, which is why Lumi never raised it.
      const [first, second] = timeToMinutes(startOf(a)!) <= timeToMinutes(startOf(b)!)
        ? [a, b] : [b, a];
      const travelNeeded = travelMinutesBetween(first, second);
      const gap = timeToMinutes(startOf(second)!) - timeToMinutes(endOf(first));
      const shortfall = travelNeeded > 0 ? Math.max(0, travelNeeded - gap) : 0;
      if (mins <= 0 && shortfall <= 0) continue;

      const options: ClashOption[] = [];

      // 1. A call needs no place — it can ride along to the one that does.
      for (const [remote, fixedPlace] of [[a, b], [b, a]] as const) {
        if (isRemoteTask(remote) && !isRemoteTask(fixedPlace)) {
          options.push({
            kind: 'attend-remotely',
            taskId: remote.id,
            labelEn: `Join "${remote.text}" on the way to "${fixedPlace.text}"`,
            labelHe: `להצטרף ל"${remote.text}" בדרך ל"${fixedPlace.text}"`,
          });
        }
      }

      // 2. Whichever side is not pinned to a clock can move, if there is room.
      for (const [flexible, other] of [[a, b], [b, a]] as const) {
        if (flexible.isFixed) continue;
        const after = endOf(other);
        const slot = firstFreeSlot(day, flexible.durationMinutes || 30, after, dayEnd);
        if (slot) {
          options.push({
            kind: 'move',
            taskId: flexible.id,
            newTime: slot,
            labelEn: `Move "${flexible.text}" to ${slot}`,
            labelHe: `להזיז את "${flexible.text}" ל-${slot}`,
          });
        }
      }

      // 2b. Keep BOTH. This is what a person actually does with a long day
      // that swallows an evening: go to the conference, leave it early enough
      // to cross town, and still make the second thing on time. It applies to
      // a real overlap just as much as to a journey that does not fit — a
      // 09:00–22:00 conference and an 18:00 class overlap by three hours and
      // the answer is still "leave at 17:45", not "give one of them up".
      //
      // There are exactly two honest versions — leave the first sooner, or
      // start the second later — and which is right depends on what matters
      // to her today. Offer both and let her pick; never choose silently.
      if (mins > 0 || shortfall > 0) {
        const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
        const mustEndBy = timeToMinutes(startOf(second)!) - travelNeeded;
        if (canLeaveEarly(first) && mustEndBy - timeToMinutes(startOf(first)!) >= 15) {
          const trip = travelNeeded > 0
            ? { en: ` — ${travelNeeded} min to "${second.text}"`, he: ` — ${travelNeeded} דק' ל"${second.text}"` }
            : { en: ` — in time for "${second.text}"`, he: ` — בזמן ל"${second.text}"` };
          options.push({
            kind: 'end-earlier',
            taskId: first.id,
            newTime: hhmm(mustEndBy),
            labelEn: `Keep both — leave "${first.text}" at ${hhmm(mustEndBy)}${trip.en}`,
            labelHe: `להספיק את שתיהן — לצאת מ"${first.text}" ב-${hhmm(mustEndBy)}${trip.he}`,
          });
        }
        const newStart = timeToMinutes(endOf(first)) + travelNeeded;
        if (canStartLater(second) && newStart < timeToMinutes(dayEnd)) {
          options.push({
            kind: 'delay-next',
            taskId: second.id,
            newTime: hhmm(newStart),
            labelEn: `Start "${second.text}" at ${hhmm(newStart)} instead — after "${first.text}"`,
            labelHe: `להתחיל את "${second.text}" ב-${hhmm(newStart)} — אחרי "${first.text}"`,
          });
        }
      }

      // 3. It does not FIT anywhere, but it could still happen — shorter.
      // A 4.5-hour evening plan cannot move after a 19:00 class and still end
      // by 23:00, yet "go, just for less time" is what a person would actually
      // do. Only offered when a worthwhile amount of time is left.
      for (const [flexible, other] of [[a, b], [b, a]] as const) {
        if (flexible.isFixed) continue;
        if (options.some((o) => o.kind === 'move' && o.taskId === flexible.id)) continue;
        const start = endOf(other);
        const left = timeToMinutes(dayEnd) - timeToMinutes(start);
        if (left >= 30 && left < (flexible.durationMinutes || 30)) {
          options.push({
            kind: 'shorten',
            taskId: flexible.id,
            newTime: start,
            labelEn: `Start "${flexible.text}" at ${start} instead — ${left} min rather than ${flexible.durationMinutes}`,
            labelHe: `להתחיל את "${flexible.text}" ב-${start} — ${left} דק' במקום ${flexible.durationMinutes}`,
          });
        }
      }

      // 4. Nothing tidy is available. Do not pick for her — ask, and say
      // plainly what the choice costs: picking one lets the OTHER go. That
      // sentence is the difference between a decision and a surprise.
      if (options.length === 0) {
        options.push(
          {
            kind: 'choose',
            taskId: a.id,
            labelEn: `Keep "${a.text}" · let go of "${b.text}"`,
            labelHe: `להשאיר את "${a.text}" · לוותר על "${b.text}"`,
          },
          {
            kind: 'choose',
            taskId: b.id,
            labelEn: `Keep "${b.text}" · let go of "${a.text}"`,
            labelHe: `להשאיר את "${b.text}" · לוותר על "${a.text}"`,
          },
        );
      }

      const both = `"${a.text}" ${'&'} "${b.text}"`;
      out.push({
        a, b, overlapMinutes: mins, travelShortfall: shortfall || undefined, options,
        questionEn: options[0].kind === 'choose'
          ? `${both} overlap by ${mins} min and neither can move. Which matters more today?`
          : mins <= 0
            ? `"${first.text}" ends when "${second.text}" starts, but they are ${travelNeeded} min apart. Which gives?`
            : `${both} overlap by ${mins} min.`,
        questionHe: options[0].kind === 'choose'
          ? `${both} חופפות ב-${mins} דק' ואי אפשר להזיז אף אחת. מה יותר חשוב לך היום?`
          : mins <= 0
            ? `"${first.text}" נגמרת כש"${second.text}" מתחילה, אבל יש ביניהן ${travelNeeded} דק' נסיעה. מה מוותר?`
            : `${both} חופפות ב-${mins} דק'.`,
      });
    }
  }
  return out;
}
