/**
 * DayEvents — "the day on screen just changed", for whoever is showing it.
 *
 * The voice sheet lives in the tab bar, above every screen, and plans the day
 * from there. The Today screen reloads on focus — which does not fire when she
 * is already looking at it. Without this the plan would be saved correctly and
 * the timeline would go on showing the old day: the same bug CalendarAutoSync
 * had one layer up (see onCalendarSync).
 *
 * Dependencies: none. Emitted by VoicePlanFlow; consumed by TodaySchedule.
 */
import type { VoicePlanReport } from '../utils/voicePlan';

export interface DayPlannedEvent {
  date: string;
  report: VoicePlanReport;
  headline: string;
  problems: string[];
}

let listeners: Array<(e: DayPlannedEvent) => void> = [];

export function onDayPlanned(fn: (e: DayPlannedEvent) => void): () => void {
  listeners.push(fn);
  return () => { listeners = listeners.filter((l) => l !== fn); };
}

/**
 * "Something on this date changed — redraw it." Emitted when a task that
 * arrived from the chat has just been routed (ArrivedTaskPlanner), so the
 * route shows up while she is looking, not on her next visit.
 */
let changeListeners: Array<(date: string) => void> = [];

export function onDayChanged(fn: (date: string) => void): () => void {
  changeListeners.push(fn);
  return () => { changeListeners = changeListeners.filter((l) => l !== fn); };
}

export function emitDayChanged(date: string): void {
  for (const l of changeListeners) {
    try {
      l(date);
    } catch (err) {
      console.warn('[DayEvents] a change listener failed', err);
    }
  }
}

export function emitDayPlanned(e: DayPlannedEvent): void {
  for (const l of listeners) {
    try {
      l(e);
    } catch (err) {
      console.warn('[DayEvents] a listener failed', err);
    }
  }
}
