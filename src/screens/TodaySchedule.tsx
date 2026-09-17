/**
 * TodaySchedule — today's timeline with rollover and completion actions.
 * Also: 🔊 spoken day briefing (button + first-open-of-day offer banner).
 * Dependencies: TaskStorage, MorningBriefingService, SpeechService.
 */
import React, { useState, useCallback, useEffect } from 'react';
import {
  View, ScrollView, StyleSheet, Text, TouchableOpacity, ActivityIndicator, Alert,
} from 'react-native';
import { BlurView } from 'expo-blur';
import AsyncStorage from '@react-native-async-storage/async-storage';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BRAND, FONTS, RADIUS, SHADOWS } from '../constants/theme';
import { getTodayString, getTomorrowString, sortTasksByPriorityAndTime } from '../utils/timeUtils';
import {
  getTasksForDate, loadSchedule, getSettings,
  markTaskComplete, updateTaskFields, deleteTask,
  loadGoals, addTask,
  getOverdueTasks, moveTasksToDate, letGoTasks,
  getAllTasks,
} from '../services/TaskStorage';
import { addMinutes, timeToMinutes } from '../utils/timeUtils';
import { hydrateCustomCategories } from '../constants/categories';
import { resolveClashes, Clash, ClashOption } from '../utils/resolveClashes';
import { classifyOverlap } from '../utils/overlapKind';
import { findSameThingGroups, mergedInto, SameThingGroup } from '../utils/likelySameTask';
import ClashCard from '../components/ClashCard';
import SameThingCard from '../components/SameThingCard';
import { Task, DailySchedule, AppLanguage } from '../types';
import TaskDetailBottomSheet from '../components/TaskDetailBottomSheet';
import { emitLumiMood } from '../services/LumiMood';
import { speakMorningBriefingNow } from '../services/MorningBriefingService';
import { stopSpeaking } from '../services/SpeechService';
import { scheduleFocusCheckIns, armMissingTaskAlerts } from '../services/NotificationService';
import { armDueAlarms } from '../services/AlarmPlanner';
import { plannedAlarmTime, wakeInputs } from '../utils/alarmPlan';
import {
  syncCalendarToday, getGmailEventSuggestions,
  acceptGmailSuggestion, dismissGmailSuggestion, ensureTravelChain,
  ensureTravelChainAhead, getNextUpcomingTask,
} from '../services/GoogleSync';
import NextUpCard from '../components/NextUpCard';
import MeetingBriefCard from '../components/MeetingBriefCard';
import YesterdayCard from '../components/YesterdayCard';
import { GapSuggestionCard } from '../components/GapSuggestionCard';
import TravelChainCard from '../components/TravelChainCard';
import DayTimeline from '../components/DayTimeline';
import { ModeQuote } from '../components/TimelineTravelLeg';
import TransitOptionsList from '../components/TransitOptionsList';
import FlexibleTasksCard from '../components/FlexibleTasksCard';
import { splitDayTasks } from '../utils/taskShape';
import { asLocation, toChainProfile } from '../utils/buildTravelChain';
import {
  replanFromNextDeparture, describeNextDeparture, nextDepartureOptions, applyDepartureOption,
  markArrivals, replanFromOrigin, keepNextTripLive,
} from '../services/LiveRoute';
import { missedPlannedDeparture } from '../utils/liveRoutePlan';
import { DepartureOption, departureUncatchable, minutesToDecide } from '../utils/departureOptions';
import {
  dayPresence, describeDayPresence, DayPresenceVerdict,
} from '../utils/presence';
import { GoogleService } from '../services/GoogleService';
import { loadProfile } from '../services/UserProfileStorage';
import { rememberTravelChoice } from '../services/TravelPreferenceStore';
import { getUserId, signInWithGoogle } from '../services/SupabaseAuthService';
import { isSupabaseConfigured } from '../services/supabaseClient';
import { UserProfile, TransportType, TransitPlan } from '../types';
import { GapSuggestion } from '../types/index';
import GapSlotRow from '../components/GapSlotRow';
import { DayGap, findDayGaps } from '../utils/findGaps';
import { visibleDayIds } from '../utils/dayWindow';
import { GapIdea, applyGapIdea, loadRoutines, suggestForGap } from '../services/GapFillService';
import { suggestReschedule } from '../utils/overlapKind';
import { Routine, constrainGaps } from '../utils/routines';
import { getCurrentLocation, describeHere } from '../services/LocationService';
import { nextMeetingBrief } from '../services/MeetingBriefService';
import { MeetingBriefResult } from '../services/LumiServer';

