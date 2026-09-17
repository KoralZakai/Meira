/**
 * buildTravelChain — pure helper that turns a task (+ its previous task and
 * the user profile) into the step list shown by TravelChainCard:
 * wake → get ready → leave home → bus/train/car → walk → arrive,
 * or, for at-home tasks after an away appointment, the WAY-HOME chain:
 * prev ends → travel home → arrive → break → task starts.
 * Dependencies: timeUtils only (pure). Drop into src/utils/.
 */
import { Task, TaskLocation, TransportType, UserProfile } from '../types';
import { addMinutes, subtractMinutes, timeToMinutes } from './timeUtils';
import { OUTING_PREP_MINUTES } from './yieldToFixed';

/**
 * Kept as the name three screens already import. The mapping itself now lives
 * in utils/profileShape, because the same translation was needed by the LLM
 * prompt, the schedule builder and the settings screen — all of which were
 * reading types/ names off a models/ profile and silently getting undefined.
 */
export { normalizeProfile as toChainProfile } from './profileShape';

export interface ChainStep {
  time: string;          // HH:MM
  icon: string;
  labelEn: string;
  labelHe: string;
  noteEn?: string;
  noteHe?: string;
  kind: 'normal' | 'highlight' | 'success'; // highlight = "leave" row, success = arrival
}

const MODE_ICON: Record<TransportType, string> = {
  bus: '🚌', train: '🚆', car: '🚗', walk: '🚶', bike: '🚴',
};
const MODE_EN: Record<TransportType, string> = {
  bus: 'Bus', train: 'Train', car: 'Drive', walk: 'Walk', bike: 'Bike',
};
const MODE_HE: Record<TransportType, string> = {
  bus: 'אוטובוס', train: 'רכבת', car: 'נסיעה ברכב', walk: 'הליכה', bike: 'אופניים',
};

/** Rough fallback multipliers used ONLY for the instant preview between a
 *  transport-chip tap and the real Google route coming back (TravelChainCard
 *  awaits onTransportChange, which refetches). Never persisted, never alerted
 *  on — showing a made-up duration as if it were Google's is the exact bug the
 *  transit parser fix was about. */
const MODE_FACTOR: Record<TransportType, number> = {
  bus: 1, train: 0.75, car: 0.6, walk: 3.2, bike: 1.4,
};

export function asLocation(t?: Task): TaskLocation | undefined {
  return t && t.location && typeof t.location === 'object' ? t.location : undefined;
}

export function taskStart(t: Task): string {
  return t.fixedTime || t.scheduledTime || '09:00';
}

export function effectiveTransport(t: Task, profile?: UserProfile | null): TransportType {
  return asLocation(t)?.transportType || profile?.transportType || 'bus';
}

/** Travel minutes for a mode: exact when it matches the stored plan/estimate,
 *  otherwise scaled by MODE_FACTOR so switching chips still gives sane times. */
export function travelMinutesFor(
  t: Task, mode: TransportType, profile?: UserProfile | null,
): number {
  const loc = asLocation(t);
  const base = loc?.transitPlan?.totalDurationMinutes ?? loc?.travelMinutes ?? 30;
  const baseMode = effectiveTransport(t, profile);
  if (mode === baseMode) return base;
  return Math.max(5, Math.round((base / MODE_FACTOR[baseMode]) * MODE_FACTOR[mode]));
}

/** True when this task happens at home (no place to travel to). */
export function isAtHome(t: Task): boolean {
  return !asLocation(t) && (t.category === 'zoom' || t.category === 'call' || !t.hasLocation);
}

