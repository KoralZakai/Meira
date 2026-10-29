/**
 * ChatMic — the chat's 🎤, on the same Whisper path as the main mic.
 *
 * The chat used Android's own recogniser (expo-speech-recognition): ONE
 * language per session, pinned to the UI language, and it stopped at the first
 * pause — so "תעזרי לי לחזור הביתה" said into an English UI, or a two-part
 * sentence, came back wrong or cut. Koral, 7.10: "move the chat mic to
 * Whisper too". This records the whole utterance, decides "done" from the
 * level (useVoiceCapture), and hands the text back once.
 *
 * Its own component on purpose: the recorder reports a level several times a
 * second, and that re-render belongs to this button, not to the whole chat.
 * Every failure is said in words (captureErrorText), never a silent no-op.
 */
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { ActivityIndicator, StyleProp, StyleSheet, Text, TouchableOpacity, ViewStyle } from 'react-native';
import { BRAND } from '../constants/theme';
import { CaptureOutcome, CapturePhase, captureErrorText, useVoiceCapture } from '../hooks/useVoiceCapture';
import { buildVoiceHint } from '../services/VoicePlanFlow';
import { stopSpeaking } from '../services/SpeechService';
import { joinParts, looksUnfinished, MAX_CONTINUATIONS } from '../utils/unfinishedUtterance';

export interface ChatMicHandle {
  /** Start listening (You → "Tell me" opens the chat already listening). */
  start: () => void;
  /** Throw away what is being recorded (she typed and sent instead). */
  cancel: () => void;
}

interface Props {
  he: boolean;
  /** What she said, transcribed. */
  onText: (text: string) => void;
  /** Why there is no text, in words naming the fix. */
  onError: (message: string) => void;
  /** listening / transcribing / idle — for the input's placeholder. */
  onPhase?: (phase: CapturePhase) => void;
  style?: StyleProp<ViewStyle>;
  activeStyle?: StyleProp<ViewStyle>;
}

const ChatMic = forwardRef<ChatMicHandle, Props>(function ChatMic(
  { he, onText, onError, onPhase, style, activeStyle }, ref,
) {
  // A sentence cut at a thinking pause ("…אני ביום שני בזומבה, ב...", 29.10)
  // is not sent: the mic listens again and the parts are joined. Nothing more
  // said (or a second cut) → what she said so far is sent, never lost.
  const sofar = useRef('');
  const rounds = useRef(0);
  const again = useRef<() => void>(() => {});
  const onDone = useCallback((outcome: CaptureOutcome) => {
    if (outcome.ok) {
      const text = joinParts(sofar.current, outcome.text);
      if (looksUnfinished(text) && rounds.current < MAX_CONTINUATIONS) {
        sofar.current = text;
        rounds.current += 1;
        setTimeout(() => again.current(), 0);
        return;
      }
      sofar.current = '';
      rounds.current = 0;
      onText(text);
      return;
    }
    const kept = sofar.current;
    sofar.current = '';
    rounds.current = 0;
    if (kept && outcome.error !== 'cancelled') {
      onText(kept);
      return;
    }
    if (outcome.error !== 'cancelled') onError(captureErrorText(outcome.error, he));
  }, [he, onText, onError]);

  const capture = useVoiceCapture({ onDone, hint: buildVoiceHint });
  again.current = () => { void capture.start(); };

  useEffect(() => { onPhase?.(capture.phase); }, [capture.phase, onPhase]);

  const start = useCallback(() => {
    // Her turn: Meira stops talking, or Whisper writes down Meira's own voice.
    sofar.current = '';
    rounds.current = 0;
    stopSpeaking();
    void capture.start();
  }, [capture]);

  useImperativeHandle(ref, () => ({ start, cancel: capture.cancel }), [start, capture.cancel]);

  const listening = capture.phase === 'listening';
  const busy = capture.phase === 'transcribing' || capture.phase === 'starting';
  // The level pulses the button while she talks, so she can see it hears her.
  const pulse = listening ? { transform: [{ scale: 1 + Math.min(capture.level, 1) * 0.25 }] } : null;

  return (
    <TouchableOpacity
      style={[style, listening && activeStyle, pulse]}
      onPress={() => (listening ? capture.stop() : busy ? undefined : start())}
      accessibilityLabel={listening ? (he ? 'סיימתי לדבר' : 'Done talking') : (he ? 'דברי' : 'Talk')}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
    >
      {busy ? <ActivityIndicator color={BRAND.sunGold} size="small" />
        : <Text style={styles.icon}>{listening ? '🔴' : '🎤'}</Text>}
    </TouchableOpacity>
  );
});

const styles = StyleSheet.create({
  icon: { fontSize: 18 },
});

export default ChatMic;
