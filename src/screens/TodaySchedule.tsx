/**
 * TodaySchedule — today's timeline with rollover and completion actions.
 * Also: 🔊 spoken day briefing (button + first-open-of-day offer banner).
 * Dependencies: TaskStorage, MorningBriefingService, SpeechService.
 */
import { allDayLabel, coversDay, isAllDay } from '../utils/allDay';
import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View, ScrollView, StyleSheet, Text, TouchableOpacity, ActivityIndicator, Alert, Linking,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import AsyncStorage from '../services/EncryptedStorage';  // AES-256-GCM at rest (7.10)
import DateTimePicker from '@react-native-community/datetimepicker';
import { useFocusEffect, useRoute } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BRAND, FONTS, MIN_TOUCH, RADIUS, SHADOWS, surf, nink, nline } from '../constants/theme';
import { getTodayString, getTomorrowString, sortTasksByPriorityAndTime } from '../utils/timeUtils';
import { endedBy } from '../utils/taskEnd';
import {
  getTasksForDate, loadSchedule, getSettings,
  markTaskComplete, updateTaskFields, deleteTask,
  loadGoals, addTask,
  getOverdueTasks, moveTasksToDate, letGoTasks,
  getAllTasks, getAllTasksChecked, getLocalTasks, getLocalSettings,
} from '../services/TaskStorage';
import { addMinutes, timeToMinutes } from '../utils/timeUtils';
import { FALLBACK_PLACE, INK as SKY_INK, skyFor, sunTimes } from '../utils/skyGradient';
import { lateNotice } from '../utils/lateNotice';
import InterviewPrepHeader from '../components/today/InterviewPrepHeader';
import { hydrateCustomCategories, getCategoryMeta } from '../constants/categories';
import { findSameThingGroups, mergedInto, SameThingGroup } from '../utils/likelySameTask';
import SameThingCard from '../components/SameThingCard';
import { Task, DailySchedule, AppLanguage } from '../types';
import TaskDetailBottomSheet from '../components/TaskDetailBottomSheet';
import { emitLumiMood } from '../services/LumiMood';
import { speakMorningBriefingNow } from '../services/MorningBriefingService';
import { speak, stopSpeaking } from '../services/SpeechService';
import { scheduleFocusCheckIns, armMissingTaskAlerts } from '../services/NotificationService';
import { armDueAlarms } from '../services/AlarmPlanner';
import { plannedAlarmTime, wakeInputs, earliestWakeOf, wakeChipFor, getReadyTimeFor } from '../utils/alarmPlan';
import {
  getGmailEventSuggestions, acceptGmailSuggestion, dismissGmailSuggestion,
  ensureTravelChain, getNextUpcomingTask, lastCalendarFailure, sweepStalePrep,
} from '../services/GoogleSync';
import { syncCalendarDate, syncCalendarNow, onCalendarSync } from '../services/CalendarAutoSync';
import { onDayChanged, onDayPlanned } from '../services/DayEvents';
import TaskPrepCard from '../components/TaskPrepCard';
import { prepForTask } from '../services/TaskPrepService';
import { TaskPrepResult } from '../services/LumiServer';
import LineIcon from '../components/ui/LineIcon';
import MeiraCoin from '../components/MeiraCoin';
import BottomSheet from '../components/ui/BottomSheet';
import MeetingBriefCard from '../components/MeetingBriefCard';
import YesterdayCard from '../components/YesterdayCard';
import { GapSuggestionCard } from '../components/GapSuggestionCard';
import TravelChainCard from '../components/TravelChainCard';
import { normalizeProfile } from '../utils/profileShape';
import { ModeQuote } from '../components/TimelineTravelLeg';
import TransitOptionsList from '../components/TransitOptionsList';
import { splitDayTasks, isStandingTask, sortFlexible, isFlexibleTask } from '../utils/taskShape';
import AlertsSheet from '../components/today/AlertsSheet';
import { waitingList, WaitingItem } from '../utils/waitingList';
import { asLocation, toChainProfile } from '../utils/buildTravelChain';
import {
  replanFromNextDeparture, describeNextDeparture, nextDepartureOptions, applyDepartureOption,
  markArrivals, replanFromOrigin, keepNextTripLive, confirmDeparture,
} from '../services/LiveRoute';
import DayCard from '../components/today/DayCard';
import MorningAlarmPill, { useMorningAlarm } from '../components/today/MorningAlarmPill';
import DayGoalCard from '../components/today/DayGoalCard';
import { loadDayGoal } from '../services/DayGoalService';
import NowLine from '../components/today/NowLine';
import NowAddRow from '../components/today/NowAddRow';
import SuggestPanel from '../components/today/SuggestPanel';
import OverlapPick from '../components/today/OverlapPick';
import PairCard from '../components/today/PairCard';
import DayRing from '../components/today/DayRing';
import CompactRow from '../components/today/CompactRow';
import TrayDock, { DragGhost, GhostHandle } from '../components/today/TrayDock';
import { DropZone, timeInWindow, zoneAt } from '../utils/dropSlot';
import { applyScheduleAction } from '../services/AddSuggestionSources';
import { diffDay, knockOnIds, snapshotDay } from '../utils/dayDiff';
import PairAdviceModal from '../components/today/PairAdviceModal';
import { adviseOverlap } from '../utils/pairAdvice';
import ClashQuestion from '../components/today/ClashQuestion';
import EarlierRow from '../components/today/EarlierRow';
import { dayProblems, moveSlotFor, TravelProblem } from '../utils/dayProblems';
import { travelRowState } from '../utils/travelRowState';
import { ridesOf } from '../utils/rideLine';
import { isRemoteTask } from '../utils/meetingLink';
import { collapseSameMeetings } from '../utils/calendarEventTask';
import { classifyCalendarError, calendarErrorLine } from '../utils/calendarErrorKind';
import { lateBy as minutesLate, missedPlannedDeparture, stillWorthGoingUntil } from '../utils/liveRoutePlan';
import { answerRunningLate, onLateAnswered, setNewDate } from '../services/RunningLate';
import { markSeen, onChangesChanged, openChanges } from '../services/ChangeRecordStore';
import { setBellCount } from '../services/BellCount';
import { answerFeasibility, checkBeforeSave } from '../services/ScheduleQueryService';
import { HourRuler, RulerHandle } from '../components/today/HourRuler';
import { HourRow, hourRows } from '../utils/hourRows';
import { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { ChangeRecord, headline } from '../utils/changeRecord';
import { followUpOriginal, isFromCalendar } from '../utils/liveRoutePlan';
import { isHighStakes } from '../utils/travelLadder';
import { DepartureOption, departureUncatchable, minutesToDecide } from '../utils/departureOptions';
import {
  dayPresence, describeDayPresence, DayPresenceVerdict,
} from '../utils/presence';
import { freedTimeLine, leftEarly, leftEarlyLine, LeftEarlyVerdict } from '../utils/leftEarly';
import { GoogleService } from '../services/GoogleService';
import { loadProfile } from '../services/UserProfileStorage';
import { rememberTravelChoice } from '../services/TravelPreferenceStore';
import { getUserId, signInWithGoogle } from '../services/SupabaseAuthService';
import { isSupabaseConfigured } from '../services/supabaseClient';
import { UserProfile, TransportType, TransitPlan } from '../types';
import { GapSuggestion } from '../types/index';
import GapSlotRow from '../components/GapSlotRow';
import { DayGap, findDayGaps, plusSlot, PLUS_MIN_MINUTES } from '../utils/findGaps';
import { GapIdea, applyGapIdea, loadRoutines, onRoutinesChanged, suggestForGap } from '../services/GapFillService';
import * as Questions from '../services/QuestionService';
import { suggestReschedule } from '../utils/overlapKind';
import { Routine, constrainGaps } from '../utils/routines';
import { RoutineRow as RoutineRowData, routineRowsFor } from '../utils/routineRows';
import RoutineRow from '../components/today/RoutineRow';
import { getCurrentLocation, describeHere } from '../services/LocationService';
import { nextMeetingBrief, upcomingInterviewBriefs, interviewBrief, InterviewBrief } from '../services/MeetingBriefService';
import { interviewChipLabel, prepBlockChipLabel, briefReasonLine } from '../utils/interviewBrief';
import { MeetingBriefResult } from '../services/LumiServer';
import { perfFirstPaint, perfMark } from '../utils/perf';
import { N, NIGHT_COLORS } from '../constants/nightTone';
import { THEME_NIGHT } from '../constants/theme';
import { NIGHT as NIGHT_SKY } from '../utils/skyGradient';

// Once-per-day flag for the "want to hear your day?" offer banner.
const BRIEFING_OFFERED_KEY = 'lumi.briefingOffered.v1';
// Groups the user has said are genuinely different things — never asked again.
const SAME_THING_DISMISSED_KEY = 'lumi.sameThingDismissed.v1';
// Her answer to a day problem (2D "which one?", 3C "can't make it"), per date —
// an answered question is not asked again that day.
const PROBLEM_ANSWERS_KEY = 'lumi.problemAnswers.v1';
// Pairs whose advice popup was already shown — once each, then only the row.
const PAIR_ADVICE_SHOWN_KEY = 'meira.pairAdviceShown.v1';
/** Routines she waved off, by date: { 'YYYY-MM-DD': ['קיקבוקס|20:30'] }. */
const ROUTINE_SKIPS_KEY = 'lumi.routineSkips.v1';

/** "2026-09-30" → "2026-10-01", on the phone's own calendar. */
function dayAfter(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  const next = new Date(y, (m || 1) - 1, (d || 1) + 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`;
}

/** Who to ask when a meeting has to move: the saved contact, else "with Dana" / "עם דנה". */
function askNameOf(task: Task): string | undefined {
  const saved = (task as any).contact?.name;
  if (saved) return String(saved).split(' ')[0];
  return /(?:with|עם)\s+([^\s,.·—-]+)/i.exec(task.text)?.[1];
}
// Once-per-day flag hiding the free-time goal suggestion after a reject.
const GAP_DISMISSED_KEY = 'lumi.gapDismissed.v1';
// Whether the suggestions drawer is expanded. Collapsed is the default: they
// are optional extras and must not compete with the schedule on first paint.
const SUGGESTIONS_OPEN_KEY = 'lumi.suggestionsOpen.v1';

/**
 * First ≥60-min hole between timed pending tasks (or after the last one,
 * before 20:00) — kept for the once-a-day wish-list banner only. Everything
 * that draws free time on the timeline uses utils/findGaps, which also sees
 * the window before the first task and stops at the departure time.
 */
function findGap(tasks: Task[]): { start: string; end: string } | null {
  const timed = tasks
    .filter((t) => t.status !== 'complete' && (t.scheduledTime || t.fixedTime))
    .map((t) => ({ start: (t.scheduledTime || t.fixedTime)!, dur: t.durationMinutes || 30 }))
    .sort((a, b) => (a.start < b.start ? -1 : 1));
  if (timed.length === 0) return null;
  for (let i = 0; i < timed.length - 1; i++) {
    const end = addMinutes(timed[i].start, timed[i].dur);
    if (timeToMinutes(timed[i + 1].start) - timeToMinutes(end) >= 60) {
      return { start: end, end: timed[i + 1].start };
    }
  }
  const lastEnd = addMinutes(timed[timed.length - 1].start, timed[timed.length - 1].dur);
  if (timeToMinutes(lastEnd) < timeToMinutes('20:00')) return { start: lastEnd, end: '20:00' };
  return null;
}

/** "Thu, 11 Sep" — a day that is neither today nor tomorrow needs a name. */
function formatDayLabel(dateKey: string, language: AppLanguage): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1).toLocaleDateString(
    language === 'he' ? 'he-IL' : 'en-GB',
    { weekday: 'short', day: 'numeric', month: 'short' },
  );
}

/** In her language, and honest about the hour — 03:28 is not "Good morning" (seen 28.10). */
function getGreeting(he: boolean): string {
  const h = new Date().getHours();
  if (h < 5 || h >= 22) return he ? 'לילה טוב' : 'Good night';
  if (h < 12) return he ? 'בוקר טוב' : 'Good morning';
  if (h < 17) return he ? 'צהריים טובים' : 'Good afternoon';
  return he ? 'ערב טוב' : 'Good evening';
}

// Today's FOCUS = the most important pending task, not just the first one:
// interview/exam/deadline words weigh heaviest, then priority, then fixed time.
const FOCUS_KEYWORDS = /interview|exam|test|deadline|ראיון|מבחן|בחינה|דדליין|הגשה/i;

function pickFocusTask(pending: Task[]): Task | undefined {
  const score = (t: Task) =>
    (FOCUS_KEYWORDS.test(t.text) ? 4 : 0) +
    (t.priority === 'must' ? 2 : t.priority === 'have_to' ? 1 : 0) +
    (t.isFixed ? 1 : 0);
  return [...pending].sort((a, b) => score(b) - score(a))[0];
}

const FOCUS_MOTIVATION_EN = [
  "You've got this! 💪", 'One step at a time — go! ✨', "Today's the day. 🚀",
];
const FOCUS_MOTIVATION_HE = [
  'את/ה יכול/ה! 💪', 'צעד אחר צעד — קדימה! ✨', 'היום זה קורה. 🚀',
];

/** The line under the pill when Meira prepared something. */
function prepLabel(p: TaskPrepResult, he: boolean): string {
  const n = (he ? p.items_he : p.items_en)?.length ?? 0;
  switch (p.kind) {
    case 'songs': return he ? `🎤 ${n} שירים לתרגל, עם מילים ›` : `🎤 ${n} songs to practise, with lyrics ›`;
    case 'questions': return he ? `❓ מה להביא ומה לשאול ›` : `❓ What to bring and ask ›`;
    case 'checklist': return he ? `✅ רשימה להכנה ›` : `✅ A checklist to get ready ›`;
    case 'route_tips': return he ? `🧭 טיפים לדרך ›` : `🧭 Tips before you go ›`;
    case 'ideas': return he ? `💡 ${n} רעיונות ›` : `💡 ${n} ideas ›`;
    default: return he ? `🔎 מאירה הכינה לך ${n} דברים ›` : `🔎 Meira prepared ${n} things ›`;
  }
}

function asLoc(t?: Task) {
  // Must tolerate undefined — departureTask below is a .find() that can miss.
  return t && t.location && typeof t.location === 'object' ? t.location : undefined;
}

interface TodayScheduleProps { navigation: any }

export default function TodaySchedule({ navigation }: TodayScheduleProps) {
  const insets = useSafeAreaInsets();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  // What went wrong during the last voice plan — a task that did not fit, a
  // calendar that was not checked. Stays until dismissed (silent-state rule 3).
  const [planProblems, setPlanProblems] = useState<string[]>([]);
  // Per-task line from the last route recompute ("next bus …"), shown on the card.
  const [replanNotes, setReplanNotes] = useState<Record<string, string>>({});
  // Other ways to make a trip, fetched only when she asks (one Google call).
  const [alternatives, setAlternatives] = useState<Record<string, TransitPlan[]>>({});
  const [language, setLanguage] = useState<AppLanguage>('en');
  const [speaking, setSpeaking] = useState(false);
  const [showBriefingOffer, setShowBriefingOffer] = useState(false);
  const [emailSuggestions, setEmailSuggestions] = useState<GapSuggestion[]>([]);
  // Profile in types/ shape — the chain needs transportType + routine minutes.
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [goalSuggestion, setGoalSuggestion] = useState<GapSuggestion | null>(null);
  /** The next timed thing across the days ahead — not just today's column. */
  const [nextUp, setNextUp] = useState<Task | null>(null);
  // The researched brief for whatever nextUp turns out to be. Null is the
  // normal case — most of what is next is a gym session, not a meeting with
  // strangers — and the card simply does not render.
  const [meetingBrief, setMeetingBrief] = useState<MeetingBriefResult | null>(null);
  const [briefTaskId, setBriefTaskId] = useState<string | null>(null);
  const [briefRefreshing, setBriefRefreshing] = useState(false);
  // The interviews coming up (today's still ahead, tomorrow's, the day after's)
  // and what the server made of each — INCLUDING "could not": an interview whose
  // brief failed keeps its chip, and the sheet says why. Tomorrow's 13:30 is
  // not "next up" while today still has things in it, so before this it was
  // never researched and had no chip at all (Koral, 17.10).
  const [ivBriefs, setIvBriefs] = useState<InterviewBrief[]>([]);
  // Which task's brief the sheet shows — a study block opens its INTERVIEW's.
  const [briefSheetId, setBriefSheetId] = useState<string | null>(null);
  const [ivRefreshing, setIvRefreshing] = useState(false);
  const [ivNote, setIvNote] = useState('');
  const ivSeq = useRef(0);
  /**
   * Research the interviews ahead. TRIGGERS (rule 7): this screen coming into
   * focus, picking another day, the focus load and its calendar sync
   * (refreshNextUp), and a calendar sync landing something while she is here
   * (onCalendarSync below). A cached answer is one AsyncStorage read and a
   * refusal is remembered for six hours, so asking this often costs nothing.
   * NOT covered: the app closed or in another screen — see CalendarAutoSync.
   */
  const refreshInterviewBriefs = useCallback(async () => {
    const seq = ++ivSeq.current;
    const { briefs, error } = await upcomingInterviewBriefs(false, (soFar) => {
      // The first chip need not wait for the second; what is already drawn for
      // the others stays until the whole pass lands, so nothing flickers off.
      if (seq === ivSeq.current) {
        setIvBriefs((prev) => [...prev.filter((p) => !soFar.some((s) => s.task.id === p.task.id)), ...soFar]);
      }
    });
    if (seq !== ivSeq.current) return;      // a newer ask is already in flight
    if (error) return;                       // unreadable ≠ none: keep what is drawn
    setIvBriefs(briefs);
  }, []);

  // Research whatever is next, once per task. Cached answers cost one
  // AsyncStorage read, and a refusal ("gym" — nothing to look up) is cached
  // too, so this does NOT hit the server on every render. `cancelled` guards
  // the case where the user's next task changes while a brief is in flight —
  // otherwise a slow brief for the old task overwrites the new one's.
  useEffect(() => {
    if (!nextUp) { setMeetingBrief(null); setBriefTaskId(null); return; }
    if (briefTaskId === nextUp.id) return;
    let cancelled = false;
    (async () => {
      const res = await nextMeetingBrief();
      if (cancelled) return;
      setMeetingBrief(res?.brief ?? null);
      setBriefTaskId(res?.task.id ?? nextUp.id);
    })();
    return () => { cancelled = true; };
  }, [nextUp?.id]);
  // Prepare for whatever the pill shows. A meeting with a brief is covered;
  // everything else asks the server once (cached on both sides). Rule 7's
  // trigger: the pill's task changing — which is every Today load and every
  // time the next thing moves.
  useEffect(() => {
    const t = nextUp;
    if (!t) { setPrep(null); return; }
    if (prep?.taskId === t.id) return;
    let cancelled = false;
    (async () => {
      const res = await prepForTask(t);
      if (cancelled) return;
      setPrep(res ? { taskId: t.id, text: t.text, result: res } : null);
    })();
    return () => { cancelled = true; };
  }, [nextUp?.id, nextUp?.text]);
  // Pending tasks stranded on earlier dates. They used to be invisible here —
  // this screen only ever queried today — so an unfinished task was simply lost.
  const [overdue, setOverdue] = useState<Task[]>([]);
  // Rows that look like one appointment worded three ways. Asked about, never
  // merged behind her back.
  const [sameThing, setSameThing] = useState<SameThingGroup[]>([]);
  // Her standing week: the Monday gym to offer, and the 16:00 school run that
  // means those two hours were never free in the first place.
  const [routines, setRoutines] = useState<Routine[]>([]);
  // An answer, an edit or a fact saved in the chat changed her routines: redraw
  // the rows now, not after the 10-minute cache.
  useEffect(() => onRoutinesChanged(() => {
    loadRoutines()
      .then((rs) => { setRoutines(rs); Questions.refresh(rs).catch(() => {}); })
      .catch((e) => console.warn('[Today] routines reload failed', e));
  }), []);
  const [routineSkips, setRoutineSkips] = useState<Record<string, string[]>>({});
  useEffect(() => {
    AsyncStorage.getItem(ROUTINE_SKIPS_KEY)
      .then((raw) => setRoutineSkips(raw ? JSON.parse(raw) : {}))
      .catch((e) => console.warn('[Today] routine skips unreadable', e));
  }, []);
  // The task whose alarm hour is being changed (the ⏰ chip → "change time").
  const [alarmEditing, setAlarmEditing] = useState<{ task: Task; at: string } | null>(null);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  // Local-only mode was completely invisible: "continue offline" on the sign-in
  // screen left the app writing to AsyncStorage and nothing else, with no
  // indicator anywhere. Weeks of tasks lived only on the device while the
  // WhatsApp sync sat waiting for an account that was never created.
  const [signedIn, setSignedIn] = useState(true);
  /**
   * Google's own words when the last calendar pull was refused, else null.
   *
   * On screen, unprompted. She checked the calendar connection herself, was
   * told "connected", and the interview still was not there — because the
   * only surface that could report a refusal was a button in Profile she had
   * no reason to press twice. A failure she has to go looking for is a
   * failure she will not find. (THE SILENT-STATE RULE, 3 and 5.)
   */
  const [calendarError, setCalendarError] = useState<string | null>(null);
  // The task refresh could not reach the cloud: what is drawn is this phone's
  // copy, and she is told so (rule 1) — never a silent "this is everything".
  const [tasksCloudError, setTasksCloudError] = useState<string | null>(null);
  // Today's cards: one open at a time (the tapped-open card, pick "1").
  const [openCardId, setOpenCardId] = useState<string | null>(null);
  const [earlierOpen, setEarlierOpen] = useState(false);
  // "+ Add something" opens Meira's suggestions in place (Koral, 17.10).
  const [suggestOpen, setSuggestOpen] = useState(false);
  // What she chose for each day problem, on the day on screen.
  const [answered, setAnswered] = useState<Record<string, string>>({});
  const [pairShown, setPairShown] = useState<Record<string, boolean>>({});
  // A popup she opened by tapping the row, after it had already been shown once.
  const [pairOpenKey, setPairOpenKey] = useState<string | null>(null);
  useEffect(() => {
    AsyncStorage.getItem(PAIR_ADVICE_SHOWN_KEY)
      .then((raw) => setPairShown(raw ? JSON.parse(raw) : {}))
      .catch((e) => console.warn('[Today] pair advice state unreadable', e));
  }, []);
  const markPairShown = useCallback((key: string) => {
    setPairOpenKey(null);
    setPairShown((prev) => {
      // Newest 100 only: the map is ids, but it should not grow for ever.
      const next = Object.fromEntries(Object.entries({ ...prev, [key]: true }).slice(-100));
      AsyncStorage.setItem(PAIR_ADVICE_SHOWN_KEY, JSON.stringify(next))
        .catch((e) => console.warn('[Today] pair advice state not saved', e));
      return next;
    });
  }, []);
  // The car option for each travel problem: absent = still asking, null = none.
  const [faster, setFaster] = useState<Record<string, { minutes: number; lateBy: number } | null>>({});
  // Where she actually is — at home / in transit / standing in one of today's
  // places. Every route in this app assumed "at home, always"; this is the
  // input that makes the return leg of a round trip start from the right town.
  const [presence, setPresence] = useState<DayPresenceVerdict>({ state: 'unknown' });
  // She left a task's place before it ended (8.10): what was done, or asked.
  // Then the conclusion — her standing rule: location + calendar → what it
  // MEANS, said aloud and in a popup: "wow, you're back early — a good time
  // to study". The freed window runs from now to where the task used to end.
  const offerFreedTime = async (v: LeftEarlyVerdict, was: number, point: { lat: number; lng: number } | null) => {
    const he = language === 'he';
    const start = addMinutes(v.endAt, -v.durationMinutes);
    const until = addMinutes(start, was);
    const now = new Date().toTimeString().slice(0, 5);
    const minutes = timeToMinutes(until) - timeToMinutes(now);
    const gap: DayGap = { start: now, end: until, minutes } as DayGap;
    const ideas = minutes >= 20
      ? await suggestForGap(gap, { currentPoint: point, routines, language }).catch((e) => {
        console.warn('[Today] ideas for the freed time failed', e);
        return [] as GapIdea[];
      })
      : [];
    const idea = ideas[0];
    const line = freedTimeLine(until, idea ? (he ? idea.titleHe : idea.title) : undefined, v.atHome, he);
    speak(line, language).catch((e) => console.warn('[Today] speaking the freed time failed', e));
    Alert.alert(he ? 'מאירה' : 'Meira', line, idea ? [
      { text: he ? 'לא עכשיו' : 'Not now', style: 'cancel' },
      { text: he ? 'להוסיף להיום' : 'Add to today', onPress: () => {
        applyGapIdea(idea, gap).then(() => load(false))
          .catch((e) => Alert.alert(he ? 'מאירה' : 'Meira', he ? `לא הוספתי: ${String(e)}` : `Not added: ${String(e)}`));
      } },
    ] : [{ text: he ? 'סגירה' : 'OK' }]);
  };
  const [leftNote, setLeftNote] = useState<{ v: LeftEarlyVerdict; title: string; was: number } | null>(null);
  // The street she is standing in, in words. "In transit" between two unnamed
  // points is the least useful thing to be told, and she asked to always SEE
  // where she is — a fix nobody turns into a name is not that.
  const [hereLabel, setHereLabel] = useState<string | null>(null);
  // What the last automatic re-route did, and why. A leave time that changes
  // on its own is not trustworthy; one that says "you've moved — re-routed" is.
  const [liveNote, setLiveNote] = useState<string | null>(null);
  // Which trip the live note is about. When it is the same trip as the missed-
  // departure card, the card is a duplicate: Meira already re-planned it, and
  // the options stay one tap away ("More options ›") instead of on screen.
  const [liveNoteTaskId, setLiveNoteTaskId] = useState<string | null>(null);
  const [missedOptionsOpen, setMissedOptionsOpen] = useState(false);
  // The trip whose departure has gone while she is still at the origin. Not a
  // note — a prompt with the three next departures already loaded, because at
  // that moment she has seconds, not a browsing mood.
  /**
   * The wall clock, ticking, as state.
   *
   * Everything about a missed departure is relative to NOW, and until this
   * existed "now" was only ever read during a render that happened for some
   * other reason. So a screen sitting open went quietly out of date: the
   * offered trains stayed on it, the countdown stayed frozen, and the longer
   * she looked at it the more wrong it was — at precisely the moment she is
   * late and reading it hardest.
   *
   * Thirty seconds. Cheap (one setState, no I/O, no network) and it keeps a
   * minute-resolution countdown honest to within half a minute.
   */
  const [clock, setClock] = useState(() => new Date().toTimeString().slice(0, 5));

  const [missedTrip, setMissedTrip] = useState<{
    task: Task;
    options: DepartureOption[];
    origin: 'home' | 'here';
    /** When these three were fetched. A timetable goes out of date by walking. */
    fetchedAt: number;
  } | null>(null);

  useEffect(() => {
    const t = setInterval(() => {
      setClock((prev) => {
        const next = new Date().toTimeString().slice(0, 5);
        return next === prev ? prev : next;   // same minute — no re-render
      });
    }, 30 * 1000);
    return () => clearInterval(t);
  }, []);

  /**
   * Which day is on screen.
   *
   * This screen and the old Timeline tab drew the same DayTimeline from the
   * same storage; the only thing Timeline could do that Today could not was
   * look at another date. Rather than keep a second tab alive for one chip
   * row, the chip row moved here and the tab went.
   *
   * Today is not just "dateKey === today" with different data, though —
   * everything below is live machinery for the day she is IN: arrivals get
   * stamped, alarms get armed, Google gets synced, a missed bus interrupts
   * her. None of that may run for a day she is merely browsing, so `load()`
   * stays today-only and another date takes the quiet path below.
   */
  const [dateKey, setDateKey] = useState<string>(getTodayString());
  const [showDayPicker, setShowDayPicker] = useState(false);
  // v3 (Koral, 27.10): Focus = the ring + the next three things; All day = the whole day.
  const [view, setView] = useState<'focus' | 'all'>('focus');
  // All day: one line per task (compact) or the full cards (expanded) — canvas v4.
  const [dense, setDense] = useState(true);
  // After a trip edit: what ELSE moved, drawn gold, with one Undo (utils/dayDiff).
  const [moved, setMoved] = useState<{ ids: string[]; line: string; undo?: () => void } | null>(null);
  const movedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (movedTimer.current) clearTimeout(movedTimer.current); }, []);
  // The tray → a free window (Koral, 27.10): the lifted task, the windows as
  // drop targets (measured when the drag starts), the one under the finger.
  const ghostRef = useRef<GhostHandle>(null);
  const zoneViews = useRef(new Map<string, { view: View | null; start: string; end: string }>());
  const zonesRef = useRef<DropZone[]>([]);
  const dragging = useRef<Task | null>(null);
  // While a task is lifted: the hour ruler she drops it on (28.10).
  const rulerRef = useRef<RulerHandle>(null);
  const [rulerRows, setRulerRows] = useState<HourRow[] | null>(null);
  const dropBusy = useRef(false);
  const [alertsOpen, setAlertsOpen] = useState(false);
  // 🔔: what the calendar changed (ChangeRecordStore) and the "set a new time" follow-ups from any day.
  const [changes, setChanges] = useState<ChangeRecord[]>([]);
  const [changesError, setChangesError] = useState<string | null>(null);
  const [followUps, setFollowUps] = useState<Task[]>([]);
  const loadBell = useCallback(async () => {
    const res = await openChanges(getTodayString()).catch((e) => ({ records: [] as ChangeRecord[], error: String(e) }));
    setChanges(res.records);
    setChangesError(res.error ?? null);
    const all = await getAllTasks().catch(() => [] as Task[]);
    setFollowUps(all.filter((t) => t.status === 'pending' && followUpOriginal(t.text)));
  }, []);
  useEffect(() => {
    loadBell().catch((e) => console.warn('[Today] bell load failed', e));
    const off1 = onChangesChanged(() => { loadBell().catch(() => {}); });
    const off2 = onLateAnswered(() => { loadBell().catch(() => {}); });
    return () => { off1(); off2(); };
  }, [loadBell]);
  // Seen = the sheet showed them; the closed-app nudge about them is no longer needed.
  useEffect(() => {
    if (alertsOpen && changes.length) markSeen(changes.map((c) => c.key)).catch(() => {});
  }, [alertsOpen, changes]);
  const [hoverZone, setHoverZone] = useState<string | null>(null);
  const say = (line: string, ids: string[] = [], undo?: () => void) => {
    if (movedTimer.current) clearTimeout(movedTimer.current);
    setMoved({ ids, line, undo });
    movedTimer.current = setTimeout(() => setMoved(null), 8000);
  };
  const scrollRef = useRef<ScrollView>(null);
  const [timelineY, setTimelineY] = useState(0);
  const [eventsOpen, setEventsOpen] = useState(false);
  // The menu's "📅 Update calendars" lands here with the email events open.
  const routeParams = (useRoute() as any).params;
  const openEventsAt = routeParams?.openEvents as number | undefined;
  // From the chat home's tiles: my day (Focus), tomorrow, or another day (the picker).
  useEffect(() => {
    const day = routeParams?.day as 'today' | 'tomorrow' | 'pick' | undefined;
    if (!day) return;
    if (day === 'today') { setDateKey(getTodayString()); setView('focus'); }
    else if (day === 'tomorrow') setDateKey(getTomorrowString());
    else setShowDayPicker(true);
  }, [routeParams?.day, routeParams?.nonce]);
  useEffect(() => { if (openEventsAt) setEventsOpen(true); }, [openEventsAt]);
  // The task page's ✏️ lands here with that task's card open, to edit.
  useEffect(() => {
    if (routeParams?.editTask) openTaskCard(String(routeParams.editTask)).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeParams?.editTask, routeParams?.nonce]);
  // The home screen's 🔔 lands here with the sheet open.
  useEffect(() => { if (routeParams?.openBell) setAlertsOpen(true); }, [routeParams?.openBell]);
  const [eventsReview, setEventsReview] = useState(false);
  const [briefOpen, setBriefOpen] = useState(false);
  // What Meira prepared for the pill's task (songs for karaoke, what to bring
  // to a clinic) — anything the meeting brief does not cover.
  const [prep, setPrep] = useState<{ taskId: string; text: string; result: TaskPrepResult } | null>(null);
  /**
   * Standing work written on an earlier day and not ticked yet. getOverdueTasks
   * removes standing tasks on purpose (they are not "missed"), so
   * `overdue.filter(isStandingTask)` was always empty and this work showed up
   * nowhere on Today. Loaded on its own now; it goes to the task pool.
   */
  const [carried, setCarried] = useState<Task[]>([]);
  /** Tasks for a date that is NOT today. Read-only browse; no side effects. */
  const [otherDayTasks, setOtherDayTasks] = useState<Task[]>([]);
  // Which day `otherDayTasks` belongs to — until it is THIS day, the list is
  // loading, never the previous day's cards under a new header (1.10: Sunday's
  // interview drawn under "Tomorrow").
  const [otherDayKey, setOtherDayKey] = useState('');
  const showingToday = dateKey === getTodayString();
  // The sky outside, from the real sunrise / sunset at home (Tel Aviv when no
  // home is saved — a background, not a fact, so a fallback is harmless).
  const sky = React.useMemo(() => {
    const place = profile?.homeLat && profile?.homeLng
      ? { lat: profile.homeLat, lng: profile.homeLng } : FALLBACK_PLACE;
    const raw = skyFor(timeToMinutes(clock), sunTimes(new Date(), place.lat, place.lng));
    // This run's palette decides dark vs light (constants/theme THEME_NIGHT) — never half and half.
    return THEME_NIGHT && !raw.dark ? { ...raw, phase: 'night' as const, colors: NIGHT_SKY, dark: true }
      : { ...raw, dark: THEME_NIGHT };
  }, [clock, profile?.homeLat, profile?.homeLng]);
  const headInk = sky.dark ? SKY_INK.light : SKY_INK.dark;
  // Night (28.10, canvas v4 dark): dark glass and light ink, not cream on navy.
  const night = THEME_NIGHT;
  const sun = React.useMemo(() => {
    const place = profile?.homeLat && profile?.homeLng
      ? { lat: profile.homeLat, lng: profile.homeLng } : FALLBACK_PLACE;
    return sunTimes(new Date(), place.lat, place.lng);
  }, [dateKey, profile?.homeLat, profile?.homeLng]);
  const focusing = showingToday && view === 'focus';
  // The list under the ＋ belongs to the day it was opened on.
  useEffect(() => { setSuggestOpen(false); }, [dateKey]);
  const showingTomorrow = dateKey === getTomorrowString();
  // The morning ⏰ (Koral, 20.10, option C): one answer for the pill and for
  // the card it belongs to — it never disappears, it moves to the next morning.
  const morningAlarm = useMorningAlarm(language === 'he', dateKey);

  // The day on screen, for callbacks that outlive the render that made them.
  const shownRef = useRef({ showingToday, dateKey });
  shownRef.current = { showingToday, dateKey };
  useFocusEffect(useCallback(() => {
    load();
    // Back from "Add task" on Tomorrow: reload THAT day too (5.10 — "the add
    // button doesn't work": the task was saved and the screen redrew today).
    if (!shownRef.current.showingToday) {
      loadOtherDay(shownRef.current.dateKey).catch((e) => console.warn('[Today] day reload on focus failed', e));
    }
  }, []));
  // After any change: the day ON SCREEN, not only today. Every handler below
  // used to call load(false), which on Tomorrow saved the change and redrew
  // today — an Add, an alarm, a move that all looked like they did nothing.
  const reloadShown = async () => {
    await load(false);
    if (!shownRef.current.showingToday) await loadOtherDay(shownRef.current.dateKey);
  };

  // The quiet path. No sync, no alarms, no arrivals — just the day, drawn.
  const loadOtherDay = useCallback(async (key: string) => {
    const rows = await getTasksForDate(key).catch(() => [] as Task[]);
    setOtherDayTasks(sortTasksByPriorityAndTime(rows));
    setOtherDayKey(key);
  }, []);

  useEffect(() => {
    if (showingToday) { setOtherDayTasks([]); return; }
    let alive = true;
    // Local first, so the day draws instantly...
    getTasksForDate(dateKey)
      .then((rows) => { if (alive) { setOtherDayTasks(sortTasksByPriorityAndTime(rows)); setOtherDayKey(dateKey); } })
      .catch((e) => { console.warn('[Today] day not read', dateKey, e); if (alive) { setOtherDayTasks([]); setOtherDayKey(dateKey); } });
    // ...then ASK GOOGLE about this specific day, and draw it again.
    //
    // This used to be "the quiet path. No sync, no alarms" — read-only browse,
    // by design. The design was wrong in one specific way: picking a day is
    // the single most literal way to ask "what do I have on Wednesday", and it
    // was the one path guaranteed never to fetch it. An interview sitting in
    // Google Calendar showed an empty Wednesday and nothing on screen could
    // say why. The other half of the old rule still holds — no arrivals, no
    // presence loop, no missed-bus interrupt for a day she is only looking at.
    // Importing what Google already knows is not a side effect on her day.
    (async () => {
      const added = await syncCalendarDate(dateKey, language).catch(() => 0);
      if (!alive) return;
      setCalendarError(lastCalendarFailure());
      if (added > 0) {
        const rows = await getTasksForDate(dateKey).catch(() => null);
        if (alive && rows) setOtherDayTasks(sortTasksByPriorityAndTime(rows));
      }
    })();
    return () => { alive = false; };
  }, [dateKey, showingToday, language]);

  /** Re-read whichever day is on screen, by whichever route owns it. */
  const refreshDay = useCallback(async () => {
    if (showingToday) await load();
    else await loadOtherDay(dateKey);
  }, [showingToday, dateKey, loadOtherDay]);

  // Her answers to the day's problems, for the day on screen.
  useEffect(() => {
    AsyncStorage.getItem(PROBLEM_ANSWERS_KEY)
      .then((raw) => setAnswered((raw ? JSON.parse(raw) : {})[dateKey] || {}))
      .catch((e) => { console.warn('[Today] problem answers unreadable', e); setAnswered({}); });
  }, [dateKey]);

  /** Remember what she chose, so the same question is not asked again today. */
  const answerProblem = useCallback(async (key: string, choice: string) => {
    setAnswered((prev) => ({ ...prev, [key]: choice }));
    try {
      const raw = await AsyncStorage.getItem(PROBLEM_ANSWERS_KEY);
      const all: Record<string, Record<string, string>> = raw ? JSON.parse(raw) : {};
      const today = getTodayString();
      const kept = Object.fromEntries(Object.entries(all).filter(([day]) => day >= today));
      kept[dateKey] = { ...(kept[dateKey] || {}), [key]: choice };
      await AsyncStorage.setItem(PROBLEM_ANSWERS_KEY, JSON.stringify(kept));
    } catch (e) {
      console.warn('[Today] problem answer not saved', key, e);
    }
  }, [dateKey]);

  /**
   * Redraw when the automatic sync lands something.
   *
   * The pull no longer belongs to this screen (CalendarAutoSync owns it, off
   * the app root), so this screen has to be TOLD. Without this the import
   * would work perfectly and the day on screen would still be the one loaded
   * two minutes ago — the same bug one layer up.
   */
  useEffect(() => onCalendarSync((r) => {
    setCalendarError(r.error);
    if (r.added > 0 || r.newTasks.length) {
      refreshDay().catch(() => {});
      // An interview that just arrived is researched now, not at the next focus.
      refreshInterviewBriefs().catch((e) => console.warn('[Today] interview briefs failed', e));
    }
  }), [refreshDay, refreshInterviewBriefs]);

  // Another day picked: its interview (if it is within three days) is drawn
  // with its chip too — the day-picker is "she went looking" (rule 7).
  useEffect(() => {
    refreshInterviewBriefs().catch((e) => console.warn('[Today] interview briefs failed', e));
  }, [dateKey, refreshInterviewBriefs]);

  /**
   * A voice plan landed (the mic lives in the tab bar, above this screen).
   * Focus does not fire when she is already here, so without this the plan
   * would be saved and the timeline would still show the old day.
   */
  /** A chat task was just routed (ArrivedTaskPlanner) — show the route now. */
  useEffect(() => onDayChanged(() => {
    refreshDay().catch(() => {});
  }), [refreshDay]);

  useEffect(() => onDayPlanned((e) => {
    if (e.date === getTodayString() && !showingToday) setDateKey(getTodayString());
    refreshDay().catch(() => {});
    setPlanProblems(e.problems);
  }), [refreshDay, showingToday]);

  /**
   * The live loop: where is she, and is the plan still true?
   *
   * Three things, in this order, every 90 seconds while this screen is in
   * front. Order matters — each one feeds the next:
   *
   *   1. markArrivals  — stamp the places she has actually reached. This is
   *      what lets the chain measure the NEXT leg from Nahariya instead of
   *      from her front door.
   *   2. dayPresence   — at home / in transit / at a venue, for the chip. The
   *      user asked to be able to see this; it is also the reason (3) can tell
   *      "still at home at 09:00" apart from "on the platform".
   *   3. the missed departure — if the leave time has passed and she has NOT
   *      moved, load the next three departures NOW and put them on screen. She
   *      should not have to know to press anything at the moment she is late.
   *
   * Cheap-ish: one GPS fix per tick, and the Google probe runs on the
   * transition into "missed" and then only when what is on screen has expired.
   *
   * It used to run ONCE and never again — `if (missedTrip?.task.id === trip.id)
   * return`. Three departures fetched at 08:26 were still on screen at 08:37,
   * top of the list a train that had left twelve minutes earlier, with a live
   * "Take it" button under it. A missed-departure prompt whose own contents go
   * stale is the exact failure it was built to prevent, and it gets worse the
   * longer she looks at it — which is precisely when she is late.
   */
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const today = getTodayString();
      const dayTasks = await getTasksForDate(today).catch(() => [] as Task[]);
      if (!alive || !dayTasks.length) return;

      const point = await getCurrentLocation().catch(() => null);
      if (!alive) return;

      // 1. Arrivals — one-way, and it cancels the alerts for trips already made.
      if (point) {
        await markArrivals(dayTasks, { current: point, language })
          .catch((e) => console.warn('[Today] arrival sweep failed', e));
      }

      // 2. Presence.
      const storedProfile: any = await loadProfile().catch(() => null);
      if (!alive) return;
      const home = storedProfile?.homeLatLng
        ?? (storedProfile?.homeLat != null
          ? { lat: storedProfile.homeLat, lng: storedProfile.homeLng } : null);
      const nowHHMM = new Date().toTimeString().slice(0, 5);
      const verdict = dayPresence(
        point,
        dayTasks.map((t) => {
          const l = asLocation(t);
          return {
            id: t.id,
            lat: l?.lat,
            lng: l?.lng,
            name: l?.displayName || l?.address,
            startsAt: t.fixedTime || t.scheduledTime,
            endsAt: undefined,
          };
        }),
        home,
        nowHHMM,
      );
      setPresence(verdict);

      // 2a. The reverse of an arrival (8.10, Koral: home from מילואים in Ramla
      //     at 17:30 and the day still showed her there until 18:00). Mid-task
      //     and kilometres from its place: seen there → shorten it and say so;
      //     never seen there → ask. Read again: markArrivals may just have
      //     set verifiedArrival.
      if (point) {
        const fresh = await getTasksForDate(today).catch(() => dayTasks);
        if (!alive) return;
        for (const v of leftEarly(fresh as any, point, home, nowHHMM)) {
          const t = fresh.find((x) => x.id === v.taskId);
          if (!t) continue;
          if (v.wasThere) {
            await updateTaskFields(t.id, {
              durationMinutes: v.durationMinutes, leftEarlyHandled: true,
            } as any).catch((e) => console.warn('[Today] shortening a task she left failed', e));
            load(false);
            offerFreedTime(v, t.durationMinutes, point);
          } else {
            // Asked ONCE: the question stays on screen until answered, but the
            // next sweep does not raise it again (13.10: "you asked many times").
            await updateTaskFields(t.id, { leftEarlyHandled: true } as any)
              .catch((e) => console.warn('[Today] could not mark the no-show question asked', e));
          }
          setLeftNote({ v, title: t.text, was: t.durationMinutes });
        }
      }

      // 2b. And WHERE, in words. Cached in LocationService, so this is free
      //     until she has actually moved 150 m.
      if (point) {
        const where = await describeHere(point).catch(() => null);
        if (!alive) return;
        setHereLabel(where);
      }

      // 2c. Is the next trip still true from here? Three triggers — she moved
      //     off the origin the route was planned from, the leave time passed,
      //     or the plan's own arrival is already after the appointment — and
      //     each one rewrites the route from where she is standing. This is
      //     the step the screen never had: it could only react to a departure
      //     time passing, so walking across town changed nothing on screen.
      //
      //     Deliberately runs while she is in transit too, which the missed-
      //     departure prompt below must not: being on the wrong train is
      //     exactly when the times need recomputing, and it is also the only
      //     state in which "you've moved" is normally true.
      if (point && storedProfile) {
        const live = await keepNextTripLive(dayTasks, storedProfile, {
          current: point, notify: true, language,
        }).catch(() => null);
        if (!alive) return;
        if (live?.replanned) {
          setLiveNote(live.message ?? null);
          setLiveNoteTaskId(live.task?.id ?? null);
          setMissedOptionsOpen(false);
          await load(false).catch(() => {});
          if (!alive) return;
        }
      }

      // 3. Missed departure, while she is demonstrably still at the origin.
      //    'in-transit' means she IS on her way — re-planning then would be
      //    telling a woman on a train that she should catch a train.
      if (verdict.state === 'in-transit') { setMissedTrip(null); return; }
      const trip = dayTasks.find((t) => t.status === 'pending'
        && !t.verifiedArrival
        && asLocation(t)?.leaveHomeBy
        && missedPlannedDeparture(asLocation(t)!.leaveHomeBy));
      if (!trip) { setMissedTrip(null); return; }
      if (!storedProfile) return;
      // Re-probe only when what is showing is no longer true: the soonest
      // option can no longer be caught (boardAt minus the walk has passed), or
      // it is simply old. Both cheap to check, and between them they mean the
      // list on screen is always one she could still act on.
      const showing = missedTrip?.task.id === trip.id ? missedTrip : null;
      if (showing) {
        const soonest = showing.options[0];
        const catchable = soonest
          ? !departureUncatchable(soonest, nowHHMM)
          : false;
        // Inside the last few minutes the timetable matters more than the
        // call budget: re-probe every tick so what is on screen is the live
        // answer, not a four-minute-old one.
        const left = soonest ? minutesToDecide(soonest, nowHHMM) : undefined;
        const ttl = left !== undefined && left <= 5 ? 0 : OPTIONS_TTL_MS;
        const fresh = Date.now() - showing.fetchedAt < ttl;
        if (catchable && fresh) return;
      }

      const { options, origin } = await nextDepartureOptions(trip, storedProfile, {
        count: 3, current: point,
      }).catch(() => ({ options: [] as DepartureOption[], origin: 'home' as const }));
      if (!alive || !options.length) return;
      setMissedTrip({ task: trip, options, origin, fetchedAt: Date.now() });
    };

    tick();
    const timer = setInterval(tick, 90 * 1000);
    return () => { alive = false; clearInterval(timer); };
    // `clock` in the deps is what makes this live rather than merely periodic:
    // the moment the offered train stops being catchable, the next minute
    // re-runs this and replaces it. She asked for exactly that — while she is
    // still at home, the offer should keep up with the clock.
  }, [missedTrip?.task.id, missedTrip?.fetchedAt, clock]);

  /**
   * "By car, by bus, by train, on foot" — all four at once, from where she is.
   *
   * She asked for this in as many words and the app has never shown it: the
   * mode chips could only be tried one at a time, each a round trip to Google,
   * so comparing two meant holding the first number in her head while the
   * second loaded. compareModes has existed in RoutePlanner since the routing
   * work and had no caller anywhere — the comparison was computable and simply
   * never rendered.
   *
   * The origin is the live fix when there is one. A comparison measured from
   * her flat answers the wrong question the moment she is not in it, which is
   * exactly when she asks.
   */
  const handleCompareModes = async (task: Task): Promise<ModeQuote[]> => {
    const storedProfile = await loadProfile().catch(() => null);
    if (!storedProfile) return [];
    const dest = asLocation(task)?.address;
    const arrival = task.fixedTime || task.scheduledTime;
    if (!dest || !arrival) return [];
    const point = await getCurrentLocation().catch(() => null);
    const results = await GoogleService.compareModes(
      dest, arrival, toChainProfile(storedProfile) as UserProfile, task.date,
      ['bus', 'train', 'car', 'walk', 'bike'],
      point ? { from: point } : {},
    ).catch(() => []);
    return results.map((r) => ({
      mode: r.mode,
      minutes: r.plan.totalDurationMinutes,
      arriveAt: r.plan.arriveAt,
    }));
  };

  /**
   * "Route it from where I actually am." The chain's guess — home, or the
   * previous stop — is right most mornings and wrong exactly when the day
   * stops going to plan, and there was no way to say so.
   */
  const handleChangeOrigin = async (task: Task, origin: 'auto' | 'current') => {
    const storedProfile = await loadProfile().catch(() => null);
    if (!storedProfile) return;
    setReplanNotes((prev) => ({ ...prev, [task.id]: language === 'he' ? '🧭 מחשבת מחדש…' : '🧭 re-routing…' }));
    const { task: updated, originLabel, reason } = await replanFromOrigin(
      task, storedProfile, origin, { language },
    ).catch(() => ({ task: undefined, originLabel: '', reason: 'failed' } as any));
    await reloadShown();
    setReplanNotes((prev) => ({
      ...prev,
      [task.id]: updated
        ? (language === 'he' ? `📍 מ${originLabel}` : `📍 From ${originLabel}`)
        : reason === 'no-fix'
          ? (language === 'he' ? 'אין מיקום כרגע 🙁' : 'No location fix right now 🙁')
          : (language === 'he' ? 'לא הצלחתי לחשב מסלול 🙁' : "Couldn't route from there 🙁"),
    }));
  };

  /** She picked one from the missed-departure prompt. */
  const handlePickMissedOption = async (plan: TransitPlan) => {
    const trip = missedTrip?.task;
    if (!trip) return;
    await applyDepartureOption(trip, plan, language).catch(() => {});
    setMissedTrip(null);
    setReplanNotes((prev) => ({
      ...prev,
      [trip.id]: language === 'he'
        ? `✓ נעול על ${plan.leaveHomeAt} · הגעה ${plan.arriveAt}`
        : `✓ Locked in ${plan.leaveHomeAt} · arrive ${plan.arriveAt}`,
    }));
    await reloadShown();
  };

  // The gold pill's task. A failed read must not look like "nothing next".
  const refreshNextUp = () => {
    getNextUpcomingTask()
      .then((t) => {
        setNextUp(t);
        if (!t) console.warn('[Today] next important: nothing timed in the next 7 days');
      })
      .catch((e) => console.warn('[Today] next important unreadable', e));
    // The interviews ahead ride on the same moments: this runs on every focus
    // load and again after its calendar sync, which is when a new one appears.
    refreshInterviewBriefs().catch((e) => console.warn('[Today] interview briefs failed', e));
  };

  // An answer to "you're late" changed a task from a system dialog: redraw now (services/RunningLate.onLateAnswered).
  const loadRef = useRef<((spin?: boolean) => Promise<void>) | null>(null);
  useEffect(() => { loadRef.current = load; });
  useEffect(() => onLateAnswered(() => { loadRef.current?.(false)?.catch(() => {}); }), []);

  const load = async (showSpinner = true) => {
    const loadT0 = Date.now();
    const today = getTodayString();
    const onToday = (all: Task[]) => all.filter((t) => coversDay(t, today) && t.status !== 'moved');
    try {
      // A refresh after an action must not blank the screen — only the first
      // load has nothing to show yet.
      if (showSpinner) setLoading(true);
      // 1. Draw the phone's own copy at once (19.10). The screen used to sit
      //    on a spinner until every task row had downloaded from Supabase —
      //    seconds on a train, for a list the phone already held. An empty
      //    phone copy (fresh install) keeps the spinner: an empty day drawn
      //    for a second would read as "nothing today".
      try {
        const [local, localSettings] = await Promise.all([getLocalTasks(), getLocalSettings()]);
        if (local.length) {
          setLanguage(localSettings.language);
          const day = onToday(local);
          setTasks(sortTasksByPriorityAndTime(day));
          setLoading(false);
          perfMark(`Today load → local rows (${day.length})`, loadT0);
          perfFirstPaint('today, local');
        }
      } catch (e) {
        console.warn('[Today] the phone copy is unreadable — waiting for the cloud', e);
      }
      // 2. …then the cloud, which has the last word. One download: the reads
      //    below (overdue, carried, the week's alerts) share it.
      const [read, settings] = await Promise.all([
        getAllTasksChecked(),
        getSettings(),
        hydrateCustomCategories(),
      ]);
      const tasksData = onToday(read.tasks);
      setTasksCloudError(read.cloudError);
      setLanguage(settings.language);
      setTasks(sortTasksByPriorityAndTime(tasksData));
      perfMark(`Today load → cloud rows (${tasksData.length})${read.cloudError ? ' FAILED, phone copy' : ''}`, loadT0);
      perfFirstPaint('today, cloud');
      AsyncStorage.getItem(SAME_THING_DISMISSED_KEY)
        .then((raw) => {
          const dismissed: string[] = raw ? JSON.parse(raw) : [];
          setSameThing(
            findSameThingGroups(tasksData)
              .filter((g) => !dismissed.includes(g.tasks.map((t) => t.id).sort().join('-'))),
          );
        })
        .catch(() => setSameThing(findSameThingGroups(tasksData)));
      // Include today's tasks whose time has already gone by — they need the
      // same Done / Move / Delete choice as yesterday's leftovers.
      const nowHHMM = new Date().toTimeString().slice(0, 5);
      // A 'waiting for a new date' note is not a task to close — it lives on the 🔔 only (28.10).
      getOverdueTasks(today, nowHHMM).then((rows) => setOverdue(rows.filter((t) => !followUpOriginal(t.text)))).catch(() => {});
      setCarried(read.tasks.filter((t) => t.date < today && isStandingTask(t)));
      // An unconfigured build is the WORST case, not an exempt one: it means
      // the APK shipped without EXPO_PUBLIC_SUPABASE_*, so nothing can ever
      // sync. Skipping the check here left signedIn stuck at its optimistic
      // `true` and hid the banner precisely when it mattered most.
      if (isSupabaseConfigured) {
        getUserId().then((id) => setSignedIn(Boolean(id))).catch(() => setSignedIn(false));
      } else {
        setSignedIn(false);
      }
      loadProfile().then((p) => setProfile(toChainProfile(p))).catch(() => {});
      // Her routines, then — if this is a good moment — one of Meira's
      // questions about them (QuestionService, trigger 1: screen visible).
      loadRoutines()
        .then((rs) => {
          setRoutines(rs);
          Questions.maybeAsk({ routines: rs }).catch((e) => console.warn('[Today] question check failed', e));
        })
        .catch((e) => console.warn('[Today] routines not loaded', e));
      // First open of the day → offer to read the day out loud.
      AsyncStorage.getItem(BRIEFING_OFFERED_KEY)
        .then((v) => { if (v !== today) setShowBriefingOffer(true); })
        .catch(() => {});
      AsyncStorage.getItem(SUGGESTIONS_OPEN_KEY)
        .then((v) => setSuggestionsOpen(v === '1'))
        .catch(() => {});
      // The three Google syncs all MUTATE the task array. Fired in parallel
      // (which is what this used to do) they raced each other: each read the
      // list, each wrote it back, and the last one to finish erased the others
      // — which is why a computed transitPlan could vanish and why the same
      // calendar event could be inserted twice. Sequential, one refresh at the
      // end. Still off the critical path: the local list is already rendered.
      (async () => {
        try {
          // One owner, one at a time. This used to be the three calls inline,
          // which meant the screen's chain and the app-root auto-sync could be
          // merging the same events into the same array concurrently — the
          // exact race the comment above was written about, reintroduced a
          // level up. runCalendarSync holds an in-flight guard: whoever asks
          // second joins the run already going.
          const r = await syncCalendarNow(settings.language, 'today-screen');
          setCalendarError(r.error);
        } catch (e) {
          console.warn('[Today] sync chain failed', e);
        }
        const refreshed = await getAllTasksChecked().catch(() => null);
        if (refreshed) {
          setTasks(sortTasksByPriorityAndTime(onToday(refreshed.tasks)));
          setTasksCloudError(refreshed.cloudError);
        }
        perfMark('Today load → calendar synced + redrawn', loadT0);
        refreshNextUp();

        // Anything that arrived from WhatsApp or Google in the sync above has
        // never had an alert armed — the merge writes rows, nothing more, and
        // the launch-time rehydrate already ran. The backend is allowed to
        // sleep now, so the phone is the only thing that will ring: arm the
        // week here, every load. No-ops for tasks that already have alerts.
        try {
          const horizon = new Date();
          horizon.setDate(horizon.getDate() + 7);
          const week = (await getAllTasks()).filter(
            (t) => t.date >= today && t.date <= horizon.toISOString().slice(0, 10),
          );
          const armed = await armMissingTaskAlerts(week, settings.language, today);
          // Persist the ONE field arming produces, on the LOCAL row.
          //
          // This used to be `const all = await getAllTasks(); saveAllTasks(all…)`
          // — and getAllTasks is cloud-hydrated, so every Today load that armed
          // anything wrote the SERVER's copy of all 121 tasks over local
          // storage. Any local-only field died with it, including
          // `uncompletedAt`, the stamp that records "she unticked this". That
          // is why a tick she had just removed came back a minute later: the
          // row was not updated, it was REPLACED by a copy that had never
          // heard of her correction.
          //
          // The same mistake is documented on purgeDuplicateTasks, which was
          // fixed for it. This was the copy still doing it.
          //
          // armTaskAlerts only ever sets notificationIds, so that is all there
          // is to save, and updateTaskFields merges it into the local row
          // rather than replacing anything.
          for (const t of armed) {
            await updateTaskFields(t.id, { notificationIds: t.notificationIds })
              .catch(() => {});
          }
        } catch (e) {
          console.warn('[Today] arming missing alerts failed', e);
        }
      })();

      // …and the days AHEAD. Tomorrow's meeting needs its route, wake time and
      // leave alert planned today — not the moment tomorrow starts. Without
      // this the alarm for a 09:00 meeting was never set unless the Plan
      // Tomorrow screen happened to be opened the night before.
      refreshNextUp();

      getGmailEventSuggestions(settings.language).then(setEmailSuggestions).catch(() => {});
      // Free slot today + an active wish-list goal → suggest doing it now.
      buildGoalSuggestion(tasksData, settings.language).then(setGoalSuggestion).catch(() => {});
      // Lumi stays engaged with today's most important task: schedule the
      // daytime "how's it going?" check-ins (once per day, taps open the task).
      // Her own "most important today" wins over the guess (DayGoalCard).
      const goal = (await loadDayGoal()).goal;
      const focus = (goal?.taskId && goal.date === getTodayString()
        ? tasksData.find((t) => t.id === goal.taskId && t.status !== 'complete') : undefined)
        ?? pickFocusTask(tasksData.filter((t) => t.status !== 'complete'));
      if (focus) {
        const busy = tasksData.map((t) => t.fixedTime).filter((t): t is string => Boolean(t));
        scheduleFocusCheckIns(focus, settings.language, busy).catch(() => {});
      }
    } finally {
      setLoading(false);
    }
  };

  // One deterministic wish-list suggestion per day (no LLM): rotate active
  // aspirations by day-of-month into today's first big free slot.
  const buildGoalSuggestion = async (dayTasks: Task[], lang: AppLanguage): Promise<GapSuggestion | null> => {
    const today = getTodayString();
    if ((await AsyncStorage.getItem(GAP_DISMISSED_KEY)) === today) return null;
    const gap = findGap(dayTasks);
    if (!gap) return null;
    const aspirations = (await loadGoals()).filter((g) => g.status === 'active' && g.type === 'aspiration');
    if (aspirations.length === 0) return null;
    const goal = aspirations[new Date().getDate() % aspirations.length];
    return {
      id: `goal-gap-${goal.id}`,
      taskToAdd: {
        text: goal.text,
        category: goal.category,
        priority: 'nice_to_do',
        durationMinutes: 45,
        scheduledTime: gap.start,
        date: today,
      },
      reason: lang === 'he' ? `יש לך חלון פנוי — זמן ל"${goal.text}"?` : `You have a free slot — time for "${goal.text}"?`,
      reasonHe: `יש לך חלון פנוי — זמן ל"${goal.text}"?`,
      gapStart: gap.start,
      gapEnd: gap.end,
      source: 'from_goals',
      status: 'pending',
    };
  };

  const handleAcceptGoalSuggestion = async (s: GapSuggestion) => {
    setGoalSuggestion(null);
    await addTask({
      text: s.taskToAdd.text || '',
      category: s.taskToAdd.category || 'aspiration',
      priority: 'nice_to_do',
      isFixed: false,
      durationMinutes: s.taskToAdd.durationMinutes || 45,
      scheduledTime: s.taskToAdd.scheduledTime,
      date: getTodayString(),
      status: 'pending',
      source: 'suggested',
      historicalDurations: [],
    } as unknown as Omit<Task, 'id' | 'createdAt' | 'completedAt'>);
    await load();
  };

  const handleRejectGoalSuggestion = async () => {
    setGoalSuggestion(null);
    await AsyncStorage.setItem(GAP_DISMISSED_KEY, getTodayString()).catch(() => {});
  };

  /**
   * "This one is right" — the chosen row keeps the disputed facts, gains
   * anything it simply did not know from the others, and the rest are let go
   * (status 'moved' — recoverable, never deleted, because being wrong about
   * this must cost a tap and not an appointment).
   */
  const handleKeepOne = async (chosen: Task, others: Task[]) => {
    const patch = mergedInto(chosen, others);
    if (Object.keys(patch).length) {
      await updateTaskFields(chosen.id, patch as any).catch(() => {});
    }
    await letGoTasks(others.map((t) => t.id)).catch(() => {});
    await reloadShown();
  };

  /** They really are different — remember that, and stop asking. */
  const handleNotTheSame = async (group: SameThingGroup) => {
    const key = group.tasks.map((t) => t.id).sort().join('-');
    const raw = await AsyncStorage.getItem(SAME_THING_DISMISSED_KEY).catch(() => null);
    const dismissed: string[] = raw ? JSON.parse(raw) : [];
    await AsyncStorage.setItem(
      SAME_THING_DISMISSED_KEY, JSON.stringify([...dismissed, key].slice(-50)),
    ).catch(() => {});
    setSameThing((prev) => prev.filter((g) => g.tasks.map((t) => t.id).sort().join('-') !== key));
  };

  /**
   * The ⏰ chip: off, back on, or a different hour.
   *
   * An alarm you cannot see is one you cannot trust, and one you cannot change
   * is one you end up working around. Three taps' worth of control, on the
   * card, where the alarm is shown.
   */
  const handleAlarmPress = (task: Task) => {
    // Same three sources the chip is drawn from (utils/alarmPlan). This used to
    // re-derive the hour from alarmAt || wakeUpBy alone, so a routine-derived
    // alarm — the kind tomorrow's un-routed tasks get — could be shown but not
    // opened: the sheet returned early and the tap did nothing.
    const at = plannedAlarmTime(task, wakeInputs(profile).routineMinutes);
    if (!at) return;
    const off = task.alarmState === 'not_needed';
    const he = language === 'he';
    const setAlarmOn = async (on: boolean) => {
      await updateTaskFields(task.id, {
        // Turning it back on re-plans it; AlarmPlanner arms it once the
        // hour is inside Android's 24 h reach.
        alarmState: on ? 'planned' : 'not_needed',
        ...(on ? { alarmAt: at } : {}),
      } as any);
      if (on) {
        await armDueAlarms([{ ...task, alarmAt: at, alarmState: 'planned' } as Task])
          .catch((e) => console.warn('[Today] alarm not armed', task.id, e));
      }
      await reloadShown();
    };
    // Which morning — an alarm for tomorrow must say tomorrow (rule 4).
    const day = task.date === getTodayString() ? ''
      : task.date === getTomorrowString() ? (he ? ' · מחר' : ' · tomorrow')
        : ` · ${task.date.slice(8, 10)}.${task.date.slice(5, 7)}`;
    // Keep · Change · Cancel (Koral, 1.10). It used to be Turn off · Change ·
    // Cancel — two ways to say "stop", and none to say "yes, that's right".
    // Android orders three buttons neutral · negative · positive, so the safe
    // answer sits where the thumb lands and the destructive one stands apart.
    Alert.alert(
      `${off ? '🔕' : '⏰'} ${at}${day}`,
      off ? (he ? 'השעון המעורר כבוי.' : 'The alarm is off.')
        : (he ? `השעון המעורר יצלצל ב-${at}.` : `The alarm will ring at ${at}.`),
      off ? [
        { text: he ? 'שנה שעה' : 'Change time', onPress: () => setAlarmEditing({ task, at }) },
        { text: he ? 'השאר כבוי' : 'Keep it off', style: 'cancel' },
        { text: he ? 'הפעל' : 'Turn on', onPress: () => { setAlarmOn(true); } },
      ] : [
        { text: he ? 'בטל שעון' : 'Cancel alarm', style: 'destructive', onPress: () => { setAlarmOn(false); } },
        { text: he ? 'שנה שעה' : 'Change time', onPress: () => setAlarmEditing({ task, at }) },
        { text: he ? '✓ שמור' : '✓ Keep', style: 'cancel' },
      ],
    );
  };

  /** Save a new alarm hour and arm it if the morning is already in reach. */
  const saveAlarmTime = async (task: Task, at: string) => {
    setAlarmEditing(null);
    await updateTaskFields(task.id, { alarmAt: at, alarmState: 'planned' } as any);
    await armDueAlarms([{ ...task, alarmAt: at, alarmState: 'planned' } as Task]).catch(() => {});
    await reloadShown();
  };

  /**
   * Ideas for one free window. The live GPS fix is fetched ONLY for the window
   * happening right now — "you're 400 m from the pharmacy" is a claim about
   * where she is standing, and a later slot is anchored to wherever the
   * previous task leaves her instead (GapFillService).
   */
  /**
   * Ideas for a free window — ON THE DAY THAT WINDOW BELONGS TO.
   *
   * Both of these used to pass `getTodayString()` while the screen was drawing
   * whatever day the picker was on. So on TOMORROW: the ideas were ranked
   * against today's list, and tapping one wrote the task onto TODAY at
   * tomorrow's hour. The tap worked, the store changed, and the timeline she
   * was looking at did not — "I press add and nothing happens". An idea that
   * was an existing task was worse: it was MOVED to today.
   *
   * `dateKey` is the day on screen. It is the only correct answer here.
   */
  const handleRequestGapIdeas = async (gap: DayGap): Promise<GapIdea[]> => {
    const now = new Date().toTimeString().slice(0, 5);
    // "Where am I standing" only means something for a window happening now,
    // which can only be a window on today.
    const isNow = showingToday && gap.start <= now && gap.end > now;
    const point = isNow ? await getCurrentLocation().catch(() => null) : null;
    return suggestForGap(gap, {
      today: dateKey, currentPoint: point, routines, language,
    });
  };

  const handlePickGapIdea = async (idea: GapIdea, gap: DayGap) => {
    await applyGapIdea(idea, gap, dateKey);
    await reloadShown();
  };

  /**
   * Redraw ONE day from the phone's own copy, on whichever list is on screen.
   *
   * Tomorrow is drawn from `otherDayTasks`, not `tasks`. The mode switch used to
   * `setTasks` (today's list) and read the day back from the CLOUD — so on
   * Tomorrow the new route was saved correctly and the card stayed on the old
   * one (27.10: car tapped, 15:12→16:00 saved, train 14:21 still drawn), and
   * each tap cost a 296-row download. The write that just landed is local, so
   * the local copy is the truth.
   */
  const redrawDay = async (date: string): Promise<Task[]> => {
    const rows = sortTasksByPriorityAndTime(
      (await getLocalTasks()).filter((x) => coversDay(x, date) && x.status !== 'moved'),
    );
    if (date === getTodayString()) setTasks(rows);
    if (!shownRef.current.showingToday && shownRef.current.dateKey === date) {
      setOtherDayTasks(rows);
      setOtherDayKey(date);
    }
    return rows;
  };

  /**
   * Transport chip on a task — the answer to "which bus, from where, at what
   * time". Pressing 🚌 has to come back with a LINE, not just a leave time:
   * that route breakdown is the app's whole point, and a chip that silently
   * left the card exactly as it was is indistinguishable from a broken app.
   *
   * So: persist the override, drop the stale plan, fetch the real route, and
   * always say what came back — the departure and arrival on success, the
   * reason on failure. If the planned departure has already gone, the question
   * is not "when should I have left" but "what is the NEXT one", so it asks
   * that instead (same recompute as the "haven't left" button).
   */
  const handleTransportChange = async (task: Task, mode: TransportType, isUndo = false) => {
    const loc = asLocation(task);
    if (!loc) return;
    const before = snapshotDay(dayTasks);
    const prevMode = loc.transportType as TransportType | undefined;
    const today = getTodayString();
    setReplanNotes((prev) => ({ ...prev, [task.id]: language === 'he' ? '🧭 בודקת…' : '🧭 checking…' }));
    // Record the choice, and KEEP the route that is on screen.
    //
    // This used to write `transitPlan: undefined` here, purely to make
    // ensureTravelChain's "already has a plan" test fail so it would recompute.
    // The side effect was that every clock time on the card disappeared for
    // the seconds the Google call took — the reported "switching modes hides
    // the timestamps". ensureTravelChain now takes forceTaskId instead, so the
    // old times stay put until the new ones arrive and replace them.
    // On the phone first, the cloud behind it: the route call must not wait for a
    // round trip to Supabase (18.10: "everything is slow").
    await updateTaskFields(task.id, {
      location: { ...loc, transportType: mode, transportTypeBy: 'her' },
    } as any, { awaitCloud: false });
    // The chip moves NOW; the new times follow when the route arrives.
    await redrawDay(task.date || today);

    // She CHOSE this. That is the only kind of evidence worth learning from —
    // the mode a route happened to be planned with is just what the app
    // assumed last time, and learning from that lets one wrong guess reinforce
    // itself forever. Next time this place, or a class like it, comes up, the
    // route is planned by bike without being asked. See utils/travelPreference.
    rememberTravelChoice(mode, loc.address || loc.displayName, task.category)
      .catch(() => {});

    let note: string | null = null;
    const storedProfile = await loadProfile().catch(() => null);
    const missed = task.date === today && missedPlannedDeparture(loc.leaveHomeBy);

    if (missed && storedProfile) {
      // That departure is gone. Switching mode here is not a question about
      // this evening — it is "how do I get there NOW", so answer with the next
      // three consecutive departures on the new mode rather than an arrive-by
      // plan that leaves hours from now.
      const { options } = await nextDepartureOptions(
        { ...task, location: { ...loc, transportType: mode } } as Task,
        storedProfile, { mode, count: 3 },
      ).catch(() => ({ options: [] as DepartureOption[] }));
      if (options.length) {
        setAlternatives((prev) => ({ ...prev, [task.id]: options.map((o) => o.plan) }));
        note = language === 'he'
          ? `🚏 ${options.length} יציאות קרובות — בחרי אחת`
          : `🚏 ${options.length} upcoming departures — pick one`;
      } else {
        const result = await replanFromNextDeparture(
          { ...task, location: { ...loc, transportType: mode } } as Task,
          storedProfile,
          { mode, language },
        ).catch(() => null);
        note = result?.message
          ?? (language === 'he' ? 'לא מצאתי נסיעה הבאה 🙁' : "Couldn't find the next departure 🙁");
      }
    } else {
      await ensureTravelChain(task.date || today, language, { forceTaskId: task.id });
    }

    const fresh = await redrawDay(task.date || today);

    // Say what else the switch moved, and offer it back (Koral, 27.10).
    const knock = knockOnIds(diffDay(before, fresh), task.id);
    if (movedTimer.current) clearTimeout(movedTimer.current);
    setMoved({
      ids: [task.id, ...knock],
      line: language === 'he'
        ? (knock.length ? `עודכן · ${knock.length} שינויים בהמשך היום` : 'הנסיעה עודכנה')
        : (knock.length ? `Updated · ${knock.length} change${knock.length === 1 ? '' : 's'} later today` : 'Trip updated'),
      undo: !isUndo && prevMode && prevMode !== mode ? () => { void handleTransportChange(task, prevMode, true); } : undefined,
    });
    movedTimer.current = setTimeout(() => setMoved(null), 8000);

    if (!note) {
      const plan = asLoc(fresh.find((t) => t.id === task.id))?.transitPlan;
      note = plan
        ? describeNextDeparture(plan, task.fixedTime, language === 'he')
        : (language === 'he'
          ? '🙁 לא קיבלתי מסלול. בדקי שכתובת הבית מוגדרת בפרופיל.'
          : "🙁 No route came back. Check that your home address is set in Profile.");
    }
    setReplanNotes((prev) => ({ ...prev, [task.id]: note! }));
  };

  /**
   * "Other ways" — every route Google offers for this trip, best first.
   *
   * Fetched on demand rather than with the plan: it is a second Directions
   * call, and most trips are never questioned. The ones that are, are the ones
   * where Lumi's answer disagreed with Google Maps on the phone next to it.
   */
  const handleShowAlternatives = async (task: Task) => {
    const loc = asLocation(task);
    const arrival = task.fixedTime || task.scheduledTime;
    if (!loc || !arrival) return;
    const storedProfile: any = await loadProfile().catch(() => null);
    if (!storedProfile) return;
    const gProfile = {
      ...storedProfile,
      homeLat: storedProfile.homeLatLng?.lat,
      homeLng: storedProfile.homeLatLng?.lng,
    } as any;
    const mode = loc.transportType === 'train' ? 'rail' : 'bus';
    const plans = await GoogleService.getTransitAlternatives(
      loc.address || loc.displayName || '', arrival, gProfile, task.date, mode,
    ).catch(() => [] as TransitPlan[]);
    setAlternatives((prev) => ({ ...prev, [task.id]: plans }));
  };

  /** Take one of them: it becomes the task's route, its times and its alerts. */
  const handlePickAlternative = async (task: Task, plan: TransitPlan) => {
    if (!asLocation(task)) return;
    // One commit path, shared with the Leave-now screen: rewrite the route,
    // replace the alerts that belonged to the departure she is abandoning.
    await applyDepartureOption(task, plan, language).catch((e) => console.warn("[Today] could not lock the chosen departure", e));
    setAlternatives((prev) => ({ ...prev, [task.id]: [plan] }));
    await redrawDay(task.date || getTodayString());
    setReplanNotes((prev) => ({
      ...prev,
      [task.id]: language === 'he'
        ? `✓ נעול על ${plan.leaveHomeAt} · הגעה ${plan.arriveAt}`
        : `✓ Locked in ${plan.leaveHomeAt} · arrive ${plan.arriveAt}`,
    }));
  };

  /**
   * "I haven't left" straight from the day list: recompute from the NEXT
   * departure and show the new leave/arrive on the card itself. It used to only
   * open another screen — one more tap between her and the answer.
   */
  const handleNotLeft = async (task: Task) => {
    setReplanNotes((prev) => ({ ...prev, [task.id]: language === 'he' ? '🚏 מחפשת את הבאות…' : '🚏 finding the next ones…' }));
    const storedProfile = await loadProfile().catch(() => null);
    if (!storedProfile) return;

    // Three, not one. "You missed the 08:30, take the 09:15" is a verdict; the
    // 09:15, the 09:45 and the 10:05 with their arrival times is a decision she
    // can make. Nothing is written until she picks — see handlePickAlternative.
    const { options, origin } = await nextDepartureOptions(task, storedProfile, { count: 3 })
      .catch(() => ({ options: [] as DepartureOption[], origin: 'home' as const }));

    if (options.length) {
      setAlternatives((prev) => ({ ...prev, [task.id]: options.map((o) => o.plan) }));
      setReplanNotes((prev) => ({
        ...prev,
        [task.id]: origin === 'here'
          ? (language === 'he' ? '📍 מהמיקום שלך — בחרי יציאה' : '📍 from where you are — pick a departure')
          : (language === 'he' ? '🏠 מהבית — בחרי יציאה' : '🏠 from home — pick a departure'),
      }));
      return;
    }

    // No timetable (car, or a route Google will not serve) — fall back to the
    // single recompute so the alerts at least point at a real departure.
    const result = await replanFromNextDeparture(task, storedProfile, { language }).catch(() => null);
    const fresh = await getTasksForDate(getTodayString());
    setTasks(sortTasksByPriorityAndTime(fresh));
    setReplanNotes((prev) => ({
      ...prev,
      [task.id]: result?.message
        ?? (language === 'he' ? 'לא מצאתי נסיעה הבאה 🙁' : "Couldn't find the next departure 🙁"),
    }));
  };

  const handleAcceptEmailSuggestion = async (s: GapSuggestion) => {
    setEmailSuggestions((prev) => prev.filter((x) => x.id !== s.id));
    await acceptGmailSuggestion(s, language);
    await load();
  };

  const handleRejectEmailSuggestion = async (s: GapSuggestion) => {
    setEmailSuggestions((prev) => prev.filter((x) => x.id !== s.id));
    await dismissGmailSuggestion(s.id);
  };

  // 🔊 read today's tasks aloud (toggles off while speaking).
  const toggleBriefing = async () => {
    if (speaking) {
      await stopSpeaking();
      setSpeaking(false);
      return;
    }
    setSpeaking(true);
    try {
      await speakMorningBriefingNow();
    } finally {
      // expo-speech resolves speak() immediately; leave the icon "on" briefly.
      setTimeout(() => setSpeaking(false), 12000);
    }
  };

  const dismissBriefingOffer = () => {
    setShowBriefingOffer(false);
    AsyncStorage.setItem(BRIEFING_OFFERED_KEY, getTodayString()).catch(() => {});
  };

  /**
   * Resolve a spatial clash — the only overlap that is genuinely impossible.
   *
   * Both answers are real edits, so both drop the route they invalidate and
   * let the chain re-plan:
   *   leave-early  shorten the first so the journey fits; its start is untouched
   *   arrive-late  accept the lateness and move the second to when she can be there
   */
  const handleResolveConflict = async (
    opts: {
      first: Task; second: Task;
      action: 'leave-early' | 'arrive-late' | 'shorten-to' | 'move-to';
      at: string;
    },
  ) => {
    const { first, second, action, at } = opts;
    // A movable block that was covering a departure. `first` is the block
    // giving way; the appointment it was covering never moves.
    if (action === 'shorten-to' || action === 'move-to') {
      const start = first.fixedTime || first.scheduledTime;
      if (!start || !at) return;
      if (action === 'shorten-to') {
        await updateTaskFields(first.id, {
          durationMinutes: Math.max(15, timeToMinutes(at) - timeToMinutes(start)),
        }).catch(() => {});
      } else {
        // Moved, not re-timed into a commitment: a block she can shift is not
        // suddenly an appointment, so isFixed is left alone.
        //
        // Write whichever field the task is actually read by. Everything that
        // decides a start time prefers fixedTime over scheduledTime, so a
        // movable block that happens to carry one — a hand-typed task where
        // the hour was later unpinned — would have kept its old time while the
        // app reported it moved. That is a "✓ done" that did nothing, which
        // this codebase has paid for before.
        await updateTaskFields(first.id, first.fixedTime
          ? { fixedTime: at, scheduledTime: at }
          : { scheduledTime: at } as any).catch(() => {});
      }
      await refreshDay();
      return;
    }
    if (action === 'leave-early') {
      const start = first.fixedTime || first.scheduledTime;
      if (!start) return;
      await updateTaskFields(first.id, {
        durationMinutes: Math.max(15, timeToMinutes(at) - timeToMinutes(start)),
      }).catch(() => {});
    } else {
      const loc = second.location && typeof second.location === 'object' ? second.location : null;
      await updateTaskFields(second.id, {
        fixedTime: at, scheduledTime: at,
        ...(loc ? { location: { ...loc, transitPlan: undefined } } : {}),
      } as any).catch(() => {});
    }
    // The day being LOOKED AT, not today — the ScheduleScreen version said
    // getTodayString() here, so resolving tomorrow's clash re-planned today.
    await ensureTravelChain(dateKey, language).catch(() => {});
    await refreshDay();
  };

  const handleComplete = async (task: Task) => {
    const completing = task.status !== 'complete';
    await markTaskComplete(task.id, completing);
    if (completing) emitLumiMood('celebrate');
    // refreshDay, not load: ticking something off tomorrow used to re-read
    // TODAY, so the tick appeared to do nothing.
    await refreshDay();
  };

  const handleUpdate = async (patch: Partial<Task>) => {
    if (!selectedTask) return;
    const current = { ...selectedTask, ...patch };
    setSelectedTask(current);
    // The card may be of a task that no longer exists — a cancelled event opened
    // from the 🔔 after it was removed (28.10: "I edit the hours and it doesn't
    // save"). A write to a missing id did nothing and said nothing (rule 3).
    const exists = (await getLocalTasks().catch(() => [] as Task[])).some((t) => t.id === selectedTask.id);
    if (!exists) {
      Alert.alert(
        he ? 'המשימה הזו כבר הוסרה' : 'This task was removed',
        he ? 'האירוע בוטל והוסר מהיום. לשמור אותו מחדש כמשימה שלך, עם השינוי?' : 'The event was cancelled and removed. Save it again as your own task, with this change?',
        [
          { text: he ? 'לא' : 'No', style: 'cancel', onPress: () => setSelectedTask(null) },
          {
            text: he ? 'לשמור מחדש' : 'Save it again',
            onPress: async () => {
              const { id: _id, createdAt: _c, completedAt: _d, notificationIds: _n, calendarEventId: _e, ...rest } = current as any;
              const made = await addTask({ ...rest, status: 'pending' }).catch((e) => { console.warn('[Today] re-add failed', e); return null; });
              if (made) { setSelectedTask(made); await load(); } else Alert.alert(he ? 'לא נשמר' : 'Not saved');
            },
          },
        ],
      );
      return;
    }
    await updateTaskFields(selectedTask.id, patch);
    await load();
  };

  const handleDelete = async () => {
    if (!selectedTask) return;
    const id = selectedTask.id;
    setSelectedTask(null);
    await deleteTask(id);
    await load();
  };

  // Yesterday's leftovers: the user chooses, we never silently pile them on.
  const handleSignIn = async () => {
    // This used to be `.catch(() => null)`, which swallowed the one error that
    // explains everything — "Supabase is not configured" — and made tapping the
    // banner do nothing at all, silently, forever.
    try {
      const session = await signInWithGoogle();
      if (session) {
        setSignedIn(true);
        await load();
      }
      // null means the browser closed without reaching lumi://auth/callback.
      // Silence here is what made the banner look dead. Say what to check.
      if (!session) {
        Alert.alert(
          language === 'he' ? 'התחברות' : 'Sign in',
          language === 'he'
            ? 'חלון ההתחברות נסגר לפני שהסתיים.\n\nאם ביטלת — פשוט להקיש שוב.'
            : 'The sign-in window closed before it finished.\n\nIf you cancelled it, just tap again.',
        );
      }
      return;
    } catch (err: any) {
      const reason = err?.message || String(err);
      const misbuilt = !isSupabaseConfigured;
      Alert.alert(
        language === 'he' ? 'התחברות' : 'Sign in',
        misbuilt
          ? (language === 'he'
            ? 'הגרסה הזאת נבנתה בלי הגדרות הענן, אז אי אפשר להתחבר ממנה בכלל.\n\n'
              + 'צריך לבנות מחדש עם npm run android:local.'
            : 'This build shipped without the cloud settings, so it cannot sign in at all.\n\n'
              + 'It needs rebuilding with npm run android:local.')
          : reason,
      );
    }
  };

  const toggleSuggestions = (open: boolean) => {
    setSuggestionsOpen(open);
    AsyncStorage.setItem(SUGGESTIONS_OPEN_KEY, open ? '1' : '0').catch(() => {});
  };

  // Both of these update the visible list FIRST and persist after. Waiting for
  // storage before redrawing made the buttons look dead: the tap did work, the
  // row just kept sitting there until every await had finished.
  // "Move it" used to mean one thing: put it on today with no hour, where it
  // joined the untimed pile. At 11am that throws away the six hours the day
  // still has. Look for room TODAY first and give it a real slot; only a day
  // with none left rolls to tomorrow.
  const handleMoveOverdue = async (ids: string[]) => {
    if (!ids.length) return;
    const gone = new Set(ids);
    setOverdue((prev) => prev.filter((t) => !gone.has(t.id)));
    const today = getTodayString();
    const nowHHMM = new Date().toTimeString().slice(0, 5);
    // The day as it fills up. Each moved task joins it before the next one is
    // placed — otherwise "Reschedule all" gave every task the SAME free slot.
    const day = await getTasksForDate(today).catch((e) => {
      console.warn('[Today] reschedule: today unreadable', e);
      return [] as Task[];
    });
    const all = await getAllTasks().catch((e) => {
      console.warn('[Today] reschedule: tasks unreadable', e);
      return [] as Task[];
    });
    const d = new Date();
    d.setDate(d.getDate() + 1);
    const pad = (n: number) => String(n).padStart(2, '0');
    const tomorrow = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const placed: string[] = [];
    let failed = 0;

    for (const id of ids) {
      const task = all.find((t) => t.id === id);
      if (!task) { failed += 1; continue; }
      const slot = suggestReschedule(task, day, { now: nowHHMM, dayEnd: profile?.sleepTime });
      try {
        if (slot.when === 'today' && slot.at) {
          await moveTasksToDate([id], today);
          await updateTaskFields(id, {
            scheduledTime: slot.at, fixedTime: undefined, isFixed: false,
          } as any);
          day.push({ ...task, date: today, status: 'pending', scheduledTime: slot.at, fixedTime: undefined });
          placed.push(`${task.text.slice(0, 24)} ${slot.at}`);
        } else {
          await moveTasksToDate([id], tomorrow);
          placed.push(`${task.text.slice(0, 24)} ${language === 'he' ? 'מחר' : 'tomorrow'}`);
        }
      } catch (e) {
        failed += 1;
        console.warn('[Today] reschedule failed for', id, e);
      }
    }
    // Say where everything went — a bulk move with no answer looks like a
    // button that does nothing.
    const he = language === 'he';
    setLiveNote(
      (placed.length
        ? `↻ ${he ? 'תוזמן מחדש' : 'Rescheduled'}: ${placed.join(' · ')}`
        : '')
      + (failed ? `${placed.length ? ' — ' : ''}${he ? `${failed} לא הצליחו, נסי שוב` : `${failed} couldn't be moved — try again`}` : ''),
    );
    await ensureTravelChain(today, language).catch((e) => console.warn('[Today] travel chain after reschedule', e));
    await reloadShown();
  };

  // An overdue task is most often one she actually DID and never ticked off.
  // The card offered "move to today" and "let go" but no way to say "done",
  // so the honest answer required moving it forward and completing it there.
  const handleCompleteOverdue = async (ids: string[]) => {
    const gone = new Set(ids);
    setOverdue((prev) => prev.filter((t) => !gone.has(t.id)));
    for (const id of ids) await markTaskComplete(id, true);
    await load(false);
  };

  const handleDeleteOverdue = async (ids: string[]) => {
    const gone = new Set(ids);
    setOverdue((prev) => prev.filter((t) => !gone.has(t.id)));
    for (const id of ids) await deleteTask(id);
    await load(false);
  };

  const handleLetGoOverdue = async (ids: string[]) => {
    const gone = new Set(ids);
    setOverdue((prev) => prev.filter((t) => !gone.has(t.id)));
    await letGoTasks(ids).catch(() => {});
    await load(false);
  };

  const done = tasks.filter((t) => t.status === 'complete').length;
  const pending = tasks.filter((t) => t.status !== 'complete');
  const focusTask = pickFocusTask(pending);
  const motivation = (language === 'he' ? FOCUS_MOTIVATION_HE : FOCUS_MOTIVATION_EN)[
    new Date().getDate() % FOCUS_MOTIVATION_EN.length
  ];

  const suggestionCount = emailSuggestions.length + (goalSuggestion ? 1 : 0);
  const handleAddAllSuggestions = async () => {
    for (const s of emailSuggestions) await handleAcceptEmailSuggestion(s);
    if (goalSuggestion) await handleAcceptGoalSuggestion(goalSuggestion);
    setEventsOpen(false);
  };
  // The next important thing, as the gold pill: when, and its wake alarm.
  // Late to something that has STARTED, still worth going, not there yet:
  // that outranks tomorrow's 08:00 (Koral, 28.9 — at 21:33 the pill pointed at
  // tomorrow while karaoke had begun and she was still home). Same window as
  // the live re-plan, liveRoutePlan.stillWorthGoingUntil.
  const clockMin = timeToMinutes(clock);
  const lateTrip = showingToday && presence.state !== 'at-venue'
    ? tasks.find((t) => {
      const at = t.fixedTime || t.scheduledTime;
      if (t.status !== 'pending' || t.verifiedArrival || !asLoc(t)?.address || !at) return false;
      const start = timeToMinutes(at);
      return start < clockMin && clockMin < stillWorthGoingUntil(start, t.durationMinutes || 30);
    }) ?? null
    : null;
  const lateBy = lateTrip ? clockMin - timeToMinutes((lateTrip.fixedTime || lateTrip.scheduledTime)!) : 0;

  const leaveBy = tasks.map(asLoc).find((l) => l?.leaveHomeBy)?.leaveHomeBy;
  const transitStop = tasks.map(asLoc).find((l) => l?.transitPlan)?.transitPlan?.firstBusStop;
  // The trip behind that leave time — feeds the "Before you go" Lumi card
  // (destination, first leg, what to bring). Tap opens the task with the map.
  const departureTask = tasks.find((t) => {
    const l = asLoc(t);
    return t.status !== 'complete' && (l?.leaveHomeBy || l?.transitPlan);
  });
  const departureLeg = asLoc(departureTask)?.transitPlan?.legs?.find((l) => l.type !== 'walk');
  // Only surface the walk-out-the-door card when the departure is actually
  // near. Showing "leave by 18:00" all morning trains the eye to skip it, and
  // it is the one card that must never be skipped.
  const BEFORE_GO_WINDOW_MINUTES = 120;
  const minutesToLeave = leaveBy
    ? timeToMinutes(leaveBy) - (new Date().getHours() * 60 + new Date().getMinutes())
    : null;
  const showBeforeGo =
    minutesToLeave !== null && minutesToLeave <= BEFORE_GO_WINDOW_MINUTES;
  // First away-appointment gets the wake/get-ready rows; the closest pending
  // task is the one that opens without a tap.
  // Clock order, NOT the priority order used elsewhere: a chain's prevTask must
  // be the previous STOP of the day, or way-home plans chain off the wrong place.
  // The day being drawn: today's live list, or the browsed day's.
  // One card per meeting: her "שיחה עם סגית" and Google's "Sagit/Koral- intro"
  // at the same minute are one call (1.10) — collapseSameMeetings.
  const dayLoading = !showingToday && otherDayKey !== dateKey;
  // 28.10 (Koral): 'Set a new time: X' is a note on the 🔔 ('waiting for a new date'), never a row in the day.
  // …and a task she postponed ('missed': "not going, new time later") leaves the day at once —
  // it waits on the 🔔 as "⏳ waiting for a new date" (28.10: "I pressed later many times and it
  // is STILL there — the interface must update fast").
  const shownRows = collapseSameMeetings((showingToday ? tasks : (dayLoading ? [] : otherDayTasks))
    .filter((t) => !followUpOriginal(t.text) && t.status !== 'missed'));
  // A whole day (vacation, a conference, 2.11–7.11) is a strip above the day,
  // never a card at 08:00 that the planner works around (29.10, Koral).
  const allDayTasks = shownRows.filter(isAllDay);
  const dayTasks = shownRows.filter((t) => !isAllDay(t));
  // She is LOOKING at a day with a trip nobody has routed: route it now. Rule 7
  // — "she went looking" is a trigger. Once per day per visit; the card says
  // "routing…" meanwhile, and the chain's own warn says why if it fails (1.10:
  // tomorrow's yoga sat on "routing…" under a fallback alarm until a tap).
  const routedOnView = useRef(new Set<string>());
  const waitingForRoute = dayTasks.some((t) => t.status !== 'complete' && Boolean(t.fixedTime)
    && !isRemoteTask(t) && travelRowState(t) === 'pending');
  useEffect(() => {
    if (dayLoading || !waitingForRoute || routedOnView.current.has(dateKey)) return;
    routedOnView.current.add(dateKey);
    ensureTravelChain(dateKey, language)
      .then(() => refreshDay())
      .catch((e) => console.warn('[Today] routing the day on view failed', dateKey, e));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateKey, dayLoading, waitingForRoute]);
  // Prep blocks no interview earns any more (a twin's second set, an orphan),
  // swept when she LOOKS at a day — the calendar sync that also does it is
  // throttled and silent (5.10: two "Prep for…" on Tuesday through two
  // installs). Once per day per visit; redraw only if something went.
  const sweptDays = useRef(new Set<string>());
  useEffect(() => {
    if (dayLoading || sweptDays.current.has(dateKey)) return;
    sweptDays.current.add(dateKey);
    sweepStalePrep()
      .then((gone) => { if (gone > 0) refreshDay(); })
      .catch((e) => console.warn('[Today] prep sweep failed', dateKey, e));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateKey, dayLoading]);
  // A bus or train trip still ahead whose plan holds no ride — a leave time and
  // a number of minutes, no train. 4.10: "it says 54 minutes, but what matters
  // is when the train leaves, from which platform, where to board, where to get
  // off and when it arrives." Re-route it once per visit, so the card shows the
  // timetable instead of a sum.
  const nowHHMM = new Date().toTimeString().slice(0, 5);
  const ridelessTrip = dayLoading ? undefined : dayTasks.find((t) => t.status !== 'complete'
    && Boolean(t.fixedTime) && !isRemoteTask(t) && travelRowState(t) === 'route'
    && ['bus', 'train'].includes(String((t.location as any)?.transportType))
    && ridesOf(t).length === 0
    && (dateKey !== getTodayString() || timeToMinutes(t.fixedTime || '') > timeToMinutes(nowHHMM)));
  useEffect(() => {
    if (!ridelessTrip || routedOnView.current.has(`rides-${ridelessTrip.id}`)) return;
    routedOnView.current.add(`rides-${ridelessTrip.id}`);
    console.warn('[Today] a trip with no ride in its plan — re-routing', ridelessTrip.id);
    ensureTravelChain(dateKey, language, { forceTaskId: ridelessTrip.id })
      .then(() => refreshDay())
      .catch((e) => console.warn('[Today] re-routing a trip with no ride failed', ridelessTrip.id, e));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateKey, ridelessTrip?.id]);
  const dayOrder = [...dayTasks].sort((a, b) =>
    ((a.fixedTime || a.scheduledTime || '99:99') < (b.fixedTime || b.scheduledTime || '99:99') ? -1 : 1));
  /**
   * The ONE hour this day wakes her — the earliest wake any of its tasks needs.
   *
   * Every card used to decide its own, so adding a task earlier than the rest
   * left the old alarm exactly where it was and drew a second ⏰ next to it.
   * A morning has one beginning; see utils/alarmPlan.dayWakeOwner.
   */
  const dayEarliestWake = earliestWakeOf(dayTasks, wakeInputs(profile));
  // Doubles on ANY day on screen — 8.10 (reserve duty vs two interviews) said
  // nothing because the checks ran for today only. Clashes: dayProblems below.
  const daySameThing = showingToday ? sameThing : findSameThingGroups(otherDayTasks);
  const nextPendingId = dayOrder.find((t) => t.status === 'pending')?.id;
  /**
   * Two different things, drawn two different ways.
   *
   * The timeline gets the commitments — a place to be, a call at an hour,
   * something off the calendar. The work Lumi merely parked in a slot
   * ("Submit CV", "Prepare the lean canvas") goes to its own card, where it
   * can be ticked off without pretending to own five hours of the day and
   * without colliding with a party it does not actually conflict with.
   */
  const split = splitDayTasks(dayOrder);
  /**
   * …but a flexible task that HAS an hour is drawn at that hour. 2.10: the
   * prep block running 13:00–23:30 sat under "✨ Anytime today" while the now
   * row offered her those same hours as "Free now" — "why isn't it in the
   * diary with the heart on it?". Flexible still decides the clash kind and
   * the place prompt (utils/taskShape); it no longer decides where the card
   * goes. Only work with no hour at all is listed apart, below the day.
   */
  const hasHour = (t: Task) => Boolean(t.fixedTime || t.scheduledTime);
  const timelineTasks = dayOrder.filter((t) => split.timed.includes(t) || hasHour(t));
  const dayFlexible = split.flexible.filter((t) => !hasHour(t));
  /**
   * Standing work she wrote down on an earlier day and has not ticked yet.
   *
   * "flexible tasks like 'להגיש קורות חיים' or 'create lean canvas' supposed
   * to go into the tasks. be there until they are signed with V, no need to
   * reschedule every day." They used to fall off the bottom of the day they
   * were typed on and reappear in the MISSED card the next morning, asking
   * her to move them — every morning.
   *
   * Nothing is moved and no date is rewritten: the row keeps the day it was
   * written on, and the card prints that day next to it (rule 4). It simply
   * appears on today as well, because today is when she can act on it.
   *
   * Only on today. Drawing a to-do from last Sunday onto next Thursday's
   * plan says it is scheduled for Thursday, which is the claim this whole
   * change exists to stop making.
   */
  const carriedFlexible = showingToday ? carried : [];
  const flexibleTasks = [...dayFlexible, ...carriedFlexible];
  // The past no longer needs a cap: it folds into "N earlier today" (EarlierRow).
  const nowClock = new Date().toTimeString().slice(0, 5);

  // The free windows of the day, drawn between the cards. Bounded by her wake
  // and sleep times, never starting in the past, and ending at the departure
  // time when the next thing needs travel — an hour that is really ten
  // minutes must not be offered as an hour.
  const gaps = constrainGaps(
    findDayGaps(timelineTasks, {
      now: showingToday ? nowClock : undefined,
      dayStart: profile?.defaultWakeTime || '07:00',
      dayEnd: profile?.sleepTime || '22:00',
      minMinutes: 30,
    }),
    // The school run is not on the task list — it is a standing fact about her
    // week — so an hour it owns must be cut out here, or the timeline offers
    // her time she does not have.
    routines,
    getTodayString(),
  );
  // `trailingGaps` and `gapBefore` used to be derived here too. Nothing ever
  // rendered them — DayTimeline runs findDayGaps itself and draws the windows
  // between its own blocks, so this screen was recomputing the timeline's
  // geometry in order to drop it on the floor. `gaps` survives because the
  // empty-day branch below still offers the whole day as free windows.

  // ── The card list (Koral's picks, 30.9): cards, a now line, 2D, 3C. ──────
  const he = language === 'he';
  const dayStartAt = profile?.defaultWakeTime || '07:00';
  const dayEndAt = profile?.sleepTime || '22:00';
  const endOfTask = (t: Task) => addMinutes(t.fixedTime || t.scheduledTime || '00:00', t.durationMinutes || 30);
  // Today's past folds into one line above the now line; other days show whole.
  const earlier = showingToday
    ? timelineTasks.filter((t) => endedBy(t, clock)) : [];  // not endOfTask: that wraps at midnight (utils/taskEnd)
  const ahead = timelineTasks.filter((t) => !earlier.includes(t));
  // HAPPENING now — started, not ended, not done. The now is inside these
  // cards (a progress bar with the heart), not a line above them: 1.10, "it
  // says 21:30 above the task that happens now".
  const inProgress = showingToday
    ? ahead.filter((t) => t.status !== 'complete' && Boolean(t.fixedTime || t.scheduledTime)
      && timeToMinutes(t.fixedTime || t.scheduledTime || '') <= timeToMinutes(clock)) : [];
  const upcoming = ahead.filter((t) => !inProgress.includes(t));
  const nextCardId = showingToday ? upcoming.find((t) => t.status !== 'complete')?.id : undefined;
  // One problem per pair (utils/dayProblems) — the 12:15 clash is drawn once.
  const allProblems = dayProblems(dayTasks, dayEndAt);
  const openProblems = allProblems.filter((p) => !answered[p.key]);
  // Tasks drawn INSIDE a "which one?" card are not cards of their own.
  const inPick = new Set(openProblems.flatMap((p) => (p.kind === 'overlap' ? [p.work.id, p.fixed.id] : [])));
  const nowInCard = inProgress.some((t) => !inPick.has(t.id));
  // Late stays late after she answers: the card keeps saying so (rule 1).
  const lateInto = new Map(allProblems
    .filter((p): p is TravelProblem => p.kind === 'travel')
    .map((p) => [p.to.id, { lateBy: p.lateBy, leaveAt: endOfTask(p.from) }]));
  // The work inside a "which one?" card is not drawn a second time.
  const drawnInPick = new Set(openProblems.flatMap((p) => (p.kind === 'overlap' ? [p.work.id] : [])));
  // Free windows between cards, 45 min and up, counted to each departure.
  // Her routines on this day, as rows of their own (6.10, pick "A"). Until she
  // answers, a routine's hour is not offered as free — it is cut from the
  // windows exactly like a constraint.
  const routineRows = routineRowsFor(routines, dateKey, dayTasks, {
    now: showingToday ? clock : undefined, skipped: routineSkips[dateKey] || [],
  });
  const listGaps = constrainGaps(
    findDayGaps(timelineTasks, {
      now: showingToday ? clock : undefined, dayStart: dayStartAt, dayEnd: dayEndAt, minMinutes: 45,
    }),
    [...routines, ...routineRows.map((r) => ({ ...r.routine, kind: 'constraint' as const, weekdays: [], time: r.start }))],
    dateKey,
  );
  // The ＋ under the now line: the window she is in, or the next one — counted
  // from NOW to the next event, however short (18.10: 29 minutes before an
  // 11:00 call is real; the 45-minute floor above hid it, so the + said only
  // "Add something" and offered nothing that fitted).
  // Every day has the ＋ (21.10: "on the next day the + is missing"). On another day there is no "now":
  // it names the first window worth naming, never "free now".
  const plusRaw = plusSlot(constrainGaps(
    findDayGaps(timelineTasks, {
      now: showingToday ? clock : undefined, dayStart: dayStartAt, dayEnd: dayEndAt, minMinutes: PLUS_MIN_MINUTES,
    }),
    [...routines, ...routineRows.map((r) => ({ ...r.routine, kind: 'constraint' as const, weekdays: [], time: r.start }))],
    dateKey,
  ), showingToday ? clock : dayStartAt);
  const plus = plusRaw ? (showingToday ? plusRaw : { ...plusRaw, startsNow: false }) : null;
  const nowGap = plus?.startsNow ? plus.gap : undefined;
  const nextGap = plus && !plus.startsNow ? plus.gap : undefined;
  const travelKeys = openProblems.filter((p) => p.kind === 'travel').map((p) => p.key).join('|');
  // The day's ONE wake alarm, visible without a tap (rule 5) — and still drawn,
  // as 🔕, when she muted it: hiding it would remove the only way back on.
  const guessedOwner = ahead
    .map((t) => ({ t, chip: wakeChipFor(t, wakeInputs(profile), { dayEarliestWake }) }))
    .find((x) => x.chip);
  // The pill's answer wins on its own day — her choice (another hour, off) is
  // what Clock holds. 21.10: the pill said 08:18 and this row said 08:33.
  const pillPlan = morningAlarm.plan?.date === dateKey ? morningAlarm.plan : null;
  const pillTask = pillPlan?.task && ahead.find((t) => t.id === pillPlan.task!.id);
  const wakeOwner = pillPlan && pillTask
    ? { t: pillTask, chip: { at: pillPlan.at, muted: !pillPlan.on }, pill: true }
    : guessedOwner ? { ...guessedOwner, pill: false } : undefined;
  const wakeRow = wakeOwner && wakeOwner.chip
    && (!showingToday || timeToMinutes(wakeOwner.chip.at) > timeToMinutes(clock)) ? (
      <TouchableOpacity key="wake" style={styles.wakeRow} onPress={() => (wakeOwner.pill ? morningAlarm.openSheet() : handleAlarmPress(wakeOwner.t))}
        accessibilityRole="button">
        <Text style={[styles.wakeText, night && N.goldInk]}>
          {`${wakeOwner.chip.muted ? '🔕' : '⏰'} ${he ? `השכמה ${wakeOwner.chip.at}` : `Wake up ${wakeOwner.chip.at}`}`
            + (wakeOwner.chip.muted ? (he ? ' · כבוי' : ' · off') : '')}
        </Text>
      </TouchableOpacity>
    ) : null;

  // The taxi answer needs a real car time from the first place to the second.
  useEffect(() => {
    const pending = openProblems.filter((p): p is TravelProblem => p.kind === 'travel' && !(p.key in faster));
    if (!pending.length) return undefined;
    let alive = true;
    (async () => {
      const stored = await loadProfile().catch(() => null);
      for (const p of pending) {
        let result: { minutes: number; lateBy: number } | null = null;
        try {
          const fromLoc: any = asLoc(p.from);
          const dest = asLocation(p.to)?.address;
          const at = p.to.fixedTime || p.to.scheduledTime;
          // 0,0 is not a place (Null Island) — no origin, no probe.
          if (stored && fromLoc?.lat && fromLoc?.lng && dest && at && p.mode !== 'car') {
            const [car] = await GoogleService.compareModes(
              dest, at, toChainProfile(stored) as UserProfile, p.to.date, ['car'],
              { from: { lat: fromLoc.lat, lng: fromLoc.lng } });
            const minutes = car?.plan.totalDurationMinutes;
            if (minutes && minutes < p.travelMinutes) {
              const land = timeToMinutes(endOfTask(p.from)) + minutes;
              result = { minutes, lateBy: Math.max(0, land - timeToMinutes(at)) };
            }
          }
        } catch (e) {
          console.warn('[Today] no car option for', p.key, e);
        }
        if (!alive) return;
        setFaster((prev) => ({ ...prev, [p.key]: result }));
      }
    })();
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [travelKeys]);

  const askToMove = async (p: TravelProblem) => {
    const text = he
      ? `היי, אני אאחר קצת — אפשר ב-${p.askFor}?`
      : `Hi! I'm running a bit late — could we make it ${p.askFor}?`;
    const phone = String((p.to as any).contact?.phone || '').replace(/\D/g, '');
    const url = phone
      ? `https://wa.me/${phone}?text=${encodeURIComponent(text)}`
      : `whatsapp://send?text=${encodeURIComponent(text)}`;
    try {
      await Linking.openURL(url);
      answerProblem(p.key, 'ask');
    } catch (e) {
      console.warn('[Today] WhatsApp did not open', e);
      Alert.alert(he ? 'וואטסאפ לא נפתח' : "WhatsApp didn't open", text);
    }
  };

  /** "✓ Going": the routine becomes a task — with its address, so it routes. */
  const goToRoutine = async (r: RoutineRowData) => {
    try {
      await addTask({
        text: r.title, category: r.routine.category || 'general', priority: 'need_to',
        isFixed: true, fixedTime: r.start, scheduledTime: r.start,
        durationMinutes: r.routine.durationMinutes || 60, date: dateKey,
        status: 'pending', source: 'routine', historicalDurations: [], pickedAt: Date.now(),
        // A string is enough: ensureTravelChain geocodes it (as a typed address is).
        ...(r.address ? { location: r.address, hasLocation: true } : {}),
      } as any);
    } catch (e) {
      console.warn('[Today] routine could not be added', r.key, e);
      Alert.alert(he ? 'לא נשמר' : 'Not saved', String((e as Error)?.message || e));
      return;
    }
    await reloadShown();
  };
  /** "Not today": hidden for this date only. */
  const skipRoutine = async (r: RoutineRowData) => {
    const next = { ...routineSkips, [dateKey]: [...(routineSkips[dateKey] || []), r.key] };
    setRoutineSkips(next);
    await AsyncStorage.setItem(ROUTINE_SKIPS_KEY, JSON.stringify(next))
      .catch((e) => console.warn('[Today] routine skip not stored', e));
  };

  /** "Make it shorter": the work ends as the appointment begins (6.10). */
  const shortenWork = async (work: Task, endAt: string, key: string) => {
    const start = work.fixedTime || work.scheduledTime || '';
    const minutes = timeToMinutes(endAt) - timeToMinutes(start);
    if (!start || minutes < 5) return;
    await updateTaskFields(work.id, { durationMinutes: minutes }).catch((e) =>
      console.warn('[Today] shortening the work failed', work.id, e));
    await answerProblem(key, 'shortened');
    await reloadShown();
  };

  const keepAppointment = async (work: Task, fixed: Task, key: string, movesTo: string) => {
    const title = work.text.split('\n')[0].trim();
    if (movesTo === 'tomorrow') {
      await updateTaskFields(work.id, { date: dayAfter(dateKey) } as any)
        .catch((e) => console.warn('[Today] move to tomorrow failed', e));
      await refreshDay();
    } else {
      await handleResolveConflict({ first: work, second: fixed, action: 'move-to', at: movesTo });
    }
    answerProblem(key, 'keep-fixed');
    setLiveNote(he
      ? `📝 "${title}" ← ${movesTo === 'tomorrow' ? 'מחר' : movesTo}`
      : `📝 "${title}" moved to ${movesTo === 'tomorrow' ? 'tomorrow' : movesTo}`);
  };

  /**
   * The line under a card that opens Meira's preparation, or null.
   *
   *   an interview            "Want to prepare? 📄 Brief · ⏱ prep tomorrow 19:00"
   *                           — shown even when the brief could NOT be made, and
   *                           then says "why none?": a missing chip is how "no
   *                           company on the event" looked like "all fine".
   *   a study block for one   links to that interview's brief
   *   the next-up meeting     the brief it already had
   *   anything else           the generic prep (songs for karaoke…)
   */
  const briefChipFor = (t: Task): { label: string; onPress: () => void } | null => {
    const open = (id: string) => () => { setIvNote(''); setBriefSheetId(id); setBriefOpen(true); };
    const iv = ivBriefs.find((x) => x.task.id === t.id);
    if (iv) {
      return {
        label: interviewChipLabel(he, { ok: iv.brief.ok, prep: iv.prep, today: getTodayString() }),
        onPress: open(t.id),
      };
    }
    const parentId = (t as { prepForTaskId?: string }).prepForTaskId;
    const parent = parentId ? ivBriefs.find((x) => x.task.id === parentId) : undefined;
    if (parent) return { label: prepBlockChipLabel(he, parent.brief.ok), onPress: open(parent.task.id) };
    const hasBrief = Boolean(meetingBrief && briefTaskId === t.id);
    if (hasBrief || prep?.taskId === t.id) {
      return {
        label: !hasBrief && prep?.taskId === t.id
          ? prepLabel(prep.result, he) : (he ? '📄 תדריך לפגישה ›' : '📄 Meeting brief ›'),
        onPress: open(t.id),
      };
    }
    return null;
  };

  /** The interview whose brief the sheet is showing, if that is what it is showing. */
  const sheetIv = briefSheetId ? ivBriefs.find((x) => x.task.id === briefSheetId) : undefined;
  const refreshSheetInterview = async () => {
    if (!sheetIv) return;
    setIvRefreshing(true);
    setIvNote('');
    try {
      const fresh = await interviewBrief(sheetIv.task, true);
      if (!fresh.ok && fresh.reason === 'unreachable' && sheetIv.brief.ok) {
        // A refresh that could not reach the server must not replace a good
        // brief with an error — but it must not look like it worked either.
        setIvNote(`${briefReasonLine('unreachable', he)} · ${he ? 'זו הגרסה האחרונה שיש לי' : 'showing the last one I have'}`);
      } else {
        setIvBriefs((prev) => prev.map((x) => (x.task.id === sheetIv.task.id ? { ...x, brief: fresh } : x)));
      }
    } finally {
      setIvRefreshing(false);
    }
  };

  const card = (t: Task, current = false) => (dense && !focusing && openCardId !== t.id ? (
    <CompactRow
      key={`row-${t.id}`}
      task={t}
      he={he}
      moved={Boolean(moved?.ids.includes(t.id))}
      onOpen={() => setOpenCardId(t.id)}
      onToggleComplete={() => handleComplete(t)}
      nowAt={current || (showingToday && inProgress.includes(t)) ? clock : undefined}
      drag={showingToday ? { onLift: liftFromTray, onMove: moveOverDay, onDrop: (x, y) => { void dropOnDay(x, y); }, onCancel: endDrag } : undefined}
    />
  ) : (
    <DayCard
      nowAt={current ? clock : undefined}
      onPlan={(patch) => { updateTaskFields(t.id, patch).then(() => refreshDay()).catch((e) => console.warn('[Today] on-the-way plan not saved', t.id, e)); }}
      home={{ lat: (profile as any)?.homeLat, lng: (profile as any)?.homeLng }}
      wake={wakeChipFor(t, wakeInputs(profile), { dayEarliestWake })}
      morningAlarm={morningAlarm.plan?.task?.id === t.id && morningAlarm.plan.date === t.date
        ? { at: morningAlarm.plan.at, on: morningAlarm.plan.on, onToggle: morningAlarm.toggle, onLongPress: morningAlarm.openSheet }
        : null}
      getReady={getReadyTimeFor(t, wakeInputs(profile))}
      key={`card-${t.id}`}
      task={t}
      he={he}
      now={showingToday ? clock : undefined}
      isNext={t.id === nextCardId}
      // Started and she is not there: late NOW outranks a planned lateness.
      late={lateTrip?.id === t.id ? { lateBy, leaveAt: he ? 'עכשיו' : 'now' } : (lateInto.get(t.id) ?? null)}
      brief={briefChipFor(t)}
      expanded={openCardId === t.id}
      onToggleExpand={() => setOpenCardId((open) => (open === t.id ? null : t.id))}
      onToggleComplete={() => handleComplete(t)}
      onMove={() => setSelectedTask(t)}
      onModeChange={(mode) => handleTransportChange(t, mode)}
      onLeft={showingToday ? async () => {
        await confirmDeparture(t.id).catch((e) => console.warn('[Today] departure not confirmed', e));
        await refreshDay();
      } : undefined}
      onRetryRoute={() => {
        ensureTravelChain(dateKey, language, { forceTaskId: t.id })
          .then(() => refreshDay())
          .catch((e) => console.warn('[Today] route retry failed', t.id, e));
      }}
      onAddPlace={() => setSelectedTask(t)}
      // No suggestions queued (or already answered): the edit sheet, where she types it.
      onWhereIs={() => {
        Questions.askNow(`place:${t.id}`)
          .then((shown) => { if (!shown) setSelectedTask(t); })
          .catch((e) => { console.warn('[Today] where-is question not opened', t.id, e); setSelectedTask(t); });
      }}
      onOpenRoute={() => navigation.navigate('Trips')}
      onCompareModes={() => handleCompareModes(t)}
      onFromHere={() => handleChangeOrigin(t, 'current')}
      onStepDeparture={async (from, dir) => {
        const stored: any = await loadProfile().catch(() => null);
        const p = normalizeProfile(stored) as UserProfile | null;
        const loc = asLocation(t);
        const dest = loc?.address || loc?.displayName || '';
        if (!p || !dest) return { plan: null, reason: 'no-origin' };
        return GoogleService.getNeighbourDeparture(from, dest, p, t.date, dir);
      }}
      onPickDeparture={(plan) => {
        // Hers: keep the stored plan's origin, and tell the chain not to
        // re-rank it away (TransitPlan.pickedBy).
        const before = asLocation(t)?.transitPlan;
        return handlePickAlternative(t, {
          ...plan,
          originAddress: plan.originAddress ?? before?.originAddress,
          rulesVersion: before?.rulesVersion,
          pickedBy: 'her',
        });
      }}
      note={replanNotes[t.id]}
    />
  ));

  const gapRow = (g: DayGap) => (
    <View key={`gap-${g.start}`} ref={(v) => { zoneViews.current.set(g.start, { view: v, start: g.start, end: g.end }); }}
      style={hoverZone === g.start ? styles.dropHover : undefined} collapsable={false}>
    <GapSlotRow
      gap={g}
      language={language}
      onRequestIdeas={handleRequestGapIdeas}
      onPick={handlePickGapIdea}
      onAddOwn={(gap) => navigation.navigate('AddTask', { initialTime: gap.start, initialUntil: gap.end, initialDate: dateKey } as any)}
    />
    </View>
  );

  const liftFromTray = (t: Task, x: number, y: number) => {
    // A calendar event belongs to the calendar: it moves there, and the sync brings it here (her pick, 22.10).
    if (isFromCalendar(t.id)) {
      say(he ? 'אירוע מהיומן — משנים את השעה ביומן עצמו' : 'A calendar event — change its time in the calendar');
      return;
    }
    dragging.current = t;
    ghostRef.current?.show(t, x, y);
    setRulerRows(hourRows(dayTasks.filter((x2) => x2.id !== t.id), timeToMinutes(clock), (profile as any)?.sleepTime || '23:00'));
    zonesRef.current = [];
    zoneViews.current.forEach((z, id) => {
      z.view?.measureInWindow((zx, zy, w, h) => {
        if (h > 0) zonesRef.current.push({ id, y: zy, height: h, start: z.start, end: z.end });
      });
    });
  };
  const moveOverDay = (x: number, y: number) => {
    ghostRef.current?.move(x, y);
    rulerRef.current?.hover(y);
    const z = zoneAt(y, zonesRef.current);
    setHoverZone((prev) => (prev === (z?.id ?? null) ? prev : (z?.id ?? null)));
  };
  const endDrag = () => { ghostRef.current?.hide(); setHoverZone(null); setRulerRows(null); dragging.current = null; };
  /**
   * Put a dropped task back. Cleared fields are written as null, not
   * undefined — an undefined key never reaches the cloud row, and the hour
   * would come back on the next pull (the untick-resurrection pattern). If
   * the task's hour changed since the drop (another device, the agent), the
   * undo does nothing and says so rather than overwrite the newer edit.
   */
  const undoDrop = async (t: Task, before: Partial<Task>, droppedAt: string) => {
    try {
      const now = (await getAllTasks()).find((x) => x.id === t.id);
      if (!now || (now.scheduledTime || now.fixedTime) !== droppedAt) {
        say(he ? 'המשימה השתנתה בינתיים — לא ביטלתי' : 'It changed meanwhile — not undone');
        return;
      }
      if (before.date && now.date !== before.date) await moveTasksToDate([t.id], before.date);
      await updateTaskFields(t.id, {
        scheduledTime: before.scheduledTime ?? null,
        fixedTime: before.fixedTime ?? null,
        durationMinutes: before.durationMinutes,
        pickedAt: null,
      } as any);
      await ensureTravelChain(dateKey, language).catch((e) => console.warn('[Today] chain after undo failed', e));
      await redrawDay(dateKey);
    } catch (e) {
      console.warn('[Today] undo of a drop failed', t.id, e);
      say(he ? 'לא הצלחתי לבטל — אפשר לשנות במשימה עצמה' : "Couldn't undo — change it on the task itself");
    }
  };
  const dropOnDay = async (_x: number, y: number) => {
    const t = dragging.current;
    const row = rulerRef.current?.hover(y) ?? null;
    endDrag();
    if (!t) return;
    if (!row) { say(he ? 'שחררי על אחת השעות' : 'Drop it on one of the hours'); return; }
    const minutes = t.durationMinutes || 30;
    // The same judgement as adding it with an hour: travel, margin, what is there (28.10).
    const check = await checkBeforeSave({ id: t.id, text: t.text, date: dateKey, fixedTime: row.start, durationMinutes: minutes,
      place: typeof t.location === 'object' ? (t.location?.address || t.location?.displayName) : undefined }, he ? 'he' : 'en');
    let at = row.start;
    if (check.error) console.warn('[Today] drop: fit check could not run', check.error);
    if (check.error) say(he ? 'לא הצלחתי לבדוק אם זה נכנס — שיבצתי בכל זאת' : "Couldn't check whether it fits — placed anyway");
    if (check.stop) {
      const choice = await new Promise<'save' | 'alt' | 'no'>((resolve) => {
        Alert.alert(he ? '⚠️ זה לא נכנס' : "⚠️ This doesn't fit", check.text, [
          { text: he ? 'ביטול' : 'Cancel', style: 'cancel', onPress: () => resolve('no') },
          { text: he ? 'לשמור בכל זאת' : 'Save anyway', onPress: () => resolve('save') },
          ...(check.alt ? [{ text: he ? `לקבוע ב-${check.alt}` : `Book ${check.alt}`, onPress: () => resolve('alt' as const) }] : []),
        ], { cancelable: true, onDismiss: () => resolve('no') });
      });
      if (choice === 'no') return;
      if (choice === 'alt' && check.alt) at = check.alt;
    }
    const slot = { ok: true as const, time: at };
    const before = { date: t.date, scheduledTime: t.scheduledTime, fixedTime: t.fixedTime, durationMinutes: t.durationMinutes } as Partial<Task>;
    // One drop at a time: each one re-plans the day's trips (paid routes), and
    // a second drop while the first is routing would ask Google twice (cost review 27.10).
    if (dropBusy.current) { say(he ? 'רגע — עוד משבצת את הקודמת' : 'One moment — still placing the last one'); return; }
    dropBusy.current = true;
    say(he ? `משבצת ב־${slot.time}…` : `Placing at ${slot.time}…`);
    try {
      await applyScheduleAction({ kind: 'schedule', taskId: t.id, date: dateKey, time: slot.time, durationMinutes: minutes });
      await ensureTravelChain(dateKey, language).catch((e) => console.warn('[Today] chain after a drop failed', e));
      await redrawDay(dateKey);
      say(he ? `${t.text} · ${slot.time}` : `${t.text} · ${slot.time}`, [t.id], () => { void undoDrop(t, before, slot.time); });
    } catch (e) {
      console.warn('[Today] the dropped task was not scheduled', t.id, e);
      say(he ? 'לא הצלחתי לשבץ — נסי שוב' : "Couldn't place it — try again");
    } finally {
      dropBusy.current = false;
    }
  };

  /** The ＋ and what it opens — on EVERY day, not only today (21.10). */
  const plusBlock = (

              <>
                <NowAddRow he={he} open={suggestOpen} freeUntil={nowGap?.end} freeMinutes={nowGap?.minutes}
                  nextStart={nextGap?.start} nextMinutes={nextGap?.minutes}
                  onPress={() => setSuggestOpen((v) => !v)} />
                {suggestOpen ? (
                  <SuggestPanel
                    he={he}
                    date={dateKey}
                    onAddOwn={() => navigation.navigate('AddTask', { initialTime: plus?.from ?? (showingToday ? clock : dayStartAt), initialUntil: plus?.until, initialDate: dateKey } as any)}
                    onPrefill={(a) => navigation.navigate('AddTask', {
                      initialText: he ? (a.textHe ?? a.text) : a.text,
                      initialTime: a.time,
                      initialDate: a.date ?? dateKey,
                    } as any)}
                    onOpenTask={(id) => navigation.navigate('TaskDetail', { taskId: id } as any)}
                    onChanged={() => load(false)}
                  />
                ) : null}
              </>
  );

  /** The day ahead, in order: free windows, the question before a clash, the cards. */
  // A "set a new time" follow-up is a bell item, not a row in the day (28.10).
  const anytime = sortFlexible(dayFlexible.filter((t) => !drawnInPick.has(t.id) && !followUpOriginal(t.text)));
  const doneCount = dayTasks.filter((t) => t.status === 'complete').length;
  // 🔔 — clashes, what an earlier day left open, today's tasks with no place (utils/waitingList).
  const waiting = waitingList({
    problems: openProblems,
    overdue: showingToday ? overdue : [],
    today: dayTasks,
    needsPlace: (t) => Boolean(t.fixedTime) && !isFlexibleTask(t) && !isRemoteTask(t)
      && !(typeof t.location === 'object' && (t.location?.address || t.location?.displayName)),
    changes: changes.map((c) => ({ key: c.key, title: headline(c, language), taskId: c.taskId })),
    followUps,
    unscheduled: showingToday ? dayFlexible : [],
  });
  /**
   * "Homework — when will you do it? Find you a free slot?" (28.10): Meira looks
   * for the nearest time that fits TODAY (travel, margin and routines counted —
   * the same judgement as "does it fit?"), or she picks the hour herself.
   */
  const findTimeFor = async (t: Task) => {
    setAlertsOpen(false);
    const loc: any = typeof t.location === 'object' ? t.location : null;
    const a = await answerFeasibility({
      kind: 'feasibility', date: getTodayString(), minutes: t.durationMinutes || 30, what: t.text,
      place: loc?.address || loc?.displayName || undefined,
    } as any, he ? 'he' : 'en').catch((e) => { console.warn('[Today] slot search failed', e); return null; });
    const at = a?.alt;
    const book = async (hhmm: string) => {
      await updateTaskFields(t.id, { fixedTime: hhmm, scheduledTime: hhmm } as Partial<Task>);
      await load(false);
    };
    const pickHour = () => {
      const init = new Date(); init.setMinutes(init.getMinutes() + 30 - (init.getMinutes() % 15));
      DateTimePickerAndroid.open({
        value: init, mode: 'time', is24Hour: true,
        onChange: (e, d) => {
          if (e.type !== 'set' || !d) return;
          book(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`).catch((err) => console.warn('[Today] hour not saved', err));
        },
      });
    };
    Alert.alert(
      t.text,
      a ? (at ? (he ? `פנוי היום ב-${at}. לקבוע?` : `Free today at ${at}. Book it?`) : a.text)
        : (he ? 'לא הצלחתי לחפש זמן עכשיו — אפשר לבחור שעה.' : "Couldn't search for a time now — pick an hour."),
      [
        { text: he ? 'ביטול' : 'Cancel', style: 'cancel' },
        { text: he ? 'אבחר שעה' : 'Pick an hour', onPress: pickHour },
        ...(at ? [{ text: he ? `לקבוע ב-${at}` : `Book ${at}`, onPress: () => { book(at).catch((e) => console.warn('[Today] slot not saved', e)); } }] : []),
      ],
    );
  };
  // The home screen's 🔔 shows this same number (services/BellCount) — after render, never during it.
  useEffect(() => { if (showingToday) setBellCount(waiting.length); }, [showingToday, waiting.length]);
  /** Any row → that task's card, where everything can be edited (28.10). */
  const openTaskCard = async (taskId: string) => {
    setAlertsOpen(false);
    const t = dayTasks.find((x) => x.id === taskId) ?? overdue.find((x) => x.id === taskId)
      ?? (await getAllTasks().catch(() => [] as Task[])).find((x) => x.id === taskId);
    if (t) setSelectedTask(t);
    else Alert.alert(he ? 'המשימה כבר לא קיימת' : 'That task is gone', he ? 'אולי בוטלה או נמחקה.' : 'It may have been cancelled or deleted.');
  };
  const pickWaiting = (i: WaitingItem) => {
    if (i.kind === 'clash' && i.problemKey) { setAlertsOpen(false); setView('all'); setPairOpenKey(i.problemKey); return; }
    if (i.kind === 'unscheduled') {
      const t = dayFlexible.find((x) => x.id === i.taskId);
      if (t) findTimeFor(t).catch((e) => console.warn('[Today] find time failed', e));
      return;
    }
    if (i.kind === 'followup') {
      // "Later" was chosen: now the new date and hour — the original moves there.
      const f = followUps.find((x) => x.id === i.taskId);
      setAlertsOpen(false);
      if (f) setNewDate(f, he).then((ok) => { if (ok) { loadBell(); load(false).catch(() => {}); } }).catch((e) => console.warn('[Today] new date failed', e));
      return;
    }
    if (i.taskId) openTaskCard(i.taskId).catch(() => {});
  };
  const dayRows: React.ReactNode[] = [];
  const windows: Array<{ start: string; render: () => React.ReactNode }> = [
    ...listGaps.filter((g) => !(nowGap && g.start === nowGap.start)).map((g) => ({ start: g.start, render: () => gapRow(g) })),
    ...routineRows.map((r) => ({
      start: r.start,
      render: () => (
        <RoutineRow key={`routine-${r.key}`} row={r} he={he}
          onGoing={() => goToRoutine(r)} onSkip={() => skipRoutine(r)}
          onAskDays={() => { Questions.askNow(`routineDays:${r.key}`).catch(() => {}); }} />
      ),
    })),
  ].sort((x, y) => timeToMinutes(x.start) - timeToMinutes(y.start));
  let w = 0;
  const drawnInPair = new Set<string>();
  // The rows of what is HAPPENING end here — the ＋ row goes under them.
  let nowRowsEnd = 0;
  // Every task still ahead, the ones in progress included: a clash between two
  // things that have started is still a clash (1.10 — drawing them apart from
  // this loop dropped the birthday × study overlap card).
  for (const t of ahead) {
    if (drawnInPick.has(t.id) || drawnInPair.has(t.id)) continue;
    const at = timeToMinutes(t.fixedTime || t.scheduledTime || '00:00');
    while (w < windows.length && timeToMinutes(windows[w].start) < at) dayRows.push(windows[w++].render());
    const travel = openProblems.find((p): p is TravelProblem => p.kind === 'travel' && p.to.id === t.id);
    if (travel) {
      dayRows.push(
        <ClashQuestion
          key={`clash-${travel.key}`}
          problem={travel}
          he={he}
          faster={travel.key in faster ? faster[travel.key] : undefined}
          askName={askNameOf(travel.to)}
          onTaxi={() => { answerProblem(travel.key, 'taxi'); handleTransportChange(travel.to, 'car'); }}
          onAsk={() => askToMove(travel)}
          onGoLate={() => answerProblem(travel.key, 'late')}
        />,
      );
    }
    const overlap = openProblems.find((p) => p.kind === 'overlap' && p.fixed.id === t.id);
    if (overlap && overlap.kind === 'overlap') {
      const movesTo = moveSlotFor(overlap.work, dayTasks, {
        now: showingToday ? clock : undefined, dayStart: dayStartAt, dayEnd: dayEndAt,
      });
      // The work started first: it can simply END as the appointment begins.
      const workAt = overlap.work.fixedTime || overlap.work.scheduledTime || '';
      const fixedAt = overlap.fixed.fixedTime || overlap.fixed.scheduledTime || '';
      const shortenTo = workAt && fixedAt && timeToMinutes(workAt) < timeToMinutes(fixedAt) ? fixedAt : undefined;
      dayRows.push(
        <OverlapPick
          key={`pick-${overlap.key}`}
          problem={overlap}
          he={he}
          movesTo={movesTo}
          onKeepFixed={() => keepAppointment(overlap.work, overlap.fixed, overlap.key, movesTo)}
          onKeepWork={() => answerProblem(overlap.key, 'keep-work')}
          shortenTo={shortenTo}
          onShorten={shortenTo ? () => shortenWork(overlap.work, shortenTo, overlap.key) : undefined}
        />,
      );
      if (inProgress.includes(t) || inProgress.includes(overlap.work)) nowRowsEnd = dayRows.length;
      continue;
    }
    // Two appointments at once: ONE card, the two side by side (Koral, 27.10),
    // drawn where the first of them starts; the second is not drawn again.
    const pair = openProblems.find((p) => (p.kind === 'spatial' || p.kind === 'double')
      && [p.a.id, p.b.id].includes(t.id));
    if (pair && (pair.kind === 'spatial' || pair.kind === 'double')) {
      const other = pair.a.id === t.id ? pair.b : pair.a;
      drawnInPair.add(other.id);
      dayRows.push(
        <PairCard
          key={`pair-${pair.key}`}
          a={t}
          b={other}
          overlapMinutes={pair.overlapMinutes}
          he={he}
          openId={openCardId}
          onOpen={(x) => setOpenCardId((open) => (open === x.id ? null : x.id))}
          onComplete={(x) => handleComplete(x)}
          onResolve={() => setPairOpenKey(pair.key)}
          drag={showingToday ? { onLift: liftFromTray, onMove: moveOverDay, onDrop: (x, y) => { void dropOnDay(x, y); }, onCancel: endDrag } : undefined}
        />,
      );
      // The half she tapped opens as its full card right under the pair.
      const opened = [t, other].find((x) => x.id === openCardId);
      if (opened) dayRows.push(card(opened, inProgress.includes(opened)));
      if (inProgress.includes(t) || inProgress.includes(other)) nowRowsEnd = dayRows.length;
      continue;
    }
    dayRows.push(card(t, inProgress.includes(t)));
    if (inProgress.includes(t)) nowRowsEnd = dayRows.length;
  }
  while (w < windows.length) dayRows.push(windows[w++].render());

  // The "2 events overlap" popup: the first open pair she has not seen yet, or
  // the one she tapped. Chosen → the warning is answered; later → shown once.
  const adviceProblem = openProblems.find((p) => (p.kind === 'spatial' || p.kind === 'double')
    && (p.key === pairOpenKey || (!pairShown[p.key] && pairOpenKey === null)));
  const pairAdvice = adviceProblem && (adviceProblem.kind === 'spatial' || adviceProblem.kind === 'double')
    ? adviseOverlap(adviceProblem.a, adviceProblem.b, dayTasks,
      profile?.homeLat && profile?.homeLng ? { lat: profile.homeLat, lng: profile.homeLng } : undefined)
    : null;

  return (
    <View style={styles.root}>
      <LinearGradient colors={sky.colors} style={StyleSheet.absoluteFill} pointerEvents="none" />
      <PairAdviceModal
        advice={pairAdvice}
        he={he}
        onChoose={(id) => { if (adviceProblem) { answerProblem(adviceProblem.key, `chose:${id}`); markPairShown(adviceProblem.key); } }}
        onLater={() => { if (adviceProblem) markPairShown(adviceProblem.key); }}
      />

      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        // The day scrolls UNDER the glass header, which is the only reason a
        // blur is worth its cost: a blurred bar with nothing passing beneath
        // it is just a translucent rectangle. The pad is the header's own
        // height so nothing starts life hidden behind it.
        contentContainerStyle={[styles.scroll, { paddingTop: insets.top + HEADER_HEIGHT + 8 }]}
        showsVerticalScrollIndicator={false}
        scrollIndicatorInsets={{ top: insets.top + HEADER_HEIGHT }}
      >
        {/* E2 (Koral, 28.9): events found in her email / goals, as ONE honey
            banner — opened since 8.10 by "📅 Update calendars" in the menu. */}
        {eventsOpen && suggestionCount > 0 && (
          <View style={styles.eventsBanner}>
            <View style={styles.eventsRow}>
              <Text style={styles.eventsTitle} numberOfLines={2}>
                {language === 'he'
                  ? `📅 ${suggestionCount} אירועים נמצאו במייל`
                  : `📅 ${suggestionCount} event${suggestionCount === 1 ? '' : 's'} found in your email`}
              </Text>
              <TouchableOpacity style={styles.eventsAddAll} onPress={handleAddAllSuggestions} activeOpacity={0.85}>
                <Text style={styles.eventsAddAllText}>{language === 'he' ? 'להוסיף הכל' : 'Add all'}</Text>
              </TouchableOpacity>
            </View>
            <TouchableOpacity onPress={() => setEventsReview((v) => !v)} hitSlop={8}>
              <Text style={styles.eventsSub} numberOfLines={eventsReview ? undefined : 1}>
                {[...emailSuggestions.map((s) => s.taskToAdd?.text), goalSuggestion?.taskToAdd?.text]
                  .filter(Boolean).join(' · ')}
                {'  '}<Text style={styles.eventsReview}>{eventsReview
                  ? (language === 'he' ? 'סגירה' : 'close')
                  : (language === 'he' ? 'לעבור אחד-אחד' : 'review')}</Text>
              </Text>
            </TouchableOpacity>
            {eventsReview && (
              <View style={{ gap: 8, marginTop: 8 }}>
                {emailSuggestions.map((s) => (
                  <GapSuggestionCard key={s.id} suggestion={s}
                    onAccept={handleAcceptEmailSuggestion} onReject={handleRejectEmailSuggestion} />
                ))}
                {goalSuggestion && (
                  <GapSuggestionCard suggestion={goalSuggestion}
                    onAccept={handleAcceptGoalSuggestion} onReject={handleRejectGoalSuggestion} />
                )}
              </View>
            )}
          </View>
        )}

        {/* What the calendar moved or cancelled lives under the 🔔 now (28.10, Koral: "I don't
            want cancellations on Today — under notifications"). See AlertsSheet. */}

        {/* She left a task's place early: said, with undo — or asked (utils/leftEarly). */}
        {showingToday && leftNote && (
          <View style={styles.eventsBanner}>
            <Text style={styles.eventsTitle}>{leftEarlyLine(leftNote.v, leftNote.title, he)}</Text>
            <View style={[styles.eventsRow, { marginTop: 8 }]}>
              {leftNote.v.wasThere ? (
                <TouchableOpacity style={styles.eventsAddAll} activeOpacity={0.85} onPress={async () => {
                  await updateTaskFields(leftNote.v.taskId, { durationMinutes: leftNote.was } as any)
                    .catch((e) => console.warn('[Today] undo left-early failed', e));
                  setLeftNote(null);
                  load(false);
                }}>
                  <Text style={styles.eventsAddAllText}>{he ? 'ביטול' : 'Undo'}</Text>
                </TouchableOpacity>
              ) : (
                <>
                  {/* She never got there: cancelled, or a new time (open task until it has one). */}
                  <TouchableOpacity style={styles.eventsAddAll} activeOpacity={0.85} onPress={() => {
                    const id = leftNote.v.taskId;
                    setLeftNote(null);
                    answerRunningLate(id, 'cancel', he).then(() => load(false)).catch(() => {});
                  }}>
                    <Text style={styles.eventsAddAllText}>{he ? '✕ בוטל' : '✕ Cancelled'}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.eventsAddAll} activeOpacity={0.85} onPress={() => {
                    const id = leftNote.v.taskId;
                    setLeftNote(null);
                    answerRunningLate(id, 'reschedule', he).then(() => load(false)).catch(() => {});
                  }}>
                    <Text style={styles.eventsAddAllText}>{he ? '🔁 מועד חדש' : '🔁 New time'}</Text>
                  </TouchableOpacity>
                  {/* GPS can miss an arrival — then it really did end early. */}
                  <TouchableOpacity activeOpacity={0.85} hitSlop={8} onPress={async () => {
                    await updateTaskFields(leftNote.v.taskId, {
                      durationMinutes: leftNote.v.durationMinutes, leftEarlyHandled: true,
                    } as any).catch((e) => console.warn('[Today] shortening a task failed', e));
                    const { v, was } = leftNote;
                    setLeftNote(null);
                    load(false);
                    offerFreedTime(v, was, await getCurrentLocation().catch(() => null));
                  }}>
                    <Text style={styles.eventsReview}>{he ? 'הייתי שם' : 'I was there'}</Text>
                  </TouchableOpacity>
                </>
              )}
              <TouchableOpacity activeOpacity={0.85} hitSlop={8} onPress={async () => {
                if (!leftNote.v.wasThere) {
                  await updateTaskFields(leftNote.v.taskId, { leftEarlyHandled: true } as any).catch(() => {});
                }
                setLeftNote(null);
              }}>
                <Text style={styles.eventsReview}>{leftNote.v.wasThere ? (he ? 'סגירה' : 'OK') : (he ? 'לא' : 'No')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Nothing is syncing — say so, every time, until it is fixed. */}
        {showingToday && !signedIn && (
          <TouchableOpacity style={styles.offlineBanner} onPress={handleSignIn} activeOpacity={0.85}>
            <Text style={styles.offlineText}>
              {language === 'he'
                ? '⚠️ לא מחוברת — המשימות נשמרות רק בטלפון הזה. הקישי כדי להתחבר'
                : '⚠️ Not signed in — tasks live only on this phone. Tap to sign in'}
            </Text>
          </TouchableOpacity>
        )}
        {/* The tasks could not be refreshed from the cloud — what is drawn is
            this phone's copy, and she is told so (rule 1). Tap = try again. */}
        {showingToday && signedIn && tasksCloudError ? (
          <TouchableOpacity
            style={styles.calPill}
            activeOpacity={0.85}
            accessibilityRole="button"
            onPress={() => { load(false).catch((e) => console.warn('[Today] task refresh retry failed', e)); }}
          >
            <Text style={[styles.calPillText, night && N.goldInk]}>
              {he
                ? '☁️ לא הצלחתי לרענן — מוצג מה שבטלפון. הקישי לנסות שוב'
                : "☁️ Couldn't refresh — showing what's on this phone. Tap to retry"}
            </Text>
          </TouchableOpacity>
        ) : null}
        {/* The calendar could not be read — one small line, in words that
            name the fix. On 30.9 a DNS blip filled the top of the screen with
            a Java exception and told her to reconnect Google (utils/
            calendarErrorKind). The clashes are drawn in the day itself now —
            one card per problem, where it happens. */}
        {calendarError && calendarError !== 'not_connected' ? (() => {
          const kind = classifyCalendarError(calendarError) || 'other';
          const line = calendarErrorLine(kind, he);
          return (
            <TouchableOpacity
              style={styles.calPill}
              activeOpacity={0.85}
              accessibilityRole="button"
              onPress={() => {
                if (line.action === 'retry') {
                  syncCalendarNow(language, 'today-pill')
                    .catch((e) => console.warn('[Today] calendar retry failed', e));
                } else if (line.action === 'reconnect') {
                  // Straight to Calendars & mail (phone calendars first, 5.10), not the whole Menu.
                  (navigation as any).navigate('ProfileEdit', { section: 'calendars' });
                } else {
                  Alert.alert(he ? 'היומן' : 'Calendar', calendarError);
                }
              }}
            >
              <Text style={[styles.calPillText, night && N.goldInk]}>{line.text}</Text>
            </TouchableOpacity>
          );
        })() : null}

        {/* "Is this the same interview?" — three rows for one appointment,
            each with a different hour, is what a conversation leaves behind.
            Never merged silently: picking an hour for her is how the wrong
            one ends up on an interview. */}
        {daySameThing.map((group) => (
          <SameThingCard
            key={group.tasks.map((t) => t.id).join('-')}
            group={group}
            language={language}
            onKeep={handleKeepOne}
            onDismiss={handleNotTheSame}
          />
        ))}
        {/* Why the times just changed. Without this a leave time that moves on
            its own reads as a bug, which is how she learned not to trust it. */}
        {showingToday && liveNote && (
          <View style={styles.liveNote}>
            <TouchableOpacity
              onPress={() => { setLiveNote(null); setLiveNoteTaskId(null); }}
              accessibilityLabel={language === 'he' ? 'סגור' : 'Dismiss'}
            >
              <Text style={styles.liveNoteText}>{liveNote}</Text>
            </TouchableOpacity>
            {missedTrip && liveNoteTaskId === missedTrip.task.id && !missedOptionsOpen && (
              <TouchableOpacity onPress={() => setMissedOptionsOpen(true)} hitSlop={8} accessibilityRole="button">
                <Text style={styles.liveNoteMore}>{language === 'he' ? 'עוד אפשרויות ›' : 'More options ›'}</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
        {/* The departure has gone and she has not moved. Do not wait to be
            asked: the three next departures are already here, with their
            arrival times, and picking one rewrites the route and the alerts. */}
        {showingToday && missedTrip && (missedOptionsOpen || !liveNote || liveNoteTaskId !== missedTrip.task.id) && (
          <View style={styles.missedBox}>
            <Text style={styles.missedTitle} numberOfLines={2}>
              {language === 'he'
                ? `🚏 פספסת את היציאה ל${missedTrip.task.text}`
                : `🚏 You've missed the departure for ${missedTrip.task.text}`}
            </Text>
            {/* Late even on the next one: say it, and ask (13.10, Koral: "you're
                late — still going? reschedule? cancel? keep options!"). */}
            {(() => {
              const first = missedTrip.options.find((o) => !departureUncatchable(o, clock));
              const late = minutesLate(missedTrip.task.fixedTime, first?.plan.arriveAt);
              if (!late) return null;
              const he = language === 'he';
              // An interview / doctor / must cannot be late: the question is
              // what happened, and "no new time" stays as an open task (13.10).
              const must = isHighStakes(missedTrip.task);
              const choices: Array<[string, 'reschedule' | 'cancel' | 'open']> = must
                ? [[he ? '🔁 הוזז' : '🔁 Moved', 'reschedule'], [he ? '× בוטל' : '× Cancelled', 'cancel'],
                  [he ? '⏳ לא יודעת' : "⏳ Don't know", 'open']]
                : [[he ? '🔁 לדחות' : '🔁 Reschedule', 'reschedule'], [he ? '× לבטל' : '× Cancel', 'cancel']];
              return (
                <View>
                  <Text style={styles.missedLate}>
                    {must
                      ? (he ? `⏰ גם עם הבאה מגיעים ב-${first!.plan.arriveAt} — ${late} דק׳ איחור, ולזה אי אפשר לאחר. מה קרה?`
                        : `⏰ Even the next one arrives ${first!.plan.arriveAt} — ${late} min late, and this can't be late. What happened?`)
                      : (he ? `⏰ גם עם הבאה מגיעים ב-${first!.plan.arriveAt} — ${late} דק׳ איחור. עדיין הולכת?`
                        : `⏰ Even the next one arrives ${first!.plan.arriveAt} — ${late} min late. Still going?`)}
                  </Text>
                  {/* v3 late flow: the apology drafted — how late, when — to the
                      person on the task (or a chat she picks). WhatsApp opens with
                      the text in the box; she presses send, Meira never does. */}
                  {(() => {
                    const n = lateNotice(missedTrip.task, late, first!.plan.arriveAt, he);
                    return (
                      <TouchableOpacity
                        style={styles.lateTell}
                        accessibilityRole="button"
                        onPress={() => Linking.openURL(n.url).catch((e) => {
                          console.warn('[Today] WhatsApp did not open for the late note', e);
                          Alert.alert(he ? 'וואטסאפ לא נפתח' : "WhatsApp didn't open", n.text);
                        })}
                      >
                        <Text style={styles.lateTellText} numberOfLines={1}>
                          {n.to
                            ? (he ? `💬 להודיע ל${n.to} שאני מאחרת` : `💬 Tell ${n.to} I'm late`)
                            : (he ? '💬 להודיע שאני מאחרת' : "💬 Tell them I'm late")}
                        </Text>
                        <Text style={styles.lateTellDraft} numberOfLines={2}>{n.text}</Text>
                      </TouchableOpacity>
                    );
                  })()}
                  <View style={styles.lateRow}>
                    {choices.map(([label, intent]) => (
                      <TouchableOpacity key={intent} style={styles.lateBtn} accessibilityRole="button"
                        onPress={() => { answerRunningLate(missedTrip.task.id, intent, he).catch(() => {}); }}>
                        <Text style={styles.lateBtnText}>{label}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  <Text style={styles.lateHint}>{he ? 'עדיין הולכת? בחרי נסיעה:' : 'Still going? Pick a ride:'}</Text>
                </View>
              );
            })()}
            {/* Filtered again HERE, not only when fetched. The probe runs at
                most every few minutes; the clock does not wait for it, and a
                row with a live "Take it" button under a train that has left is
                worse than one fewer option. */}
            <TransitOptionsList
              options={missedTrip.options.filter((o) => !departureUncatchable(o, clock))}
              language={language}
              now={clock}
              emptyNote={language === 'he'
                ? 'הנסיעות שהצעתי כבר יצאו — מחפשת את הבאות…'
                : 'The ones I offered have gone — finding the next…'}
              originNote={missedTrip.origin === 'here'
                ? (language === 'he' ? '📍 מחושב מהמיקום שלך עכשיו' : '📍 timed from where you are now')
                : (language === 'he' ? '🏠 מחושב מהבית' : '🏠 timed from home')}
              onPick={handlePickMissedOption}
            />
            <TouchableOpacity
              style={styles.missedDismiss}
              onPress={() => setMissedTrip(null)}
              activeOpacity={0.8}
            >
              <Text style={styles.missedDismissText} numberOfLines={1}>
                {language === 'he' ? 'לא עכשיו' : 'Not now'}
              </Text>
            </TouchableOpacity>
          </View>
        )}
        {allDayTasks.length ? (
          <View style={styles.allDayStrip}>
            {allDayTasks.map((t) => (
              <TouchableOpacity key={`allday-${t.id}`} style={styles.allDayItem} onPress={() => setSelectedTask(t)}
                accessibilityRole="button" accessibilityLabel={`${allDayLabel(t, dateKey, he)} · ${t.text}`}>
                <Text style={[styles.allDayKicker, he && { textAlign: 'right' }]} numberOfLines={1}>{allDayLabel(t, dateKey, he)}</Text>
                <Text style={[styles.allDayTitle, he && { textAlign: 'right' }]} numberOfLines={2}>{t.text}</Text>
              </TouchableOpacity>
            ))}
          </View>
        ) : null}
        {/* Task list */}
        {loading || dayLoading ? (
          <ActivityIndicator color={BRAND.sunGold} size="large" style={{ marginTop: 32 }} />
        ) : dayTasks.length === 0 ? (
          // An empty day is still a day: the rest of it is offered as free
          // windows to fill, not as the words "nothing on today".
          <View style={styles.section}>
            {/* Day-aware. Today owns the day chips now, so a clear TOMORROW
                was being announced as "Today's clear". */}
            <Text style={[styles.emptyText, night && N.inkSoft]}>
              {showingToday
                ? (language === 'he' ? 'היום פנוי — מה נכניס?' : "Today's clear — what shall we put in?")
                : showingTomorrow
                  ? (language === 'he' ? 'מחר פנוי — מה נכניס?' : "Tomorrow's clear — what shall we put in?")
                  : (language === 'he'
                      ? `${formatDayLabel(dateKey, language)} פנוי — מה נכניס?`
                      : `${formatDayLabel(dateKey, language)} is clear — what shall we put in?`)}
            </Text>
            {plusBlock}
            {/* Her routines belong on an empty day most of all (6.10, pick A);
                their hours are cut from the windows beside them. */}
            {[
              ...constrainGaps(gaps, routineRows.map((r) => ({
                ...r.routine, kind: 'constraint' as const, weekdays: [], time: r.start,
              })), dateKey).map((gap) => ({
                start: gap.start,
                node: (
                  <GapSlotRow
                    key={`gap-${gap.start}`}
                    gap={gap}
                    language={language}
                    onRequestIdeas={handleRequestGapIdeas}
                    onPick={handlePickGapIdea}
                    // initialDate too: the empty-day branch dropped it, so a task
                    // added to an empty TOMORROW landed on today and vanished.
                    onAddOwn={(g) => navigation.navigate(
                      'AddTask', { initialTime: g.start, initialUntil: g.end, initialDate: dateKey } as any)}
                  />
                ),
              })),
              ...routineRows.map((r) => ({
                start: r.start,
                node: (
                  <RoutineRow key={`routine-${r.key}`} row={r} he={he}
                    onGoing={() => goToRoutine(r)} onSkip={() => skipRoutine(r)}
                    onAskDays={() => { Questions.askNow(`routineDays:${r.key}`).catch(() => {}); }} />
                ),
              })),
            ].sort((x, y) => timeToMinutes(x.start) - timeToMinutes(y.start)).map((x) => x.node)}
          </View>
        ) : (
          focusing ? (
          // v3 Focus (Koral, 27.10): the day as a ring with the beating heart,
          // what is happening now, the next three things, one suggestion — and
          // a door to the whole day. Nothing is hidden for good: All day is one tap.
          <View style={styles.section}>
            <View style={styles.focusHero}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={[styles.focusClock, { color: headInk }]}>{clock}</Text>
                <Text style={[styles.focusSub, { color: headInk }]} numberOfLines={2}>
                  {he
                    ? `${formatDayLabel(dateKey, language)} · ${doneCount} מתוך ${dayTasks.length} בוצעו`
                    : `${formatDayLabel(dateKey, language)} · ${doneCount} of ${dayTasks.length} done`}
                </Text>
              </View>
              <DayRing tasks={dayTasks} nowMin={timeToMinutes(clock)} sunriseMin={sun.sunrise} sunsetMin={sun.sunset}
                done={doneCount} total={dayTasks.length} he={he} ink={headInk} />
            </View>
            <View style={styles.cardList}>
              {wakeRow}
              {dayRows.slice(0, nowRowsEnd + 3)}
            </View>
            {plusBlock}
            {dayRows.length > nowRowsEnd + 3 || anytime.length || earlier.length ? (
              <TouchableOpacity style={[styles.allDayLink, night && N.chip]} onPress={() => setView('all')} accessibilityRole="button">
                <Text style={[styles.allDayLinkText, night && N.goldInk]}>{he ? 'כל היום ›' : 'All day ›'}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
          ) : (
          <View style={styles.section} onLayout={(e) => setTimelineY(e.nativeEvent.layout.y)}>
            <View style={styles.denseRow}>
              {[true, false].map((d) => (
                <TouchableOpacity key={String(d)} onPress={() => setDense(d)} accessibilityRole="tab"
                  accessibilityState={{ selected: dense === d }} style={[styles.denseChip, night && N.chip, dense === d && styles.denseChipOn]}>
                  <Text style={[styles.denseText, night && N.ink, dense === d && styles.denseTextOn]}>
                    {d ? (he ? 'מצומצם' : 'Compact') : (he ? 'מורחב' : 'Expanded')}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <TrayDock tasks={anytime} he={he} onLift={liftFromTray} onMove={moveOverDay}
              onDrop={(x, y) => { void dropOnDay(x, y); }} onCancel={endDrag}
              onOpen={(t) => setOpenCardId((open) => (open === t.id ? null : t.id))} />
            {anytime.filter((t) => t.id === openCardId).map((t) => card(t))}
            {/* Koral's picks, 30.9 (design canvas "Your picks"): what already
                happened folds into one line; a now line with a beating heart
                sits where she is; the ＋ under it offers the time she has;
                then the day as cards — the question before a clash that does
                not fit (3C), "which one?" where two things share an hour
                (2D), free windows between them. */}
            {showingToday ? (
              <DayGoalCard he={language === 'he'} date={dateKey} tasks={dayTasks} onCompleteTask={(t) => handleComplete(t)} />
            ) : null}
            {showingToday && earlier.length > 0 ? (
              <EarlierRow
                count={earlier.length}
                icons={earlier.map((t) => getCategoryMeta(t.category).icon)}
                open={earlierOpen}
                he={he}
                onToggle={() => setEarlierOpen((open) => !open)}
              />
            ) : null}
            {showingToday && earlierOpen ? <View style={styles.cardList}>{earlier.map((t) => card(t))}</View> : null}
            {/* The now line stands alone only when no card in progress carries
                it — a clash card holding both halves carries none. */}
            {showingToday && !nowInCard ? <NowLine time={clock} he={he} /> : null}
            {nowRowsEnd > 0 ? <View style={styles.cardList}>{dayRows.slice(0, nowRowsEnd)}</View> : null}
            {plusBlock}
            <View style={styles.cardList}>
              {wakeRow}
              {dayRows.slice(nowRowsEnd)}
            </View>
            {/* Her own work with no hour is drawn in the tray at the top of All day
                (TrayDock, 27.10) — never dropped (1.10: the prep block vanished). */}
          </View>
          )
        )}

        {/* What she didn't finish on earlier days — at the END of the day,
            out of the way of what is next, and still one tap from Done / Move
            / Let go. (Tasks does not carry these yet; until it does, they
            stay reachable here.) */}
        {showingToday && !focusing && <YesterdayCard
          tasks={overdue}
          today={getTodayString()}
          language={language}
          onMove={handleMoveOverdue}
          onReschedule={(t) => setSelectedTask(t)}
          onLetGo={handleLetGoOverdue}
          onComplete={handleCompleteOverdue}
          // The row's third button lets go (recoverable) — it deleted for ever,
          // with no confirmation, 4px from Done (council review, 28.9).
          onDelete={handleLetGoOverdue}
        />}

        <View style={{ height: 120 }} />
      </ScrollView>

      {rulerRows ? <HourRuler ref={rulerRef} rows={rulerRows} he={he} top={insets.top + 120} bottom={110} /> : null}
      <DragGhost ref={ghostRef} he={he} />
      <AlertsSheet visible={alertsOpen} items={waiting} he={he} onClose={() => setAlertsOpen(false)} onPick={pickWaiting}
        changes={changes} changesError={changesError} onOpenTask={(id) => { openTaskCard(id).catch(() => {}); }}
        onMore={() => { setAlertsOpen(false); setView('all'); }} />
      {moved ? (
        <View style={[styles.movedStrip, { bottom: 12 }]}>
          <Text style={styles.movedText} numberOfLines={1}>{moved.line}</Text>
          {moved.undo ? (
            <TouchableOpacity onPress={() => { const u = moved.undo; setMoved(null); u?.(); }} accessibilityRole="button" style={styles.movedUndo}>
              <Text style={styles.movedUndoText}>{he ? '↶ ביטול' : '↶ Undo'}</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}

      {/* "Change time" on the ⏰ chip — the system time picker, so the hour is
          set the way every other hour in this app is set. */}
      {alarmEditing && (
        <DateTimePicker
          value={(() => {
            const d = new Date();
            const [h, m] = alarmEditing.at.split(':').map(Number);
            d.setHours(Number.isFinite(h) ? h : 7, Number.isFinite(m) ? m : 0, 0, 0);
            return d;
          })()}
          mode="time"
          is24Hour
          onChange={(event: any, picked?: Date) => {
            if (event?.type === 'dismissed' || !picked) { setAlarmEditing(null); return; }
            const at = `${String(picked.getHours()).padStart(2, '0')}:${String(picked.getMinutes()).padStart(2, '0')}`;
            saveAlarmTime(alarmEditing.task, at);
          }}
        />
      )}

      {/* H3 (Koral, 28.9): a warm, SOLID band — the design system allows no
          backdrop blur. The L-clock is Meira's face; the location line sits
          right under the greeting, the highest place on the screen, because
          every leave time is counted from it. */}
      <LinearGradient
        colors={[sky.colors[0], sky.colors[1]]}
        style={[styles.headerOverlay, { paddingTop: insets.top + 6 }]}
      >
          <View style={[styles.header, language === 'he' && { flexDirection: 'row-reverse' }]}>
          {/* Meira's face is the door to her (canvas v4): tap → the chat. */}
          <TouchableOpacity onPress={() => navigation.navigate('Meira')} hitSlop={8}
            accessibilityRole="button" accessibilityLabel={language === 'he' ? 'לדבר עם מאירה' : 'Talk to Meira'}>
            <MeiraCoin size={32} label="Meira" />
          </TouchableOpacity>
          <Text style={[styles.greetingBig, { color: headInk }, language === 'he' && { textAlign: 'right' }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
            {showingToday
              ? getGreeting(language === 'he')
              : showingTomorrow
                ? (language === 'he' ? 'מחר' : 'Tomorrow')
                : formatDayLabel(dateKey, language)}
          </Text>
          <TouchableOpacity style={[styles.headerIcon, night && N.chip]} onPress={() => setAlertsOpen(true)}
            accessibilityLabel={language === 'he' ? `התראות — ${waiting.length}` : `Alerts — ${waiting.length}`}>
            <LineIcon name="bell" size={20} color={night ? NIGHT_COLORS.ink : BRAND.warmInk} />
            {waiting.length ? (
              <View style={styles.bellBadge}><Text style={styles.bellBadgeText}>{waiting.length}</Text></View>
            ) : null}
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.headerIcon, night && N.chip]}
            onPress={() => navigation.navigate('SettingsMenu')}
            accessibilityLabel={language === 'he' ? 'תפריט' : 'Menu'}
          >
            <LineIcon name="menu" size={20} color={night ? NIGHT_COLORS.ink : BRAND.warmInk} />
          </TouchableOpacity>
          {/* One door (8.10, Koral): the profile is the menu's "👤 את", and the
              📅 is the menu's "📅 עדכון יומנים", which opens the banner below. */}
        </View>
        <Text style={[styles.headerSub, { color: headInk }, language === 'he' && styles.headerSubHe]} numberOfLines={1}>
          {showingToday
            ? `${presence.state !== 'unknown' ? '' : '📍 '}${presence.state !== 'unknown' || hereLabel
              ? `${describeDayPresence(presence, language === 'he')}${hereLabel && presence.state !== 'at-venue' ? ` · ${hereLabel}` : ''}`
              : (language === 'he' ? 'מיקום כבוי' : 'Location off')}`
            // No "· N left today" (Koral, 17.10: "why 2 left today?! it was
            // great"): on one line the count either cut the place off or, with
            // no fix yet, stood in for it. The day below already shows what's left.
            : (language === 'he' ? `${dayTasks.length} מתוכננות` : `${dayTasks.length} planned`)}
        </Text>


        {/* The day picker that used to be the whole point of the Timeline tab.
            Today and tomorrow are the two days she actually plans between, so
            they stay one tap apart; anything further is the date picker. A
            timeline that can only draw two days is a diary that ends on
            Wednesday. */}
        {/* v3 (27.10): Focus | All day for today; any other day is "all day".
            Tomorrow stays one tap away (the chip), any other day is the 📅. */}
        <View style={styles.dayToggle}>
          {showingToday ? (
            <>
              <TouchableOpacity onPress={() => setView('focus')} activeOpacity={0.85}
                style={[styles.dayChip, night && N.chip, view === 'focus' && styles.dayChipOn]} accessibilityRole="tab"
                accessibilityState={{ selected: view === 'focus' }}>
                <Text style={[styles.dayChipText, night && N.ink, view === 'focus' && styles.dayChipTextOn]} numberOfLines={1}>
                  {language === 'he' ? '◎ פוקוס' : '◎ Focus'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setView('all')} activeOpacity={0.85}
                style={[styles.dayChip, night && N.chip, view === 'all' && styles.dayChipOn]} accessibilityRole="tab"
                accessibilityState={{ selected: view === 'all' }}>
                <Text style={[styles.dayChipText, night && N.ink, view === 'all' && styles.dayChipTextOn]} numberOfLines={1}>
                  {language === 'he' ? '☰ כל היום' : '☰ All day'}
                </Text>
              </TouchableOpacity>
            </>
          ) : (
            <TouchableOpacity onPress={() => setDateKey(getTodayString())} activeOpacity={0.85} style={[styles.dayChip, night && N.chip]}>
              <Text style={[styles.dayChipText, night && N.ink]} numberOfLines={1}>{language === 'he' ? '‹ חזרה להיום' : '‹ Back to today'}</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            onPress={() => setDateKey(getTomorrowString())}
            activeOpacity={0.85}
            style={[styles.dayChip, night && N.chip, showingTomorrow && styles.dayChipOn]}
          >
            <Text style={[styles.dayChipText, night && N.ink, showingTomorrow && styles.dayChipTextOn]} numberOfLines={1}>
              {language === 'he' ? 'מחר' : 'Tomorrow'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setShowDayPicker(true)}
            activeOpacity={0.85}
            style={[styles.dateBtn, night && N.chip, !showingToday && !showingTomorrow && styles.dayChipOn]}
            accessibilityLabel={language === 'he' ? 'בחירת תאריך' : 'Pick a day'}
          >
            <Text style={styles.dateBtnText}>📅</Text>
          </TouchableOpacity>
        </View>
        <MorningAlarmPill he={language === 'he'} state={morningAlarm} />
      </LinearGradient>

      {showDayPicker && (
        <DateTimePicker
          value={(() => {
            const [y, m, d] = dateKey.split('-').map(Number);
            return new Date(y, (m || 1) - 1, d || 1);
          })()}
          mode="date"
          onChange={(_e: any, picked?: Date) => {
            setShowDayPicker(false);
            if (!picked) return;
            const pad = (n: number) => String(n).padStart(2, '0');
            setDateKey(`${picked.getFullYear()}-${pad(picked.getMonth() + 1)}-${pad(picked.getDate())}`);
          }}
        />
      )}
      <BottomSheet visible={briefOpen} onClose={() => setBriefOpen(false)} heightRatio={0.8}>
        <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}>
          {sheetIv && (
            <>
              <InterviewPrepHeader task={sheetIv.task} prep={sheetIv.prep} he={language === 'he'} />
              {!!ivNote && (
                <Text style={styles.ivNote} numberOfLines={3}>{ivNote}</Text>
              )}
              <MeetingBriefCard
                brief={sheetIv.brief}
                language={language}
                refreshing={ivRefreshing}
                onRefresh={refreshSheetInterview}
              />
            </>
          )}
          {!sheetIv && prep && briefSheetId === prep.taskId && !(meetingBrief && briefTaskId === prep.taskId) && (
            <TaskPrepCard prep={prep.result} he={language === 'he'} taskText={prep.text} />
          )}
          {!sheetIv && meetingBrief && briefTaskId === nextUp?.id && briefSheetId === nextUp?.id && (
            <MeetingBriefCard
              brief={meetingBrief}
              language={language}
              refreshing={briefRefreshing}
              onRefresh={async () => {
                setBriefRefreshing(true);
                try {
                  const res = await nextMeetingBrief(true);
                  setMeetingBrief(res?.brief ?? null);
                  setBriefTaskId(res?.task.id ?? null);
                } finally {
                  setBriefRefreshing(false);
                }
              }}
            />
          )}
        </ScrollView>
      </BottomSheet>


      {selectedTask && (
        <TaskDetailBottomSheet
          task={selectedTask}
          visible={Boolean(selectedTask)}
          onClose={() => setSelectedTask(null)}
          onComplete={() => { handleComplete(selectedTask); setSelectedTask(null); }}
          onUpdate={handleUpdate}
          onDelete={handleDelete}
          language={language}
        />
      )}
    </View>
  );
}

/**
 * The floating header's own height (greeting ≈19 + name ≈32 + padding), plus
 * the day-chip row that came over when the Timeline tab was folded in (≈33 +
 * 10 margin). The scroll pads by this so the first card does not start life
 * hidden behind the glass — measured, not guessed at 56, which tucked the
 * clash card under it.
 */
/**
 * How long three fetched departures stay believable.
 *
 * Short, because the whole prompt exists for the minutes after she has already
 * missed one — and long enough that a screen left open does not re-probe
 * Google every ninety seconds. The catchability check is what actually retires
 * a departed option; this only catches the case where the timetable moved
 * underneath a list that still technically reads as catchable.
 */
const OPTIONS_TTL_MS = 4 * 60 * 1000;

const HEADER_HEIGHT = 74 + 42 + 44;   // + the day-chip row + the morning ⏰ pill

const styles = StyleSheet.create({
  greetingBig: { flex: 1, fontFamily: FONTS.display, fontSize: 22, color: BRAND.warmInk },
  headerIcon: {
    width: 38, height: 38, borderRadius: 19, backgroundColor: BRAND.creamCard,
    borderWidth: 1, borderColor: BRAND.line, alignItems: 'center', justifyContent: 'center',
  },
  headerIconText: { fontSize: 17 },
  headerSub: { fontFamily: FONTS.bodyBold, fontSize: 12, color: BRAND.inkSoft, marginTop: 4, marginLeft: 42 },
  headerSubHe: { marginLeft: 0, marginRight: 42, textAlign: 'right', writingDirection: 'rtl' },
  // One small line when the calendar could not be read (utils/calendarErrorKind).
  calPill: {
    alignSelf: 'flex-start', minHeight: 36, justifyContent: 'center', borderRadius: 12,
    paddingHorizontal: 12, marginBottom: 10, backgroundColor: BRAND.timeChipBg,
  },
  calPillText: { fontFamily: FONTS.bodyHeavy, fontSize: 12, color: BRAND.goldInk },
  anytimeHead: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.goldInk, marginTop: 4, marginBottom: 2 },
  cardList: { gap: 10 },
  wakeRow: {
    minHeight: 44, justifyContent: 'center', borderRadius: 14, paddingHorizontal: 14,
    backgroundColor: BRAND.timeChipBg,
  },
  wakeText: { fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.goldInk },
  eventsBanner: {
    backgroundColor: BRAND.honey, borderWidth: 1, borderColor: BRAND.sunGold, borderRadius: 16,
    padding: 12, marginBottom: 12,
  },
  eventsRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  eventsTitle: { flex: 1, fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.onGold },
  eventsAddAll: { backgroundColor: BRAND.warmInk, borderRadius: 999, paddingVertical: 8, paddingHorizontal: 14, minHeight: 36, justifyContent: 'center' },
  eventsAddAllText: { color: BRAND.creamCard, fontFamily: FONTS.bodyHeavy, fontSize: 12 },
  eventsSub: { fontFamily: FONTS.bodySemi, fontSize: 12, color: BRAND.goldInk, marginTop: 6 },
  eventsReview: { fontFamily: FONTS.bodyHeavy, textDecorationLine: 'underline', color: BRAND.onGold },
  // Warm cream. Today and the timeline blocks inside it are one palette
  // again: the blocks were briefly moved to a clay-accented set while the
  // screen around them stayed cream-and-gold, so Today read as two designs
  // stacked. Everything here is BRAND.
  // The sky gradient is drawn over this; cream only shows for a frame on mount.
  root: { flex: 1, backgroundColor: BRAND.cream },
  scroll: { paddingHorizontal: 16 },

  header: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0,
    paddingHorizontal: 16, paddingBottom: 10,
    borderBottomWidth: 1, borderBottomColor: nline('rgba(255,255,255,0.45)'),
    overflow: 'hidden',
  },
  greeting: { fontSize: 14, fontFamily: FONTS.body, color: BRAND.inkSoft },
  // The name is a heading, not a control.
  userName: { fontSize: 24, fontFamily: FONTS.serif, color: BRAND.warmInk },
  avatar: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: BRAND.goldSoft, borderWidth: 1, borderColor: BRAND.sunGold,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { fontSize: 16, fontFamily: FONTS.bodyBold, color: BRAND.goldInk },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dayToggle: { flexDirection: 'row', gap: 8, marginTop: 10 },
  dayChip: {
    flex: 1, flexBasis: 0, minWidth: 0, alignItems: 'center',
    paddingHorizontal: 10, paddingVertical: 7, borderRadius: RADIUS.pill,
    borderWidth: 1, borderColor: BRAND.line, backgroundColor: BRAND.creamCard,
  },
  dayChipOn: { backgroundColor: BRAND.sunGold, borderColor: BRAND.amber },
  dateBtn: {
    width: 40, alignItems: 'center', justifyContent: 'center', borderRadius: RADIUS.pill,
    borderWidth: 1, borderColor: BRAND.line, backgroundColor: BRAND.creamCard,
  },
  dateBtnText: { fontSize: 15 },
  bellBadge: {
    position: 'absolute', top: -2, right: -2, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4,
    backgroundColor: BRAND.danger, alignItems: 'center', justifyContent: 'center',
  },
  bellBadgeText: { fontFamily: FONTS.bodyHeavy, fontSize: 10, color: BRAND.white },
  denseRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 6, marginBottom: 8 },
  denseChip: { minHeight: 32, justifyContent: 'center', paddingHorizontal: 12, borderRadius: RADIUS.pill, backgroundColor: surf('rgba(255,253,247,0.6)') },
  denseChipOn: { backgroundColor: BRAND.warmInk },
  denseText: { fontFamily: FONTS.bodyBold, fontSize: 12, color: BRAND.warmInk },
  denseTextOn: { color: BRAND.creamCard },
  dropHover: { borderRadius: 18, borderWidth: 2, borderColor: '#7B6CFF', backgroundColor: 'rgba(123,108,255,0.10)' },
  movedStrip: {
    position: 'absolute', left: 14, right: 14, minHeight: 52, borderRadius: 26, paddingHorizontal: 16,
    flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: 'rgba(14,18,44,0.9)',
  },
  movedText: { flex: 1, fontFamily: FONTS.bodySemi, fontSize: 13, color: BRAND.white },
  movedUndo: { minHeight: 40, justifyContent: 'center', paddingHorizontal: 14, borderRadius: 20, backgroundColor: BRAND.sunGold },
  movedUndoText: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.onGold },
  focusHero: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 6, paddingBottom: 14 },
  focusClock: { fontFamily: FONTS.bodyHeavy, fontSize: 46, lineHeight: 50, fontVariant: ['tabular-nums'] },
  focusSub: { fontFamily: FONTS.bodySemi, fontSize: 14, marginTop: 4 },
  allDayStrip: { marginHorizontal: 16, marginBottom: 10, gap: 8 },
  allDayItem: { minHeight: 44, paddingVertical: 10, paddingHorizontal: 14, borderRadius: 16,
    backgroundColor: '#FFF4D6', borderWidth: 1, borderColor: '#F3D98B' },
  allDayKicker: { fontFamily: FONTS.bodyBold, fontSize: 12, color: BRAND.goldInk },
  allDayTitle: { fontFamily: FONTS.bodyHeavy, fontSize: 15, color: BRAND.warmInk, marginTop: 2 },
  allDayLink: {
    alignSelf: 'center', minHeight: 44, justifyContent: 'center', paddingHorizontal: 18, marginTop: 4,
    borderRadius: RADIUS.pill, backgroundColor: surf('rgba(255,253,247,0.85)'),
  },
  allDayLinkText: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.goldInk },
  dayChipText: {
    fontFamily: FONTS.bodySemi, fontSize: 12.5, color: BRAND.inkSoft, textAlign: 'center',
  },
  // Never white on gold — 1.7:1. onGold is the ink that survives the fill.
  dayChipTextOn: { color: BRAND.onGold, fontFamily: FONTS.bodyBold },
  speakBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: BRAND.creamCard, borderWidth: 1, borderColor: BRAND.line,
    alignItems: 'center', justifyContent: 'center',
  },
  speakBtnActive: { backgroundColor: BRAND.goldSoft, borderColor: BRAND.sunGold },
  speakIcon: { fontSize: 16 },

  briefingBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: BRAND.creamCard, borderWidth: 1, borderColor: BRAND.line,
    borderRadius: RADIUS.card - 2,
    paddingVertical: 10, paddingHorizontal: 14, marginBottom: 12,
  },
  briefingText: {
    flex: 1, flexShrink: 1, minWidth: 0,
    fontSize: 13, fontFamily: FONTS.bodySemi, color: BRAND.warmInk,
  },
  briefingPlay: {
    flexShrink: 0, backgroundColor: BRAND.sunGold, borderRadius: RADIUS.pill,
    paddingHorizontal: 14, paddingVertical: 7,
  },
  briefingPlayText: { fontSize: 12, fontFamily: FONTS.bodyBold, color: BRAND.onGold },
  briefingClose: { fontSize: 14, color: BRAND.inkFaint, fontFamily: FONTS.bodyBold },
  ivNote: { marginTop: 12, marginHorizontal: 16, fontFamily: FONTS.bodySemi, fontSize: 13, lineHeight: 19, color: BRAND.danger },

  greetingCard: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: BRAND.creamCard, borderWidth: 1, borderColor: BRAND.line,
    borderRadius: RADIUS.card - 2, padding: 14, marginBottom: 12,
  },
  greetingText: {
    flex: 1, flexShrink: 1, minWidth: 0,
    fontSize: 14, fontFamily: FONTS.bodySemi, color: BRAND.warmInk,
  },
  greetingChevron: { fontSize: 20, color: BRAND.inkFaint },
  heroWrap: { alignItems: 'center', marginBottom: 14, gap: 6 },
  heroStatus: {
    fontSize: 14, fontFamily: FONTS.bodySemi, color: BRAND.warmInk,
    textAlign: 'center', paddingHorizontal: 24,
  },

  leaveBanner: {
    backgroundColor: BRAND.amber, borderRadius: RADIUS.card,
    paddingVertical: 10, paddingHorizontal: 14, marginBottom: 12,
  },
  leaveText: { fontSize: 13, fontFamily: FONTS.bodyBold, color: BRAND.creamCard },
  offlineBanner: {
    backgroundColor: surf('#FDECEF'), borderRadius: RADIUS.card,
    borderWidth: 1, borderColor: '#EF476F',
    paddingHorizontal: 14, paddingVertical: 10, marginBottom: 12,
  },
  offlineText: { fontFamily: FONTS.bodyBold, fontSize: 13, color: nink('#A32B47') },
  clashBox: {
    backgroundColor: surf('#FFF4E5'), borderRadius: RADIUS.card,
    borderWidth: 1, borderColor: '#FF9F1C',
    paddingHorizontal: 14, paddingVertical: 10, marginBottom: 12, gap: 4,
  },
  clashTitle: { fontFamily: FONTS.bodyBold, fontSize: 14, color: nink('#8A5300') },
  clashItem: { gap: 6, marginTop: 4 },
  clashOptions: { gap: 6 },
  clashOption: {
    backgroundColor: BRAND.creamCard, borderRadius: RADIUS.chip,
    borderWidth: 1, borderColor: nline('#E8C89A'),
    paddingHorizontal: 10, paddingVertical: 7,
  },
  clashOptionText: { fontFamily: FONTS.bodySemi, fontSize: 12.5, color: nink('#7A4A00') },
  clashLine: { fontFamily: FONTS.body, fontSize: 13, color: nink('#8A5300') },
  clashCta: { fontFamily: FONTS.bodySemi, fontSize: 12, color: nink('#8A5300'), marginTop: 2 },
  suggestBox: {
    backgroundColor: BRAND.creamCard, borderRadius: RADIUS.card,
    borderWidth: 1, borderColor: BRAND.line,
    paddingHorizontal: 14, paddingVertical: 10, marginBottom: 12,
  },
  suggestHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  suggestTitle: { fontFamily: FONTS.bodyBold, fontSize: 14, color: BRAND.inkSoft },
  suggestChevron: { fontSize: 11, color: BRAND.inkFaint },
  suggestBody: { marginTop: 10, gap: 8 },
  beforeGoCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: BRAND.honey, borderRadius: RADIUS.card,
    borderWidth: 1, borderColor: BRAND.sunGold,
    paddingVertical: 12, paddingHorizontal: 14, marginBottom: 12,
    ...SHADOWS.card,
  },
  beforeGoBody: { flex: 1, gap: 2 },
  beforeGoTitle: { fontSize: 14, fontFamily: FONTS.bodyHeavy, color: BRAND.warmInk },
  beforeGoLine: { fontSize: 13, fontFamily: FONTS.bodySemi, color: BRAND.warmInk },

  presenceChip: {
    alignSelf: 'flex-start', backgroundColor: BRAND.creamCard,
    borderWidth: 1, borderColor: BRAND.line, borderRadius: RADIUS.pill,
    paddingHorizontal: 12, paddingVertical: 6, marginBottom: 10,
  },
  presenceChipText: { fontFamily: FONTS.bodySemi, fontSize: 12, color: BRAND.inkSoft },
  liveNote: {
    backgroundColor: BRAND.goldSoft, borderWidth: 1, borderColor: BRAND.goldInk,
    borderRadius: RADIUS.chip, paddingHorizontal: 12, paddingVertical: 8, marginBottom: 12,
  },
  liveNoteText: { fontFamily: FONTS.bodySemi, fontSize: 13, color: BRAND.warmInk, lineHeight: 19 },
  liveNoteMore: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.goldInk, marginTop: 6 },
  // v3: a glass card with a soft red edge — urgent, never alarming.
  missedBox: {
    backgroundColor: surf('rgba(255,255,255,0.94)'), borderWidth: 1, borderColor: '#F6B8C6', borderTopWidth: 4, borderTopColor: BRAND.danger,
    borderRadius: 22, padding: 14, gap: 10, marginBottom: 12, ...SHADOWS.card,
  },
  lateTell: {
    marginTop: 10, padding: 12, borderRadius: 16, backgroundColor: surf('#E6FAF3'), borderWidth: 1, borderColor: nline('#9FE6CC'), gap: 4,
  },
  lateTellText: { fontFamily: FONTS.bodyHeavy, fontSize: 14, color: nink('#0B6B4F') },
  lateTellDraft: { fontFamily: FONTS.bodySemi, fontSize: 12.5, color: BRAND.inkSoft, lineHeight: 18 },
  missedTitle: { fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.warmInk, lineHeight: 20 },
  missedDismiss: { alignSelf: 'center', minHeight: MIN_TOUCH, justifyContent: 'center', paddingHorizontal: 16 },
  missedLate: { fontFamily: FONTS.bodySemi, fontSize: 13.5, color: BRAND.warmInk, marginTop: 6, lineHeight: 19 },
  // Wraps: three answers ("Moved / Cancelled / Don't know") in Hebrew do not fit one line of a phone,
  // and squeezed side by side (flex 1 on each) they broke mid-word. flexBasis is the width a button
  // wants; what does not fit goes to the next line and the line's buttons share the room.
  lateRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  lateBtn: {
    flexGrow: 1, flexBasis: 96, minHeight: MIN_TOUCH, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 12,
    borderWidth: 1.5, borderColor: BRAND.goldInk, alignItems: 'center', justifyContent: 'center', backgroundColor: BRAND.creamCard,
  },
  lateBtnText: { fontFamily: FONTS.bodyBold, fontSize: 13, textAlign: 'center', color: BRAND.warmInk },
  lateHint: { fontFamily: FONTS.body, fontSize: 12.5, color: BRAND.inkSoft, marginTop: 8 },
  missedDismissText: { fontFamily: FONTS.bodySemi, fontSize: 13, color: BRAND.inkSoft },
  focusSlim: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: BRAND.goldSoft, borderWidth: 1, borderColor: BRAND.sunGold,
    borderRadius: RADIUS.chip, paddingHorizontal: 12, paddingVertical: 9,
    marginBottom: 10,
  },
  focusSlimLabel: { flexShrink: 0, fontFamily: FONTS.bodyBold, fontSize: 11, color: BRAND.goldInk },
  focusSlimTitle: { flex: 1, flexShrink: 1, minWidth: 0, fontFamily: FONTS.bodySemi, fontSize: 13, color: BRAND.warmInk },
  // flexShrink: 0 — "4/7" is the answer to the question the row asks; the
  // task title beside it is allowed to truncate, this is not.
  focusSlimPct: { flexShrink: 0, fontFamily: FONTS.bodyBold, fontSize: 11, color: BRAND.inkSoft },
  focusCard: {
    borderRadius: RADIUS.card, padding: 18, marginBottom: 16,
    ...SHADOWS.button,
  },
  focusLabel: { fontSize: 11, fontFamily: FONTS.bodyHeavy, color: 'rgba(255,255,255,0.7)', letterSpacing: 0.5, marginBottom: 6 },
  focusTitle: { fontSize: 18, fontFamily: FONTS.display, color: BRAND.creamCard, marginBottom: 4 },
  focusMotivation: { fontSize: 13, fontFamily: FONTS.bodySemi, color: 'rgba(255,255,255,0.9)', marginBottom: 12 },
  focusBottom: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  focusStatus: { fontSize: 13, fontFamily: FONTS.bodySemi, color: 'rgba(255,255,255,0.85)' },
  focusProgress: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  focusProgressText: { fontSize: 13, fontFamily: FONTS.bodySemi, color: 'rgba(255,255,255,0.85)' },
  ring: {
    width: 40, height: 40, borderRadius: 20,
    borderWidth: 3, borderColor: nline('rgba(255,255,255,0.5)'),
    alignItems: 'center', justifyContent: 'center',
  },
  ringPct: { fontSize: 10, fontFamily: FONTS.bodyHeavy, color: BRAND.creamCard },

  chainList: { gap: 10 },
  section: { gap: 8 },
  sectionLabel: {
    fontSize: 11, fontFamily: FONTS.bodyHeavy, color: BRAND.goldInk,
    letterSpacing: 1.2, marginBottom: 8,
  },

  taskCard: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: BRAND.creamCard, borderRadius: RADIUS.card,
    padding: 14, ...SHADOWS.card,
  },
  checkbox: {
    width: 24, height: 24, borderRadius: 12,
    borderWidth: 2, borderColor: BRAND.line,
    alignItems: 'center', justifyContent: 'center',
  },
  checkboxDone: { backgroundColor: BRAND.sunGold, borderColor: BRAND.sunGold },
  checkmark: { fontSize: 13, color: BRAND.creamCard, fontFamily: FONTS.bodyHeavy },
  taskBody: { flex: 1 },
  taskTitle: { fontSize: 15, fontFamily: FONTS.bodySemi, color: BRAND.warmInk, marginBottom: 4 },
  taskTitleDone: { color: BRAND.inkFaint, textDecorationLine: 'line-through' },
  taskMeta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  catTag: { borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2 },
  catTagText: { fontSize: 11, fontFamily: FONTS.bodySemi },
  duration: { fontSize: 11, fontFamily: FONTS.body, color: BRAND.inkSoft },
  subtaskList: { marginTop: 6, gap: 2 },
  subtaskLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  subtaskBullet: { fontSize: 12, color: BRAND.inkSoft },
  subtaskLabel: { flex: 1, fontSize: 12, fontFamily: FONTS.body, color: BRAND.inkSoft },
  subtaskLabelDone: { color: BRAND.inkFaint, textDecorationLine: 'line-through' },
  timeChip: {
    backgroundColor: BRAND.timeChipBg, borderRadius: RADIUS.chip,
    paddingHorizontal: 8, paddingVertical: 4,
  },
  timeChipText: { fontSize: 12, fontFamily: FONTS.bodyHeavy, color: BRAND.timeChipText },

  empty: { alignItems: 'center', paddingTop: 48, gap: 16 },
  emptyText: { fontSize: 14, fontFamily: FONTS.bodySemi, color: BRAND.inkSoft, textAlign: 'center' },
});
