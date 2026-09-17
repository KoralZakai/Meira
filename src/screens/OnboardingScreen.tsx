/**
 * OnboardingScreen — conversational onboarding that fills the UserProfile
 * (name, home, transport, routine) by voice or text.
 * Dependencies: LumiOnboardingAgent (LLM extraction), SpeechService,
 * MorningRoutineService, UserProfileStorage.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ONBOARDING_STRINGS } from '../constants/strings';
import { BRAND, FONTS, RADIUS, SHADOWS } from '../constants/theme';
import LumiWordmark from '../components/LumiWordmark';
import { useLumiContext } from '../hooks/useLumiContext';
import { OnboardingExtraction, UserProfile } from '../models/UserProfile';
import { extractFromAnswer } from '../services/LumiOnboardingAgent';
import { calculateMorningRoutineMinutes } from '../services/MorningRoutineService';
import { saveProfile } from '../services/UserProfileStorage';
import {
  getSpeechRecognitionUnavailableReason,
  isSpeechRecognitionAvailable,
  setupSpeechRecognitionCallbacks,
  speak,
  startSpeechToText,
  stopSpeaking,
  stopSpeechToText,
} from '../services/SpeechService';
import { RootStackParamList } from '../types/navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'Onboarding'>;

type MessageRole = 'lumi' | 'user';

type ChatMessage = {
  id: string;
  role: MessageRole;
  text: string;
};

type ProfileDraft = Partial<{
  name: string;
  transportMode: 'car' | 'foot' | 'bicycle' | 'transit';
  homeAddress: string;
  // Asked for in the opening question — so they must survive the draft, or
  // Lumi collects an answer and quietly throws it away.
  workAddress: string;
  routinesNotes: string;
  morningHabits: Array<{ habit: string; estimatedMinutes: number }>;
  totalMorningMinutesEstimate: number;
  workStartTime: string;
  sleepTime: string;
}>;

/**
 * Tappable answers for the field Lumi is still missing.
 *
 * Voice and typing both ask the user to compose a sentence. For most of these
 * fields the real answer is one of four things, and choosing beats composing —
 * especially for the person this app is for, on a phone, in a hurry. The chip
 * text is sent as the answer, so it goes through exactly the same extraction
 * as anything spoken or typed; nothing here is a separate code path.
 *
 * Free text always remains available: the chips are a shortcut, never a menu
 * you are trapped in.
 */
function quickAnswers(field: string | undefined, he: boolean): string[] {
  switch (field) {
    case 'transportMode':
      return he
        ? ['🚌 בתחבורה ציבורית', '🚗 ברכב', '🚶 ברגל', '🚲 באופניים']
        : ['🚌 public transport', '🚗 by car', '🚶 on foot', '🚲 by bike'];
    case 'morningHabitsOrTotal':
      return he
        ? ['20 דקות', '30 דקות', '45 דקות', 'שעה']
        : ['20 minutes', '30 minutes', '45 minutes', 'an hour'];
    case 'workStartTime':
      return he
        ? ['ב-07:00', 'ב-08:00', 'ב-09:00', 'שעות גמישות']
        : ['at 07:00', 'at 08:00', 'at 09:00', 'flexible hours'];
    case 'sleepTime':
      return he
        ? ['22:00', '23:00', '00:00', 'אחרי חצות']
        : ['22:00', '23:00', '00:00', 'after midnight'];
    default:
      return [];
  }
}

function AnimatedBubble({ message }: { message: ChatMessage }) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(10)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 300,
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 0,
        duration: 300,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [opacity, translateY]);

  const isLumi = message.role === 'lumi';

  return (
    <Animated.View
      style={[
        styles.messageRow,
        isLumi ? styles.leftRow : styles.rightRow,
        { opacity, transform: [{ translateY }] },
      ]}
    >
      <View style={[styles.messageBubble, isLumi ? styles.lumiBubble : styles.userBubble]}>
        <Text style={styles.messageText}>{message.text}</Text>
      </View>
    </Animated.View>
  );
}

