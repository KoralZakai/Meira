/**
 * routineOriginDeps — the real wiring of the 'routineOrigin' question (kinds/routineOrigin.ts):
 * her profile's home, the task store, her routines (the same rows Today draws, with her
 * "Not today" skips), the answer store, and the way-home pass.
 *
 * ReturnHomeTasks is imported LAZILY at the re-plan, like the other kinds' GoogleSync: it reads
 * the answers this question writes, and a static import both ways would be a cycle.
 */
import AsyncStorage from '../../services/EncryptedStorage';
import { loadRoutines } from '../../services/GapFillService';
import { readRoutineOrigins, saveRoutineOrigin } from '../../services/RoutineOriginStore';
import { getSettings, getTasksForDate } from '../../services/TaskStorage';
import { loadProfile } from '../../services/UserProfileStorage';
import { routineRowsFor } from '../../utils/routineRows';
import type { MeiraQuestion } from '../types';
import { ApplyDeps, DetectDeps, detectRoutineOrigin as detect } from './routineOrigin';

/** The key TodaySchedule keeps "Not today" under: { [date]: routineKey[] }. */
export const ROUTINE_SKIPS_KEY = 'lumi.routineSkips.v1';

async function skipsFor(date: string): Promise<string[]> {
  const raw = await AsyncStorage.getItem(ROUTINE_SKIPS_KEY);
  return raw ? (JSON.parse(raw)?.[date] ?? []) : [];
}

export const detectDeps: DetectDeps = {
  async home() {
    const p: any = await loadProfile();
    return p?.homeAddress || null;
  },
  tasksFor: (date) => getTasksForDate(date),
  async rowsFor(date, nowHHMM) {
    const [routines, tasks, skipped] = await Promise.all([loadRoutines(), getTasksForDate(date), skipsFor(date)]);
    return routineRowsFor(routines, date, tasks, { now: nowHHMM, skipped });
  },
  answers: () => readRoutineOrigins(),
};

export const applyDeps: ApplyDeps = {
  async skipToday(date, routineKey) {
    const raw = await AsyncStorage.getItem(ROUTINE_SKIPS_KEY);
    const all = raw ? JSON.parse(raw) : {};
    const next = { ...all, [date]: [...new Set([...(all[date] ?? []), routineKey])] };
    await AsyncStorage.setItem(ROUTINE_SKIPS_KEY, JSON.stringify(next));
  },
  save: (key, choice) => saveRoutineOrigin(key, choice),
  read: () => readRoutineOrigins(),
  async replan() {
    const [{ ensureReturnHomeTasks }, settings] = await Promise.all([import('../../services/ReturnHomeTasks'), getSettings()]);
    return ensureReturnHomeTasks(settings.language === 'he' ? 'he' : 'en');
  },
};

export function detectRoutineOrigin(): Promise<MeiraQuestion[]> {
  return detect(detectDeps);
}
