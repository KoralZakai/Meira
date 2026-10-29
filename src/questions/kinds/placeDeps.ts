/**
 * placeDeps — the real wiring of the 'place' question (kinds/place.ts).
 *
 * Everything place.ts needs from the outside, in one file: the queue on the
 * phone (encrypted AsyncStorage), Places Text Search through the server, the
 * task store, the known-places memory, the server's record of the answer, and
 * the travel chain.
 *
 * GoogleSync is imported LAZILY, at the moment of the re-plan: GoogleSync asks
 * the question (its "unplaced" branch) and the question re-plans through
 * GoogleSync, so a static import in both directions would be a cycle that
 * loads one half-built. The same reason TaskStorage imports its heavy
 * neighbours with `await import(...)`.
 */
import AsyncStorage from '../../services/EncryptedStorage';  // AES-256-GCM at rest (7.10)
import { answerQuestion } from '../../services/LumiServer';
import { learnPlace } from '../../services/KnownPlacesStore';
import { placeTextSearch } from '../../services/RoutePlanner';
import { getAllTasks, getSettings, updateTask } from '../../services/TaskStorage';
import type { MeiraQuestion } from '../types';
import {
  ApplyDeps, EnqueueDeps, forgetPlace, PlaceQueue, PlaceStore, placeQuestionsFrom, questionOf,
} from './place';

const KEY = 'lumi.placeQuestions.v1';

export const placeStore: PlaceStore = {
  async load(): Promise<PlaceQueue> {
    try {
      const raw = await AsyncStorage.getItem(KEY);
      if (!raw) return { items: {}, tried: {} };
      const parsed = JSON.parse(raw);
      return {
        items: parsed && typeof parsed.items === 'object' && parsed.items ? parsed.items : {},
        tried: parsed && typeof parsed.tried === 'object' && parsed.tried ? parsed.tried : {},
      };
    } catch (e) {
      // Unreadable is not "no questions": say so (rule 2). The queue starts over.
      console.warn('[Questions] place queue unreadable; starting empty', e);
      return { items: {}, tried: {} };
    }
  },
  async save(queue: PlaceQueue): Promise<void> {
    await AsyncStorage.setItem(KEY, JSON.stringify(queue));
  },
};

/** The record for the server. The wire takes a 'place' kind (server/questions_store.py). */
const send: ApplyDeps['send'] = async (input) => {
  const r = await answerQuestion(input);
  return r.ok ? { ok: true } : { ok: false, reason: r.reason };
};

export function enqueueDeps(isAnswered: EnqueueDeps['isAnswered']): EnqueueDeps {
  return {
    store: placeStore,
    // placeTextSearch THROWS on a refusal, unlike RoutePlanner.searchPlaces,
    // which turns every failure into [] — the same empty list for "no such
    // place" and "the search broke" (rule 1).
    search: (query) => placeTextSearch(query),
    isAnswered,
  };
}

export const applyDeps: ApplyDeps = {
  async findTask(taskId) {
    const task = (await getAllTasks()).find((t) => t.id === taskId);
    return task ? { id: task.id, text: task.text, date: task.date } : null;
  },
  patchLocation(taskId, build) {
    // The current location is read INSIDE the task lock, so a route that
    // landed a moment ago is not overwritten by a stale copy.
    return updateTask(taskId, (task) => ({ ...task, location: build(task.location) as never }));
  },
  learn: (activity, address, coords) => learnPlace(activity, address, coords),
  async replan(date, taskId) {
    const [{ ensureTravelChain }, settings] = await Promise.all([import('../../services/GoogleSync'), getSettings()]);
    return ensureTravelChain(date, settings.language === 'he' ? 'he' : 'en', { forceTaskId: taskId });
  },
  forget: (taskId) => forgetPlace(placeStore, taskId),
  send,
};

/** The queued questions that are still true; the rest are dropped from the queue. */
export async function detectPlaces(today: string): Promise<MeiraQuestion[]> {
  const queue = await placeStore.load();
  if (!Object.keys(queue.items).length) return [];
  let tasks: Awaited<ReturnType<typeof getAllTasks>>;
  try {
    tasks = await getAllTasks();
  } catch (e) {
    console.warn('[Questions] tasks unreadable; place questions kept as they are', e);
    return Object.values(queue.items).map(questionOf);
  }
  // An empty list is "not loaded yet" as often as "nothing left": do not prune on it.
  if (!tasks.length) return Object.values(queue.items).map(questionOf);
  const { questions, drop } = placeQuestionsFrom(queue, tasks, today);
  for (const id of drop) {
    console.warn('[Questions] a place question no longer applies and was dropped:', id);
    await forgetPlace(placeStore, id).catch((e) => console.warn('[Questions] place question not dropped', e));
  }
  return questions;
}

export { send as sendPlaceAnswer };