function TypingIndicator() {
  const dots = [useRef(new Animated.Value(0.25)).current, useRef(new Animated.Value(0.25)).current, useRef(new Animated.Value(0.25)).current];

  useEffect(() => {
    const animations = dots.map((dot, index) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(index * 120),
          Animated.timing(dot, {
            toValue: 1,
            duration: 260,
            useNativeDriver: true,
          }),
          Animated.timing(dot, {
            toValue: 0.25,
            duration: 260,
            useNativeDriver: true,
          }),
        ]),
      ));

    animations.forEach((a) => a.start());
    return () => {
      animations.forEach((a) => a.stop());
    };
  }, [dots]);

  return (
    <View style={[styles.messageRow, styles.leftRow]}>
      <View style={[styles.messageBubble, styles.lumiBubble, styles.typingBubble]}>
        <Text style={styles.typingLabel}>{ONBOARDING_STRINGS.typingLabel}</Text>
        <View style={styles.typingDotsRow}>
          {dots.map((dot, i) => (
            <Animated.View key={`dot-${i}`} style={[styles.dot, { opacity: dot }]} />
          ))}
        </View>
      </View>
    </View>
  );
}

export default function OnboardingScreen({ navigation }: Props) {
  const { checkInState } = useLumiContext();
  const language = checkInState.settings.language;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [profile, setProfile] = useState<ProfileDraft>({});
  const [isListening, setIsListening] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [liveTranscript, setLiveTranscript] = useState('');
  const [completedProfile, setCompletedProfile] = useState<UserProfile | null>(null);

  const lastFinalTranscriptRef = useRef('');
  const profileRef = useRef<ProfileDraft>({});

  const micPulse = useRef(new Animated.Value(1)).current;
  // Typing is a first-class way in, not a fallback for when the mic fails.
  const [typed, setTyped] = useState('');
  // The field Lumi is waiting on — drives the quick answers under the question.
  const [awaitingField, setAwaitingField] = useState<string | undefined>('name');

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(micPulse, {
          toValue: 1.08,
          duration: 700,
          useNativeDriver: true,
        }),
        Animated.timing(micPulse, {
          toValue: 1,
          duration: 700,
          useNativeDriver: true,
        }),
      ]),
    );

    if (isListening) {
      loop.start();
    }

    return () => loop.stop();
  }, [isListening, micPulse]);

  const appendMessage = useCallback((role: MessageRole, text: string) => {
    setMessages((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role,
        text,
      },
    ]);
  }, []);

  const toFinalProfile = useCallback((draft: ProfileDraft): UserProfile | null => {
    if (!draft.name || !draft.transportMode || !draft.workStartTime || !draft.sleepTime) {
      return null;
    }

    const now = new Date().toISOString();
    const habits = (draft.morningHabits ?? [])
      .filter((item) => item.habit.trim() && item.estimatedMinutes > 0)
      .map((item) => ({
        habit: item.habit.trim(),
        estimatedMinutes: Math.round(item.estimatedMinutes),
      }));

    const totalFromHabits = habits.reduce((sum, item) => sum + item.estimatedMinutes, 0);
    const roughTotal = draft.totalMorningMinutesEstimate ?? totalFromHabits;

    if (!roughTotal || roughTotal <= 0) {
      return null;
    }

    const normalizedHabits = habits.length
      ? habits
      : [
        {
          habit: ONBOARDING_STRINGS.defaultHabitLabel,
          estimatedMinutes: roughTotal,
        },
      ];

    const normalizedTotal = calculateMorningRoutineMinutes({
      name: draft.name,
      homeAddress: draft.homeAddress ?? '',
      homeLatLng: null,
      transportMode: draft.transportMode,
      morningHabits: normalizedHabits,
      totalMorningRoutineMinutes: roughTotal,
      workStartTime: draft.workStartTime,
      sleepTime: draft.sleepTime,
      onboardingComplete: true,
      createdAt: now,
      lastUpdated: now,
    });

    return {
      name: draft.name,
      homeAddress: draft.homeAddress ?? '',
      homeLatLng: null,
      workAddress: draft.workAddress,
      routinesNotes: draft.routinesNotes,
      transportMode: draft.transportMode,
      morningHabits: normalizedHabits,
      totalMorningRoutineMinutes: normalizedTotal,
      workStartTime: draft.workStartTime,
      sleepTime: draft.sleepTime,
      onboardingComplete: true,
      createdAt: now,
      lastUpdated: now,
    };
  }, []);

  const mergeExtraction = useCallback((extraction: OnboardingExtraction) => {
    setProfile((prev) => {
      const next: ProfileDraft = {
        ...prev,
        ...(extraction.name ? { name: extraction.name } : {}),
        ...(extraction.transportMode ? { transportMode: extraction.transportMode } : {}),
        ...(extraction.homeAddress ? { homeAddress: extraction.homeAddress } : {}),
        ...(extraction.workStartTime ? { workStartTime: extraction.workStartTime } : {}),
        ...(extraction.sleepTime ? { sleepTime: extraction.sleepTime } : {}),
        ...(typeof extraction.totalMorningMinutesEstimate === 'number'
          ? { totalMorningMinutesEstimate: extraction.totalMorningMinutesEstimate }
          : {}),
        ...(extraction.morningHabits && extraction.morningHabits.length
          ? { morningHabits: extraction.morningHabits }
          : {}),
      };
      profileRef.current = next;
      return next;
    });
  }, []);

  const openingText = useMemo(
    () => (language === 'he'
      ? ONBOARDING_STRINGS.openingMessageHe
      : ONBOARDING_STRINGS.openingMessage),
    [language],
  );

  /**
   * One answer from the user, however it arrived.
   *
   * This lived inside the speech callback, which made the microphone the only
   * way into onboarding: no STT (Expo Go, a denied permission, a noisy room,
   * or simply not wanting to talk on a bus) meant no profile, and no profile
   * means Lumi cannot plan anything at all. The first conversation is where
   * Lumi learns who she is talking to — it must not depend on a working mic.
   */
  const handleAnswer = useCallback(async (raw: string) => {
    const normalized = raw.trim();
    if (!normalized) return;
    setLiveTranscript('');
    setTyped('');
    setLiveTranscript('');
    appendMessage('user', normalized);

    setIsThinking(true);
    const extraction = await extractFromAnswer(normalized, profileRef.current);
    mergeExtraction(extraction);
    setAwaitingField(extraction.missingFields?.[0]);

    if (!extraction.followUpQuestion && !extraction.isComplete) {
      appendMessage('lumi', ONBOARDING_STRINGS.agentRetry);
      await speak(ONBOARDING_STRINGS.agentRetry, language);
      setIsThinking(false);
      return;
    }

    if (!extraction.isComplete) {
      const nextQuestion = extraction.followUpQuestion || ONBOARDING_STRINGS.fallbackFollowUp;
      appendMessage('lumi', nextQuestion);
      await speak(nextQuestion, language);
      setIsThinking(false);
      return;
    }

    const finalDraft: ProfileDraft = {
      ...profileRef.current,
      ...(extraction.name ? { name: extraction.name } : {}),
      ...(extraction.transportMode ? { transportMode: extraction.transportMode } : {}),
      ...(extraction.homeAddress ? { homeAddress: extraction.homeAddress } : {}),
      ...(extraction.workStartTime ? { workStartTime: extraction.workStartTime } : {}),
      ...(extraction.sleepTime ? { sleepTime: extraction.sleepTime } : {}),
      ...(typeof extraction.totalMorningMinutesEstimate === 'number'
        ? { totalMorningMinutesEstimate: extraction.totalMorningMinutesEstimate }
        : {}),
      ...(extraction.morningHabits && extraction.morningHabits.length
        ? { morningHabits: extraction.morningHabits }
        : {}),
    };

    const finalProfile = toFinalProfile(finalDraft);
    if (!finalProfile) {
      appendMessage('lumi', ONBOARDING_STRINGS.agentRetry);
      await speak(ONBOARDING_STRINGS.agentRetry, language);
      setIsThinking(false);
      return;
    }

    await saveProfile(finalProfile);
    setCompletedProfile(finalProfile);
    const completion = ONBOARDING_STRINGS.completionMessage(finalProfile.name);
    appendMessage('lumi', completion);
    await speak(completion, language);
    setIsThinking(false);
  }, [appendMessage, language, mergeExtraction, toFinalProfile]);

  useEffect(() => {
    appendMessage('lumi', openingText);
    speak(openingText, language);

    const teardown = setupSpeechRecognitionCallbacks({
      onStart: () => {
        setIsListening(true);
        setLiveTranscript('');
      },
      onEnd: () => setIsListening(false),
      onResult: async (recognizedText, isFinal) => {
        const normalized = recognizedText.trim();
        if (!normalized) {
          return;
        }

        setLiveTranscript(normalized);

        if (!isFinal) {
          return;
        }

        if (lastFinalTranscriptRef.current === normalized) {
          return;
        }

        lastFinalTranscriptRef.current = normalized;
        await handleAnswer(normalized);
      },
      onError: async () => {
        setIsListening(false);
        setIsThinking(false);
        appendMessage('lumi', ONBOARDING_STRINGS.sttRetry);
        await speak(ONBOARDING_STRINGS.sttRetry, language);
      },
    });

    return () => {
      teardown();
      stopSpeechToText();
      stopSpeaking();
    };
  }, [appendMessage, handleAnswer, language, openingText]);

  const onPressMic = useCallback(async () => {
    if (isListening) {
      stopSpeechToText();
      return;
    }

    if (!isSpeechRecognitionAvailable()) {
      appendMessage('lumi', getSpeechRecognitionUnavailableReason() || ONBOARDING_STRINGS.sttRetry);
      return;
    }

    const started = await startSpeechToText(language);
    if (!started) {
      appendMessage('lumi', ONBOARDING_STRINGS.sttRetry);
    }
  }, [appendMessage, isListening, language]);

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={[StyleSheet.absoluteFill, { backgroundColor: BRAND.cream }]} />
      {completedProfile ? (
        <View style={styles.summaryWrap}>
          <View style={styles.header}>
            <LumiWordmark size={34} style={{ marginTop: 12 }} />
            <Text style={styles.headerTitle}>
              {completedProfile.name && completedProfile.name.trim().length >= 2
                ? `${completedProfile.name}'s Profile`
                : 'Your Profile'}
            </Text>
            <Text style={styles.headerHint}>{ONBOARDING_STRINGS.sensitiveHomeHint}</Text>
          </View>

          <ScrollView contentContainerStyle={styles.summaryContent}>
            <View style={styles.summaryCard}>
              <Text style={styles.summaryLabel}>Travel mode</Text>
              <Text style={styles.summaryValue}>{completedProfile.transportMode === 'transit' ? 'Public transportation' : completedProfile.transportMode}</Text>
            </View>
            <View style={styles.summaryCard}>
              <Text style={styles.summaryLabel}>Morning routine time</Text>
              <Text style={styles.summaryValue}>{completedProfile.totalMorningRoutineMinutes} minutes</Text>
            </View>
            <View style={styles.summaryCard}>
              <Text style={styles.summaryLabel}>Work start</Text>
              <Text style={styles.summaryValue}>{completedProfile.workStartTime}</Text>
            </View>
            <View style={styles.summaryCard}>
              <Text style={styles.summaryLabel}>Sleep time</Text>
              <Text style={styles.summaryValue}>{completedProfile.sleepTime}</Text>
            </View>
            <View style={styles.summaryCard}>
              <Text style={styles.summaryLabel}>Habits</Text>
              <Text style={styles.summaryValue}>{completedProfile.morningHabits.map((item) => `${item.habit} ${item.estimatedMinutes}m`).join(', ')}</Text>
            </View>
          </ScrollView>

          <View style={styles.summaryActions}>
            <Pressable style={styles.summarySecondaryButton} onPress={() => navigation.replace('Home')}>
              <Text style={styles.summarySecondaryText}>Done</Text>
            </Pressable>
            <Pressable style={styles.summaryPrimaryButton} onPress={() => navigation.replace('ProfileEdit')}>
              <Text style={styles.summaryPrimaryText}>Edit by voice</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <>
      <View style={styles.header}>
        <LumiWordmark size={34} style={{ marginTop: 12 }} />
        <Text style={styles.headerTitle}>{ONBOARDING_STRINGS.title}</Text>
        <Text style={styles.headerHint}>{ONBOARDING_STRINGS.sensitiveHomeHint}</Text>
      </View>

      <ScrollView contentContainerStyle={styles.chatContent}>
        {messages.map((message) => (
          <AnimatedBubble key={message.id} message={message} />
        ))}

        {Boolean(liveTranscript) && (
          <View style={[styles.messageRow, styles.rightRow]}>
            <View style={[styles.messageBubble, styles.userBubble, styles.liveBubble]}>
              <Text style={styles.messageText}>{liveTranscript}</Text>
            </View>
          </View>
        )}

        {isThinking && <TypingIndicator />}
      </ScrollView>

      {/* Quick answers for whatever Lumi is still missing. They send the same
          text a person would have said, so there is one path in, not three. */}
      {quickAnswers(awaitingField, language === 'he').length > 0 && !isThinking ? (
        <View style={styles.chipsRow}>
          {quickAnswers(awaitingField, language === 'he').map((chip) => (
            <Pressable
              key={chip}
              style={styles.chip}
              onPress={() => handleAnswer(chip)}
            >
              <Text style={styles.chipText}>{chip}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      <View style={styles.bottomBar}>
        {/* Either way in. The mic is bigger because speaking is faster for a
            long answer, but the field is always there — an onboarding that
            only listens is an onboarding some people can never finish. */}
        <TextInput
          style={styles.typeInput}
          value={typed}
          onChangeText={setTyped}
          placeholder={language === 'he' ? ONBOARDING_STRINGS.typeHintHe : ONBOARDING_STRINGS.typeHint}
          placeholderTextColor={BRAND.inkFaint}
          editable={!isThinking}
          multiline
          onSubmitEditing={() => handleAnswer(typed)}
          returnKeyType="send"
        />
        {typed.trim() ? (
          <Pressable
            style={styles.sendButton}
            onPress={() => handleAnswer(typed)}
            disabled={isThinking}
          >
            <Text style={styles.sendIcon}>➤</Text>
          </Pressable>
        ) : null}
        <Pressable onPress={onPressMic} disabled={isThinking}>
          <Animated.View
            style={[
              styles.micButton,
              isListening && styles.micButtonActive,
              isThinking && styles.micButtonDisabled,
              { transform: [{ scale: isListening ? micPulse : 1 }] },
            ]}
          >
            {isThinking ? <ActivityIndicator color={BRAND.warmInk} /> : <Text style={styles.micIcon}>{ONBOARDING_STRINGS.micIcon}</Text>}
          </Animated.View>
        </Pressable>
      </View>
        </>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: BRAND.cream,
  },
  header: {
    alignItems: 'center',
    paddingTop: 16,
    paddingHorizontal: 18,
    paddingBottom: 8,
  },
  headerTitle: {
    marginTop: 10,
    fontSize: 22,
    fontFamily: FONTS.display,
    color: BRAND.warmInk,
  },
  headerHint: {
    marginTop: 4,
    color: BRAND.inkSoft,
    fontSize: 13,
    fontFamily: FONTS.body,
  },
  chatContent: {
    paddingHorizontal: 14,
    paddingBottom: 18,
  },
  messageRow: {
    width: '100%',
    marginBottom: 10,
  },
  leftRow: {
    alignItems: 'flex-start',
  },
  rightRow: {
    alignItems: 'flex-end',
  },
  messageBubble: {
    maxWidth: '84%',
    borderRadius: 18,
    paddingHorizontal: 13,
    paddingVertical: 11,
  },
  lumiBubble: {
    backgroundColor: BRAND.creamCard,
    borderTopLeftRadius: 6,
    ...SHADOWS.card,
  },
  userBubble: {
    backgroundColor: BRAND.sunGold,
    borderTopRightRadius: 6,
  },
  liveBubble: {
    borderStyle: 'dashed',
    borderWidth: 1,
    borderColor: BRAND.amber,
  },
  messageText: {
    color: BRAND.warmInk,
    fontSize: 15,
    lineHeight: 21,
    fontFamily: FONTS.bodySemi,
  },
  typingBubble: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  typingLabel: {
    color: BRAND.warmInk,
    fontSize: 14,
    fontFamily: FONTS.bodySemi,
  },
  typingDotsRow: {
    flexDirection: 'row',
    gap: 6,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: BRAND.inkSoft,
  },
  summaryWrap: {
    flex: 1,
  },
  summaryContent: {
    paddingHorizontal: 16,
    paddingBottom: 22,
  },
  summaryCard: {
    backgroundColor: BRAND.creamCard,
    borderRadius: RADIUS.card,
    padding: 14,
    borderWidth: 1,
    borderColor: BRAND.line,
    marginBottom: 10,
    ...SHADOWS.card,
  },
  summaryLabel: {
    color: BRAND.inkSoft,
    fontSize: 12,
    fontFamily: FONTS.bodyBold,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  summaryValue: {
    color: BRAND.warmInk,
    fontSize: 15,
    lineHeight: 22,
    fontFamily: FONTS.bodySemi,
  },
  summaryActions: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingBottom: 18,
  },
  summarySecondaryButton: {
    flex: 1,
    backgroundColor: BRAND.honey,
    borderRadius: RADIUS.button,
    paddingVertical: 14,
    alignItems: 'center',
  },
  summarySecondaryText: {
    color: BRAND.warmInk,
    fontFamily: FONTS.bodyBold,
  },
  summaryPrimaryButton: {
    flex: 1,
    backgroundColor: BRAND.sunGold,
    borderRadius: RADIUS.button,
    paddingVertical: 14,
    alignItems: 'center',
    ...SHADOWS.button,
  },
  summaryPrimaryText: {
    color: BRAND.warmInk,
    fontFamily: FONTS.bodyBold,
  },
  bottomBar: {
    paddingBottom: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipsRow: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 8,
    paddingHorizontal: 16, paddingBottom: 8,
  },
  chip: {
    backgroundColor: BRAND.creamCard, borderRadius: 999,
    borderWidth: 1, borderColor: BRAND.sunGold,
    paddingHorizontal: 14, paddingVertical: 9,
  },
  chipText: { fontFamily: FONTS.bodyHeavy, fontSize: 13.5, color: BRAND.warmInk },
  typeInput: {
    flex: 1, minHeight: 46, maxHeight: 110,
    backgroundColor: BRAND.creamCard, borderRadius: 22,
    borderWidth: 1, borderColor: BRAND.line,
    paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12,
    fontFamily: FONTS.body, fontSize: 15, color: BRAND.warmInk,
  },
  sendButton: {
    width: 46, height: 46, borderRadius: 23, backgroundColor: BRAND.warmInk,
    alignItems: 'center', justifyContent: 'center',
  },
  sendIcon: { color: BRAND.honey, fontSize: 18 },
  micButton: {
    width: 82,
    height: 82,
    borderRadius: 41,
    backgroundColor: BRAND.sunGold,
    alignItems: 'center',
    justifyContent: 'center',
    ...SHADOWS.button,
  },
  micButtonActive: {
    backgroundColor: BRAND.amber,
  },
  micButtonDisabled: {
    opacity: 0.8,
  },
  micIcon: {
    fontSize: 30,
  },
});
