/**
 * useVoiceCapture — record what she says, send it to Whisper, return the text.
 *
 * WHY THIS REPLACES THE OLD MIC
 *
 * The app used `expo-speech-recognition`, i.e. Android's own recogniser. Two
 * things made it bad at exactly what she does:
 *
 *   1. It recognises ONE language per session, and we pinned it to the UI
 *      language (`he-IL` or `en-US`). Hebrew spoken into an English UI came back
 *      as English-sounding nonsense; English names in a Hebrew sentence were
 *      mangled the other way.
 *   2. `continuous: false` — it stopped at the first pause, so a two-part
 *      sentence ("work on Meira today, and also study for Ceva") lost its
 *      second half.
 *
 * WhatsApp never had either problem: the whole voice note reaches Whisper on
 * the server with no language pinned. This hook gives the app that same path —
 * record the whole utterance, decide "done" from loudness (utils/voiceActivity),
 * upload once, get one transcript.
 *
 * Every outcome is typed (silent-state rule 1): "the mic is not allowed",
 * "nobody spoke", "no connection" and "the server has no STT key" each say
 * something different on screen.
 *
 * Dependencies: expo-audio, utils/voiceActivity, services/LumiServer
 * (transcribeAudio). Consumed by components/VoiceSheet.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  RecordingOptions,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { SttFailure, transcribeAudio } from '../services/LumiServer';
import { VadState, heardSpeech, initVad, stepVad } from '../utils/voiceActivity';

/**
 * Speech, not music: mono at 16 kHz is what Whisper resamples to anyway, and a
 * third of the upload of the stereo 44.1 kHz preset. Still AAC in MPEG-4
 * (`.m4a`), which the server names correctly for Groq.
 */
const OPTIONS: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  sampleRate: 16000,
  numberOfChannels: 1,
  bitRate: 48000,
  isMeteringEnabled: true,
  android: { ...RecordingPresets.HIGH_QUALITY.android, sampleRate: 16000 },
  ios: { ...RecordingPresets.HIGH_QUALITY.ios, sampleRate: 16000 },
};

/** How often the recorder reports a level. */
const STATUS_INTERVAL_MS = 120;

export type CapturePhase = 'idle' | 'starting' | 'listening' | 'transcribing';

export type CaptureError =
  | SttFailure
  | 'mic_denied'       // she declined the microphone permission
  | 'recorder_failed'  // the device would not record
  | 'nothing_heard'    // levels were measured and nobody spoke
  | 'cancelled';

export type CaptureOutcome =
  | { ok: true; text: string }
  | { ok: false; error: CaptureError; detail?: string };

export interface VoiceCapture {
  phase: CapturePhase;
  /** 0..1, for the waveform. */
  level: number;
  elapsedMs: number;
  start: () => Promise<void>;
  /** Finish now and transcribe what was said. */
  stop: () => void;
  /** Finish now and discard it. */
  cancel: () => void;
}

