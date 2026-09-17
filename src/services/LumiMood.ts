/**
 * LumiMood — tiny app-wide event bus for the avatar's mood: screens emit
 * ('celebrate' on task completion, 'wave' on greetings) and every mounted
 * Lumi (hero on Today, floating companion elsewhere) reacts in sync.
 * Talking is NOT routed here — it stays TTS-driven via SpeechService.
 * Dependencies: none (pure). Consumed by LumiCompanion, TodaySchedule,
 * MyTasks.
 */
export type LumiMoodEvent = 'celebrate' | 'wave';

type Listener = (mood: LumiMoodEvent) => void;
const listeners = new Set<Listener>();

/** Subscribe to mood events; returns unsubscribe. */
export function onLumiMood(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Fire a mood event to every mounted avatar. */
export function emitLumiMood(mood: LumiMoodEvent): void {
  listeners.forEach((l) => {
    try { l(mood); } catch { /* never break the caller */ }
  });
}
