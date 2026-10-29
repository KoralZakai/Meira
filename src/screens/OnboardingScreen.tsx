/**
 * OnboardingScreen — Meira's first meeting (8.10, Koral).
 *
 * Her picks from the mockup: the talking orb + a checklist. Meira speaks in
 * her own voice (Google Chirp 3 HD, services/NaturalVoice), the mic opens by
 * itself when she has finished (Whisper, components/ChatMic), "שמעתי: …" shows
 * what was heard (tap to fix it), and the details tick off as they arrive.
 * The server (POST /app/profile/extract) understands each answer, saves it
 * where Meira reads it, and names the ONE next thing still missing — she keeps
 * asking until everything is covered: the morning ("so about 40 minutes?"),
 * routines (where, which days, what time, how she gets there), work, home,
 * car, sleep. ✏️ types instead; ⏭ later saves what she has and asks again on
 * a later open.
 *
 * Opened by App.tsx on the first run after sign-in (rule 7: a meeting nothing
 * opens is not a feature), and from Profile → "start over".
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Animated, Easing, KeyboardAvoidingView, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import AsyncStorage from '../services/EncryptedStorage';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { BRAND, FONTS } from '../constants/theme';
import MeiraCoin from '../components/MeiraCoin';
import ChatMic, { ChatMicHandle } from '../components/ChatMic';
import { CapturePhase } from '../hooks/useVoiceCapture';
import { useLumiContext } from '../hooks/useLumiContext';
import { extractProfileAnswer } from '../services/LumiServer';
import { sayNatural, stopNatural } from '../services/NaturalVoice';
import { loadProfile, saveProfile } from '../services/UserProfileStorage';
import {
  MEETING_DRAFT_KEY, MeetingDraft, SavedMeeting, checkLine, checklist, doneLine, draftFromProfile, draftOf, fixRow,
  openingLine, resumeDraft, routineLines, savedSummary, toProfile, welcomeBackLine,
} from '../utils/firstMeeting';

async function readSavedMeeting(): Promise<SavedMeeting | null> {
  try {
    const raw = await AsyncStorage.getItem(MEETING_DRAFT_KEY);
    return raw ? (JSON.parse(raw) as SavedMeeting) : null;
  } catch (e) {
    console.warn('[FirstMeeting] the last conversation could not be read', e);
    return null;
  }
}
import { RootStackParamList } from '../types/navigation';
import { getTodayString } from '../utils/timeUtils';

type Props = NativeStackScreenProps<RootStackParamList, 'Onboarding'>;

/** ⏭ later: not asked again until this day has passed. */
export const FIRST_MEETING_SNOOZE_KEY = 'meira.firstMeeting.snoozedOn';