// Once-per-day flag for the "want to hear your day?" offer banner.
const BRIEFING_OFFERED_KEY = 'lumi.briefingOffered.v1';
// Groups the user has said are genuinely different things — never asked again.
const SAME_THING_DISMISSED_KEY = 'lumi.sameThingDismissed.v1';
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

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
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
  // Pending tasks stranded on earlier dates. They used to be invisible here —
  // this screen only ever queried today — so an unfinished task was simply lost.
  const [overdue, setOverdue] = useState<Task[]>([]);
  // Overlap detection has existed in utils/dayPlanning since before this
  // screen did, and only ever surfaced in PlanTomorrow — so a day holding a
  // Zoom call, a yoga class and a party all at once said nothing at all.
  const [clashes, setClashes] = useState<Clash[]>([]);
  // Rows that look like one appointment worded three ways. Asked about, never
  // merged behind her back.
  const [sameThing, setSameThing] = useState<SameThingGroup[]>([]);
  // Her standing week: the Monday gym to offer, and the 16:00 school run that
  // means those two hours were never free in the first place.
  const [routines, setRoutines] = useState<Routine[]>([]);
  // The task whose alarm hour is being changed (the ⏰ chip → "change time").
  const [alarmEditing, setAlarmEditing] = useState<{ task: Task; at: string } | null>(null);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [showAllTasks, setShowAllTasks] = useState(false);
  // Local-only mode was completely invisible: "continue offline" on the sign-in
  // screen left the app writing to AsyncStorage and nothing else, with no
  // indicator anywhere. Weeks of tasks lived only on the device while the
  // WhatsApp sync sat waiting for an account that was never created.
  const [signedIn, setSignedIn] = useState(true);
  // Where she actually is — at home / in transit / standing in one of today's
  // places. Every route in this app assumed "at home, always"; this is the
  // input that makes the return leg of a round trip start from the right town.
  const [presence, setPresence] = useState<DayPresenceVerdict>({ state: 'unknown' });
  // The street she is standing in, in words. "In transit" between two unnamed
  // points is the least useful thing to be told, and she asked to always SEE
  // where she is — a fix nobody turns into a name is not that.
  const [hereLabel, setHereLabel] = useState<string | null>(null);
  // What the last automatic re-route did, and why. A leave time that changes
  // on its own is not trustworthy; one that says "you've moved — re-routed" is.
  const [liveNote, setLiveNote] = useState<string | null>(null);
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
  /** Tasks for a date that is NOT today. Read-only browse; no side effects. */
  const [otherDayTasks, setOtherDayTasks] = useState<Task[]>([]);
  const showingToday = dateKey === getTodayString();
  const showingTomorrow = dateKey === getTomorrowString();

  useFocusEffect(useCallback(() => { load(); }, []));

  // The quiet path. No sync, no alarms, no arrivals — just the day, drawn.
  const loadOtherDay = useCallback(async (key: string) => {
    const rows = await getTasksForDate(key).catch(() => [] as Task[]);
    setOtherDayTasks(sortTasksByPriorityAndTime(rows));
  }, []);

  useEffect(() => {
    if (showingToday) { setOtherDayTasks([]); return; }
    let alive = true;
    getTasksForDate(dateKey)
      .then((rows) => { if (alive) setOtherDayTasks(sortTasksByPriorityAndTime(rows)); })
      .catch(() => { if (alive) setOtherDayTasks([]); });
    return () => { alive = false; };
  }, [dateKey, showingToday]);

  /** Re-read whichever day is on screen, by whichever route owns it. */
  const refreshDay = useCallback(async () => {
    if (showingToday) await load();
    else await loadOtherDay(dateKey);
  }, [showingToday, dateKey, loadOtherDay]);

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
        await markArrivals(dayTasks, { current: point }).catch(() => {});
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
   * The timeline asking for departures. Same computation as the prompt above —
   * it just hands the options back instead of putting them on the screen
   * itself, because the leg renders them inline where the journey is drawn.
   */
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

  const handleTimelineOptions = async (task: Task): Promise<DepartureOption[]> => {
    const storedProfile = await loadProfile().catch(() => null);
    if (!storedProfile) return [];
    const { options } = await nextDepartureOptions(task, storedProfile, { count: 3 })
      .catch(() => ({ options: [] as DepartureOption[] }));
    return options;
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
    await load(false);
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
    await load(false);
  };

  const load = async (showSpinner = true) => {
    try {
      // A refresh after an action must not blank the screen — only the first
      // load has nothing to show yet.
      if (showSpinner) setLoading(true);
      const today = getTodayString();
      const [tasksData, settings] = await Promise.all([
        getTasksForDate(today),
        getSettings(),
        hydrateCustomCategories(),
      ]);
      setLanguage(settings.language);
      setTasks(sortTasksByPriorityAndTime(tasksData));
      // Only a real SPATIAL clash earns a warning card. resolveClashes flags
      // any overlap, so a phone call during a meeting — which is a normal
      // Tuesday, not a problem — raised the same red card as being due in two
      // towns at once. Crying wolf costs the card its meaning.
      setClashes(resolveClashes(tasksData).filter((c) => {
        const verdict = classifyOverlap(c.a, c.b);
        return !verdict || verdict.kind === 'spatial';
      }));
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
      getOverdueTasks(today, nowHHMM).then(setOverdue).catch(() => {});
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
      loadRoutines().then(setRoutines).catch(() => {});
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
          await syncCalendarToday(settings.language);
          await ensureTravelChain(today, settings.language);
          await ensureTravelChainAhead(settings.language);
        } catch (e) {
          console.warn('[Today] sync chain failed', e);
        }
        const refreshed = await getTasksForDate(today).catch(() => null);
        if (refreshed) setTasks(sortTasksByPriorityAndTime(refreshed));
        getNextUpcomingTask().then(setNextUp).catch(() => {});

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
      getNextUpcomingTask().then(setNextUp).catch(() => {});

      getGmailEventSuggestions(settings.language).then(setEmailSuggestions).catch(() => {});
      // Free slot today + an active wish-list goal → suggest doing it now.
      buildGoalSuggestion(tasksData, settings.language).then(setGoalSuggestion).catch(() => {});
      // Lumi stays engaged with today's most important task: schedule the
      // daytime "how's it going?" check-ins (once per day, taps open the task).
      const focus = pickFocusTask(tasksData.filter((t) => t.status !== 'complete'));
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
    await load(false);
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
    Alert.alert(
      `${off ? '🔕' : '⏰'} ${at}`,
      he ? 'מה לעשות עם השעון המעורר?' : 'What should the alarm do?',
      [
        {
          text: off ? (he ? 'הפעל' : 'Turn on') : (he ? 'כבה' : 'Turn off'),
          onPress: async () => {
            await updateTaskFields(task.id, {
              // Turning it back on re-plans it; AlarmPlanner arms it once the
              // hour is inside Android's 24 h reach.
              alarmState: off ? 'planned' : 'not_needed',
              ...(off ? { alarmAt: at } : {}),
            } as any);
            if (off) {
              await armDueAlarms([{ ...task, alarmAt: at, alarmState: 'planned' } as Task])
                .catch(() => {});
            }
            await load(false);
          },
        },
        {
          text: he ? 'שנה שעה' : 'Change time',
          onPress: () => setAlarmEditing({ task, at }),
        },
        { text: he ? 'ביטול' : 'Cancel', style: 'cancel' },
      ],
    );
  };

  /** Save a new alarm hour and arm it if the morning is already in reach. */
  const saveAlarmTime = async (task: Task, at: string) => {
    setAlarmEditing(null);
    await updateTaskFields(task.id, { alarmAt: at, alarmState: 'planned' } as any);
    await armDueAlarms([{ ...task, alarmAt: at, alarmState: 'planned' } as Task]).catch(() => {});
    await load(false);
  };

  /**
   * Ideas for one free window. The live GPS fix is fetched ONLY for the window
   * happening right now — "you're 400 m from the pharmacy" is a claim about
   * where she is standing, and a later slot is anchored to wherever the
   * previous task leaves her instead (GapFillService).
   */
  const handleRequestGapIdeas = async (gap: DayGap): Promise<GapIdea[]> => {
    const now = new Date().toTimeString().slice(0, 5);
    const isNow = gap.start <= now && gap.end > now;
    const point = isNow ? await getCurrentLocation().catch(() => null) : null;
    return suggestForGap(gap, {
      today: getTodayString(), currentPoint: point, routines, language,
    });
  };

  const handlePickGapIdea = async (idea: GapIdea, gap: DayGap) => {
    await applyGapIdea(idea, gap, getTodayString());
    await load(false);
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
  const handleTransportChange = async (task: Task, mode: TransportType) => {
    const loc = asLocation(task);
    if (!loc) return;
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
    await updateTaskFields(task.id, {
      location: { ...loc, transportType: mode },
    } as any);

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
      await ensureTravelChain(today, language, { forceTaskId: task.id });
    }

    const fresh = await getTasksForDate(today);
    setTasks(sortTasksByPriorityAndTime(fresh));

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
    await applyDepartureOption(task, plan, language).catch(() => {});
    setAlternatives((prev) => ({ ...prev, [task.id]: [plan] }));
    const fresh = await getTasksForDate(getTodayString());
    setTasks(sortTasksByPriorityAndTime(fresh));
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
    setSelectedTask((p) => p ? { ...p, ...patch } : p);
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
    const gone = new Set(ids);
    setOverdue((prev) => prev.filter((t) => !gone.has(t.id)));
    const today = getTodayString();
    const nowHHMM = new Date().toTimeString().slice(0, 5);
    const dayTasks = await getTasksForDate(today).catch(() => [] as Task[]);
    const all = await getAllTasks().catch(() => [] as Task[]);

    for (const id of ids) {
      const task = all.find((t) => t.id === id);
      if (!task) continue;
      const slot = suggestReschedule(task, dayTasks, { now: nowHHMM });
      if (slot.when === 'today' && slot.at) {
        await moveTasksToDate([id], today).catch(() => {});
        await updateTaskFields(id, {
          scheduledTime: slot.at, fixedTime: undefined, isFixed: false,
        } as any).catch(() => {});
      } else {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        const pad = (n: number) => String(n).padStart(2, '0');
        await moveTasksToDate(
          [id], `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
        ).catch(() => {});
      }
    }
    await ensureTravelChain(today, language).catch(() => {});
    await load(false);
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

  // Apply one resolution. Everything here is a real edit to a real task —
  // nothing is "suggested" into a state the user cannot see or undo.
  const applyClashOption = async (opt: ClashOption) => {
    if (opt.kind === 'move' && opt.newTime) {
      await updateTaskFields(opt.taskId, { scheduledTime: opt.newTime, fixedTime: opt.newTime });
    } else if (opt.kind === 'shorten' && opt.newTime) {
      const task = tasks.find((t) => t.id === opt.taskId);
      const endMin = 23 * 60;
      const startMin = Number(opt.newTime.slice(0, 2)) * 60 + Number(opt.newTime.slice(3, 5));
      await updateTaskFields(opt.taskId, {
        scheduledTime: opt.newTime,
        fixedTime: opt.newTime,
        durationMinutes: Math.max(15, Math.min(task?.durationMinutes ?? 30, endMin - startMin)),
      });
    } else if (opt.kind === 'delay-next' && opt.newTime) {
      await updateTaskFields(opt.taskId, { scheduledTime: opt.newTime, fixedTime: opt.newTime });
    } else if (opt.kind === 'end-earlier' && opt.newTime) {
      // Shorten the earlier task so the journey to the pinned one fits.
      const task = tasks.find((t) => t.id === opt.taskId);
      const start = task?.fixedTime || task?.scheduledTime;
      if (start) {
        const mins = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
        await updateTaskFields(opt.taskId, {
          durationMinutes: Math.max(15, mins(opt.newTime) - mins(start)),
        });
      }
    } else if (opt.kind === 'attend-remotely') {
      // Nothing to reschedule — the point is that it needs no travel. Record
      // the decision so the travel chain stops planning a trip for it.
      await updateTaskFields(opt.taskId, { hasLocation: false, location: undefined } as any);
    } else if (opt.kind === 'choose') {
      // Keeping one means the other is let go — recoverable, never deleted.
      const clash = clashes.find((c) => c.options.some((o) => o === opt));
      const drop = clash && (clash.a.id === opt.taskId ? clash.b.id : clash.a.id);
      if (drop) await letGoTasks([drop]);
    }

    // Moving a clock without re-planning the journey leaves a route that is
    // quietly wrong — the whole reason the clash existed. Drop the stored plan
    // on BOTH tasks (the chain shifts for everything after the edit too) and
    // let ensureTravelChain work them out again, which also re-arms the
    // leave/wake alerts. Same pattern as handleTransportChange.
    const clash = clashes.find((c) => c.options.includes(opt));
    for (const t of [clash?.a, clash?.b]) {
      if (!t) continue;
      const loc = asLocation(t);
      if (loc) await updateTaskFields(t.id, { location: { ...loc, transitPlan: undefined } } as any);
    }
    await ensureTravelChain(getTodayString(), language).catch(() => {});
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
  const dayTasks = showingToday ? tasks : otherDayTasks;
  const dayOrder = [...dayTasks].sort((a, b) =>
    ((a.fixedTime || a.scheduledTime || '99:99') < (b.fixedTime || b.scheduledTime || '99:99') ? -1 : 1));
  const firstAwayId = dayOrder.find((t) => asLocation(t))?.id;
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
  const { timed: timelineTasks, flexible: flexibleTasks } = splitDayTasks(dayOrder);
  /**
   * Which cards actually get drawn — utils/dayWindow, which explains the rule
   * and is pinned by tests/run-day-window.ts. The short version: the cap used
   * to take the first six tasks in CLOCK order, so by the afternoon all six
   * were over and a 16:00 task added on a busy day appeared nowhere on the
   * screen. The cut comes off the past end now.
   */
  const nowClock = new Date().toTimeString().slice(0, 5);
  const visibleIds = visibleDayIds(timelineTasks, nowClock);
  const visibleDayOrder = showAllTasks
    ? timelineTasks : timelineTasks.filter((t) => visibleIds.has(t.id));
  const hiddenTaskCount = timelineTasks.length - visibleDayOrder.length;

  // The free windows of the day, drawn between the cards. Bounded by her wake
  // and sleep times, never starting in the past, and ending at the departure
  // time when the next thing needs travel — an hour that is really ten
  // minutes must not be offered as an hour.
  const gaps = constrainGaps(
    findDayGaps(timelineTasks, {
      now: nowClock,
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

  return (
    <View style={styles.root}>

      <ScrollView
        style={{ flex: 1 }}
        // The day scrolls UNDER the glass header, which is the only reason a
        // blur is worth its cost: a blurred bar with nothing passing beneath
        // it is just a translucent rectangle. The pad is the header's own
        // height so nothing starts life hidden behind it.
        contentContainerStyle={[styles.scroll, { paddingTop: insets.top + HEADER_HEIGHT + 8 }]}
        showsVerticalScrollIndicator={false}
        scrollIndicatorInsets={{ top: insets.top + HEADER_HEIGHT }}
      >
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

        {/* Clashes, above everything else — a day cannot be trusted if it
            silently claims you are in two places at once. Each one is a full
            card now: both sides with their hour, their place and a 🔒 when
            someone else holds the slot; the minutes at stake in the header
            colour (red for an overlap, amber for a journey that does not
            fit); every option with an icon for the kind of compromise it is;
            and "which matters more?" set apart at the bottom, because
            dropping something is a different answer from moving it. */}
        {showingToday && clashes.map((clash) => (
          <ClashCard
            key={`${clash.a.id}-${clash.b.id}`}
            clash={clash}
            language={language}
            onApply={applyClashOption}
            onOpenTask={(t) => navigation.navigate('TaskDetail', { taskId: t.id })}
          />
        ))}

        {/* "Is this the same interview?" — three rows for one appointment,
            each with a different hour, is what a conversation leaves behind.
            Never merged silently: picking an hour for her is how the wrong
            one ends up on an interview. */}
        {showingToday && sameThing.map((group) => (
          <SameThingCard
            key={group.tasks.map((t) => t.id).join('-')}
            group={group}
            language={language}
            onKeep={handleKeepOne}
            onDismiss={handleNotTheSame}
          />
        ))}

        {/* First-open-of-day: offer the spoken briefing */}
        {showingToday && showBriefingOffer && (
          <View style={styles.briefingBanner}>
            <Text style={styles.briefingText}>
              {language === 'he' ? '🔊 רוצה לשמוע את היום שלך?' : '🔊 Want to hear your day?'}
            </Text>
            <TouchableOpacity
              style={styles.briefingPlay}
              onPress={() => { dismissBriefingOffer(); toggleBriefing(); }}
            >
              <Text style={styles.briefingPlayText}>{language === 'he' ? 'נגן ▶' : 'Play ▶'}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={dismissBriefingOffer} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={styles.briefingClose}>✕</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* What is ACTUALLY next, with its wake / leave / route chain — above
            the fold, because "the first thing in today's list" is not the same
            as "the next thing that needs you somewhere at a time". */}
        {showingToday && nextUp && (
          <NextUpCard
            task={nextUp}
            language={language}
            profile={profile}
            onAlarmPress={handleAlarmPress}
            onPress={() => {
              // Tapping what's next opens its TRAVEL ROUTE — the map, the chain,
              // and the "not left yet → next bus" recompute — when it is a trip.
              // A task with no place has no route, so it opens its detail instead.
              const l = asLoc(nextUp);
              if (l?.transitPlan || l?.leaveHomeBy) {
                navigation.navigate('LeaveNow', { task: nextUp, isFirstOfDay: nextUp.id === firstAwayId });
              } else {
                navigation.navigate('TaskDetail', { taskId: nextUp.id });
              }
            }}
            onStart={() => navigation.navigate('FocusNow', { task: nextUp })}
          />
        )}

        {meetingBrief && nextUp && briefTaskId === nextUp.id && (
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

        {/* The 132px avatar that used to sit here is gone. It occupied the
            most valuable space on the screen — above the fold, before the
            schedule — to say nothing the status line does not say better. */}
        {showingToday && (
        <TouchableOpacity
          style={styles.heroWrap}
          onPress={() => navigation.navigate('CoachChat')}
          activeOpacity={0.85}
        >
          <Text style={styles.heroStatus} numberOfLines={2}>
            {tasks.length > 0
              ? `${pending.length}/${tasks.length} ${language === 'he' ? 'משימות להיום' : 'tasks today'}` +
                (leaveBy ? ` · 🚪 ${leaveBy}` : '') +
                (focusTask ? ` · 🎯 ${focusTask.text.slice(0, 28)}` : '')
              : language === 'he' ? 'הכל פנוי! לחצי כאן לתכנן את היום' : 'All clear — tap to plan your day'}
          </Text>
        </TouchableOpacity>
        )}

        {/* What you didn't finish — collapsed, and you decide what happens
            to it. Previously these tasks kept their old date and vanished. */}
        {showingToday && <YesterdayCard
          tasks={overdue}
          today={getTodayString()}
          language={language}
          onMove={handleMoveOverdue}
          onReschedule={(t) => setSelectedTask(t)}
          onLetGo={handleLetGoOverdue}
          onComplete={handleCompleteOverdue}
          onDelete={handleDeleteOverdue}
        />}

        {/* Suggestions (Gmail events + a wish-list item for a free slot) behind
            ONE collapsed row. Rendered open, they were 1-N extra cards
            competing with the actual schedule on first paint. */}
        {showingToday && suggestionCount > 0 && (
          <View style={styles.suggestBox}>
            <TouchableOpacity
              style={styles.suggestHeader}
              onPress={() => toggleSuggestions(!suggestionsOpen)}
              activeOpacity={0.8}
            >
              <Text style={styles.suggestTitle}>
                💡 {suggestionCount} {language === 'he'
                  ? (suggestionCount === 1 ? 'הצעה' : 'הצעות')
                  : (suggestionCount === 1 ? 'suggestion' : 'suggestions')}
              </Text>
              <Text style={styles.suggestChevron}>{suggestionsOpen ? '▲' : '▼'}</Text>
            </TouchableOpacity>

            {suggestionsOpen && (
              <View style={styles.suggestBody}>
                {emailSuggestions.map((s) => (
                  <GapSuggestionCard
                    key={s.id}
                    suggestion={s}
                    onAccept={handleAcceptEmailSuggestion}
                    onReject={handleRejectEmailSuggestion}
                  />
                ))}
                {goalSuggestion && (
                  <GapSuggestionCard
                    suggestion={goalSuggestion}
                    onAccept={handleAcceptGoalSuggestion}
                    onReject={handleRejectGoalSuggestion}
                  />
                )}
              </View>
            )}
          </View>
        )}

        {/* "Before you go" merged into NextUpCard above — one card for the
            next trip, tap it for the full route. */}

        {/* Focus card — tapping it opens the one-thing-at-a-time screen.
            Naming the focus was never the hard part; starting it is.
            Hidden when the focus IS what's next — the two cards were the same
            task shown twice, which is the overlap that made the top of the
            screen noise. */}
        {/* The big gold focus card is gone. It restated the next task in a
            second, louder shape, and between it and NEXT UP the day itself
            started below the fold — on a screen whose entire job is showing
            the day. Progress moved into the one-line summary above; starting
            a task is a tap on its block. */}
        {/* Where she is, said plainly. The whole travel chain is built on an
            assumption about this — "she is at home" — and until now that
            assumption was invisible and unfalsifiable. A chip that says
            "🚆 In transit" is also how she knows why the leave time changed. */}
        {showingToday && (presence.state !== 'unknown' || hereLabel) && (
          <View style={styles.presenceChip}>
            <Text style={styles.presenceChipText} numberOfLines={1}>
              {describeDayPresence(presence, language === 'he')}
              {/* The street, when we have it and the state has not already
                  named the place. "At home" and "At Tel Aviv University" are
                  both more useful than an address; "In transit" is not. */}
              {hereLabel && presence.state !== 'at-venue' ? ` · ${hereLabel}` : ''}
            </Text>
          </View>
        )}

        {/* Why the times just changed. Without this a leave time that moves on
            its own reads as a bug, which is how she learned not to trust it. */}
        {showingToday && liveNote && (
          <TouchableOpacity
            style={styles.liveNote}
            onPress={() => setLiveNote(null)}
            accessibilityLabel={language === 'he' ? 'סגור' : 'Dismiss'}
          >
            <Text style={styles.liveNoteText}>{liveNote}</Text>
          </TouchableOpacity>
        )}

        {/* The departure has gone and she has not moved. Do not wait to be
            asked: the three next departures are already here, with their
            arrival times, and picking one rewrites the route and the alerts. */}
        {showingToday && missedTrip && (
          <View style={styles.missedBox}>
            <Text style={styles.missedTitle} numberOfLines={2}>
              {language === 'he'
                ? `🚏 פספסת את היציאה ל${missedTrip.task.text}`
                : `🚏 You've missed the departure for ${missedTrip.task.text}`}
            </Text>
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

        {showingToday && focusTask && focusTask.id !== nextUp?.id && (
          <TouchableOpacity
            style={styles.focusSlim}
            activeOpacity={0.85}
            onPress={() => navigation.navigate('FocusNow', { task: focusTask })}
          >
            <Text style={styles.focusSlimLabel}>
              {language === 'he' ? '🎯 להתחיל' : '🎯 Start'}
            </Text>
            <Text style={styles.focusSlimTitle} numberOfLines={1}>{focusTask.text}</Text>
            <Text style={styles.focusSlimPct}>
              {done}/{tasks.length}
            </Text>
          </TouchableOpacity>
        )}

        {/* Task list */}
        {loading ? (
          <ActivityIndicator color={BRAND.sunGold} size="large" style={{ marginTop: 32 }} />
        ) : dayTasks.length === 0 ? (
          // An empty day is still a day: the rest of it is offered as free
          // windows to fill, not as the words "nothing on today".
          <View style={styles.section}>
            {/* Day-aware. Today owns the day chips now, so a clear TOMORROW
                was being announced as "Today's clear". */}
            <Text style={styles.emptyText}>
              {showingToday
                ? (language === 'he' ? 'היום פנוי — מה נכניס?' : "Today's clear — what shall we put in?")
                : showingTomorrow
                  ? (language === 'he' ? 'מחר פנוי — מה נכניס?' : "Tomorrow's clear — what shall we put in?")
                  : (language === 'he'
                      ? `${formatDayLabel(dateKey, language)} פנוי — מה נכניס?`
                      : `${formatDayLabel(dateKey, language)} is clear — what shall we put in?`)}
            </Text>
            {gaps.map((gap) => (
              <GapSlotRow
                key={`gap-${gap.start}`}
                gap={gap}
                language={language}
                onRequestIdeas={handleRequestGapIdeas}
                onPick={handlePickGapIdea}
                onAddOwn={(g) => navigation.navigate('AddTask', { initialTime: g.start } as any)}
              />
            ))}
          </View>
        ) : (
          <View style={styles.section}>
            {/* The work, above the diary. It holds no hour, so it cannot be
                drawn on a timeline without inventing one. */}
            <FlexibleTasksCard
              tasks={flexibleTasks}
              language={language}
              onToggle={handleComplete}
              onTap={setSelectedTask}
              onHold={setSelectedTask}
            />

            <Text style={styles.sectionLabel}>UP NEXT</Text>
            {/* One timeline, shared with the Timeline tab: proportional spans,
                the journey drawn between the blocks it joins, overlapping
                commitments side by side, and the moment marked where it
                actually falls. The old list of chain cards said the same
                things in a shape that could not show duration or collision. */}
            {/* visibleDayOrder, not timelineTasks. The cap above was computed
                and then never used: DayTimeline got the FULL day, so every
                task was already on screen and the "Show all N tasks" button
                below opened onto nothing — it just hid itself. Handing the
                timeline the windowed list is what makes both the cap and the
                button mean something. */}
            <DayTimeline
              tasks={visibleDayOrder}
              language={language}
              // The moment only exists on the day she is in. Marking "now" on
              // Thursday's timeline draws a red rule through an hour that has
              // not happened.
              now={showingToday ? new Date().toTimeString().slice(0, 5) : undefined}
              dayStart={profile?.defaultWakeTime || '08:00'}
              dayEnd={profile?.sleepTime || '22:00'}
              routines={routines}
              date={dateKey}
              onTaskTap={setSelectedTask}
              onTaskHold={setSelectedTask}
              onAddAtTime={(hhmm) => navigation.navigate(
                'AddTask', { initialTime: hhmm, initialDate: dateKey } as any)}
              onRequestIdeas={handleRequestGapIdeas}
              onPickIdea={handlePickGapIdea}
              onModeChange={handleTransportChange}
              onOpenRoute={(t) => navigation.navigate(
                'LeaveNow', { task: t, isFirstOfDay: t.id === firstAwayId } as any)}
              onPlaceTask={setSelectedTask}
              onResolveConflict={handleResolveConflict}
              onShowOptions={handleTimelineOptions}
              onPickOption={handlePickAlternative}
              onToggleComplete={handleComplete}
              onChangeOrigin={handleChangeOrigin}
              onCompareModes={handleCompareModes}
            />
            {hiddenTaskCount > 0 && (
              <TouchableOpacity
                style={styles.showAll}
                onPress={() => setShowAllTasks(true)}
                activeOpacity={0.8}
              >
                <Text style={styles.showAllText}>
                  {language === 'he'
                    ? `הצג את כל ${timelineTasks.length} המשימות`
                    : `Show all ${timelineTasks.length} tasks`}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        <View style={{ height: 120 }} />
      </ScrollView>

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

      {/* The header, lifted out of the scroll and floated over it.
          It used to scroll away with the content, so there was nothing for a
          blur to blur and the account badge left the screen the moment she
          looked at her afternoon. The clash cards stay first INSIDE the
          scroll — a day that claims you are in two places at once still
          leads — they simply pass beneath the glass now. */}
      <BlurView
        intensity={40}
        tint="light"
        style={[styles.headerOverlay, { paddingTop: insets.top + 6 }]}
      >
        <View style={styles.header}>
          <View>
            <Text style={styles.greeting}>
              {showingToday
                ? `☀️ ${getGreeting()}`
                : showingTomorrow
                  ? (language === 'he' ? 'מחר' : 'Tomorrow')
                  : formatDayLabel(dateKey, language)}
            </Text>
            <Text style={styles.userName}>Lumi</Text>
          </View>
          <View style={styles.headerActions}>
            {/* 🔊 hear today's tasks read aloud */}
            <TouchableOpacity
              style={[styles.speakBtn, speaking && styles.speakBtnActive]}
              onPress={toggleBriefing}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={styles.speakIcon}>{speaking ? '⏹' : '🔊'}</Text>
            </TouchableOpacity>
            {/* ☑️ end-of-day review: tick off the list, and give anything
                left over an exit (move / archive / delete). */}
            <TouchableOpacity
              style={styles.speakBtn}
              onPress={() => navigation.navigate('DayReview')}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={styles.speakIcon}>☑️</Text>
            </TouchableOpacity>
            {/* Was a decorative "L". A round badge in the top-right corner is
                where every app puts the account, so it now IS the account —
                and Profile gives up its tab-bar slot to the timeline. */}
            <TouchableOpacity
              style={styles.avatar}
              onPress={() => navigation.navigate('ProfileEdit')}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityLabel={language === 'he' ? 'פרופיל' : 'Profile'}
            >
              <Text style={styles.avatarText}>👤</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* The day picker that used to be the whole point of the Timeline tab.
            Today and tomorrow are the two days she actually plans between, so
            they stay one tap apart; anything further is the date picker. A
            timeline that can only draw two days is a diary that ends on
            Wednesday. */}
        <View style={styles.dayToggle}>
          <TouchableOpacity
            onPress={() => setDateKey(getTodayString())}
            activeOpacity={0.85}
            style={[styles.dayChip, showingToday && styles.dayChipOn]}
          >
            <Text style={[styles.dayChipText, showingToday && styles.dayChipTextOn]} numberOfLines={1}>
              {language === 'he' ? 'היום' : 'Today'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setDateKey(getTomorrowString())}
            activeOpacity={0.85}
            style={[styles.dayChip, showingTomorrow && styles.dayChipOn]}
          >
            <Text style={[styles.dayChipText, showingTomorrow && styles.dayChipTextOn]} numberOfLines={1}>
              {language === 'he' ? 'מחר' : 'Tomorrow'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setShowDayPicker(true)}
            activeOpacity={0.85}
            style={[styles.dayChip, !showingToday && !showingTomorrow && styles.dayChipOn]}
          >
            <Text
              style={[styles.dayChipText, !showingToday && !showingTomorrow && styles.dayChipTextOn]}
              numberOfLines={1}
            >
              📅 {language === 'he' ? 'תאריך' : 'Pick a day'}
            </Text>
          </TouchableOpacity>
        </View>
      </BlurView>

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

const HEADER_HEIGHT = 68 + 42;   // + the day-chip row

const styles = StyleSheet.create({
  // Warm cream. Today and the timeline blocks inside it are one palette
  // again: the blocks were briefly moved to a clay-accented set while the
  // screen around them stayed cream-and-gold, so Today read as two designs
  // stacked. Everything here is BRAND.
  root: { flex: 1, backgroundColor: BRAND.cream },
  scroll: { paddingHorizontal: 16 },

  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  headerOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0,
    paddingHorizontal: 16, paddingBottom: 10,
    borderBottomWidth: 1, borderBottomColor: BRAND.line,
    // BRAND.cream (#FCF7EC) at 72%, so expo-blur has the canvas colour to
    // work from rather than turning the top of the screen grey. It was the
    // old paper white, which tinted the glass a shade cooler than the day
    // scrolling under it.
    backgroundColor: 'rgba(252,247,236,0.72)',
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
    backgroundColor: '#FDECEF', borderRadius: RADIUS.card,
    borderWidth: 1, borderColor: '#EF476F',
    paddingHorizontal: 14, paddingVertical: 10, marginBottom: 12,
  },
  offlineText: { fontFamily: FONTS.bodyBold, fontSize: 13, color: '#A32B47' },
  clashBox: {
    backgroundColor: '#FFF4E5', borderRadius: RADIUS.card,
    borderWidth: 1, borderColor: '#FF9F1C',
    paddingHorizontal: 14, paddingVertical: 10, marginBottom: 12, gap: 4,
  },
  clashTitle: { fontFamily: FONTS.bodyBold, fontSize: 14, color: '#8A5300' },
  clashItem: { gap: 6, marginTop: 4 },
  clashOptions: { gap: 6 },
  clashOption: {
    backgroundColor: BRAND.creamCard, borderRadius: RADIUS.chip,
    borderWidth: 1, borderColor: '#E8C89A',
    paddingHorizontal: 10, paddingVertical: 7,
  },
  clashOptionText: { fontFamily: FONTS.bodySemi, fontSize: 12.5, color: '#7A4A00' },
  clashLine: { fontFamily: FONTS.body, fontSize: 13, color: '#8A5300' },
  clashCta: { fontFamily: FONTS.bodySemi, fontSize: 12, color: '#8A5300', marginTop: 2 },
  suggestBox: {
    backgroundColor: BRAND.creamCard, borderRadius: RADIUS.card,
    borderWidth: 1, borderColor: BRAND.line,
    paddingHorizontal: 14, paddingVertical: 10, marginBottom: 12,
  },
  suggestHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  suggestTitle: { fontFamily: FONTS.bodyBold, fontSize: 14, color: BRAND.inkSoft },
  suggestChevron: { fontSize: 11, color: BRAND.inkFaint },
  suggestBody: { marginTop: 10, gap: 8 },
  showAll: {
    alignSelf: 'center', marginTop: 10,
    paddingVertical: 8, paddingHorizontal: 16,
    borderRadius: 999, borderWidth: 1, borderColor: BRAND.line,
    backgroundColor: BRAND.creamCard,
  },
  showAllText: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.inkSoft },
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
  missedBox: {
    backgroundColor: BRAND.creamCard, borderWidth: 1.5, borderColor: BRAND.danger,
    borderRadius: RADIUS.chip + 4, padding: 12, gap: 10, marginBottom: 12,
  },
  missedTitle: { fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.warmInk, lineHeight: 20 },
  missedDismiss: { alignSelf: 'center', paddingVertical: 6, paddingHorizontal: 14 },
  missedDismissText: { fontFamily: FONTS.bodySemi, fontSize: 12.5, color: BRAND.inkFaint },
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
    borderWidth: 3, borderColor: 'rgba(255,255,255,0.5)',
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
