/**
 * RoutineOriginStore — her answers to "home first, or straight to the routine?"
 * (questions/kinds/routineOrigin). Key → 'direct' | 'home', kept on the phone only:
 * the answer is a plan for one day, not something Meira learns about her.
 * Old days are dropped so the blob does not grow forever.
 */
import AsyncStorage from './EncryptedStorage';
import type { RoutineOriginChoice } from '../utils/routineOrigin';

export const ROUTINE_ORIGIN_STORE_KEY = 'lumi.routineOrigin.v1';
const KEEP = 60;

type Blob = Record<string, RoutineOriginChoice>;

/** A throw means "could not read" — never the same value as "no answers yet" (rule 1). */
export async function readRoutineOrigins(): Promise<Blob> {
  const raw = await AsyncStorage.getItem(ROUTINE_ORIGIN_STORE_KEY);
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  return parsed && typeof parsed === 'object' ? (parsed as Blob) : {};
}

export async function saveRoutineOrigin(key: string, choice: RoutineOriginChoice): Promise<void> {
  const all = await readRoutineOrigins();
  const next: Blob = { ...all, [key]: choice };
  // Keys read routineOrigin:<date>:… so a plain sort is a date sort.
  const keys = Object.keys(next).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - KEEP))) delete next[k];
  await AsyncStorage.setItem(ROUTINE_ORIGIN_STORE_KEY, JSON.stringify(next));
}
