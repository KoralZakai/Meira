/**
 * tripOriginDeps — the real wiring of the 'tripOrigin' question
 * (kinds/tripOrigin.ts).
 *
 * Everything tripOrigin.ts needs from the outside, in one file: the clock,
 * the phone's last known position, the profile's home, the task store, the
 * stored day start, the reverse geocoder (the Today header's own label) and
 * the travel chain.
 *
 * GoogleSync is imported LAZILY, at the moment of the re-plan, for the reason
 * placeDeps.ts gives: GoogleSync reads the day start this question writes, and
 * a static import in both directions would be a cycle that loads one half-built.
 */
import { describeHere, getLastKnownLocation } from '../../services/LocationService';
import { clearDayStart, getDayStart, setDayStart } from '../../services/DayStartStore';
import { getAllTasks, getSettings, getTasksForDate } from '../../services/TaskStorage';
import { loadProfile } from '../../services/UserProfileStorage';
import type { MeiraQuestion } from '../types';
import { ApplyDeps, DetectDeps, detectTripOrigin as detect } from './tripOrigin';

/**
 * How old a position may be and still be "where she is". An hour: the question
 * is about the evening/morning around tomorrow's departure, and a person asleep
 * at the same address for three hours has not moved — whereas the 15 minutes
 * the live route uses would make the closed-app run (no fresh fix) go quiet.
 */
export const HERE_MAX_AGE_MS = 60 * 60 * 1000;

export const detectDeps: DetectDeps = {
  here: () => getLastKnownLocation(HERE_MAX_AGE_MS),
  async home() {
    const p: any = await loadProfile();
    if (!p) return null;
    const coords = p.homeLatLng
      ?? (p.homeLat != null && p.homeLng != null ? { lat: p.homeLat, lng: p.homeLng } : null);
    return { coords, address: p.homeAddress || undefined };
  },
  tasksFor: (date) => getTasksForDate(date),
  dayStart: (date) => getDayStart(date),
  // The label the Today header shows — cached by LocationService until she moves 150 m.
  labelOf: (point) => describeHere(point),
};

export const applyDeps: ApplyDeps = {
  async findTask(taskId) {
    const task = (await getAllTasks()).find((t) => t.id === taskId);
    return task ? { id: task.id, text: task.text, date: task.date } : null;
  },
  saveStart: (date, start) => setDayStart(date, start),
  readStart: (date) => getDayStart(date),
  clearStart: (date) => clearDayStart(date),
  async replan(date, taskId) {
    const [{ ensureTravelChain }, settings] = await Promise.all([import('../../services/GoogleSync'), getSettings()]);
    // reladder: the vehicle the ladder picked for the trip from HOME is not hers
    // to keep for the trip from somewhere else (GoogleSync.ensureTravelChain).
    return ensureTravelChain(date, settings.language === 'he' ? 'he' : 'en', { forceTaskId: taskId, reladder: true });
  },
};

/** The question for tomorrow, if it is worth asking now. `answered` = AskState.answered. */
export async function detectTripOrigin(answered: Record<string, unknown>): Promise<MeiraQuestion[]> {
  return (await detect(detectDeps, answered)).questions;
}
