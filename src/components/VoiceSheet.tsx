/**
 * VoiceSheet — tap the mic, say your day, see it planned.
 *
 * Opens from the tab-bar mic on any screen and starts listening AT ONCE — no
 * greeting, no button to press first (CLAUDE.md: "NO speech from Lumi — mic
 * starts immediately"). While she talks, the calendar is re-read and her
 * position is taken (VoicePlanFlow.beginVoiceContext), so the seconds she
 * spends speaking are not wasted.
 *
 *   listening → transcribing → understanding → planning → done
 *
 * Every step can fail, and each failure has its own sentence and its own way
 * out ("try again", "type it instead") — never a spinner that just stops.
 * "done" closes by itself only when nothing went wrong; if something did, the
 * lines stay until she has read them (silent-state rule 3).
 *
 * Dependencies: hooks/useVoiceCapture, services/VoicePlanFlow, SpeechService,
 * TaskStorage (settings), WaveformAnimation. Consumed by CustomTabBar.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Modal, Pressable, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BRAND, FONTS, RADIUS, SHADOWS } from '../constants/theme';
import { AppLanguage } from '../types/index';
import { CaptureOutcome, captureErrorText, useVoiceCapture } from '../hooks/useVoiceCapture';
import { VoiceContext, beginVoiceContext, buildVoiceHint, runVoicePlan } from '../services/VoicePlanFlow';
import { getSettings } from '../services/TaskStorage';
import { hebrewVoiceStatus, speak, voiceLanguageFor } from '../services/SpeechService';
import { describePlan, spokenLine } from '../utils/voicePlan';
import { WaveformAnimation } from './WaveformAnimation';

type Stage =
  | { kind: 'listening' }
  | { kind: 'transcribing' }
  | { kind: 'understanding'; transcript: string }
  | { kind: 'planning'; transcript: string }
  | { kind: 'done'; transcript: string; headline: string; problems: string[] }
  | { kind: 'error'; message: string; transcript?: string };

const AUTO_CLOSE_MS = 2600;

export default function VoiceSheet({
  onClose,
  onTypeInstead,
}: {
  /** `planned`: a plan was made, so the caller can show the day. */
  onClose: (planned?: boolean) => void;
  /** Open the chat, with whatever was heard already typed in. */
  onTypeInstead: (text?: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const [language, setLanguage] = useState<AppLanguage>('en');
  const [stage, setStage] = useState<Stage>({ kind: 'listening' });
  const [ttsNote, setTtsNote] = useState<string | null>(null);
  const ctx = useRef<VoiceContext | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  const he = language === 'he';

  const onDone = useCallback(async (outcome: CaptureOutcome) => {
    if (!alive.current) return;
    if (!outcome.ok) {
      if (outcome.error === 'cancelled') return;
      setStage({ kind: 'error', message: captureErrorText(outcome.error, he) });
      return;
    }
    const transcript = outcome.text;
    setStage({ kind: 'understanding', transcript });
    try {
      const report = await runVoicePlan(
        transcript,
        ctx.current ?? beginVoiceContext(language),
        language,
        (step) => {
          if (alive.current && step === 'planning') setStage({ kind: 'planning', transcript });
        },
      );
      if (!alive.current) return;
      // The outcome of THIS request: what was set, or Meira's question, or
      // the clash — her reply is read for questions and warnings in there.
      const { headline, problems } = describePlan(report, he, report.reply);
      setStage({ kind: 'done', transcript, headline, problems });
      const line = spokenLine(report, he, report.reply);
      if (voiceLanguageFor(line, language) === 'he-IL' && (await hebrewVoiceStatus()) === 'missing') {
        setTtsNote(he
          ? '🔇 אין קול עברי בטלפון — הגדרות › המרת טקסט לדיבור › התקנת עברית'
          : '🔇 No Hebrew voice on this phone — Settings › Text-to-speech › install Hebrew');
      } else {
        speak(line, language).catch(() => undefined);
      }
      if (!problems.length) {
        closeTimer.current = setTimeout(() => alive.current && onClose(true), AUTO_CLOSE_MS);
      }
    } catch (e) {
      console.warn('[VoiceSheet] planning failed', e);
      if (alive.current) {
        setStage({
          kind: 'error',
          transcript,
          message: he ? 'משהו נכשל בדרך — אפשר לפתוח בצ׳אט' : 'Something failed on the way — you can open it in chat',
        });
      }
    }
  }, [he, language, onClose]);

  const capture = useVoiceCapture({ onDone, hint: buildVoiceHint });

  const begin = useCallback(async () => {
    setTtsNote(null);
    setStage({ kind: 'listening' });
    const settings = await getSettings().catch(() => null);
    const lang: AppLanguage = settings?.language === 'he' ? 'he' : 'en';
    setLanguage(lang);
    ctx.current = beginVoiceContext(lang);
    await capture.start();
  }, [capture]);

  // Mounted only while open (CustomTabBar): the recorder hook polls its
  // status on a timer, and an always-mounted sheet would re-render the tab
  // bar several times a second for nothing. Opening = mounting = listening.
  useEffect(() => {
    alive.current = true;
    begin();
    return () => {
      alive.current = false;
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
    // Start once per opening, not on every render of the hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (capture.phase === 'transcribing') setStage({ kind: 'transcribing' });
  }, [capture.phase]);

  const close = (planned = false) => {
    alive.current = false;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    if (capture.phase === 'listening') capture.cancel();
    onClose(planned);
  };

  const seconds = Math.floor(capture.elapsedMs / 1000);
  const transcript = 'transcript' in stage ? stage.transcript : undefined;

  return (
    <Modal visible transparent animationType="slide" onRequestClose={() => close()}>
      <Pressable style={styles.backdrop} onPress={() => close(stage.kind === 'done')} accessibilityLabel={he ? 'סגירה' : 'Close'} />
      <View style={[styles.sheet, { paddingBottom: insets.bottom + 20 }]}>
        <View style={styles.grabber} />

        {stage.kind === 'listening' && (
          <View style={styles.center}>
            <Text style={styles.title}>{he ? 'מקשיבה… אפשר לדבר חופשי' : 'Listening… say it your way'}</Text>
            <Text style={styles.sub}>
              {he ? 'עברית, אנגלית או שתיהן' : 'Hebrew, English, or both'}
              {seconds > 0 ? ` · ${seconds}″` : ''}
            </Text>
            <View style={styles.wave}>
              <WaveformAnimation active={capture.phase === 'listening'} level={capture.level} />
            </View>
            <TouchableOpacity
              style={styles.doneBtn}
              onPress={capture.stop}
              accessibilityLabel={he ? 'סיימתי' : 'Done'}
              activeOpacity={0.85}
            >
              <Text style={styles.doneBtnText}>{he ? '✓ סיימתי' : '✓ Done'}</Text>
            </TouchableOpacity>
          </View>
        )}

        {(stage.kind === 'transcribing' || stage.kind === 'understanding' || stage.kind === 'planning') && (
          <View style={styles.center}>
            {transcript ? <Text style={styles.transcript} numberOfLines={4}>“{transcript}”</Text> : null}
            <ActivityIndicator color={BRAND.sunGold} size="large" style={{ marginVertical: 14 }} />
            <Text style={styles.title}>
              {stage.kind === 'transcribing'
                ? (he ? '✍️ כותבת…' : '✍️ Writing it down…')
                : stage.kind === 'understanding'
                  ? (he ? '🧠 מבינה ובודקת את היומן…' : '🧠 Understanding, checking your calendar…')
                  : (he ? '🗓️ משבצת את היום…' : '🗓️ Planning your day…')}
            </Text>
          </View>
        )}

        {stage.kind === 'done' && (
          <View>
            {stage.transcript ? (
              <Text style={styles.transcript} numberOfLines={3}>“{stage.transcript}”</Text>
            ) : null}
            <Text style={styles.headline}>{stage.headline}</Text>
            {stage.problems.map((p) => (
              <Text key={p} style={styles.problem}>{p}</Text>
            ))}
            {ttsNote ? <Text style={styles.problem}>{ttsNote}</Text> : null}
            <View style={styles.row}>
              <TouchableOpacity style={styles.secondary} onPress={begin} activeOpacity={0.85}>
                <Text style={styles.secondaryText}>{he ? '🎤 עוד' : '🎤 More'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.primary} onPress={() => close(true)} activeOpacity={0.85}>
                <Text style={styles.primaryText}>{he ? 'לראות את היום' : 'See my day'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {stage.kind === 'error' && (
          <View style={styles.center}>
            {stage.transcript ? (
              <Text style={styles.transcript} numberOfLines={3}>“{stage.transcript}”</Text>
            ) : null}
            <Text style={styles.errorText}>{stage.message}</Text>
            <View style={styles.row}>
              <TouchableOpacity
                style={styles.secondary}
                onPress={() => { close(); onTypeInstead(stage.transcript); }}
                activeOpacity={0.85}
              >
                <Text style={styles.secondaryText}>{he ? '⌨️ להקליד' : '⌨️ Type it'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.primary} onPress={begin} activeOpacity={0.85}>
                <Text style={styles.primaryText}>{he ? '🎤 שוב' : '🎤 Try again'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(40, 30, 10, 0.35)' },
  sheet: {
    backgroundColor: BRAND.creamCard,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 20,
    paddingTop: 10,
    minHeight: 300,
    ...SHADOWS.card,
  },
  grabber: {
    alignSelf: 'center', width: 44, height: 5, borderRadius: 3,
    backgroundColor: BRAND.line, marginBottom: 14,
  },
  center: { alignItems: 'center' },
  title: {
    fontFamily: FONTS.bodyHeavy, fontSize: 18, color: BRAND.warmInk, textAlign: 'center',
  },
  sub: { fontFamily: FONTS.bodySemi, fontSize: 13, color: BRAND.inkSoft, marginTop: 4 },
  wave: { height: 70, justifyContent: 'center', marginVertical: 18, alignSelf: 'stretch' },
  doneBtn: {
    backgroundColor: BRAND.sunGold, borderRadius: RADIUS.button,
    paddingHorizontal: 34, paddingVertical: 14, ...SHADOWS.button,
  },
  doneBtnText: { fontFamily: FONTS.bodyHeavy, fontSize: 16, color: BRAND.onGold },
  transcript: {
    fontFamily: FONTS.bodySemi, fontSize: 14, color: BRAND.inkSoft,
    textAlign: 'center', marginBottom: 8, lineHeight: 20,
  },
  headline: {
    fontFamily: FONTS.bodyHeavy, fontSize: 17, color: BRAND.warmInk,
    marginTop: 6, marginBottom: 10, lineHeight: 24,
  },
  problem: {
    fontFamily: FONTS.bodySemi, fontSize: 13.5, color: BRAND.inkSoft,
    marginBottom: 6, lineHeight: 19,
  },
  errorText: {
    fontFamily: FONTS.bodyBold, fontSize: 15, color: BRAND.danger,
    textAlign: 'center', marginVertical: 16, lineHeight: 21,
  },
  row: { flexDirection: 'row', gap: 10, marginTop: 14, alignSelf: 'stretch' },
  primary: {
    flex: 1, backgroundColor: BRAND.sunGold, borderRadius: RADIUS.button,
    paddingVertical: 13, alignItems: 'center',
  },
  primaryText: { fontFamily: FONTS.bodyHeavy, fontSize: 15, color: BRAND.onGold },
  secondary: {
    flex: 1, backgroundColor: BRAND.goldSoft, borderRadius: RADIUS.button,
    paddingVertical: 13, alignItems: 'center',
  },
  secondaryText: { fontFamily: FONTS.bodyBold, fontSize: 15, color: BRAND.goldInk },
});
