/**
 * voiceActivity — when has she finished speaking?
 *
 * The recorder reports a loudness level (dBFS, about -160 to 0) every ~120 ms.
 * This decides, from those numbers alone, when to stop recording:
 *
 *   - after she has spoken and then been quiet for SILENCE_MS  → stop, send it
 *   - if she never spoke within NO_SPEECH_MS                   → stop, send nothing
 *   - at MAX_MS whatever happens                                → stop, send it
 *
 * The threshold is RELATIVE to the room, not a fixed dB value. A kitchen with
 * the fan on and a quiet bedroom differ by 20 dB, and a fixed "speech is above
 * -40" either never triggers in one or always triggers in the other. So the
 * quietest reading so far is the floor, and speech is anything clearly above it.
 *
 * "Send nothing" matters: Whisper given silence invents a polite sentence
 * ("תודה רבה", "Thanks for watching"), and that would become a task. When no
 * level ever rose above the room, there is nothing to transcribe and the sheet
 * says "I didn't hear anything" instead.
 *
 * When the device reports no levels at all (metering unsupported), nothing here
 * can decide — only MAX_MS stops it, and she taps to finish. Pure: no timers,
 * no I/O; the caller passes `now`.
 */

export const VAD = {
  /** Nothing is judged before this much has been heard. */
  FLOOR_MS: 400,
  /** Speech = this far above the room's floor. */
  SPEECH_ABOVE_FLOOR_DB: 12,
  /** Quiet = back within this distance of the floor. */
  QUIET_ABOVE_FLOOR_DB: 6,
  /** Quiet this long after speech ends the recording (CLAUDE.md: ~1.5 s). */
  SILENCE_MS: 1600,
  /** Nobody spoke in this long: stop, and say so. */
  NO_SPEECH_MS: 8000,
  /**
   * A recording this loud is never "nobody spoke", even if it is flat: that is
   * someone talking without a breath, and cutting her off is worse than
   * waiting for her tap.
   */
  LOUD_DB: -35,
  /** Hard cap: a spoken task is seconds, not minutes. */
  MAX_MS: 60000,
  /** Levels at or below this are the recorder's "no signal", not a room. */
  SILENT_DB: -100,
  /** Bottom of the range the UI draws. */
  UI_FLOOR_DB: -60,
} as const;

export type VadStopReason = 'silence_after_speech' | 'no_speech' | 'max_length';

/**
 * Every usable reading so far. A spoken task is seconds; even the 60 s cap is
 * ~500 readings, so keeping them all is cheap — and it is what makes the
 * "she started talking at once" case right (see stepVad).
 */
export interface VadState {
  startedAt: number;
  times: number[];
  dbs: number[];
  /** Whether the device has reported any level at all. */
  metered: boolean;
  speechSeen: boolean;
}

export interface VadDecision {
  stop: boolean;
  reason?: VadStopReason;
  /** 0..1 for the waveform. */
  level: number;
}

export function initVad(now: number): VadState {
  return { startedAt: now, times: [], dbs: [], metered: false, speechSeen: false };
}

function toLevel(db: number | undefined): number {
  if (db === undefined || !Number.isFinite(db)) return 0;
  const clamped = Math.max(VAD.UI_FLOOR_DB, Math.min(0, db));
  return (clamped - VAD.UI_FLOOR_DB) / -VAD.UI_FLOOR_DB;
}

/**
 * One level reading → the next state, and whether to stop.
 *
 * The floor is the QUIETEST reading so far, re-evaluated every tick, and
 * "speech" is judged against it retroactively. That is deliberate: when she
 * starts talking the instant the sheet opens, the first readings ARE her voice,
 * and a floor frozen after 400 ms would define her voice as silence — every
 * word after that would sit "at the floor" and the recording would end as
 * "nobody spoke". Once a real pause arrives the floor drops, and everything she
 * said before it becomes speech, as it was.
 */
export function stepVad(
  prev: VadState,
  meteringDb: number | undefined,
  now: number,
): { state: VadState; decision: VadDecision } {
  const elapsed = now - prev.startedAt;
  const level = toLevel(meteringDb);
  const usable = meteringDb !== undefined && Number.isFinite(meteringDb) && meteringDb > VAD.SILENT_DB;
  const state: VadState = usable
    ? { ...prev, metered: true, times: [...prev.times, now], dbs: [...prev.dbs, meteringDb as number] }
    : { ...prev };

  if (elapsed >= VAD.MAX_MS) {
    return { state, decision: { stop: true, reason: 'max_length', level } };
  }
  if (!state.metered) {
    // No levels from this device: nothing to decide on. She taps to finish.
    return { state, decision: { stop: false, level } };
  }
  if (elapsed < VAD.FLOOR_MS) {
    return { state, decision: { stop: false, level } };
  }

  const floor = Math.min(...state.dbs);
  let firstSpeech = -1;
  for (let i = 0; i < state.dbs.length; i += 1) {
    if (state.dbs[i] >= floor + VAD.SPEECH_ABOVE_FLOOR_DB) { firstSpeech = i; break; }
  }
  state.speechSeen = firstSpeech >= 0;

  if (state.speechSeen) {
    // The last moment she was audibly there — a word, or trailing off.
    let lastVoiceAt = state.times[firstSpeech];
    for (let i = state.dbs.length - 1; i > firstSpeech; i -= 1) {
      if (state.dbs[i] >= floor + VAD.QUIET_ABOVE_FLOOR_DB) { lastVoiceAt = state.times[i]; break; }
    }
    if (now - lastVoiceAt >= VAD.SILENCE_MS) {
      return { state, decision: { stop: true, reason: 'silence_after_speech', level } };
    }
    return { state, decision: { stop: false, level } };
  }

  if (elapsed >= VAD.NO_SPEECH_MS && Math.max(...state.dbs) < VAD.LOUD_DB) {
    return { state, decision: { stop: true, reason: 'no_speech', level } };
  }
  return { state, decision: { stop: false, level } };
}

/**
 * Was there anything worth transcribing? False only when levels WERE measured
 * and none rose above the room — an unmetered recording gets the benefit of
 * the doubt and is sent.
 */
export function heardSpeech(state: VadState): boolean {
  return !state.metered || state.speechSeen;
}