/** WAY THERE — for a task with a location. `isFirstOfDay` adds wake/get-ready rows. */
export function buildWayThere(
  t: Task, mode: TransportType, profile?: UserProfile | null, isFirstOfDay = false,
): ChainStep[] {
  const loc = asLocation(t);
  if (!loc) return [];
  const start = taskStart(t);
  const buffer = profile?.wakeBufferMinutes ?? 15;
  const routine = profile?.morningRoutineMinutes ?? 45;
  const travel = travelMinutesFor(t, mode, profile);
  const plan = mode === effectiveTransport(t, profile) ? loc.transitPlan : undefined;
  const leave = plan?.leaveHomeAt || subtractMinutes(start, travel + buffer);
  const steps: ChainStep[] = [];

  if (isFirstOfDay) {
    const wake = subtractMinutes(leave, routine + buffer);
    steps.push({ time: wake, icon: '⏰', labelEn: 'Wake up', labelHe: 'להתעורר', noteEn: `${buffer}m buffer`, noteHe: `${buffer} דק' רזרבה`, kind: 'normal' });
    steps.push({ time: addMinutes(wake, buffer), icon: '🛁', labelEn: 'Get ready', labelHe: 'להתארגן', noteEn: `${routine}m routine`, noteHe: `${routine} דק'`, kind: 'normal' });
  } else {
    // EVERY departure needs getting ready for, not only the first of the day.
    //
    // Koral, 2026-09-17, about a 19:00 yoga class: "a time to get ready will
    // appear, travel time by bike will appear". The leave row was there and
    // nothing stood before it, so the chain read as though she teleported from
    // her desk onto the bike.
    //
    // It is deliberately NOT the morning routine. That number is a shower and
    // breakfast; spending it on changing into leggings would move the whole
    // evening an hour earlier, and a row that is obviously wrong is a row she
    // learns to skip.
    steps.push({
      time: subtractMinutes(leave, OUTING_PREP_MINUTES),
      icon: '🧭', labelEn: 'Get ready to go', labelHe: 'להתארגן לצאת',
      noteEn: `${OUTING_PREP_MINUTES} min`, noteHe: `${OUTING_PREP_MINUTES} דק'`,
      kind: 'normal',
    });
  }
  steps.push({ time: leave, icon: '🏠', labelEn: 'Leave home', labelHe: 'לצאת מהבית', noteEn: "don't miss!", noteHe: 'לא לפספס!', kind: 'highlight' });

  if (plan?.legs?.length) {
    for (const leg of plan.legs) {
      steps.push({
        time: leg.departureTime,
        icon: MODE_ICON[(leg.type === 'subway' ? 'train' : leg.type) as TransportType] || '🚌',
        labelEn: leg.lineNumber ? `${MODE_EN[leg.type as TransportType] || 'Bus'} ${leg.lineNumber} → ${leg.to}` : `${MODE_EN[leg.type as TransportType] || 'Walk'} → ${leg.to}`,
        labelHe: leg.lineNumber ? `${MODE_HE[leg.type as TransportType] || 'אוטובוס'} ${leg.lineNumber} → ${leg.to}` : `${MODE_HE[leg.type as TransportType] || 'הליכה'} → ${leg.to}`,
        noteEn: `${leg.durationMinutes} min`, noteHe: `${leg.durationMinutes} דק'`,
        kind: 'normal',
      });
    }
  } else {
    steps.push({
      time: addMinutes(leave, Math.min(8, Math.round(travel * 0.15))),
      icon: MODE_ICON[mode],
      labelEn: `${MODE_EN[mode]} → ${loc.displayName || loc.address}`,
      labelHe: `${MODE_HE[mode]} → ${loc.displayName || loc.address}`,
      noteEn: `${travel} min`, noteHe: `${travel} דק'`,
      kind: 'normal',
    });
  }

  const arrive = plan?.arriveAt || subtractMinutes(start, Math.min(buffer, 10));
  const early = Math.max(0, timeToMinutes(start) - timeToMinutes(arrive));
  steps.push({
    time: arrive, icon: '🎯',
    labelEn: early > 0 ? `Arrive — ${early} min early` : 'Arrive',
    labelHe: early > 0 ? `הגעה — ${early} דק' לפני` : 'הגעה',
    kind: 'success',
  });
  return steps;
}

/** WAY HOME — for an at-home task when the previous task was away. */
export function buildWayHome(
  t: Task, prev: Task, mode: TransportType, profile?: UserProfile | null,
): ChainStep[] {
  const prevLoc = asLocation(prev);
  if (!prevLoc) return [];
  const prevEnd = prev.endTime || addMinutes(taskStart(prev), prev.durationMinutes || 60);
  const travel = travelMinutesFor(prev, mode, profile); // symmetric estimate back home
  const leave = addMinutes(prevEnd, 5);
  const arriveHome = addMinutes(leave, travel);
  const start = taskStart(t);
  const spare = Math.max(0, timeToMinutes(start) - timeToMinutes(arriveHome));
  const steps: ChainStep[] = [
    { time: prevEnd, icon: '🏁', labelEn: `${prev.text} ends`, labelHe: `${prev.text} מסתיים`, kind: 'normal' },
    { time: leave, icon: MODE_ICON[mode], labelEn: `${MODE_EN[mode]} → home`, labelHe: `${MODE_HE[mode]} → הביתה`, noteEn: `${travel} min`, noteHe: `${travel} דק'`, kind: 'highlight' },
    { time: arriveHome, icon: '🏠', labelEn: 'Arrive home', labelHe: 'הגעה הביתה', noteEn: spare ? `${spare} min to spare` : undefined, noteHe: spare ? `${spare} דק' רזרבה` : undefined, kind: 'normal' },
  ];
  if (spare >= 20) {
    steps.push({ time: subtractMinutes(start, 15), icon: '☕', labelEn: 'Break + set up', labelHe: 'הפסקה והתארגנות', noteEn: '15 min', noteHe: "15 דק'", kind: 'normal' });
  }
  steps.push({ time: start, icon: '📚', labelEn: `${t.text} starts`, labelHe: `${t.text} מתחיל`, noteEn: 'on time ✓', noteHe: 'בזמן ✓', kind: 'success' });
  return steps;
}
