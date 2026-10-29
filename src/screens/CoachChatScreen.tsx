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
  TouchableOpacity, KeyboardAvoidingView, Platform, ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BRAND, FONTS, RADIUS, SHADOWS } from '../constants/theme';
import { coachTurn, CoachPending } from '../services/LumiCoachEngine';
import { brainTurn, sendReaction } from '../services/LumiBrain';
import AsyncStorage from '../services/EncryptedStorage';  // AES-256-GCM at rest (7.10)
import LearnedCard from '../components/LearnedCard';
import HomeConfirmCard from '../components/HomeConfirmCard';
import { HOME_HERE_CHIP, HomeAsk, findHomeHere, saveHomeHere } from '../utils/homeFromHere';
import AnswerCard from '../components/AnswerCard';
import ChainCard from '../components/ChainCard';
import { ChainAnswer, asChainAnswer } from '../utils/chainAnswer';
import type { VoiceTurn } from '../components/VoiceSheet';
import { LookupAnswer, asLookupAnswer } from '../utils/answerCard';
import type { ProfileChange } from '../services/LumiServer';
import { invalidateRoutines } from '../services/GapFillService';
import { getSettings, getAllTasks } from '../services/TaskStorage';
import { useFocusEffect } from '@react-navigation/native';
import MeiraHomePanel, { HomeTile } from '../components/home/MeiraHomePanel';
import SkyBackdrop, { useSky } from '../components/ui/SkyBackdrop';
import MeiraCoin from '../components/MeiraCoin';
import LineIcon from '../components/ui/LineIcon';
import { useBellCount } from '../services/BellCount';
import { homeBrief, briefLine, HomeBrief } from '../utils/homeBrief';
import { getTodayString, timeToMinutes } from '../utils/timeUtils';
import type { Task } from '../types/index';
import { RIDE_ICON, ridesOf } from '../utils/rideLine';
import {
  getCurrentLocation,
  getAddressFromCoordinates,
  getLastKnownLocation,
  asksAboutHere,
} from '../services/LocationService';
import { loadProfile, saveProfile } from '../services/UserProfileStorage';
import { UserProfile, blankProfile } from '../models/UserProfile';
import { tryAnswerScheduleQuestion } from '../services/ScheduleQueryService';
import { preprocessTranscript } from '../services/SpeechService';
import ChatMic, { ChatMicHandle } from '../components/ChatMic';
import type { CapturePhase } from '../hooks/useVoiceCapture';

// A minimal profile so "set home from chat" works even before onboarding.
interface Message {
  id: string;
  role: 'lumi' | 'user';
  text: string;
  /** Epoch ms — rendered as a small time+date stamp under the bubble. */
  ts?: number;
  /** What this turn saved about her — cards with Undo (components/LearnedCard). */
  cards?: ProfileChange[];
  /** Meira's opening line, worded in her language when it is drawn. */
  greet?: 'hello' | 'tell';
  /** A place/route answer, drawn as a card under the bubble (components/AnswerCard). */
  answer?: LookupAnswer;
  /** A bike/car-elsewhere plan, drawn as a map under the bubble (components/ChainCard). */
  chain?: ChainAnswer;
  /** Buttons that answer this reply's question — tapping one sends it. */
  replies?: string[];
  /** Said on the mic: the bubble shows "heard this way ✏️" and taps to edit. */
  voice?: boolean;
  /** 📍 found where she is: "save as home?" (components/HomeConfirmCard). */
  homeAsk?: HomeAsk;
  /** Her 👍 / 👎 on a Meira reply (27.10), kept on the server too (chat_feedback). */
  reaction?: 'up' | 'down';
  /** The Meira message she answered (↩ / long-press), drawn as a quote in her bubble. */
  replyTo?: string;
}

// THE chat with Meira (6.10): the 💬 in the tab bar and You → "Tell me" open
// this same screen. What she says here is kept between app restarts, so a
// routine she described yesterday is still on the page today.
const CHAT_KEY = 'lumi.chat.v1';
const CHAT_KEEP = 60;
const GREETING = {
  hello: { en: "Hi, I'm Meira. What's on your day — or tell me about your week, so I can plan around it.",
    he: 'היי, אני מאירה. מה יש לך היום — או ספרי לי על השבוע שלך, ואתכנן סביבו.' },
  tell: { en: 'Tell me about a normal week — where you go, when, and how you get there.',
    he: 'ספרי לי על שבוע רגיל — לאן את הולכת, מתי, ואיך את מגיעה.' },
};

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
import { ASK_GROUPS, isStarter } from '../constants/askExamples';

