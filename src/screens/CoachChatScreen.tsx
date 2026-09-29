/**
 * CoachChatScreen — chat UI over the shared brain (LumiBrain -> POST
 * /agent/chat, the same agent WhatsApp uses), with diary QUESTIONS
 * ("what do I have on Tuesday 1/9?", "can I fit 2h in Haifa at 14:00?")
 * answered locally and exactly by ScheduleQueryService first, falling back to
 * LumiCoachEngine.coachTurn when signed out or offline: renders replies,
 * keeps the CoachPending handoff (transport/origin/home questions) between
 * turns, and shares device location when asked. Also: mic (STT) input,
 * long-press-to-quote replies, and session-persistent history.
 * Dependencies: LumiCoachEngine, LocationService, TaskStorage,
 * UserProfileStorage, SpeechService.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  View, ScrollView, StyleSheet, Text, TextInput,
  TouchableOpacity, KeyboardAvoidingView, Platform, ActivityIndicator, Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BRAND, FONTS, RADIUS, SHADOWS } from '../constants/theme';
import { coachTurn, CoachPending } from '../services/LumiCoachEngine';
import { brainTurn } from '../services/LumiBrain';
import { getSettings } from '../services/TaskStorage';
import {
  getCurrentLocation,
  getAddressFromCoordinates,
  getLastKnownLocation,
  asksAboutHere,
} from '../services/LocationService';
import { loadProfile, saveProfile } from '../services/UserProfileStorage';
import { UserProfile, blankProfile } from '../models/UserProfile';
import { tryAnswerScheduleQuestion } from '../services/ScheduleQueryService';
import {
  isSpeechRecognitionAvailable,
  getSpeechRecognitionUnavailableReason,
  setupSpeechRecognitionCallbacks,
  startSpeechToText,
  stopSpeechToText,
  preprocessTranscript,
} from '../services/SpeechService';

// A minimal profile so "set home from chat" works even before onboarding.
interface Message {
  id: string;
  role: 'lumi' | 'user';
  text: string;
  /** Epoch ms — rendered as a small time+date stamp under the bubble. */
  ts?: number;
}

/** "14:38 · 20/7" — date part only when the message isn't from today. */
function stampOf(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? hhmm : `${hhmm} · ${d.getDate()}/${d.getMonth() + 1}`;
}

// Chips are localized so the Hebrew ones hit the engine's HE intent regexes.
const CHIPS_EN = ['Plan my day', "What's urgent?", 'Add a task', 'Reschedule'];
const CHIPS_HE = ['תכנן לי את היום', 'מה דחוף?', 'הוסף משימה', 'לתזמן מחדש'];

// Session-persistent chat history: survives closing/reopening the chat modal
// (it's remounted each time) without hitting AsyncStorage. Reset on app restart.
let sessionMessages: Message[] | null = null;
let sessionPending: CoachPending | undefined;

