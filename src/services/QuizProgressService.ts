/**
 * QuizProgressService — save/load/clear resumable MBTI quiz progress.
 *
 * Offline-first (AsyncStorage), with best-effort cloud sync to the Supabase
 * `personality_quiz` table when the user is signed in. This is what lets the
 * user answer a section of 5, stop, and continue later — on the same device
 * (AsyncStorage) or another (Supabase) — and is the shared personality memory
 * the WhatsApp bot will read in the Phase 2 DB-unification.
 *
 * Mirrors the storage pattern in TaskStorage.ts: the local cache is the source
 * of truth for the UI; the cloud write never blocks or breaks the flow.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { QuizProgress } from '../types';
import { isSupabaseConfigured } from './supabaseClient';
import { fetchQuizProgress, upsertQuizProgress } from './supabaseRepo';

/** AsyncStorage key for the local working copy of quiz progress. */
const QUIZ_PROGRESS_KEY = 'lumi.quizProgress.v1';

/** True when we have a real signed-in Supabase user (not the 'local' fallback). */
function isCloudUser(userId?: string): boolean {
  return !!userId && userId !== 'local' && isSupabaseConfigured;
}

async function readLocal(): Promise<QuizProgress | null> {
  try {
    const raw = await AsyncStorage.getItem(QUIZ_PROGRESS_KEY);
    return raw ? (JSON.parse(raw) as QuizProgress) : null;
  } catch {
    return null;
  }
}

async function writeLocal(progress: QuizProgress): Promise<void> {
  try {
    await AsyncStorage.setItem(QUIZ_PROGRESS_KEY, JSON.stringify(progress));
  } catch (e) {
    console.warn('[QuizProgress] local write failed', e);
  }
}

/**
 * Load saved progress. Prefers the cloud copy (cross-device) when signed in and
 * mirrors it into the local cache; otherwise returns the local cache. Null means
 * the user hasn't started the quiz.
 */
export async function loadProgress(userId?: string): Promise<QuizProgress | null> {
  if (isCloudUser(userId)) {
    try {
      const cloud = await fetchQuizProgress(userId!);
      if (cloud) {
        await writeLocal(cloud);
        return cloud;
      }
    } catch (e) {
      console.warn('[QuizProgress] cloud load failed, falling back to local', e);
    }
  }
  return readLocal();
}

/**
 * Persist progress locally (always) and to the cloud (best-effort). Call after
 * every answer and at each section checkpoint. A fresh save overwrites the cloud
 * row, so it also serves to reset progress on a retake.
 */
export async function saveProgress(userId: string | undefined, progress: QuizProgress): Promise<void> {
  await writeLocal(progress);
  if (isCloudUser(userId)) {
    try {
      await upsertQuizProgress(userId!, progress);
    } catch (e) {
      console.warn('[QuizProgress] cloud save failed (kept locally)', e);
    }
  }
}

/**
 * Clear the local working copy (used by "retake"). The cloud row is left intact
 * as the last completed record until the retake writes fresh progress over it.
 */
export async function clearProgress(): Promise<void> {
  try {
    await AsyncStorage.removeItem(QUIZ_PROGRESS_KEY);
  } catch (e) {
    console.warn('[QuizProgress] local clear failed', e);
  }
}
