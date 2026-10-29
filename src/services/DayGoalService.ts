/**
 * DayGoalService — today's "most important thing", kept on this phone.
 * One record, replaced each day; utils/dayGoal decides what it means.
 */
import AsyncStorage from './EncryptedStorage';
import { DayGoal } from '../utils/dayGoal';

const KEY = 'meira.dayGoal';

export async function loadDayGoal(): Promise<{ goal: DayGoal | null; error?: string }> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return { goal: raw ? JSON.parse(raw) : null };
  } catch (e) {
    console.warn('[DayGoal] could not read today\'s goal', e);
    return { goal: null, error: String((e as Error)?.message || e) };
  }
}

export async function saveDayGoal(goal: DayGoal | null): Promise<void> {
  if (goal) await AsyncStorage.setItem(KEY, JSON.stringify(goal));
  else await AsyncStorage.removeItem(KEY);
  console.warn(`[DayGoal] ${goal ? `set for ${goal.date}: ${goal.taskId ? 'task' : 'own words'}${goal.done ? ', done' : ''}` : 'cleared'}`);
}