export default function OnboardingScreen({ navigation }: Props) {
  const { checkInState } = useLumiContext();
  const he = checkInState.settings.language === 'he';
  const lang = he ? 'he' : 'en';

  const [draft, setDraft] = useState<MeetingDraft>({});
  const draftRef = useRef<MeetingDraft>({});
  const savedLines = useRef<string[]>([]);          // routine lines this meeting last wrote
  const [line, setLine] = useState('');            // what Meira is saying / asked
  const [heard, setHeard] = useState('');          // "שמעתי: …"
  const [phase, setPhase] = useState<CapturePhase | 'speaking' | 'thinking'>('idle');
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState('');
  const [done, setDone] = useState(false);
  const asked = useRef('');                         // the question the answer is to
  const silences = useRef(0);
  const alive = useRef(true);
  const mic = useRef<ChatMicHandle>(null);
  const breathe = useRef(new Animated.Value(1)).current;

  // The orb breathes while she talks or listens — motion that means something.
  useEffect(() => {
    const on = phase === 'speaking' || phase === 'listening';
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(breathe, { toValue: 1.1, duration: 650, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      Animated.timing(breathe, { toValue: 1, duration: 650, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    ]));
    if (on) loop.start(); else breathe.setValue(1);
    return () => loop.stop();
  }, [phase, breathe]);

  /** Say it in her voice, then open the mic — never while she is still talking. */
  const ask = useCallback(async (text: string, listenAfter = true) => {
    setLine(text);
    asked.current = text;
    setPhase('speaking');
    await sayNatural(text, lang);
    if (!alive.current) return;
    setPhase('idle');
    if (listenAfter && !typing) mic.current?.start();
  }, [lang, typing]);

  useEffect(() => {
    alive.current = true;
    (async () => {
      const existing = await loadProfile().catch(() => null);
      const saved = await readSavedMeeting();
      savedLines.current = saved?.lines ?? [];
      const known = resumeDraft(draftFromProfile(existing as any), saved);
      draftRef.current = known;
      setDraft(known);
      const returning = Boolean(existing?.onboardingComplete || known.homeAddress);
      await ask(returning ? welcomeBackLine(he, known.name) : openingLine(he, known.name));
    })();
    return () => { alive.current = false; stopNatural(); mic.current?.cancel(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = useCallback(async (complete: boolean) => {
    const existing = await loadProfile().catch(() => null);
    const draftNow = draftRef.current;
    await saveProfile(toProfile(draftNow, existing, complete, new Date().toISOString(), savedLines.current));
    savedLines.current = routineLines(draftNow);
    const kept: SavedMeeting = { draft: draftNow, lines: savedLines.current };
    await AsyncStorage.setItem(MEETING_DRAFT_KEY, JSON.stringify(kept))
      .catch((e) => console.warn('[FirstMeeting] the conversation was not kept for next time', e));
  }, []);

  const answer = useCallback(async (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    silences.current = 0;
    setHeard(text);
    setTyped('');
    setPhase('thinking');
    const res = await extractProfileAnswer(text, draftRef.current as Record<string, unknown>, asked.current, lang);
    if (!alive.current) return;
    if (!res.ok) {
      // Rule 3: say WHICH failure — the day's AI allowance used up, or the
      // server out of reach — they have different fixes (8.10: the first was
      // reported as the second).
      setPhase('idle');
      const limit = /ai_limit/.test(res.reason);
      const detail = limit ? (res.reason.match(/"detail":\s*"([^"]+)"/)?.[1] ?? '') : '';
      const slow = /^slow:/.test(res.reason);
      await ask(limit
        ? (detail || (he ? 'נגמרו להיום הפניות למאירה — נמשיך מחר. מה שאמרת עד עכשיו נשמר.' : "Today's requests to Meira are used up — we'll continue tomorrow. What you said so far is saved."))
        : slow
          ? (he ? 'לקח לי יותר מדי זמן להבין — תגידי את זה שוב?' : 'That took me too long to understand — say it again?')
          : (he ? 'אין לי חיבור לשרת כרגע — תגידי את זה שוב עוד רגע?' : "I can't reach my server right now — say that again in a moment?"), false);
      return;
    }
    const out = res.data;
    const next = draftOf(out);
    draftRef.current = next;
    setDraft(next);
    await save(false).catch((e) => console.warn('[FirstMeeting] partial save failed', e));
    if (out.isComplete) {
      await save(true).catch((e) => console.warn('[FirstMeeting] final save failed', e));
      setDone(true);
      // Said back in full and shown for her to check — never "✓ saved" unseen.
      const heard = String(out.heardLine || '');
      await ask([heard, doneLine(he, next.name), checkLine(he)].filter(Boolean).join(' '), false);
      return;
    }
    await ask(String(out.followUpQuestion || (he ? 'ספרי לי עוד קצת?' : 'Tell me a bit more?')));
  }, [ask, he, lang, save]);

  const onMicError = useCallback(async (message: string) => {
    setPhase('idle');
    // Nobody spoke: ask once more, then wait for her tap — no nagging loop.
    silences.current += 1;
    if (silences.current === 1) {
      await ask(he ? `לא שמעתי. ${asked.current}` : `I didn't catch that. ${asked.current}`);
    } else {
      setLine(message);
    }
  }, [ask, he]);

  const later = useCallback(async () => {
    stopNatural();
    mic.current?.cancel();
    await save(false).catch((e) => console.warn('[FirstMeeting] save on later failed', e));
    await AsyncStorage.setItem(FIRST_MEETING_SNOOZE_KEY, getTodayString())
      .catch((e) => console.warn('[FirstMeeting] later not remembered', e));
    navigation.reset({ index: 0, routes: [{ name: 'MainTabs' as never }] });
  }, [navigation, save]);

  const finish = useCallback(() => {
    stopNatural();
    navigation.reset({ index: 0, routes: [{ name: 'MainTabs' as never }] });
  }, [navigation]);

  const rows = done ? savedSummary(draft, he) : checklist(draft, he);
  const rtl = he ? styles.rtl : null;
  const row = he ? styles.rowRtl : null;
  const status = phase === 'listening' ? (he ? 'מקשיבה…' : 'Listening…')
    : phase === 'transcribing' || phase === 'thinking' ? (he ? 'רגע…' : 'One moment…')
      : phase === 'speaking' ? (he ? 'מאירה מדברת' : 'Meira is talking') : '';

  return (
    <SafeAreaView style={styles.safe}>
      {/* Typing: the keyboard pushes the box up instead of covering it (9.10).
          "padding" measures this view against the keyboard, so it is right
          whether or not Android resized the window (edge-to-edge does not). */}
      <KeyboardAvoidingView style={styles.flex} behavior="padding">
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Animated.View style={[styles.orb, { transform: [{ scale: breathe }] }]}>
          <MeiraCoin size={92} glow />
        </Animated.View>
        <Text style={[styles.line, rtl]}>{line}</Text>
        {status ? <Text style={styles.status}>{status}</Text> : null}

        {heard ? (
          <Pressable onPress={() => { setTyping(true); setTyped(heard); mic.current?.cancel(); }}
            accessibilityRole="button" accessibilityLabel={he ? 'לתקן את מה ששמעתי' : 'Fix what I heard'}>
            <Text style={[styles.heard, rtl]}>{he ? `שמעתי: "${heard}" ✏️` : `I heard: "${heard}" ✏️`}</Text>
          </Pressable>
        ) : null}

        {done ? <Text style={[styles.summaryTitle, rtl]}>{he ? 'זה מה ששמרתי עלייך' : 'What I saved about you'}</Text> : null}
        <View style={styles.list}>
          {rows.map((r) => (
            <Pressable key={r.key} style={[styles.item, row]} accessibilityRole="button"
              accessibilityLabel={he ? `לתקן: ${r.label}` : `Fix: ${r.label}`}
              onPress={() => {
                const fix = fixRow(draftRef.current, r.key, he);
                if (!fix) return;
                stopNatural();
                mic.current?.cancel();
                draftRef.current = fix.draft;
                setDraft(fix.draft);
                setDone(false);
                void ask(fix.question);
              }}>
              <Text style={[styles.tick, r.value ? styles.tickOn : null]}>{r.value ? '✓' : '○'}</Text>
              <Text style={[styles.label, rtl]}>{r.label}</Text>
              <Text style={[styles.value, rtl]} numberOfLines={r.key === 'routines' ? 8 : 1}>{r.value ?? ''}</Text>
              {r.value ? <Text style={styles.edit}>✏️</Text> : null}
            </Pressable>
          ))}
        </View>
      </ScrollView>

      {done ? (
        <View style={[styles.doneRow, row]}>
          <Pressable style={styles.secondary} accessibilityRole="button" onPress={() => {
            setDone(false);
            void ask(he ? 'מה לתקן?' : 'What should I fix?');
          }}>
            <Text style={styles.secondaryText}>{he ? '✏️ לתקן משהו' : '✏️ Fix something'}</Text>
          </Pressable>
          <Pressable style={[styles.primary, styles.primaryFlex]} onPress={finish} accessibilityRole="button">
            <Text style={styles.primaryText}>{he ? '✓ הכל נכון' : '✓ All correct'}</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.bottom}>
          {typing ? (
            <View style={[styles.typeRow, row]}>
              <TextInput style={[styles.input, rtl]} value={typed} onChangeText={setTyped} autoFocus multiline
                placeholder={he ? 'כתבי כאן…' : 'Type here…'} placeholderTextColor={BRAND.inkFaint} />
              <Pressable style={styles.send} onPress={() => { setTyping(false); void answer(typed); }}
                disabled={!typed.trim()} accessibilityRole="button">
                <Text style={styles.sendText}>➤</Text>
              </Pressable>
            </View>
          ) : (
            <ChatMic ref={mic} he={he} onText={(t) => void answer(t)} onError={(m) => void onMicError(m)}
              onPhase={(p) => setPhase((cur) => (cur === 'speaking' || cur === 'thinking') && p === 'idle' ? cur : p)}
              style={styles.mic} activeStyle={styles.micOn} />
          )}
          <View style={[styles.links, row]}>
            <Pressable onPress={() => { setTyping((v) => !v); mic.current?.cancel(); stopNatural(); }} hitSlop={8}>
              <Text style={styles.link}>{typing ? (he ? '🎤 לדבר' : '🎤 Talk') : (he ? '✏️ להקליד' : '✏️ Type')}</Text>
            </Pressable>
            <Pressable onPress={() => void later()} hitSlop={8}>
              <Text style={styles.link}>{he ? '⏭ אחר כך' : '⏭ Later'}</Text>
            </Pressable>
          </View>
        </View>
      )}
      {phase === 'thinking' ? <ActivityIndicator style={styles.spinner} color={BRAND.amber} /> : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: BRAND.cream },
  flex: { flex: 1 },
  content: { padding: 20, paddingTop: 36, alignItems: 'stretch' },
  orb: { alignSelf: 'center', marginBottom: 18 },
  line: { fontFamily: FONTS.bodyHeavy, fontSize: 19, lineHeight: 27, color: BRAND.warmInk, textAlign: 'center' },
  status: { fontFamily: FONTS.bodySemi, fontSize: 12, color: BRAND.inkFaint, textAlign: 'center', marginTop: 6 },
  heard: {
    fontFamily: FONTS.body, fontSize: 14, color: BRAND.inkSoft, marginTop: 14, padding: 10,
    backgroundColor: BRAND.creamCard, borderRadius: 12, borderWidth: 1, borderColor: BRAND.line,
  },
  list: { marginTop: 18, backgroundColor: BRAND.creamCard, borderRadius: 16, borderWidth: 1, borderColor: BRAND.line, paddingVertical: 4 },
  item: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, minHeight: 40, gap: 10 },
  tick: { width: 18, fontSize: 15, color: BRAND.inkFaint, textAlign: 'center' },
  tickOn: { color: BRAND.success, fontFamily: FONTS.bodyHeavy },
  label: { width: 76, fontFamily: FONTS.bodySemi, fontSize: 14, color: BRAND.warmInk },
  value: { flex: 1, fontFamily: FONTS.body, fontSize: 14, color: BRAND.inkSoft },
  edit: { fontSize: 13, opacity: 0.6 },
  bottom: { paddingHorizontal: 20, paddingBottom: 18, alignItems: 'center', gap: 10 },
  mic: {
    width: 76, height: 76, borderRadius: 38, backgroundColor: BRAND.sunGold, alignItems: 'center', justifyContent: 'center',
  },
  micOn: { backgroundColor: BRAND.amber },
  links: { flexDirection: 'row', gap: 28 },
  link: { fontFamily: FONTS.bodySemi, fontSize: 14, color: BRAND.goldInk, paddingVertical: 6 },
  typeRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, alignSelf: 'stretch' },
  input: {
    flex: 1, minHeight: 46, maxHeight: 120, borderRadius: 14, borderWidth: 1, borderColor: BRAND.line,
    backgroundColor: BRAND.creamCard, paddingHorizontal: 12, paddingVertical: 10, fontFamily: FONTS.body, fontSize: 15, color: BRAND.warmInk,
  },
  send: { width: 46, height: 46, borderRadius: 23, backgroundColor: BRAND.sunGold, alignItems: 'center', justifyContent: 'center' },
  sendText: { fontSize: 18, color: BRAND.onGold },
  summaryTitle: { fontFamily: FONTS.bodyHeavy, fontSize: 15, color: BRAND.warmInk, marginTop: 18, marginBottom: -8 },
  doneRow: { flexDirection: 'row', gap: 10, margin: 20 },
  primaryFlex: { flex: 1, margin: 0 },
  secondary: {
    minHeight: 52, borderRadius: 999, borderWidth: 1, borderColor: BRAND.line, backgroundColor: BRAND.creamCard,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18,
  },
  secondaryText: { fontFamily: FONTS.bodySemi, fontSize: 15, color: BRAND.warmInk },
  primary: { margin: 20, minHeight: 52, borderRadius: 999, backgroundColor: BRAND.sunGold, alignItems: 'center', justifyContent: 'center' },
  primaryText: { fontFamily: FONTS.bodyHeavy, fontSize: 16, color: BRAND.onGold },
  spinner: { position: 'absolute', top: 24, right: 24 },
  rtl: { writingDirection: 'rtl' },
  rowRtl: { flexDirection: 'row-reverse' },
});