const CHIPS_EN = ['Plan my day', "What's urgent?", 'Add a task', 'Reschedule'];
const CHIPS_HE = ['תכנן לי את היום', 'מה דחוף?', 'הוסף משימה', 'לתזמן מחדש'];

// Session copy of the chat: reopening the sheet (it's remounted each time)
// shows it at once; CHAT_KEY keeps it across app restarts.
let sessionMessages: Message[] | null = null;
let sessionPending: CoachPending | undefined;

// A reply lands where she will SEE it. Closing the chat while Meira was still
// answering threw the answer away (7.10, on her phone: the question stayed, the
// reply never came) — the screen that asked was gone, and its setState with it.
// So a reply goes to whichever chat is open now, or into the kept history for
// the next time she opens it.
const openChats = new Set<(msgs: Message[]) => void>();
function deliver(msgs: Message[]) {
  if (openChats.size) {
    openChats.forEach((add) => add(msgs));
    return;
  }
  sessionMessages = [...(sessionMessages ?? []), ...msgs];
  AsyncStorage.setItem(CHAT_KEY, JSON.stringify(sessionMessages.slice(-CHAT_KEEP)))
    .catch((e) => console.warn('[CoachChat] reply kept in memory only, not saved', e));
}

export default function CoachChatScreen({ navigation, route }: any) {
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView>(null);
  const [messages, setMessages] = useState<Message[]>(
    sessionMessages ?? [{ id: '0', role: 'lumi', text: '', greet: 'hello' }],
  );
  // Kept across restarts (the module copy only survived closing the sheet).
  const restored = useRef(Boolean(sessionMessages));
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    AsyncStorage.getItem(CHAT_KEY)
      .then((raw) => {
        const saved: Message[] = raw ? JSON.parse(raw) : [];
        if (saved.length) setMessages((now) => [...saved, ...now.filter((m) => m.id !== '0')]);
      })
      .catch((e) => console.warn('[CoachChat] history unreadable', e));
  }, []);
  useEffect(() => {
    AsyncStorage.setItem(CHAT_KEY, JSON.stringify(messages.slice(-CHAT_KEEP)))
      .catch((e) => console.warn('[CoachChat] history not saved', e));
  }, [messages]);
  // You → "Tell me": Meira opens the subject, and 🎙️ starts listening.
  useEffect(() => {
    if (route?.params?.mode !== 'tell') return;
    setMessages((prev) => (prev[prev.length - 1]?.greet === 'tell' ? prev
      : [...prev, { id: `tell-${Date.now()}`, role: 'lumi', text: '', greet: 'tell', ts: Date.now() }]));
    if (route?.params?.listen) setTimeout(() => { micRef.current?.start(); }, 400);
  }, [route?.params?.mode, route?.params?.listen]);
  // A question asked on the mic arrives here WITH its answer (her pick, 7.10:
  // "Meira answers inside the chat"), so she can act on it and keep asking.
  const voiceTurn: VoiceTurn | undefined = route?.params?.voiceTurn;
  useEffect(() => {
    if (!voiceTurn?.id) return;
    setMessages((prev) => (prev.some((m) => m.id === `${voiceTurn.id}-q`) ? prev : [
      ...prev,
      { id: `${voiceTurn.id}-q`, role: 'user', text: voiceTurn.question, ts: Date.now(), voice: true },
      { id: `${voiceTurn.id}-a`, role: 'lumi', text: voiceTurn.reply, ts: Date.now(),
        ...(asLookupAnswer(voiceTurn.answer) ? { answer: voiceTurn.answer } : {}),
        ...(asChainAnswer(voiceTurn.chain) ? { chain: voiceTurn.chain } : {}) },
    ]));
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 150);
  }, [voiceTurn?.id]);
  // "⌨️ Type it" from the voice sheet arrives with what was already heard, so
  // a failed voice turn is one tap from sent, not a sentence to say again.
  const [input, setInput] = useState<string>(route?.params?.initialText ?? '');
  const [loading, setLoading] = useState(false);
  // "What can I ask?": starters the user finishes (constants/askExamples).
  const [showExamples, setShowExamples] = useState(false);
  const [language, setLanguage] = useState<'en' | 'he'>('en');
  const [pending, setPending] = useState<CoachPending | undefined>(sessionPending);
  // Question-specific quick replies from the engine (e.g. train numbers); falls back to CHIPS.
  const [dynamicChips, setDynamicChips] = useState<string[] | undefined>(undefined);
  const [locating, setLocating] = useState(false);
  // No home yet → the 📍 chip leads the row; once there is one it goes last.
  const [hasHome, setHasHome] = useState(true);
  // Long-pressed Lumi message being replied to (WhatsApp-style quote).
  const [quoted, setQuoted] = useState<string | null>(null);
  // 🎤 — Whisper, like the main mic (components/ChatMic). What she said is
  // sent at once and shows as "heard this way ✏️", one tap from fixed.
  const micRef = useRef<ChatMicHandle>(null);
  // v3 (Koral, 27.10): the chat IS the home tab. Then the top is Meira's home
  // panel (MeiraHomePanel), this visit's messages follow it, and what was said
  // before is one tap away — not a wall of yesterday above "how can I help?".
  const home = route?.name === 'Meira' || Boolean(route?.params?.home);
  const sessionStart = useRef(Date.now());
  const [showHistory, setShowHistory] = useState(false);
  const [brief, setBrief] = useState<HomeBrief | null>(null);
  const [firstName, setFirstName] = useState<string | undefined>(undefined);
  const loadBrief = React.useCallback(() => {
    const today = getTodayString();
    getAllTasks()
      .then((all: Task[]) => {
        const d = new Date();
        setBrief(homeBrief(all.filter((t) => t.date === today), d.getHours() * 60 + d.getMinutes()));
      })
      .catch((e) => console.warn('[CoachChat] home brief unreadable', e));
    loadProfile()
      .then((p) => setFirstName(p?.name?.trim().split(/\s+/)[0] || undefined))
      .catch((e) => console.warn('[CoachChat] profile unreadable for the greeting', e));
  }, []);
  useFocusEffect(React.useCallback(() => { if (home) loadBrief(); }, [home, loadBrief]));
  const [micPhase, setMicPhase] = useState<CapturePhase>('idle');
  const listening = micPhase === 'listening';

  // Keep the module-level session copies in sync so reopening restores the chat.
  useEffect(() => { sessionMessages = messages; }, [messages]);
  useEffect(() => {
    const add = (msgs: Message[]) => setMessages((prev) => [...prev, ...msgs]);
    openChats.add(add);
    return () => { openChats.delete(add); };
  }, []);
  useEffect(() => { sessionPending = pending; }, [pending]);

  const lumiSay = (text: string) =>
    deliver([{ id: Date.now().toString(), role: 'lumi', text, ts: Date.now() }]);

  // 📍 "my home is here": GPS fix → address → a card that ASKS. Home changes
  // only on her yes (utils/homeFromHere) — it used to save on one tap, and a
  // mis-tap reaching for the mic did exactly that (7.10).
  const askLocationAsHome = async () => {
    if (locating) return;
    setLocating(true);
    lumiSay(language === 'he' ? '📍 מאתר את המיקום שלך…' : '📍 Getting your location…');
    try {
      const found = await findHomeHere({ locate: getCurrentLocation, addressOf: getAddressFromCoordinates, load: loadProfile });
      if (!found.ok) {
        lumiSay(language === 'he' ? 'לא הצלחתי לקבל מיקום — אשר/י הרשאת מיקום 📍' : "Couldn't get your location — allow location access 📍");
        return;
      }
      deliver([{ id: `${Date.now()}-home`, role: 'lumi', text: '', ts: Date.now(), homeAsk: found.ask }]);
    } catch (e) {
      console.warn('[CoachChat] location→home failed', e);
      lumiSay(language === 'he' ? 'משהו השתבש עם המיקום 🙏' : 'Something went wrong getting your location 🙏');
    } finally {
      setLocating(false);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
    }
  };

  // Her answer on the card. Only a yes writes home, and the card keeps the answer.
  const answerHome = async (msgId: string, ask: HomeAsk, yes: boolean) => {
    // Answered: the card keeps the words, the kept chat drops the coordinates.
    const mark = (outcome: 'saved' | 'declined') => setMessages((prev) =>
      prev.map((m) => (m.id === msgId && m.homeAsk
        ? { ...m, homeAsk: { address: m.homeAsk.address, current: m.homeAsk.current, outcome } } : m)));
    if (!yes) {
      mark('declined');
      return { ok: true as const };
    }
    const saved = await saveHomeHere(ask, { load: loadProfile, save: saveProfile, blank: blankProfile });
    if (!saved.ok) return saved;
    mark('saved');
    setHasHome(true);
    // If we were mid-plan waiting on home, continue now that it's set.
    if (pending?.mode) {
      try {
        const result = await coachTurn('', { language, pending });
        setPending(result.pending);
        setDynamicChips(result.chips);
        lumiSay(result.reply);
      } catch (e) {
        console.warn('[CoachChat] plan after home failed', e);
        lumiSay(language === 'he' ? 'הבית נשמר, אבל התכנון נתקע — נסי שוב 🙏' : 'Home saved, but the plan got stuck — try again 🙏');
      }
    }
    return saved;
  };

  useEffect(() => {
    loadProfile()
      .then((p) => setHasHome(Boolean(p?.homeAddress?.trim())))
      .catch((e) => console.warn('[CoachChat] profile unreadable', e));
  }, []);

  useEffect(() => {
    getSettings().then((s) => setLanguage(s.language)).catch(() => {});
  }, []);

  const send = async (text: string, opts: { voice?: boolean } = {}) => {
    if (!text.trim() || loading) return;
    if (!opts.voice && listening) micRef.current?.cancel();
    // A quoted Meira message goes to the brain as `replyTo`, apart from her
    // words; only the device fallback still gets it inline.
    const replyTo = quoted ?? undefined;
    const finalText = text.trim();
    const userMsg: Message = { id: Date.now().toString(), role: 'user', text: finalText, ts: Date.now(),
      ...(opts.voice ? { voice: true } : {}), ...(replyTo ? { replyTo } : {}) };
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
      if (!pending?.mode && !replyTo) {
        const answered = await tryAnswerScheduleQuestion(finalText, language).catch(() => null);
        if (answered) {
          deliver([{ id: Date.now().toString(), role: 'lumi', text: answered.text, ts: Date.now() }]);
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
        const brain = await brainTurn(finalText, {
          ...(here ? { here: { ...here, label } } : {}), ...(replyTo ? { replyTo } : {}),
        });
        if (brain?.text) {
          deliver([
            { id: Date.now().toString(), role: 'lumi', text: brain.text, ts: Date.now(),
              ...(brain.answer ? { answer: brain.answer } : {}),
              ...(brain.chain ? { chain: brain.chain } : {}),
              ...(brain.replies?.length ? { replies: brain.replies } : {}) },
            // What she just told Meira about herself, said back with Undo.
            ...(brain.profileChanges?.length
              ? [{ id: `${Date.now()}-cards`, role: 'lumi' as const, text: '', cards: brain.profileChanges, ts: Date.now() }]
              : []),
          ]);
          if (brain.profileChanges?.length) invalidateRoutines();
          return;   // finally{} still runs: spinner off, scroll to end
        }
      }

      // Local fallback. The last few turns go along so follow-ups
      // ("actually tomorrow") keep their context.
      const history = messages.slice(-6).map((m) => ({ role: m.role, text: m.text }));
      const result = await coachTurn(replyTo ? `> ${replyTo}\n${finalText}` : finalText,
        { language, pending, history });
      setPending(result.pending);
      setDynamicChips(result.chips);
      deliver([{ id: Date.now().toString(), role: 'lumi', text: result.reply, ts: Date.now() }]);
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
      deliver([{ id: Date.now().toString(), role: 'lumi', text: 'Hmm, I hit a snag. Try again! 🙏' }]);
    } finally {
      setLoading(false);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
    }
  };

  // 👍 / 👎 (27.10): marked at once, kept on the server; if the server did
  // not keep it, the mark comes off and she is told — never a silent no-op.
  const react = async (msg: Message, reaction: 'up' | 'down') => {
    const next = msg.reaction === reaction ? undefined : reaction;
    const set = (r?: 'up' | 'down') => setMessages((prev) =>
      prev.map((m) => (m.id === msg.id ? { ...m, reaction: r } : m)));
    set(next);
    const i = messages.findIndex((m) => m.id === msg.id);
    const question = [...messages.slice(0, Math.max(i, 0))].reverse().find((m) => m.role === 'user')?.text ?? '';
    const ok = await sendReaction(next ?? 'none', msg.text, question, msg.id);
    if (!ok) {
      set(msg.reaction);
      lumiSay(language === 'he' ? 'לא הצלחתי לשמור את הסימון — נסי שוב 🙏' : "Couldn't save that reaction — try again 🙏");
    }
  };

  const he = language === 'he';
  // The same time-of-day sky as Today (canvas v4) — the chat is home now.
  const sky = useSky();
  const bell = useBellCount();
  // The six tiles (her pick, 27.10). The day views are Today's own; "how do I
  // get there" asks Meira the way to the NEXT task, so the answer is the real
  // route card (AnswerCard), not a screen to read it from.
  const onTile = (tile: HomeTile) => {
    const next = brief?.next;
    // The place may come from a calendar invite someone else wrote: sent as her
    // words, so it is cut short and stripped of long digit runs (no phone number
    // rides into "her" message — security review 27.10).
    const rawPlace = next && typeof next.location === 'object'
      ? (next.location?.displayName || next.location?.address) : undefined;
    const place = rawPlace ? rawPlace.replace(/\d{7,}/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) : undefined;
    switch (tile) {
      case 'today': case 'tomorrow': case 'pick':
        navigation.navigate('Today', { day: tile, nonce: Date.now() });
        return;
      case 'add':
        navigation.navigate('AddTask');
        return;
      case 'next':
        if (next) navigation.navigate('TaskDetail', { taskId: next.id });
        else lumiSay(he ? 'אין משימה בשעה קבועה בהמשך היום.' : 'Nothing else with a set time today.');
        return;
      case 'route': {
        // Rung 0 (cost review, 27.10): the next task usually has its route saved
        // already — say it from there, free, and ask Meira only when there is none.
        const loc = next && typeof next.location === 'object' ? next.location : undefined;
        const ride = next ? ridesOf(next)[0] : undefined;
        if (next && loc?.leaveHomeBy) {
          const via = ride?.departureTime
            ? `${RIDE_ICON[ride.type] || '🚌'} ${ride.lineNumber ? `${ride.lineNumber} ` : ''}${he ? 'יוצא' : 'leaves'} ${ride.departureTime}`
            : '';
          const arrive = loc.transitPlan?.arriveAt;
          lumiSay([
            he ? `ל${next.text}: צאי ב־${loc.leaveHomeBy}` : `To ${next.text}: leave at ${loc.leaveHomeBy}`,
            via,
            arrive ? (he ? `מגיעה ${arrive}` : `arrive ${arrive}`) : '',
          ].filter(Boolean).join(' · '));
          return;
        }
        if (next && place) void send(he ? `איך אני מגיעה ל${place}?` : `How do I get to ${place}?`);
        else if (next) lumiSay(he ? `ל"${next.text}" אין מקום עדיין — הוסיפי מקום ואחשב את הדרך.` : `"${next.text}" has no place yet — add one and I'll work out the way.`);
        else lumiSay(he ? 'אין משימה בהמשך היום שצריך להגיע אליה.' : 'Nothing later today to get to.');
        return;
      }
    }
  };
  const fromThisVisit = (m: Message) => (m.ts ?? 0) >= sessionStart.current && !m.greet;
  const shown = home && !showHistory ? messages.filter(fromThisVisit) : messages;
  const hasEarlier = home && messages.some((m) => !fromThisVisit(m) && !m.greet);

  const homeChip = (
    <TouchableOpacity key="home-here" style={styles.chip} onPress={askLocationAsHome} disabled={locating}>
      {locating ? <ActivityIndicator color={BRAND.sunGold} size="small" />
        : <Text style={styles.chipText}>{language === 'he' ? HOME_HERE_CHIP.he : HOME_HERE_CHIP.en}</Text>}
    </TouchableOpacity>
  );

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <SkyBackdrop sky={sky} />
      {/* Header — drawn on the sky, ink chosen by its contrast */}
      {/* Hebrew reads right to left: Meira's face and name on the right, ☰ on the left. */}
      <View style={[styles.header, { paddingTop: insets.top + 8, flexDirection: he ? 'row-reverse' : 'row' }]}>
        {/* The home panel below already shows her face large — one face per screen. */}
        {home && !shown.length ? null : <MeiraCoin size={36} label="Meira" />}
        <View style={styles.headerText}>
          <Text style={[styles.headerName, { color: sky.ink }, he && styles.rtlText]}>{he ? 'מאירה' : 'Meira'}</Text>
          <Text style={[styles.headerStatus, sky.dark && { color: '#7BE8C6' }, he && styles.rtlText]}>{he ? '● מחוברת' : '● online'}</Text>
        </View>
        {home ? (
          <TouchableOpacity onPress={() => navigation.navigate('Today', { openBell: Date.now() })} style={styles.closeBtn}
            accessibilityLabel={he ? `התראות${bell ? ` — ${bell}` : ''}` : `Alerts${bell ? ` — ${bell}` : ''}`}>
            <LineIcon name="bell" size={20} color={BRAND.warmInk} />
            {bell ? <View style={styles.bellBadge}><Text style={styles.bellBadgeText}>{bell}</Text></View> : null}
          </TouchableOpacity>
        ) : null}
        {home ? (
          <TouchableOpacity onPress={() => navigation.navigate('SettingsMenu')} style={styles.closeBtn}
            accessibilityLabel={he ? 'תפריט' : 'Menu'}>
            <LineIcon name="menu" size={20} color={BRAND.warmInk} />
          </TouchableOpacity>
        ) : (
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.closeBtn}>
            <Text style={styles.closeBtnText}>✕</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Messages */}
      <ScrollView
        ref={scrollRef}
        style={styles.messages}
        contentContainerStyle={styles.messagesContent}
        showsVerticalScrollIndicator={false}
        // At home, the panel stays in view until this visit has a conversation.
        onContentSizeChange={() => { if (!home || shown.length) scrollRef.current?.scrollToEnd({ animated: false }); }}
      >
        {home ? (
          <MeiraHomePanel
            he={he}
            name={firstName}
            next={brief?.now ?? brief?.next}
            leaveAt={brief?.now ? undefined : brief?.leaveAt}
            onTile={onTile}
            onAsk={(text) => (isStarter(text) ? setInput(text.replace(/…\s*$/, ' ')) : void send(text))}
            onPrefill={(a) => navigation.navigate('AddTask', {
              initialText: he ? (a.textHe ?? a.text) : a.text, initialTime: a.time, initialDate: a.date,
            })}
            onOpenTask={(id) => navigation.navigate('TaskDetail', { taskId: id })}
            onChanged={loadBrief}
          />
        ) : null}
        {hasEarlier ? (
          <TouchableOpacity onPress={() => setShowHistory((v) => !v)} style={styles.historyLink} accessibilityRole="button">
            <Text style={styles.historyLinkText}>
              {showHistory ? (he ? 'להסתיר שיחות קודמות' : 'Hide earlier chat') : (he ? 'שיחות קודמות ›' : 'Earlier chat ›')}
            </Text>
          </TouchableOpacity>
        ) : null}
        {shown.map((msg) =>
          msg.homeAsk ? (
            <View key={msg.id} style={styles.cardsRow}>
              <HomeConfirmCard ask={msg.homeAsk} he={language === 'he'}
                onAnswer={(yes) => answerHome(msg.id, msg.homeAsk!, yes)} />
              {/* The card outlives the day in the kept history: say when the fix was taken. */}
              {msg.ts ? <Text style={styles.msgStamp}>{stampOf(msg.ts)}</Text> : null}
            </View>
          ) : msg.cards?.length ? (
            <View key={msg.id} style={styles.cardsRow}>
              {msg.cards.map((c, i) => (
                <LearnedCard key={`${msg.id}-${i}`} change={c} he={language === 'he'}
                  onOpenYou={() => navigation.navigate('ProfileEdit')} />
              ))}
            </View>
          ) : msg.role === 'lumi' ? (
            <View key={msg.id} style={styles.lumiCol}>
              {/* Long-press a Lumi bubble to reply to that specific message. */}
              <TouchableOpacity
                style={styles.lumiBubble}
                onLongPress={() => setQuoted(msg.text)}
                delayLongPress={300}
                activeOpacity={0.85}
              >
                <Text style={styles.lumiText} selectable>
                  {msg.greet ? GREETING[msg.greet][language === 'he' ? 'he' : 'en'] : msg.text}
                </Text>
                {msg.ts ? <Text style={styles.msgStamp}>{stampOf(msg.ts)}</Text> : null}
              </TouchableOpacity>
              {/* Visible, not hidden behind a long-press (silent-state rule 5). */}
              {!msg.greet && msg.text ? (
                <View style={styles.reactRow}>
                  {(['up', 'down'] as const).map((r) => (
                    <TouchableOpacity key={r} onPress={() => react(msg, r)}
                      style={[styles.reactBtn, msg.reaction === r && styles.reactBtnOn]}
                      accessibilityLabel={r === 'up' ? (language === 'he' ? 'תשובה טובה' : 'Good answer')
                        : (language === 'he' ? 'תשובה לא טובה' : 'Bad answer')}
                      hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}>
                      <Text style={[styles.reactIcon, msg.reaction && msg.reaction !== r && styles.reactIconDim]}>
                        {r === 'up' ? '👍' : '👎'}
                      </Text>
                    </TouchableOpacity>
                  ))}
                  <TouchableOpacity onPress={() => setQuoted(msg.text)} style={styles.reactBtn}
                    accessibilityLabel={language === 'he' ? 'להשיב להודעה הזו' : 'Reply to this message'}
                    hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}>
                    <Text style={styles.reactReply}>{language === 'he' ? '↩ השיבי' : '↩ Reply'}</Text>
                  </TouchableOpacity>
                </View>
              ) : null}
              {msg.answer ? (
                <AnswerCard answer={msg.answer} he={language === 'he'}
                  onAsk={(text, now) => (now ? send(text) : setInput(text))}
                  onSay={lumiSay} />
              ) : null}
              {msg.chain ? <ChainCard chain={msg.chain} he={language === 'he'} /> : null}
              {/* Only on the latest reply: an old question's buttons would answer a question no longer asked. */}
              {msg.replies?.length && msg.id === shown[shown.length - 1]?.id ? (
                <View style={[styles.replyRow, language === 'he' && { flexDirection: 'row-reverse' }]}>
                  {msg.replies.map((r) => (
                    <TouchableOpacity key={r} style={styles.replyChip} onPress={() => send(r)} accessibilityRole="button">
                      <Text style={styles.replyChipText} numberOfLines={2}>{r}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              ) : null}
            </View>
          ) : (
            <View key={msg.id} style={styles.userRow}>
              <View style={styles.userBubble}>
                {msg.replyTo ? (
                  <View style={styles.replyQuote}>
                    <Text style={styles.replyQuoteText} numberOfLines={2}>{msg.replyTo}</Text>
                  </View>
                ) : null}
                <Text style={styles.userText} selectable>{msg.voice ? `🎤 ${msg.text}` : msg.text}</Text>
                {msg.ts ? <Text style={[styles.msgStamp, styles.msgStampUser]}>{stampOf(msg.ts)}</Text> : null}
              </View>
              {msg.voice ? (
                // What the mic heard, one tap from fixed and sent again.
                <TouchableOpacity onPress={() => setInput(msg.text)} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                  <Text style={styles.heard}>{language === 'he' ? 'שמעתי ככה ✏️' : 'Heard this ✏️'}</Text>
                </TouchableOpacity>
              ) : null}
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

      {/* What can I ask? — starters per theme; one that ends in "…" goes into the box to finish. */}
      {showExamples ? (
        <ScrollView style={styles.examples} contentContainerStyle={styles.examplesContent} keyboardShouldPersistTaps="handled">
          {ASK_GROUPS.map((g) => (
            <View key={g.id} style={styles.exGroup}>
              <Text style={[styles.exTitle, language === 'he' && styles.exRtl]}>
                {`${g.icon} ${language === 'he' ? g.titleHe : g.titleEn}`}
              </Text>
              <View style={[styles.exRow, language === 'he' && styles.exRowRtl]}>
                {g.examples.map((ex) => {
                  const text = language === 'he' ? ex.he : ex.en;
                  return (
                    <TouchableOpacity key={ex.id} style={styles.exChip} accessibilityRole="button"
                      onPress={() => {
                        setShowExamples(false);
                        if (isStarter(text)) setInput(text.replace(/…\s*$/, ' '));
                        else void send(text);
                      }}>
                      <Text style={styles.chipText}>{text}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          ))}
        </ScrollView>
      ) : null}

      {/* Suggestion chips. 📍 lives here, not beside the 🎤 (7.10): first while
          there is no home yet, last once there is. It only ever ASKS. */}
      {home && !shown.length ? null : (
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chips} contentContainerStyle={styles.chipsContent}>
        <TouchableOpacity style={[styles.chip, showExamples && styles.chipOn]} accessibilityRole="button"
          onPress={() => setShowExamples((v) => !v)}>
          <Text style={styles.chipText}>{language === 'he' ? '💡 מה אפשר לשאול?' : '💡 What can I ask?'}</Text>
        </TouchableOpacity>
        {!hasHome && homeChip}
        {(dynamicChips?.length ? dynamicChips : language === 'he' ? CHIPS_HE : CHIPS_EN).map((chip) => (
          <TouchableOpacity key={chip} style={styles.chip} onPress={() => send(chip)}>
            <Text style={styles.chipText}>{chip}</Text>
          </TouchableOpacity>
        ))}
        {hasHome && homeChip}
      </ScrollView>
      )}

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
        <ChatMic
          ref={micRef}
          he={language === 'he'}
          style={styles.micBtn}
          activeStyle={styles.micBtnActive}
          onPhase={setMicPhase}
          onText={(heard) => {
            const text = preprocessTranscript(heard, language);
            // Meira is still answering the last one: keep it in the box, never drop it.
            if (loading) setInput(text);
            else void send(text, { voice: true });
          }}
          onError={lumiSay}
        />
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder={listening ? (language === 'he' ? 'מקשיבה… הקישי 🔴 כשסיימת' : 'Listening… tap 🔴 when done')
            : micPhase === 'transcribing' ? (language === 'he' ? 'מתמללת…' : 'Transcribing…')
              : language === 'he' ? 'ספרי למאירה…' : 'Ask Meira anything…'}
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
  historyLink: { alignSelf: 'center', minHeight: 40, justifyContent: 'center', paddingHorizontal: 14, borderRadius: RADIUS.pill, backgroundColor: 'rgba(255,255,255,0.8)' },
  historyLinkText: { fontFamily: FONTS.bodyHeavy, fontSize: 12, color: BRAND.goldInk },

  header: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 16, paddingBottom: 12,
  },
  headerText: { flex: 1 },
  rtlText: { textAlign: 'right', writingDirection: 'rtl' },
  bellBadge: {
    position: 'absolute', top: -2, right: -2, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4,
    backgroundColor: BRAND.danger, alignItems: 'center', justifyContent: 'center',
  },
  bellBadgeText: { fontFamily: FONTS.bodyHeavy, fontSize: 10, color: BRAND.white },
  replyRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  replyChip: {
    minHeight: 44, maxWidth: '100%', justifyContent: 'center', paddingHorizontal: 16, paddingVertical: 6, borderRadius: 22,
    backgroundColor: BRAND.sunGold,
  },
  replyChipText: { fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.onGold },
  headerName: { fontSize: 17, fontFamily: FONTS.display, color: BRAND.warmInk },
  headerStatus: { fontSize: 12, fontFamily: FONTS.bodySemi, color: BRAND.success },
  closeBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.75)', alignItems: 'center', justifyContent: 'center',
  },
  closeBtnText: { fontSize: 14, color: BRAND.inkSoft, fontFamily: FONTS.bodyBold },

  messages: { flex: 1 },
  messagesContent: { padding: 16, gap: 12 },

  lumiRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  cardsRow: { gap: 6, paddingHorizontal: 4 },
  lumiBubble: {
    backgroundColor: BRAND.creamCard, borderRadius: 20, borderBottomLeftRadius: 6,
    paddingHorizontal: 14, paddingVertical: 10, maxWidth: '78%',
    ...SHADOWS.card,
  },
  lumiText: { fontSize: 14, fontFamily: FONTS.body, color: BRAND.warmInk, lineHeight: 20 },
  msgStamp: { fontSize: 10, fontFamily: FONTS.body, color: BRAND.inkFaint, marginTop: 3, alignSelf: 'flex-end' },
  msgStampUser: { color: 'rgba(255,255,255,0.75)' },

  userRow: { alignItems: 'flex-end' },
  // A reply with a card: the bubble, and the card full-width under it.
  lumiCol: { alignItems: 'flex-start', gap: 2 },
  heard: { fontFamily: FONTS.body, fontSize: 11, color: BRAND.inkSoft, marginTop: 2, marginRight: 4, paddingHorizontal: 6, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.7)', overflow: 'hidden' },
  userBubble: {
    borderRadius: 20, borderBottomRightRadius: 6,
    paddingHorizontal: 14, paddingVertical: 10, maxWidth: '78%',
    backgroundColor: BRAND.sunGold,
    ...SHADOWS.button,
  },
  userText: { fontSize: 14, fontFamily: FONTS.body, color: BRAND.creamCard, lineHeight: 20 },
  replyQuote: {
    borderLeftWidth: 3, borderLeftColor: BRAND.creamCard, backgroundColor: 'rgba(255,255,255,0.18)',
    borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4, marginBottom: 6,
  },
  replyQuoteText: { fontSize: 12, fontFamily: FONTS.body, color: BRAND.creamCard, lineHeight: 16 },
  reactRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2, marginLeft: 4 },
  reactBtn: { minHeight: 32, minWidth: 36, paddingHorizontal: 6, borderRadius: RADIUS.pill, backgroundColor: 'rgba(255,255,255,0.7)',
    alignItems: 'center', justifyContent: 'center' },
  reactBtnOn: { backgroundColor: BRAND.honey },
  reactIcon: { fontSize: 15 },
  reactIconDim: { opacity: 0.35 },
  reactReply: { fontSize: 12, fontFamily: FONTS.bodySemi, color: BRAND.inkSoft },

  chips: { flexGrow: 0, borderTopWidth: 1, borderTopColor: BRAND.line },
  chipsContent: { padding: 10, gap: 8 },
  chip: {
    backgroundColor: BRAND.honey, borderRadius: RADIUS.pill,
    paddingHorizontal: 14, paddingVertical: 8,
  },
  chipText: { fontSize: 13, fontFamily: FONTS.bodyBold, color: BRAND.warmInk },
  chipOn: { backgroundColor: BRAND.sunGold },
  examples: { flexGrow: 0, maxHeight: 280, borderTopWidth: 1, borderTopColor: BRAND.line, backgroundColor: BRAND.creamCard },
  examplesContent: { padding: 12, gap: 12 },
  exGroup: { gap: 6 },
  exTitle: { fontSize: 13, fontFamily: FONTS.bodyHeavy, color: BRAND.inkSoft },
  exRtl: { textAlign: 'right', writingDirection: 'rtl' },
  exRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  exRowRtl: { flexDirection: 'row-reverse' },
  exChip: { backgroundColor: BRAND.honey, borderRadius: RADIUS.pill, paddingHorizontal: 14, paddingVertical: 8 },

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
  micBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: BRAND.honey, alignItems: 'center', justifyContent: 'center',
  },
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
