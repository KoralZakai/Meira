/**
 * liveRoutePlan — the PURE decisions behind LiveRoute (which trip, from which
 * assumed origin). Split out so it imports without react-native and can be
 * tested on its own; the service in LiveRoute.ts owns the GPS read, the Google
 * fetch and the notification.
 */
import { Task, TransitPlan } from '../types/index';
import { LatLng } from './positionDrift';
import { addrOf, timeOf } from './dayPlanning';

/**
 * How long after a thing has STARTED it is still worth routing her to it.
 * Half of it, at most an hour: late for karaoke is still karaoke; an all-day
 * conference she skipped must not nag "leave now" until the evening.
 */
export function stillWorthGoingUntil(startMin: number, durationMinutes: number): number {
  return startMin + Math.min(60, Math.max(10, Math.round(durationMinutes / 2)));
}

/**
 * The trip a live re-plan would act on: the next pending, located, timed task
 * — including one that has already STARTED while she has not arrived.
 *
 * Koral, 28.9: "if I have a task now and I haven't left for it — my location
 * didn't change — update the leave time and the arrival accordingly." This
 * used to take only tasks at or after the current minute, so the moment the
 * appointment began she dropped out of every re-plan: the screen kept a leave
 * time from the past and an arrival that was no longer true. A started trip
 * stays the trip (earliest first, so it wins) until she arrives, ticks it, or
 * it is too far gone to be worth going (stillWorthGoingUntil).
 */
export function nextTrip(tasks: Task[], now: Date = new Date()): Task | undefined {
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const toMin = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  };
  return tasks
    .filter((t) => {
      // Already there. Re-planning a journey to a place she is standing in is
      // the bug this guard exists for: it produced a live travel card to a
      // building she was inside, and pushed the NEXT trip's origin back home.
      if (t.status !== 'pending' || t.verifiedArrival || !addrOf(t) || !timeOf(t)) return false;
      const start = toMin(timeOf(t)!);
      if (!Number.isFinite(start)) return false;
      return start >= nowMin || nowMin < stillWorthGoingUntil(start, t.durationMinutes || 30);
    })
    .sort((a, b) => (timeOf(a)! < timeOf(b)! ? -1 : 1))[0];
}

/**
 * Where the plan for a task assumed the user starts.
 *
 * A route records its own origin coordinates (`startLat`/`startLng`) once the
 * server or the chain set them. Absent that there is no assumed origin to
 * compare against; assessDrift treats a null origin as "re-plan from the real
 * fix", which is strictly better than planning from an unknown.
 */
export function assumedOrigin(task: Task): LatLng | null {
  const loc = task.location;
  const plan = (loc && typeof loc === 'object'
    ? (loc.transitPlan as (TransitPlan & { startLat?: number; startLng?: number }) | undefined)
    : undefined);
  if (plan && Number.isFinite(plan.startLat) && Number.isFinite(plan.startLng)) {
    return { lat: plan.startLat as number, lng: plan.startLng as number };
  }
  return null;
}

