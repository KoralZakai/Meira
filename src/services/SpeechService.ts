/**
 * SpeechService — STT (expo-speech-recognition; unavailable in Expo Go →
 * TextInput fallback) + TTS (expo-speech, SHORT responses only) + transcript
 * preprocessing (filler removal, Hebrew/English place-name corrections).
 *
 * Dependencies: expo-speech, utils/fuzzyMatch (correctPlaceName).
 * preprocessTranscript is consumed by LLMService before the agent runs.
 */
import * as Speech from 'expo-speech';
import { AppLanguage } from '../types/models';
import { correctPlaceName } from '../utils/fuzzyMatch';

let speechRecognitionModule: any = null;
let sttInitErrorMessage = '';

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pkg = require('expo-speech-recognition');
  speechRecognitionModule = pkg.ExpoSpeechRecognitionModule;
} catch (error) {
  console.log('[STT] expo-speech-recognition not available in this build:', error);
  sttInitErrorMessage = String(error);
}

type SpeechRecognitionCallbacks = {
  onStart?: () => void | Promise<void>;
  onEnd?: () => void | Promise<void>;
  onResult?: (transcript: string, isFinal: boolean) => void | Promise<void>;
  onError?: (error: string, message?: string) => void | Promise<void>;
};

let recognitionListeners: Array<{ remove: () => void }> = [];

function runRecognitionCallback(
  label: string,
  callback: (() => void | Promise<void>) | undefined,
  reportError?: (error: string, message?: string) => void | Promise<void>,
) {
  if (!callback) {
    return;
  }

  try {
    const result = callback();
    if (result && typeof result.catch === 'function') {
      result.catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[STT] ${label} callback promise rejected:`, message);

        if (reportError) {
          try {
            const reportResult = reportError('callback-failed', message);
            if (reportResult && typeof reportResult.catch === 'function') {
              reportResult.catch((reportErr) => {
                console.warn('[STT] onError callback failed:', reportErr);
              });
            }
          } catch (reportErr) {
            console.warn('[STT] onError callback sync failed:', reportErr);
          }
        }
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[STT] ${label} callback sync error:`, message);

    if (reportError) {
      try {
        reportError('callback-failed', message);
      } catch (reportErr) {
        console.warn('[STT] onError callback failed:', reportErr);
      }
    }
  }
}

function clearRecognitionListeners() {
  recognitionListeners.forEach((sub) => sub.remove());
  recognitionListeners = [];
}

/** True only in an EAS build with expo-speech-recognition present (Expo Go -> false). */
export function isSpeechRecognitionAvailable(): boolean {
  if (!speechRecognitionModule?.isRecognitionAvailable) {
    return false;
  }
  try {
    return Boolean(speechRecognitionModule.isRecognitionAvailable());
  } catch (error) {
    console.log('[STT] isRecognitionAvailable check failed:', error);
    return false;
  }
}

/** User-facing reason STT is unavailable, for the TextInput fallback UI. */
export function getSpeechRecognitionUnavailableReason(): string {
  if (speechRecognitionModule) {
    return '';
  }
  if (sttInitErrorMessage.includes("Cannot find native module 'ExpoSpeechRecognition'")) {
    return 'Native STT module is not in this app build. Rebuild and reinstall the Android app.';
  }
  if (sttInitErrorMessage.includes("Cannot find module 'expo-speech-recognition'")) {
    return 'JavaScript STT package is missing at runtime. Reinstall dependencies and rebuild app.';
  }
  return sttInitErrorMessage || 'STT module is unavailable in this runtime.';
}

