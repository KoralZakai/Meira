/**
 * morningAlarm — THE next morning alarm, the one ⏰ at the top of Today.
 *
 * Koral, 20.10: "an icon of an alarm clock that won't disappear even after
 * time has passed. I can turn it on again for the next task in the morning —
 * enable/disable (Meira calculates it automatically) and a long press changes
 * the time."
 *
 * Before this, the ⏰ lived only on a card with a trip, and only until its
 * hour went by — a call at 09:30 had an alarm in Clock and nothing on screen
 * to see it, turn it off, or move it.
 *
 * So there is one answer, computed the same way every time:
 *   - each day's alarm belongs to its first morning task (alarmPlan.dayWakeOwner,
 *     the rule the Clock already follows); Meira picks the hour;
 *   - her choice for a DATE (`MorningChoice`: off, or another hour) overrides it;
 *   - once that alarm's moment has passed, the next morning's takes its place —
 *     the ⏰ never disappears, it moves on.
 *
 * Pure: no storage, no intents. MorningAlarmService persists choices and
 * AlarmPlanner.syncWakeAlarms sets Clock from `morningAlarmFor`.
 */
import { Task } from '../types/index';
import { dayWakeOwner, plannedAlarmTime } from './alarmPlan';

/** What she chose for one morning. Absent fields mean "Meira decides". */
export interface MorningChoice {
  on?: boolean;
  /** HH:MM she picked by long press — only for a morning with no task to count back from. */
  at?: string;
  /** Minutes before she must LEAVE (or start, with no trip). Kept as minutes,
   *  not an hour: the wake follows the bus. Koral, 20.10: "this is highly
   *  depending on the time I need to leave to get the meeting on time — depends
   *  on the bus time." */
  beforeMin?: number;
}

/** What the wake counts back from: when she must leave (and on what), else the start. */
export interface WakeAnchor {
  kind: 'leave' | 'start';
  at: string;
  ride?: { icon: string; line?: string; time?: string; stop?: string };
}

/** YYYY-MM-DD → her choice for that morning. */
export type MorningChoices = Record<string, MorningChoice>;

export interface MorningPlan {
  date: string;
  /** HH:MM it rings (or would, when off). */
  at: string;
  /** Meira's own hour, before her choice. Undefined when no task wants one. */
  autoAt?: string;
  on: boolean;
  /** She picked the hour. */
  custom: boolean;
  task?: Task;
  anchor?: WakeAnchor;
  /** anchor − at, in minutes, when there is an anchor. */
  beforeMin?: number;
}

function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function fromMin(t: number): string {
  const x = ((t % 1440) + 1440) % 1440;
  return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
}

const RIDE_ICON: Record<string, string> = { bus: '🚌', train: '🚆', subway: '🚇', tram: '🚋' };

/** When she has to leave for `task` and on what — the bus decides the morning. */
export function anchorOf(task?: Task): WakeAnchor | undefined {
  if (!task) return undefined;
  const loc: any = typeof task.location === 'object' ? task.location : undefined;
  const leave: string | undefined = loc?.leaveHomeBy || loc?.transitPlan?.leaveHomeAt;
  if (leave) {
    const leg = (loc?.transitPlan?.legs || []).find((l: any) => l?.type && l.type !== 'walk');
    return {
      kind: 'leave', at: leave,
      ride: leg ? { icon: RIDE_ICON[leg.type] || '🚌', line: leg.lineNumber, time: leg.departureTime, stop: leg.stopName } : undefined,
    };
  }
  const start = startOf(task);
  return start ? { kind: 'start', at: start } : undefined;
}

type Inputs = { usualWakeTime?: string; routineMinutes?: number };

const NOON = '12:00';

function startOf(t: Task): string | undefined {
  return t.fixedTime || t.scheduledTime || undefined;
}

/**
 * The morning's first task when the wake rule found no owner — a task Meira
 * judged needs no alarm (she is up by then anyway). It still gets the ⏰, off,
 * so she can turn it on: "I can turn it on for the next task in the morning".
 */
function firstMorningTask(dayTasks: Task[], routineMinutes?: number): Task | undefined {
  return dayTasks
    .filter((t) => t.status === 'pending' && startOf(t) && startOf(t)! < NOON
      && plannedAlarmTime(t, routineMinutes))
    .sort((a, b) => (startOf(a)! < startOf(b)! ? -1 : startOf(a)! > startOf(b)! ? 1 : a.id < b.id ? -1 : 1))[0];
}