/** Current wall-clock as "HH:MM" in the app's local timezone. */
export function nowHHMM(now: Date = new Date()): string {
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

/**
 * Has the planned departure already passed while she is still at the origin?
 *
 * The plan says "leave by 17:18 for the 17:30 bus". If 17:18 comes and she has
 * not left, that bus is gone and the whole plan — departure, arrival, the lot —
 * is now fiction. This is the signal to recompute from the NEXT departure, and
 * it is separate from drift: drift fires when she MOVES, this fires when she
 * does NOT. `graceMinutes` avoids re-planning in the same minute the alert
 * fires (she may be walking out the door right now).
 */
export function missedPlannedDeparture(
  leaveHomeBy: string | undefined,
  now: Date = new Date(),
  graceMinutes = 0,
): boolean {
  if (!leaveHomeBy || !/^\d{1,2}:\d{2}$/.test(leaveHomeBy)) return false;
  const [h, m] = leaveHomeBy.split(':').map(Number);
  const leaveMins = h * 60 + m;
  const nowMins = now.getHours() * 60 + now.getMinutes();
  // Same-day only: a leave time that reads as "earlier" but is really tomorrow
  // (a 00:40 flight) is not something an evening loop should treat as missed.
  return nowMins > leaveMins + graceMinutes && nowMins - leaveMins < 12 * 60;
}


/**
 * Minutes she will be late if she leaves on the next departure; 0 = in time.
 *
 * 13.10, Koral: "if you see I haven't left — ask me: you're late, are you
 * still going? reschedule? cancel? keep options!" The missed-departure re-plan
 * said "Times updated · arrive 13:42" for a 13:00 interview and nothing else:
 * a new arrival that is already a no-show, reported as an update.
 */
export function lateBy(startsAt: string | undefined, arriveAt: string | undefined): number {
  const m = (t?: string) => (t && /^\d{1,2}:\d{2}$/.test(t) ? Number(t.split(':')[0]) * 60 + Number(t.split(':')[1]) : null);
  const s = m(startsAt);
  const a = m(arriveAt);
  if (s === null || a === null) return 0;
  return Math.max(0, a - s);
}

/** The question, in her language — the late arrival, and her three choices. */
export function runningLateText(
  taskText: string, arriveAt: string, minutesLate: number, he: boolean,
  /** An interview, a doctor, a must: late is not an option, so the question is what happened. */
  mustBeOnTime = false,
): { title: string; body: string } {
  // 13.10, Koral: "to an interview I cannot be late! If it's nearly 13:00 and
  // I'm still at home I haven't left — why? Cancelled? Changed? To when?"
  if (mustBeOnTime) {
    return he
      ? {
        title: `⏰ לא תגיעי בזמן ל${taskText}`,
        body: `אם יוצאים עכשיו מגיעים ב-${arriveAt}, ${minutesLate} דק׳ איחור — ולזה אי אפשר לאחר. מה קרה? בוטל? הוזז — למתי?`,
      }
      : {
        title: `⏰ You won't make ${taskText} on time`,
        body: `Leaving now you arrive at ${arriveAt}, ${minutesLate} min late — and this one can't be late. What happened? Cancelled? Moved — to when?`,
      };
  }
  return he
    ? {
      title: `⏰ את מאחרת ל${taskText}`,
      body: `אם יוצאים עכשיו מגיעים ב-${arriveAt} — ${minutesLate} דק׳ איחור. עדיין הולכת? לדחות? לבטל?`,
    }
    : {
      title: `⏰ You're running late for ${taskText}`,
      body: `Leaving now you arrive at ${arriveAt} — ${minutesLate} min late. Still going? Reschedule? Cancel?`,
    };
}

/** A meeting from her calendar (Google / phone / Outlook) — not Meira's to move. */
export const isFromCalendar = (id: string) => /^(gcal|dcal|ocal)-/.test(id);

/** The open task left when there is no new time yet (13.10: "keep it in the open tasks to do"). */
export function followUpTitle(taskText: string, he: boolean): string {
  return he ? `לקבוע מועד חדש: ${taskText}` : `Set a new time: ${taskText}`;
}

/** The original task's text when this is such a follow-up ("לקבוע מועד חדש: X" → "X"), else null. */
export function followUpOriginal(text: string | undefined): string | null {
  const m = /^(?:לקבוע מועד חדש|Set a new time):\s*(.+)$/.exec(String(text ?? '').trim());
  return m ? m[1].trim() : null;
}

/**
 * She is late on the planned way: is another way, from NOW, really faster? (21.10, Koral: "when she
 * does not leave in time, Meira finds the next fastest way at once, and says so clearly".)
 *
 * `options` are depart-now plans for the other vehicles, each from Google. The pick is the one
 * that ARRIVES first, and only when it beats the way she is on by at least `minGainMin` — a
 * two-minute gain is not worth a different vehicle and a new decision. Pure.
 */
export function bestAlternative(
  current: { arriveAt: string },
  options: Array<{ mode: string; plan: { arriveAt: string; leaveHomeAt: string; totalDurationMinutes: number } }>,
  minGainMin = 5,
): { mode: string; plan: { arriveAt: string; leaveHomeAt: string; totalDurationMinutes: number }; gain: number } | null {
  const mins = (s: string) => {
    const [h, m] = (s || '').split(':').map(Number);
    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : NaN;
  };
  const cur = mins(current.arriveAt);
  if (!Number.isFinite(cur)) return null;
  const ranked = options
    .map((o) => ({ ...o, at: mins(o.plan.arriveAt) }))
    .filter((o) => Number.isFinite(o.at))
    .sort((a, b) => a.at - b.at);
  const best = ranked[0];
  if (!best || cur - best.at < minGainMin) return null;
  return { mode: best.mode, plan: best.plan, gain: cur - best.at };
}

/** The clear, true sentence: what is faster, when she arrives, how much sooner. */
export function alternativeLine(
  alt: { mode: string; plan: { arriveAt: string; totalDurationMinutes: number }; gain: number }, he: boolean,
): string {
  const icon = ({ bus: '🚌', train: '🚆', car: '🚗', bike: '🚴', walk: '🚶' } as Record<string, string>)[alt.mode] ?? '';
  const name = he
    ? ({ bus: 'אוטובוס', train: 'רכבת', car: 'רכב', bike: 'אופניים', walk: 'הליכה' } as Record<string, string>)[alt.mode] ?? alt.mode
    : alt.mode;
  return he
    ? `${icon} מהר יותר: ${name} — מגיעים ב-${alt.plan.arriveAt} (${alt.gain} דק׳ מוקדם יותר, לפי גוגל)`
    : `${icon} Faster: ${name} — arrive ${alt.plan.arriveAt} (${alt.gain} min sooner, per Google)`;
}