export default function CoachChatScreen({ navigation, route }: any) {
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView>(null);
  const [messages, setMessages] = useState<Message[]>(
    sessionMessages ?? [
      { id: '0', role: 'lumi', text: "Hey! Ready to light up your day? 🌟 What's on your mind?" },
    ],
  );
  // "⌨️ Type it" from the voice sheet arrives with what was already heard, so
  // a failed voice turn is one tap from sent, not a sentence to say again.
  const [input, setInput] = useState<string>(route?.params?.initialText ?? '');
  const [loading, setLoading] = useState(false);
  const [language, setLanguage] = useState<'en' | 'he'>('en');
  const [pending, setPending] = useState<CoachPending | undefined>(sessionPending);
  // Question-specific quick replies from the engine (e.g. train numbers); falls back to CHIPS.
  const [dynamicChips, setDynamicChips] = useState<string[] | undefined>(undefined);
  const [locating, setLocating] = useState(false);
  // Long-pressed Lumi message being replied to (WhatsApp-style quote).
  const [quoted, setQuoted] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const sttCleanup = useRef<(() => void) | null>(null);

  // Keep the module-level session copies in sync so reopening restores the chat.
  useEffect(() => { sessionMessages = messages; }, [messages]);
  useEffect(() => { sessionPending = pending; }, [pending]);

  // Detach STT listeners (and stop the recognizer) only when the modal closes.
  const listeningRef = useRef(false);
  useEffect(() => { listeningRef.current = listening; }, [listening]);
  useEffect(() => () => {
    if (listeningRef.current) stopSpeechToText();
    sttCleanup.current?.();
  }, []);

  // 🎤 toggle: start dictation into the input box (user reviews, then sends).
  const toggleMic = async () => {
    if (listening) {
      stopSpeechToText();
      setListening(false);
      return;
    }
    if (!isSpeechRecognitionAvailable()) {
      Alert.alert(
        language === 'he' ? 'קלט קולי לא זמין' : 'Voice input unavailable',
        getSpeechRecognitionUnavailableReason() ||
          (language === 'he' ? 'קלט קולי עובד רק באפליקציה המותקנת (EAS)' : 'Voice input works in the installed (EAS) app only.'),
      );
      return;
    }
    sttCleanup.current?.();
    sttCleanup.current = setupSpeechRecognitionCallbacks({
      onResult: (transcript: string, _isFinal: boolean) => {
        setInput(preprocessTranscript(transcript, language));
      },
      onEnd: () => setListening(false),
      onError: (code: string) => {
        console.warn('[CoachChat] STT error', code);
        setListening(false);
      },
    });
    const started = await startSpeechToText(language);
    setListening(started);
  };

  const lumiSay = (text: string) =>
    setMessages((prev) => [...prev, { id: Date.now().toString(), role: 'lumi', text, ts: Date.now() }]);

  // Capture the phone's current GPS position → address → save as home.
  const useLocationAsHome = async () => {
    if (locating) return;
    setLocating(true);
    lumiSay(language === 'he' ? '📍 מאתר את המיקום שלך…' : '📍 Getting your location…');
    try {
      const coords = await getCurrentLocation();
      if (!coords) {
        lumiSay(language === 'he' ? 'לא הצלחתי לקבל מיקום — אשר/י הרשאת מיקום 📍' : "Couldn't get your location — allow location access 📍");
        return;
      }
      const address = (await getAddressFromCoordinates(coords.lat, coords.lng)) || `${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}`;
      const base = (await loadProfile()) ?? blankProfile();
      await saveProfile({ ...base, homeAddress: address, homeLatLng: coords, lastUpdated: new Date().toISOString() });
      lumiSay(language === 'he' ? `שמרתי את הבית: ${address} 🏠` : `Saved your home: ${address} 🏠`);
      // If we were mid-plan waiting on home, continue now that it's set.
      if (pending?.mode) {
        const result = await coachTurn('', { language, pending });
        setPending(result.pending);
        setDynamicChips(result.chips);
        lumiSay(result.reply);
      }
    } catch (e) {
      console.warn('[CoachChat] location→home failed', e);
      lumiSay(language === 'he' ? 'משהו השתבש עם המיקום 🙏' : 'Something went wrong getting your location 🙏');
    } finally {
      setLocating(false);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
    }
  };

  useEffect(() => {
    getSettings().then((s) => setLanguage(s.language)).catch(() => {});
  }, []);

  const send = async (text: string) => {
    if (!text.trim() || loading) return;
    if (listening) { stopSpeechToText(); setListening(false); }
    // A quoted Lumi message rides along as leading context (WhatsApp-style).
    const finalText = quoted ? `> ${quoted}\n${text.trim()}` : text.trim();
    const userMsg: Message = { id: Date.now().toString(), role: 'user', text: finalText, ts: Date.now() };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setQuoted(null);
    setLoading(true);

    try {
      // A QUESTION about the diary is answered from the diary, before any
      // model sees it. "What do I have on Tuesday 1/9?" and "can I fit two
      // hours in Haifa on Wednesday at 14:00?" have exact answers sitting in
      // local storage plus one Directions call — and an agent that paraphrases
      // them is strictly worse: slower, offline-fragile, and occasionally
      // wrong about the one thing she is asking to rely on. Everything else
      // carries on to the brain untouched.
      if (!pending?.mode) {
        const answered = await tryAnswerScheduleQuestion(finalText, language).catch(() => null);
        if (answered) {
          setMessages((prev) => [...prev, {
            id: Date.now().toString(), role: 'lumi', text: answered.text, ts: Date.now(),
          }]);
          return;
        }
      }

      // The real brain next: the same LangGraph agent WhatsApp talks to, with
      // its tools, its memory and its personality. This comment used to claim
      // the local engine WAS that agent; it never was, and the gap in answer
      // quality was the whole complaint.
      //
      // The local engine stays as the fallback — signed out, offline, or the
      // server down. Worse answers beat no answers, and a mid-question handoff
      // (pending: which transport? which origin?) must finish where it started.
      if (!pending?.mode) {
        // Where she is goes with the question. The cached fix is free, so it
        // rides along on every turn; a real fix is only worth its seconds when
        // the answer depends on the position ("how do I get there from here").
        let here = await getLastKnownLocation();
        if (!here && asksAboutHere(finalText)) here = await getCurrentLocation().catch(() => null);
        const label = here
          ? (await getAddressFromCoordinates(here.lat, here.lng).catch(() => null)) ?? undefined
          : undefined;
        const brain = await brainTurn(finalText, here ? { here: { ...here, label } } : {});
        if (brain?.text) {
          setMessages((prev) => [...prev, {
            id: Date.now().toString(), role: 'lumi', text: brain.text, ts: Date.now(),
          }]);
          return;   // finally{} still runs: spinner off, scroll to end
        }
      }

      // Local fallback. The last few turns go along so follow-ups
      // ("actually tomorrow") keep their context.
      const history = messages.slice(-6).map((m) => ({ role: m.role, text: m.text }));
      const result = await coachTurn(finalText, { language, pending, history });
      setPending(result.pending);
      setDynamicChips(result.chips);
      setMessages((prev) => [...prev, { id: Date.now().toString(), role: 'lumi', text: result.reply, ts: Date.now() }]);
      // No refresh call is needed here: TodaySchedule reloads on focus
      // (useFocusEffect), so a task saved by this turn is on the day as soon
      // as she goes back. What was missing was never the refresh — it was that
      // nothing had been saved to refresh INTO.
      // Engine side-effects: "plan tomorrow" opens the tomorrow timeline.
      if (result.action === 'openPlanTomorrow') {
        setTimeout(() => navigation.navigate('PlanTomorrow'), 600);
      }
    } catch (e) {
      console.warn('[CoachChat] coachTurn failed', e);
      setMessages((prev) => [...prev, { id: Date.now().toString(), role: 'lumi', text: 'Hmm, I hit a snag. Try again! 🙏' }]);
    } finally {
      setLoading(false);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <View style={styles.headerText}>
          <Text style={styles.headerName}>Lumi</Text>
          <Text style={styles.headerStatus}>● online</Text>
        </View>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.closeBtn}>
          <Text style={styles.closeBtnText}>✕</Text>
        </TouchableOpacity>
      </View>

      {/* Messages */}
      <ScrollView
        ref={scrollRef}
        style={styles.messages}
        contentContainerStyle={styles.messagesContent}
        showsVerticalScrollIndicator={false}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
      >
        {messages.map((msg) =>
          msg.role === 'lumi' ? (
            <View key={msg.id} style={styles.lumiRow}>
              {/* Long-press a Lumi bubble to reply to that specific message. */}
              <TouchableOpacity
                style={styles.lumiBubble}
                onLongPress={() => setQuoted(msg.text)}
                delayLongPress={300}
                activeOpacity={0.85}
              >
                <Text style={styles.lumiText} selectable>{msg.text}</Text>
                {msg.ts ? <Text style={styles.msgStamp}>{stampOf(msg.ts)}</Text> : null}
              </TouchableOpacity>
            </View>
          ) : (
            <View key={msg.id} style={styles.userRow}>
              <View style={styles.userBubble}>
                <Text style={styles.userText} selectable>{msg.text}</Text>
                {msg.ts ? <Text style={[styles.msgStamp, styles.msgStampUser]}>{stampOf(msg.ts)}</Text> : null}
              </View>
            </View>
          ),
        )}
        {loading && (
          <View style={styles.lumiRow}>
            <View style={styles.lumiBubble}>
              <ActivityIndicator color={BRAND.sunGold} size="small" />
            </View>
          </View>
        )}
        <View style={{ height: 20 }} />
      </ScrollView>

      {/* Suggestion chips */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chips} contentContainerStyle={styles.chipsContent}>
        {(dynamicChips?.length ? dynamicChips : language === 'he' ? CHIPS_HE : CHIPS_EN).map((chip) => (
          <TouchableOpacity key={chip} style={styles.chip} onPress={() => send(chip)}>
            <Text style={styles.chipText}>{chip}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Quote bar — replying to a specific Lumi message */}
      {quoted && (
        <View style={styles.quoteBar}>
          <View style={styles.quoteAccent} />
          <Text style={styles.quoteText} numberOfLines={1}>
            {quoted}
          </Text>
          <TouchableOpacity onPress={() => setQuoted(null)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={styles.quoteClose}>✕</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Input row */}
      <View style={[styles.inputRow, { paddingBottom: insets.bottom + 8 }]}>
        <TouchableOpacity
          style={styles.locBtn}
          onPress={useLocationAsHome}
          disabled={locating}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          {locating ? <ActivityIndicator color={BRAND.sunGold} size="small" /> : <Text style={styles.locIcon}>📍</Text>}
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.locBtn, listening && styles.micBtnActive]}
          onPress={toggleMic}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={styles.locIcon}>{listening ? '🔴' : '🎤'}</Text>
        </TouchableOpacity>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder={listening ? (language === 'he' ? 'מקשיבה…' : 'Listening…') : language === 'he' ? 'ספר/י ללומי…' : 'Ask Lumi anything…'}
          placeholderTextColor={BRAND.inkFaint}
          multiline
          returnKeyType="send"
          onSubmitEditing={() => send(input)}
        />
        <TouchableOpacity
          style={[styles.sendBtn, !input.trim() && styles.sendBtnDisabled]}
          onPress={() => send(input)}
          disabled={!input.trim() || loading}
        >
          <Text style={styles.sendIcon}>›</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BRAND.cream },

  header: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 16, paddingBottom: 12,
    backgroundColor: BRAND.creamCard,
    borderBottomWidth: 1, borderBottomColor: BRAND.line,
  },
  headerText: { flex: 1 },
  headerName: { fontSize: 17, fontFamily: FONTS.display, color: BRAND.warmInk },
  headerStatus: { fontSize: 12, fontFamily: FONTS.bodySemi, color: BRAND.success },
  closeBtn: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: BRAND.line, alignItems: 'center', justifyContent: 'center',
  },
  closeBtnText: { fontSize: 14, color: BRAND.inkSoft, fontFamily: FONTS.bodyBold },

  messages: { flex: 1 },
  messagesContent: { padding: 16, gap: 12 },

  lumiRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  lumiBubble: {
    backgroundColor: BRAND.creamCard, borderRadius: 20, borderBottomLeftRadius: 6,
    paddingHorizontal: 14, paddingVertical: 10, maxWidth: '78%',
    ...SHADOWS.card,
  },
  lumiText: { fontSize: 14, fontFamily: FONTS.body, color: BRAND.warmInk, lineHeight: 20 },
  msgStamp: { fontSize: 10, fontFamily: FONTS.body, color: BRAND.inkFaint, marginTop: 3, alignSelf: 'flex-end' },
  msgStampUser: { color: 'rgba(255,255,255,0.75)' },

  userRow: { alignItems: 'flex-end' },
  userBubble: {
    borderRadius: 20, borderBottomRightRadius: 6,
    paddingHorizontal: 14, paddingVertical: 10, maxWidth: '78%',
    backgroundColor: BRAND.sunGold,
    ...SHADOWS.button,
  },
  userText: { fontSize: 14, fontFamily: FONTS.body, color: BRAND.creamCard, lineHeight: 20 },

  chips: { flexGrow: 0, borderTopWidth: 1, borderTopColor: BRAND.line },
  chipsContent: { padding: 10, gap: 8 },
  chip: {
    backgroundColor: BRAND.honey, borderRadius: RADIUS.pill,
    paddingHorizontal: 14, paddingVertical: 8,
  },
  chipText: { fontSize: 13, fontFamily: FONTS.bodyBold, color: BRAND.warmInk },

  inputRow: {
    flexDirection: 'row', alignItems: 'flex-end', gap: 8,
    paddingHorizontal: 12, paddingTop: 8,
    backgroundColor: BRAND.creamCard, borderTopWidth: 1, borderTopColor: BRAND.line,
  },
  input: {
    flex: 1, backgroundColor: BRAND.cream,
    borderRadius: 24, borderWidth: 1, borderColor: BRAND.line,
    paddingHorizontal: 16, paddingVertical: 10,
    fontSize: 14, fontFamily: FONTS.body, color: BRAND.warmInk,
    maxHeight: 100,
  },
  sendBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: BRAND.sunGold, alignItems: 'center', justifyContent: 'center',
    ...SHADOWS.button,
  },
  sendBtnDisabled: { opacity: 0.4 },
  sendIcon: { fontSize: 22, color: BRAND.creamCard, fontFamily: FONTS.bodyHeavy, lineHeight: 26 },
  locBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: BRAND.honey, alignItems: 'center', justifyContent: 'center',
  },
  locIcon: { fontSize: 20 },
  micBtnActive: { backgroundColor: BRAND.sunGold },

  quoteBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 14, paddingVertical: 8,
    backgroundColor: BRAND.creamCard, borderTopWidth: 1, borderTopColor: BRAND.line,
  },
  quoteAccent: { width: 3, alignSelf: 'stretch', borderRadius: 2, backgroundColor: BRAND.sunGold },
  quoteText: { flex: 1, fontSize: 12, fontFamily: FONTS.body, color: BRAND.inkSoft },
  quoteClose: { fontSize: 14, color: BRAND.inkSoft, fontFamily: FONTS.bodyBold },
});