export function useVoiceCapture(opts: {
  onDone: (outcome: CaptureOutcome) => void;
  /** Vocabulary for Whisper, read when the upload starts. */
  hint?: () => string | Promise<string>;
}): VoiceCapture {
  const recorder = useAudioRecorder(OPTIONS);
  const status = useAudioRecorderState(recorder, STATUS_INTERVAL_MS);
  const [phase, setPhase] = useState<CapturePhase>('idle');
  const [level, setLevel] = useState(0);
  const vad = useRef<VadState | null>(null);
  const finishing = useRef(false);
  const phaseRef = useRef<CapturePhase>('idle');
  const onDone = useRef(opts.onDone);
  const hint = useRef(opts.hint);
  // Built while she talks, so the upload does not wait for it.
  const hintPending = useRef<Promise<string> | null>(null);
  onDone.current = opts.onDone;
  hint.current = opts.hint;

  const setBoth = (p: CapturePhase) => {
    phaseRef.current = p;
    setPhase(p);
  };

  const finish = useCallback(async (mode: 'upload' | 'cancel' | 'nothing') => {
    if (finishing.current || phaseRef.current !== 'listening') return;
    finishing.current = true;
    try {
      await recorder.stop();
    } catch (e) {
      console.warn('[VoiceCapture] stop failed', e);
    }
    // Hand the audio route back, or the spoken reply that follows plays
    // through the earpiece at call volume.
    setAudioModeAsync({ allowsRecording: false }).catch((e) =>
      console.warn('[VoiceCapture] could not reset audio mode', e));
    setLevel(0);

    if (mode === 'cancel') {
      setBoth('idle');
      onDone.current({ ok: false, error: 'cancelled' });
      return;
    }
    if (mode === 'nothing' || (vad.current && !heardSpeech(vad.current))) {
      setBoth('idle');
      onDone.current({ ok: false, error: 'nothing_heard' });
      return;
    }
    const uri = recorder.uri;
    if (!uri) {
      setBoth('idle');
      onDone.current({ ok: false, error: 'recorder_failed', detail: 'the recorder produced no file' });
      return;
    }

    setBoth('transcribing');
    let vocabulary = '';
    try {
      vocabulary = (await (hintPending.current ?? hint.current?.())) ?? '';
    } catch (e) {
      console.warn('[VoiceCapture] hint failed — transcribing without one', e);
    }
    hintPending.current = null;
    const res = await transcribeAudio(uri, vocabulary);
    setBoth('idle');
    onDone.current(res.ok ? { ok: true, text: res.text } : res);
  }, [recorder]);

  // Each level report: decide whether she has finished.
  useEffect(() => {
    if (phaseRef.current !== 'listening' || !vad.current || finishing.current) return;
    const { state, decision } = stepVad(vad.current, status.metering, Date.now());
    vad.current = state;
    setLevel(decision.level);
    if (decision.stop) {
      finish(decision.reason === 'no_speech' ? 'nothing' : 'upload');
    }
  }, [status.durationMillis, status.metering, finish]);

  const start = useCallback(async () => {
    if (phaseRef.current !== 'idle') return;
    setBoth('starting');
    try {
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) {
        setBoth('idle');
        onDone.current({ ok: false, error: 'mic_denied' });
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      vad.current = initVad(Date.now());
      finishing.current = false;
      hintPending.current = hint.current
        ? Promise.resolve(hint.current()).catch((e) => {
          console.warn('[VoiceCapture] hint failed — transcribing without one', e);
          return '';
        })
        : null;
      setBoth('listening');
    } catch (e) {
      console.warn('[VoiceCapture] could not start recording', e);
      setBoth('idle');
      onDone.current({ ok: false, error: 'recorder_failed', detail: String(e).slice(0, 120) });
    }
  }, [recorder]);

  // Leaving the screen mid-recording discards it rather than leaving the mic on.
  useEffect(() => () => {
    if (phaseRef.current === 'listening') {
      recorder.stop().catch(() => undefined);
    }
  }, [recorder]);

  return {
    phase,
    level,
    elapsedMs: phase === 'listening' ? status.durationMillis : 0,
    start,
    stop: () => { finish('upload'); },
    cancel: () => { finish('cancel'); },
  };
}

/** What to say for each failure — short, and naming the fix (rule 3). */
export function captureErrorText(error: CaptureError, he: boolean): string {
  const t: Record<CaptureError, [string, string]> = {
    mic_denied: ['אין הרשאה למיקרופון — אפשר בהגדרות האפליקציה', 'Microphone is off for Meira — allow it in app settings'],
    recorder_failed: ['ההקלטה לא הצליחה — נסי שוב', "Couldn't record — try again"],
    nothing_heard: ['לא שמעתי כלום — נסי שוב', "I didn't hear anything — try again"],
    no_speech: ['לא שמעתי מילים — נסי שוב', "I didn't catch any words — try again"],
    cancelled: ['', ''],
    no_server: ['הגרסה הזו לא מחוברת לשרת — צריך בנייה חדשה', 'This build has no server — it needs a rebuild'],
    signed_out: ['צריך להתחבר מחדש כדי שאשמע', 'Sign in again so I can listen'],
    offline: ['אין חיבור — אפשר להקליד ⌨️', 'No connection — type it instead ⌨️'],
    slow: ['השרת איטי כרגע ולא ענה בזמן — נסי שוב עוד רגע', 'The server was too slow to answer — try again in a moment'],
    stt_not_configured: ['זיהוי הדיבור בשרת לא מוגדר', "The server's speech recognition isn't set up"],
    provider_failed: ['שירות התמלול לא ענה — נסי שוב', "The transcription service didn't answer — try again"],
    rate_limited: ['יותר מדי הקלטות ברצף — רגע', 'Too many recordings in a row — one moment'],
    too_large: ['ההקלטה ארוכה מדי', 'That recording is too long'],
    server_error: ['השרת נכשל — נסי שוב', 'The server failed — try again'],
  };
  return t[error][he ? 0 : 1];
}
