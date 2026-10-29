/**
 * MorningAlarmService — her choices for the morning ⏰ (on/off, another hour),
 * kept on this phone, and the one call the pill makes.
 *
 * The decision is utils/morningAlarm (pure); setting Clock is
 * AlarmPlanner.syncWakeAlarms, which reads these choices. This file only
 * stores them and, when she turns one off or moves it, takes the old one out
 * of Clock before the sync sets the new one.
 */
import AsyncStorage from './EncryptedStorage';
import { getAllTasks } from './TaskStorage';
import { loadProfile } from './UserProfileStorage';
import { normalizeProfile } from '../utils/profileShape';
import { wakeInputs } from '../utils/alarmPlan';
import { MorningChoice, MorningChoices, MorningPlan, nextMorningAlarm } from '../utils/morningAlarm';

const KEY = 'meira.morningAlarmChoices';

function dayKey(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export async function loadMorningChoices(): Promise<MorningChoices> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.warn('[MorningAlarm] could not read her choices', e);
    return {};
  }
}

async function saveMorningChoices(all: MorningChoices): Promise<void> {
  const yesterday = dayKey(-1);
  const keep = Object.fromEntries(Object.entries(all).filter(([d]) => d >= yesterday));
  await AsyncStorage.setItem(KEY, JSON.stringify(keep));
}

/** The pill's answer right now, from the same inputs the Clock sync uses. */
export async function currentMorningAlarm(): Promise<{ plan: MorningPlan | null; error?: string }> {
  try {
    const [tasks, profile, choices] = await Promise.all([
      getAllTasks(), loadProfile().catch(() => null), loadMorningChoices()]);
    return { plan: nextMorningAlarm(tasks, wakeInputs(normalizeProfile(profile)), choices) };
  } catch (e) {
    console.warn('[MorningAlarm] could not work out the next alarm', e);
    return { plan: null, error: String((e as Error)?.message || e) };
  }
}

/**
 * Record her choice for `date`, then let the sync put Clock in step: it takes
 * out any Meira alarm for that morning that is no longer the one, and sets the
 * new one. Imported lazily — AlarmPlanner imports this file for the choices.
 */
export async function chooseMorningAlarm(date: string, choice: MorningChoice): Promise<{ dismissed: string[] }> {
  const all = await loadMorningChoices();
  all[date] = { ...all[date], ...choice };
  await saveMorningChoices(all);
  console.warn(`[MorningAlarm] her choice for ${date}: ${JSON.stringify(all[date])}`);
  const { syncWakeAlarms } = await import('./AlarmPlanner');
  const res = await syncWakeAlarms({ announce: false, dismiss: true });
  return { dismissed: res?.dismissed ?? [] };
}