/** Wire result/error/end callbacks; returns a cleanup function. */
export function setupSpeechRecognitionCallbacks(callbacks: SpeechRecognitionCallbacks): () => void {
  if (!speechRecognitionModule?.addListener) {
    console.log('[STT] Listener setup skipped: module unavailable.');
    return () => undefined;
  }

  clearRecognitionListeners();

  recognitionListeners.push(
    speechRecognitionModule.addListener('start', () => {
      console.log('[STT] start event');
      runRecognitionCallback('start', callbacks.onStart, callbacks.onError);
    }),
  );

  recognitionListeners.push(
    speechRecognitionModule.addListener('end', () => {
      console.log('[STT] end event');
      runRecognitionCallback('end', callbacks.onEnd, callbacks.onError);
    }),
  );

  recognitionListeners.push(
    speechRecognitionModule.addListener('result', (event: any) => {
      const transcript = event?.results?.[0]?.transcript ?? '';
      const isFinal = Boolean(event?.isFinal);
      console.log('[STT] result event:', { transcript, isFinal, raw: event });
      runRecognitionCallback(
        'result',
        callbacks.onResult ? () => callbacks.onResult?.(transcript, isFinal) : undefined,
        callbacks.onError,
      );
    }),
  );

  recognitionListeners.push(
    speechRecognitionModule.addListener('error', (event: any) => {
      const code = String(event?.error ?? 'unknown');
      const message = event?.message ? String(event.message) : undefined;
      console.log('[STT] error event:', { code, message, raw: event });
      runRecognitionCallback(
        'error',
        callbacks.onError ? () => callbacks.onError?.(code, message) : undefined,
      );
    }),
  );

  return () => {
    clearRecognitionListeners();
  };
}

/** Begin listening (he-IL handles mixed Hebrew/English); false if unavailable. */
export async function startSpeechToText(language: AppLanguage): Promise<boolean> {
  if (!speechRecognitionModule) {
    console.log('[STT] start skipped: module unavailable in current runtime.');
    return false;
  }

  const lang = language === 'he' ? 'he-IL' : 'en-US';

  try {
    if (speechRecognitionModule.supportsOnDeviceRecognition) {
      const supportsOnDevice = Boolean(speechRecognitionModule.supportsOnDeviceRecognition());
      console.log('[STT] supportsOnDeviceRecognition:', supportsOnDevice);
    }

    const permissions = await speechRecognitionModule.requestPermissionsAsync();
    console.log('[STT] permission result:', permissions);

    if (!permissions?.granted) {
      console.log('[STT] permission denied, cannot start recognition.');
      return false;
    }

    // requiresOnDeviceRecognition was true and the service was pinned to
    // com.google.android.as (Android System Intelligence). That forces the
    // ON-DEVICE model, which is markedly weaker in Hebrew than Google's cloud
    // recogniser — and on many devices the he-IL on-device pack is not even
    // installed, so recognition degraded or failed with no message. Letting
    // Android pick the default service restores cloud recognition.
    speechRecognitionModule.start({
      lang,
      interimResults: true,
      continuous: false,
      maxAlternatives: 1,
    });
    console.log('[STT] start called with options:', {
      lang, interimResults: true, continuous: false, onDevice: false,
    });
    return true;
  } catch (error) {
    console.log('[STT] startSpeechToText failed:', error);
    return false;
  }
}

/** Stop the recognizer if it's listening. */
export function stopSpeechToText(): void {
  if (!speechRecognitionModule?.stop) {
    console.log('[STT] stop skipped: module unavailable.');
    return;
  }
  try {
    speechRecognitionModule.stop();
    console.log('[STT] stop called');
  } catch (error) {
    console.log('[STT] stopSpeechToText failed:', error);
  }
}

// TTS speaking-state listeners. These used to drive the avatar's talking
// animation; the avatar is gone, but callers still use them to show that Lumi
// is speaking.
type SpeakingListener = (speaking: boolean) => void;
const speakingListeners = new Set<SpeakingListener>();

/** Subscribe to TTS start/stop. Returns unsubscribe. */
export function subscribeSpeaking(listener: SpeakingListener): () => void {
  speakingListeners.add(listener);
  return () => speakingListeners.delete(listener);
}

function emitSpeaking(speaking: boolean) {
  speakingListeners.forEach((l) => {
    try { l(speaking); } catch { /* listener errors never break TTS */ }
  });
}

const HEBREW_LETTER = /[א-ת]/;