/** One date's alarm: its owner task, Meira's hour, her choice. Null = nothing to draw. */
export function morningAlarmFor(date: string, dayTasks: Task[], inputs: Inputs = {},
                                choice?: MorningChoice): MorningPlan | null {
  const own = dayTasks.filter((t) => t.date === date);
  const owner = dayWakeOwner(own, inputs);
  const task = owner ? own.find((t) => t.id === owner.taskId) : firstMorningTask(own, inputs.routineMinutes);
  const autoAt = owner?.at ?? (task ? plannedAlarmTime(task, inputs.routineMinutes) : undefined);
  const anchor = anchorOf(task);
  const theirs = anchor && Number.isFinite(choice?.beforeMin)
    ? fromMin(toMin(anchor.at) - (choice!.beforeMin as number))
    : choice?.at;
  const at = theirs || autoAt;
  if (!at) return null;
  // 'not_needed' on the owner is the card's own mute (wakeChipFor's 🔕).
  const meiraOn = Boolean(owner) && task?.alarmState !== 'not_needed';
  return {
    date, at, autoAt, task, anchor,
    beforeMin: anchor ? ((toMin(anchor.at) - toMin(at)) + 1440) % 1440 : undefined,
    on: choice?.on ?? (theirs ? true : meiraOn),
    custom: Boolean(theirs && theirs !== autoAt),
  };
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The moment `plan` rings. A wake later than its task's own start is the night before. */
export function momentOf(plan: MorningPlan): Date {
  const [y, mo, d] = plan.date.split('-').map(Number);
  const [h, m] = plan.at.split(':').map(Number);
  const start = plan.task ? startOf(plan.task) : undefined;
  const before = start && plan.at > start ? 1 : 0;
  return new Date(y, mo - 1, d - before, h, m, 0, 0);
}

/**
 * The alarm the ⏰ shows: the first morning, from today, whose moment is still
 * ahead. Looks a week out, so a free tomorrow does not empty the pill.
 */
export function nextMorningAlarm(tasks: Task[], inputs: Inputs = {}, choices: MorningChoices = {},
                                 now: Date = new Date(), horizonDays = 7): MorningPlan | null {
  for (let i = 0; i <= horizonDays; i += 1) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    const date = dayKey(d);
    const plan = morningAlarmFor(date, tasks, inputs, choices[date]);
    if (plan && momentOf(plan).getTime() > now.getTime()) return plan;
  }
  return null;
}

/**
 * The hours a long press offers: round quarter hours around Meira's own (an
 * hour before to half an hour after), and Meira's exact hour among them.
 * Never past the task's start.
 */
export function alarmTimeChoices(plan: Pick<MorningPlan, 'at' | 'autoAt' | 'task'>): string[] {
  const base = plan.autoAt || plan.at;
  const [h, m] = base.split(':').map(Number);
  const mins = h * 60 + m;
  const start = plan.task ? startOf(plan.task) : undefined;
  const hhmm = (t: number) => {
    const x = ((t % 1440) + 1440) % 1440;
    return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
  };
  // Her own hour stays in the grid, so the sheet shows what is set now.
  const set = new Set<string>([base, plan.at]);
  for (let t = Math.ceil((mins - 60) / 15) * 15; t <= mins + 30; t += 15) set.add(hhmm(t));
  return [...set]
    .filter((t) => !(start && t > base && t >= start))
    .sort((a, b) => ((timeKey(a, mins) - timeKey(b, mins))));
}

/** Minutes, ordered around `around` so a choice past midnight sorts after 23:45. */
function timeKey(t: string, around: number): number {
  const [h, m] = t.split(':').map(Number);
  const v = h * 60 + m;
  return v - around < -720 ? v + 1440 : v;
}

export interface WakeOption {
  at: string;
  /** Minutes before leaving (or starting). */
  before: number;
  auto: boolean;
}

/**
 * A long press with a trip to count back from: "N min before you leave",
 * each with the hour it means today. Meira's own and her current one included.
 */
export function wakeOptions(plan: MorningPlan): WakeOption[] {
  if (!plan.anchor) return [];
  const leave = toMin(plan.anchor.at);
  const autoBefore = plan.autoAt ? ((leave - toMin(plan.autoAt)) + 1440) % 1440 : undefined;
  const set = new Set<number>([15, 30, 45, 60, 75, 90, 120]);
  if (autoBefore) set.add(autoBefore);
  if (plan.beforeMin) set.add(plan.beforeMin);
  return [...set].filter((b) => b > 0 && b < 12 * 60).sort((a, b) => b - a)
    .map((before) => ({ at: fromMin(leave - before), before, auto: before === autoBefore }));
}

/** "מחר 08:30" / "Tomorrow 08:30" / "Thu 08:30" — the pill's words. */
export function morningAlarmLabel(plan: MorningPlan, now: Date, he: boolean): string {
  const today = dayKey(now);
  const tomorrow = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  const ring = dayKey(momentOf(plan));
  const day = ring === today ? (he ? 'היום' : 'Today')
    : ring === tomorrow ? (he ? 'מחר' : 'Tomorrow')
      : momentOf(plan).toLocaleDateString(he ? 'he-IL' : 'en-GB', { weekday: 'short', day: 'numeric', month: 'numeric' });
  return `${day} ${plan.at}`;
}