/**
 * Which voice should read THIS text.
 *
 * It used to follow the UI language, so a Hebrew reply in an English UI was
 * read letter-by-letter by the English voice (and the reverse). The text knows
 * its own language: any Hebrew letter means the Hebrew voice, which also copes
 * with the English names inside a Hebrew sentence ("Meira", "Ceva").
 */
export function voiceLanguageFor(text: string, fallback: AppLanguage): 'he-IL' | 'en-US' {
  if (HEBREW_LETTER.test(text)) return 'he-IL';
  if (/[A-Za-z]/.test(text)) return 'en-US';
  return fallback === 'he' ? 'he-IL' : 'en-US';
}

let hebrewVoice: { status: 'available' | 'missing' | 'unknown'; id?: string } | null = null;

/**
 * Is a Hebrew voice installed on this phone?
 *
 * Android reports Hebrew under both codes — `he` and the legacy `iw` that
 * Java's Locale still produces — so both are accepted. 'missing' is worth
 * telling her about: without it every Hebrew reply is silence or gibberish,
 * and the fix (Settings → Text-to-speech → install Hebrew) is hers to make.
 * 'unknown' means the engine would not list its voices; we try anyway.
 */
export async function hebrewVoiceStatus(): Promise<'available' | 'missing' | 'unknown'> {
  if (hebrewVoice) return hebrewVoice.status;
  try {
    const voices = await Speech.getAvailableVoicesAsync();
    if (!voices?.length) {
      hebrewVoice = { status: 'unknown' };
    } else {
      const he = voices.find((v) => /^(he|iw)([-_]|$)/i.test(v.language || ''));
      hebrewVoice = he ? { status: 'available', id: he.identifier } : { status: 'missing' };
      if (!he) console.warn('[TTS] no Hebrew voice installed — Hebrew replies cannot be spoken');
    }
  } catch (error) {
    console.warn('[TTS] could not list voices', error);
    hebrewVoice = { status: 'unknown' };
  }
  return hebrewVoice.status;
}

/** TTS via expo-speech — SHORT texts only per CLAUDE.md speech rules. */
export async function speak(text: string, language: AppLanguage): Promise<void> {
  const voice = voiceLanguageFor(text, language);
  const voiceId = voice === 'he-IL' && (await hebrewVoiceStatus()) === 'available'
    ? hebrewVoice?.id
    : undefined;

  return new Promise<void>((resolve) => {
    const done = () => {
      emitSpeaking(false);
      resolve();
    };
    try {
      emitSpeaking(true);
      Speech.speak(text, {
        language: voice,
        ...(voiceId ? { voice: voiceId } : {}),
        pitch: 1,
        rate: 0.95,
        onDone: done,
        onStopped: done,
        onError: done,
      });
    } catch (error) {
      console.log('[MOCK] Speech unavailable:', error);
      done();
    }
  });
}

/** Cancel any in-progress TTS. */
export function stopSpeaking() {
  try {
    Speech.stop();
  } catch (error) {
    console.log('[MOCK] Speech stop unavailable:', error);
  }
  emitSpeaking(false);
}

const FILLER_WORDS = ['um', 'uh', 'like', 'you know', 'so', 'כאילו', 'אממ', 'אה'];

/** Remove fillers + fix place names before parsing; consumed by LLMService/TaskParser. */
export const preprocessTranscript = (text: string, language: AppLanguage): string => {
  let result = text;
  FILLER_WORDS.forEach(fw => {
    result = result.replace(new RegExp(`\\b${fw}\\b`, 'gi'), '');
  });
  result = correctPlaceName(result);
  result = result
    .replace(/\bעשר\b/g, '10').replace(/\bאחת עשרה\b/g, '11')
    .replace(/\bשתיים עשרה\b/g, '12').replace(/\bשמונה\b/g, '8')
    .replace(/\bתשע\b/g, '9').replace(/\bשבע\b/g, '7')
    .replace(/\bשש\b/g, '6').replace(/\bחמש\b/g, '5');
  return result.trim();
};
