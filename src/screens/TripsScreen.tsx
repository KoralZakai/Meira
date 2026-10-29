/**
 * TripsScreen — every journey Lumi has planned, as a directions list.
 *
 * This is the tab that replaced Stats. Stats showed `Math.random()` bar
 * heights (Analytics.tsx) — fabricated numbers presented as a real week — and
 * nothing in the app is more central than "am I going to get there on time".
 * That question had no home: a route lived buried inside one task's detail
 * sheet, so seeing tomorrow's train meant remembering which task it belonged
 * to and tapping into it.
 *
 * Shape borrowed from Google Maps directions, deliberately:
 *   destination and arrival time at the top, then the legs as a vertical
 *   timeline with a connecting rail, then the actions.
 * That layout is already in most people's muscle memory, which is exactly what
 * you want from a screen someone opens while walking out of the house.
 *
 * ADHD-specific choices:
 *   - the next trip is expanded on open; everything else is collapsed. One
 *     decision visible at a time.
 *   - relative time ("leave in 12 min") next to every clock time. A clock time
 *     alone requires the reader to do arithmetic to feel urgency, which is the
 *     exact operation time blindness makes unreliable.
 *   - the leave time is the loudest element on the card, not the appointment
 *     time — leaving is the action; arriving is the consequence.
 *   - trips with no route yet say so rather than rendering an empty shell.
 *
 * Every trip can be re-planned here, by mode: 🚌 🚆 🚗 🚲 🚶. "Other ways"
 * used to be train-blind — it asked Google for the mode already stored on the
 * task, which is a bus unless something else set it, so asking for other ways
 * answered with more buses forever. The mode is now hers to choose, the
 * timetable options come back for THAT mode, and picking one SAVES it: the
 * route, the leave time, the wake time and the alerts all move with it.
 *
 * Dependencies: TaskStorage, GoogleSync (route planning), GoogleService
 * (alternatives), NotificationService (re-arming), buildTravelChain,
 * RouteMap, constants/theme. Consumed by navigation/MainTabs.
 */
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator, RefreshControl, ScrollView,
  StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BRAND, FONTS, RADIUS, SHADOWS } from '../constants/theme';
import { getCategoryMeta } from '../constants/categories';
import { AppLanguage, Task, TaskLocation, TransitLeg, TransitPlan, TransportType } from '../types';
import { getAllTasks, getSettings, updateTaskFields, getTasksForDate } from '../services/TaskStorage';
import { ensureTravelChainAhead } from '../services/GoogleSync';
import { replanFromNextDeparture } from '../services/LiveRoute';
import { GoogleService } from '../services/GoogleService';
import {
  CombinedPlan, LastLegMode, needsLastMileHelp, planCombined,
} from '../services/MultiModalPlanner';
import { armTaskAlerts } from '../services/NotificationService';
import { describePlanOption } from '../utils/transitParse';
import { loadProfile } from '../services/UserProfileStorage';
import SkyBackdrop, { useSky } from '../components/ui/SkyBackdrop';
import { getTodayString, timeToMinutes } from '../utils/timeUtils';
import { missedPlannedDeparture } from '../utils/liveRoutePlan';
import { asLocation } from '../utils/buildTravelChain';
import { openLocationInMaps } from '../services/NearbyTaskReminderService';
import RouteMap from '../components/RouteMap';
import TransitOptionsList from '../components/TransitOptionsList';
import { rankDepartureOptions } from '../utils/departureOptions';

/** What the last leg is called, for the line under the trip. */
const MODE_WORD_HE: Record<string, string> = {
  car: 'ברכב', taxi: 'במונית', bike: 'באופניים', scooter: 'בקורקינט', walk: 'בהליכה',
};
const LAST_LEG_ICON: Record<LastLegMode, string> = {
  car: '🚗', taxi: '🚕', bike: '🚲', scooter: '🛴', walk: '🚶',
};

/** How far ahead a journey is worth listing. */
const HORIZON_DAYS = 14;

const LEG_ICON: Record<TransitLeg['type'], string> = {
  walk: '🚶',
  bus: '🚌',
  train: '🚆',
  subway: '🚇',
  car: '🚗',
  bike: '🚲',
};

/** "today" / "tomorrow" / "Wed 2/9" — never a bare ISO date. */
function dayLabel(date: string, he: boolean): string {
  const key = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = new Date();
  if (date === key(today)) return he ? 'היום' : 'Today';
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (date === key(tomorrow)) return he ? 'מחר' : 'Tomorrow';
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const days = he
    ? ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת']
    : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return `${days[dt.getDay()]} ${dt.getDate()}/${dt.getMonth() + 1}`;
}

/**
 * "in 12 min" / "in 3 h" / "40 min ago" for a clock time on a given date.
 *
 * Returns null past the horizon where a relative phrasing stops helping — "in
 * 4 days" is not more useful than the date already shown on the card.
 */
function relativeTime(date: string, time: string, he: boolean): string | null {
  const now = new Date();
  const [y, m, d] = date.split('-').map(Number);
  const target = new Date(y, m - 1, d);
  target.setHours(0, 0, 0, 0);
  const minutes =
    Math.round((target.getTime() - new Date(now).setHours(0, 0, 0, 0)) / 60000)
    + timeToMinutes(time)
    - (now.getHours() * 60 + now.getMinutes());

  if (Math.abs(minutes) > 60 * 24) return null;
  if (minutes < 0) {
    const past = Math.abs(minutes);
    return past < 60
      ? (he ? `לפני ${past} דק'` : `${past} min ago`)
      : (he ? `לפני ${Math.round(past / 60)} שע'` : `${Math.round(past / 60)} h ago`);
  }
  if (minutes < 60) return he ? `בעוד ${minutes} דק'` : `in ${minutes} min`;
  return he ? `בעוד ${Math.round(minutes / 60)} שע'` : `in ${Math.round(minutes / 60)} h`;
}

interface Trip {
  task: Task;
  loc: TaskLocation;
}

/** Real coordinates — 0,0 is the Atlantic, not a missing value the map can draw. */
function hasCoords(loc?: TaskLocation): boolean {
  return Boolean(
    loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng) && (loc.lat !== 0 || loc.lng !== 0),
  );
}

export default function TripsScreen({ navigation }: any) {
  const insets = useSafeAreaInsets();
  const [trips, setTrips] = useState<Trip[]>([]);
  const [language, setLanguage] = useState<AppLanguage>('en');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  // Per-trip line from the last "haven't left" recompute, and which one is busy.
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [replanningId, setReplanningId] = useState<string | null>(null);
  // The departure being saved right now, so its own row can say so rather
  // than the whole card going quiet for the second the write takes.
  const [pickingDeparture, setPickingDeparture] = useState<string | null>(null);
  // Timetable options per trip, fetched only when she asks for them.
  const [alternatives, setAlternatives] = useState<Record<string, TransitPlan[]>>({});
  // Which trip has the "train + …" picker open, and the combination found.
  const [comboFor, setComboFor] = useState<string | null>(null);
  const [combo, setCombo] = useState<Record<string, CombinedPlan | null>>({});
  // True while the first route computation for the screen is running, so the
  // card can say "working it out" ONLY when something actually is.
  const [planning, setPlanning] = useState(false);
  const he = language === 'he';
  const sky = useSky();

  const load = useCallback(async () => {
    const today = getTodayString();
    const [all, settings] = await Promise.all([getAllTasks(), getSettings()]);
    setLanguage(settings.language);

    const horizon = new Date();
    horizon.setDate(horizon.getDate() + HORIZON_DAYS);
    const horizonKey =
      `${horizon.getFullYear()}-${String(horizon.getMonth() + 1).padStart(2, '0')}-${String(horizon.getDate()).padStart(2, '0')}`;

    const found: Trip[] = all
      .filter((t) => t.date >= today && t.date <= horizonKey && t.status === 'pending')
      .map((task) => ({ task, loc: asLocation(task) as TaskLocation }))
      // A trip needs somewhere to go. Tasks you do at home are not journeys.
      //
      // Coordinates are NOT the test for that. Requiring truthy lat/lng dropped
      // every trip whose place came in as an address with lat/lng of 0 — the
      // yoga class at יגאל אלון 94 among them — so the one screen built to
      // answer "am I going to get there on time" simply did not list them. An
      // address or a computed route is enough; the map is what needs real
      // coordinates, and it checks for itself below.
      .filter((t) => Boolean(t.loc && (t.loc.address || t.loc.displayName || t.loc.transitPlan)))
      .sort((a, b) => {
        const key = (t: Trip) =>
          `${t.task.date} ${t.loc.leaveHomeBy || t.task.fixedTime || t.task.scheduledTime || '23:59'}`;
        return key(a) < key(b) ? -1 : 1;
      });

    setTrips(found);
    // Open the nearest one. Everything else stays shut: one thing at a time.
    setOpenId((prev) => prev ?? found[0]?.task.id ?? null);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => {
    load();
    // …and actually COMPUTE the missing routes. The card has always been able
    // to say "🧭 working out the route and leave time…", and nothing on this
    // screen ever worked anything out: load() only reads storage, and the
    // planner ran on pull-to-refresh alone. A trip with an address but no route
    // sat on that line forever, which is a screen lying about what it is doing.
    let alive = true;
    (async () => {
      const stale = (await getAllTasks()).some(
        (t) => t.status === 'pending' && t.date >= getTodayString()
          && asLocation(t) && !asLocation(t)!.leaveHomeBy && !asLocation(t)!.transitPlan,
      );
      if (!stale || !alive) return;
      setPlanning(true);
      try {
        await ensureTravelChainAhead(language).catch(() => {});
        if (alive) await load();
      } finally {
        if (alive) setPlanning(false);
      }
    })();
    return () => { alive = false; };
  }, [load, language]));

  /**
   * Re-plan this trip by a mode she picked, and SAVE it.
   *
   * The transport chips are the fix for "other ways only ever shows buses":
   * the alternatives lookup asks Google for the mode stored on the task, and
   * nothing on this screen could change that mode — so a train never appeared
   * however many times she asked.
   */
  const changeMode = async (task: Task, mode: TransportType) => {
    const loc = asLocation(task);
    const arrival = task.fixedTime || task.scheduledTime;
    if (!loc || !arrival) return;
    setReplanningId(task.id);
    setNotes((prev) => ({ ...prev, [task.id]: he ? '🧭 בודקת…' : '🧭 checking…' }));
    try {
      const stored: any = await loadProfile().catch(() => null);
      if (!stored) {
        setNotes((prev) => ({ ...prev, [task.id]: he ? 'חסר פרופיל 🙁' : 'No profile yet 🙁' }));
        return;
      }
      const gProfile = {
        ...stored,
        homeLat: stored.homeLatLng?.lat,
        homeLng: stored.homeLatLng?.lng,
      } as any;
      const plan = await GoogleService.getPlanForMode(
        mode, loc.address || loc.displayName || '', arrival, gProfile, task.date,
      ).catch(() => null);
      // The mode is saved either way: a mode with no route today is still how
      // she intends to travel, and the next recompute should use it.
      const nextLocation: TaskLocation = {
        ...loc,
        transportType: mode,
        ...(plan
          ? {
            transitPlan: plan,
            leaveHomeBy: plan.leaveHomeAt,
            travelMinutes: plan.totalDurationMinutes,
          }
          : { transitPlan: undefined }),
      } as TaskLocation;
      await updateTaskFields(task.id, { location: nextLocation } as any);
      if (plan) {
        await armTaskAlerts({ ...task, location: nextLocation } as Task, language).catch(() => {});
      }
      setAlternatives((prev) => ({ ...prev, [task.id]: [] }));
      setNotes((prev) => ({
        ...prev,
        [task.id]: plan
          ? describePlanOption(plan, he)
          : (he ? 'לא מצאתי מסלול באמצעי הזה 🙁' : "No route came back for that mode 🙁"),
      }));
      await load();
    } finally {
      setReplanningId(null);
    }
  };

  /** Every timetable option for THIS trip's mode, best first. */
  const showWays = async (task: Task) => {
    const loc = asLocation(task);
    const arrival = task.fixedTime || task.scheduledTime;
    if (!loc || !arrival) return;
    setReplanningId(task.id);
    try {
      const stored: any = await loadProfile().catch(() => null);
      if (!stored) return;
      const gProfile = {
        ...stored,
        homeLat: stored.homeLatLng?.lat,
        homeLng: stored.homeLatLng?.lng,
      } as any;
      const pref = loc.transportType === 'train' ? 'rail' : 'bus';
      const plans = await GoogleService.getTransitAlternatives(
        loc.address || loc.displayName || '', arrival, gProfile, task.date, pref,
      ).catch(() => [] as TransitPlan[]);
      setAlternatives((prev) => ({ ...prev, [task.id]: plans }));
      if (!plans.length) {
        setNotes((prev) => ({
          ...prev,
          [task.id]: he ? 'אין אפשרויות נוספות באמצעי הזה' : 'No other options for this mode',
        }));
      } else if (pref === 'rail') {
        // Google falls back to buses when no train serves the route, and
        // returning them silently under a train request is why "I chose train
        // and it shows buses" kept happening. Name it.
        const anyRail = plans.some((p) =>
          p.legs.some((l) => l.type === 'train' || l.type === 'subway'));
        if (!anyRail) {
          setNotes((prev) => ({
            ...prev,
            [task.id]: he
              ? '🚆 אין רכבת ישירה למסלול הזה — אלו אפשרויות אוטובוס. נסי "🚆＋ שילוב אמצעים".'
              : '🚆 No direct train for this route — these are buses. Try "🚆＋ Combine two ways".',
          }));
        }
      }
    } finally {
      setReplanningId(null);
    }
  };

  /**
   * "Train to the station, then a lift" — the journey as two decisions.
   *
   * This is the answer to the 06:00 departure for a 10:00 interview: nothing
   * was miscalculated, Google was simply asked for ONE mode and finished the
   * last ten kilometres on foot. Planning the last leg first and working
   * backwards is what makes the train half solvable at all.
   */
  const planCombo = async (task: Task, lastLeg: LastLegMode) => {
    const loc = asLocation(task);
    const arrival = task.fixedTime || task.scheduledTime;
    if (!loc || !arrival) return;
    setReplanningId(task.id);
    setNotes((prev) => ({
      ...prev,
      [task.id]: he ? '🚆 מחפשת רכבת + הסעה…' : '🚆 finding train + last mile…',
    }));
    try {
      const stored: any = await loadProfile().catch(() => null);
      if (!stored) return;
      const gProfile = {
        ...stored,
        homeLat: stored.homeLatLng?.lat,
        homeLng: stored.homeLatLng?.lng,
      } as any;
      const found = await planCombined(
        loc.address || loc.displayName || '', arrival, task.date, gProfile,
        {
          lastLeg,
          // Whatever she typed as the station stays hers; otherwise the
          // stations near the destination are tried.
          station: loc.viaStation || undefined,
          singleModeMinutes: loc.transitPlan?.totalDurationMinutes,
        },
      ).catch(() => null);

      setCombo((prev) => ({ ...prev, [task.id]: found }));
      setNotes((prev) => ({
        ...prev,
        [task.id]: found
          ? (he
            ? `🚆 ${found.station.name} → ${found.lastLeg.minutes} דק׳ ${MODE_WORD_HE[lastLeg]} · יציאה ${found.plan.leaveHomeAt}`
            : `🚆 ${found.station.name} → ${found.lastLeg.minutes} min by ${lastLeg} · leave ${found.plan.leaveHomeAt}`)
          : (he
            ? 'לא מצאתי שילוב שמגיע בזמן 🙁'
            : "No combination gets you there in time 🙁"),
      }));
    } finally {
      setReplanningId(null);
    }
  };

  /** Save the combination as the trip's route — times, alerts and all. */
  const useCombo = async (task: Task, found: CombinedPlan, lastLeg: LastLegMode) => {
    const loc = asLocation(task);
    if (!loc) return;
    const nextLocation: TaskLocation = {
      ...loc,
      transitPlan: found.plan,
      leaveHomeBy: found.plan.leaveHomeAt,
      travelMinutes: found.plan.totalDurationMinutes,
      transportType: 'train',
      viaStation: found.station.name,
      lastLegMode: lastLeg,
    } as TaskLocation;
    await updateTaskFields(task.id, { location: nextLocation } as any);
    await armTaskAlerts({ ...task, location: nextLocation } as Task, language).catch(() => {});
    setComboFor(null);
    setCombo((prev) => ({ ...prev, [task.id]: null }));
    setNotes((prev) => ({
      ...prev,
      [task.id]: he
        ? `✓ נשמר — יציאה ${found.plan.leaveHomeAt}, ${found.station.name}, ואז ${found.lastLeg.minutes} דק׳`
        : `✓ Saved — leave ${found.plan.leaveHomeAt}, ${found.station.name}, then ${found.lastLeg.minutes} min`,
    }));
    await load();
  };

  /** Take one of them: it becomes the trip's route, times and alerts. */
  const pickWay = async (task: Task, plan: TransitPlan) => {
    const loc = asLocation(task);
    if (!loc) return;
    setPickingDeparture(plan.leaveHomeAt);
    try {
      const nextLocation: TaskLocation = {
        ...loc,
        transitPlan: plan,
        leaveHomeBy: plan.leaveHomeAt,
        travelMinutes: plan.totalDurationMinutes,
      } as TaskLocation;
      await updateTaskFields(task.id, { location: nextLocation } as any);
      await armTaskAlerts({ ...task, location: nextLocation } as Task, language).catch(() => {});
      setAlternatives((prev) => ({ ...prev, [task.id]: [] }));
      setNotes((prev) => ({ ...prev, [task.id]: describePlanOption(plan, he) }));
      await load();
    } finally {
      setPickingDeparture(null);
    }
  };

  /**
   * "I haven't left yet" — right here, on the trip.
   *
   * This used to open the LeaveNow screen and make her press again there. The
   * question is one tap's worth: what is the next departure, and when do I get
   * there now. Answer it on the card, and rewrite the leave/arrive times it
   * shows so the change is visible where she was already looking.
   */
  const notLeft = async (task: Task) => {
    setReplanningId(task.id);
    setNotes((prev) => ({ ...prev, [task.id]: he ? '🚏 מחפשת את הבא…' : '🚏 finding the next one…' }));
    try {
      const profile = await loadProfile().catch(() => null);
      if (!profile) {
        setNotes((prev) => ({ ...prev, [task.id]: he ? 'חסר פרופיל 🙁' : 'No profile yet 🙁' }));
        return;
      }
      const result = await replanFromNextDeparture(task, profile, { language });
      setNotes((prev) => ({
        ...prev,
        [task.id]: result.message
          ?? (he ? 'לא מצאתי נסיעה הבאה 🙁' : "Couldn't find the next departure 🙁"),
      }));
      await load();   // the card re-reads the rewritten leave / arrive times
    } catch {
      setNotes((prev) => ({ ...prev, [task.id]: he ? 'משהו השתבש 🙁' : 'Something went wrong 🙁' }));
    } finally {
      setReplanningId(null);
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      // Re-plans routes for the days ahead, then re-reads them.
      await ensureTravelChainAhead(language).catch(() => {});
      await load();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <SkyBackdrop sky={sky} />
      <View style={styles.header}>
        <Text style={[styles.title, { color: sky.ink }, he && styles.rtlText]}>{he ? 'נסיעות' : 'Trips'}</Text>
        <Text style={[styles.subtitle, { color: sky.ink, opacity: 0.8 }, he && styles.rtlText]}>
          {trips.length
            ? (he ? `${trips.length} מתוכננות` : `${trips.length} planned`)
            : (he ? 'אין נסיעות' : 'None planned')}
        </Text>
      </View>

      {loading ? (
        <ActivityIndicator color={BRAND.sunGold} size="large" style={{ marginTop: 48 }} />
      ) : (
        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={BRAND.sunGold} />
          }
        >
          {trips.length === 0 && (
            <View style={styles.empty}>
              <Text style={styles.emptyIcon}>🗺️</Text>
              <Text style={styles.emptyText}>
                {he
                  ? 'אין נסיעות מתוכננות.\nמשימה עם כתובת תופיע כאן עם המסלול ושעת היציאה.'
                  : 'No trips planned.\nAny task with an address shows up here with its route and leave time.'}
              </Text>
            </View>
          )}

          {trips.map((trip, index) => {
            const today = getTodayString();
            const { task, loc } = trip;
            const plan = loc.transitPlan;
            const open = openId === task.id;
            const meta = getCategoryMeta(task.category);
            const place = loc.displayName || loc.address;
            // The appointment time is when she is DUE; the plan's arriveAt is
            // when this route actually gets her there. Showing the appointment
            // regardless is what made a recomputed trip look unchanged — the
            // leave time moved and the arrival still read 11:00. When the route
            // lands late, that is the number worth showing, and worth naming.
            const dueAt = task.fixedTime || task.scheduledTime;
            const willArriveAt = plan?.arriveAt;
            const isLate = Boolean(dueAt && willArriveAt && willArriveAt > dueAt);
            const arriveAt = willArriveAt || dueAt;
            const leaveAt = loc.leaveHomeBy || plan?.leaveHomeAt;
            // Only once the planned departure has actually passed — see
            // TravelChainCard: offering it earlier invites overwriting a good
            // plan with a "leave now" one.
            const departureGone = task.date === today
              && missedPlannedDeparture(leaveAt || undefined);
            const leaveRel = leaveAt ? relativeTime(task.date, leaveAt, he) : null;
            const isNext = index === 0;

            return (
              <View key={task.id} style={[styles.card, isNext && styles.cardNext]}>
                {/* ── header: where, and when you have to be there ── */}
                <TouchableOpacity
                  onPress={() => setOpenId(open ? null : task.id)}
                  activeOpacity={0.85}
                >
                  <View style={styles.cardTop}>
                    <View style={styles.dayChip}>
                      <Text style={styles.dayChipText}>{dayLabel(task.date, he)}</Text>
                    </View>
                    {isNext && (
                      <Text style={styles.nextTag}>{he ? 'הקרובה' : 'NEXT'}</Text>
                    )}
                    <View style={{ flex: 1 }} />
                    <Text style={styles.chevron}>{open ? '▲' : '▼'}</Text>
                  </View>

                  <Text style={styles.dest} numberOfLines={1}>{place}</Text>
                  <Text style={styles.reason} numberOfLines={1}>
                    {meta.icon} {task.text}
                  </Text>

                  {/* Leave time is the loudest thing on the card: leaving is
                      the action, arriving is only its consequence. */}
                  {leaveAt ? (
                    <View style={styles.leaveRow}>
                      <View style={styles.leaveBox}>
                        <Text style={styles.leaveLabel}>{he ? 'לצאת' : 'LEAVE'}</Text>
                        <Text style={styles.leaveTime}>{leaveAt}</Text>
                      </View>
                      <View style={styles.leaveMeta}>
                        {leaveRel && <Text style={styles.leaveRel}>{leaveRel}</Text>}
                        {arriveAt && (
                          <Text style={[styles.arriveText, isLate && styles.arriveLate]}>
                            {he ? `הגעה ${arriveAt}` : `arrive ${arriveAt}`}
                            {isLate ? (he ? ` (אחרי ${dueAt})` : ` (after ${dueAt})`) : ''}
                            {plan ? ` · ${plan.totalDurationMinutes} ${he ? "דק'" : 'min'}` : ''}
                          </Text>
                        )}
                      </View>
                    </View>
                  ) : planning || replanningId === task.id ? (
                    <Text style={styles.planning}>
                      {he ? '🧭 מחשבת מסלול וזמן יציאה…' : '🧭 Working out the route and leave time…'}
                    </Text>
                  ) : (
                    // Not "thinking" — nothing is running. Say what is missing
                    // and give her the button that fixes it.
                    <Text style={styles.planning}>
                      {he ? '🧭 אין עדיין מסלול — בחרי אמצעי נסיעה למטה' : '🧭 No route yet — pick a travel mode below'}
                    </Text>
                  )}
                </TouchableOpacity>

                {/* ── expanded: the legs, the map, the actions ── */}
                {open && (
                  <View style={styles.details}>
                    {loc.wakeUpBy && (
                      <View style={styles.wakeRow}>
                        <Text style={styles.wakeText}>
                          ⏰ {he ? 'להתעורר' : 'Wake'} {loc.wakeUpBy}
                        </Text>
                      </View>
                    )}

                    {plan?.legs?.length ? (
                      <View style={styles.legs}>
                        {plan.legs.map((leg, i) => (
                          <View key={`${leg.type}-${i}`} style={styles.legRow}>
                            {/* the connecting rail, Google-Maps style */}
                            <View style={styles.rail}>
                              <View style={styles.dot} />
                              {i < plan.legs.length - 1 && <View style={styles.railLine} />}
                            </View>
                            <View style={styles.legBody}>
                              <Text style={styles.legTitle}>
                                {LEG_ICON[leg.type] || '➡️'}{' '}
                                {leg.lineNumber ? `${leg.lineNumber} · ` : ''}
                                {leg.durationMinutes} {he ? "דק'" : 'min'}
                              </Text>
                              <Text style={styles.legDetail} numberOfLines={1}>
                                {leg.departureTime} {leg.stopName || leg.from}
                                {leg.to ? ` → ${leg.to}` : ''}
                              </Text>
                            </View>
                          </View>
                        ))}
                      </View>
                    ) : null}

                    {plan && hasCoords(loc) && (
                      <View style={styles.mapBox}>
                        <RouteMap
                          plan={plan}
                          destLat={loc.lat}
                          destLng={loc.lng}
                          destLabel={place}
                          height={170}
                        />
                      </View>
                    )}

                    {/* What the recompute found — the next departure and the
                        arrival it implies — on the card, not a screen away. */}
                    {notes[task.id] ? (
                      <View style={styles.note}>
                        <Text style={styles.noteText}>{notes[task.id]}</Text>
                      </View>
                    ) : null}

                    {/* "Haven't left" — recomputes from the next departure and
                        rewrites the times above. This is the answer to "where do
                        I press didn't leave": on every trip, here. */}
                    {departureGone ? (
                    <TouchableOpacity
                      style={styles.notLeftBtn}
                      onPress={() => notLeft(task)}
                      activeOpacity={0.85}
                      disabled={replanningId === task.id}
                    >
                      <Text style={styles.notLeftText}>
                        {replanningId === task.id
                          ? (he ? '🚏 מחשבת…' : '🚏 recalculating…')
                          : (he ? '🚏 עוד לא יצאתי — הבא?' : "🚏 Haven't left — next bus?")}
                      </Text>
                    </TouchableOpacity>
                    ) : null}
                    {/* The tell for "the last mile has no service": Google
                        finished the journey on foot. THIS is what a 06:00
                        departure for a 10:00 interview actually was — not a
                        miscalculation, a plan nobody would follow. Say it, and
                        offer the journey people really make. */}
                    {needsLastMileHelp(plan) > 0 && (
                      <View style={styles.lastMile}>
                        <Text style={styles.lastMileText}>
                          {he
                            ? `⚠️ המסלול הזה מסתיים ב-${needsLastMileHelp(plan)} דק׳ הליכה — אין תחבורה למקום. אפשר רכבת + הסעה:`
                            : `⚠️ This route ends with a ${needsLastMileHelp(plan)} min walk — nothing serves the last mile. Try train + a lift:`}
                        </Text>
                      </View>
                    )}

                    {/* Train to a station, then whatever covers the last mile. */}
                    <View style={styles.comboRow}>
                      <TouchableOpacity
                        style={styles.comboBtn}
                        onPress={() => setComboFor(comboFor === task.id ? null : task.id)}
                        activeOpacity={0.85}
                      >
                        <Text style={styles.comboBtnText}>
                          {he ? '🚆＋ שילוב אמצעים' : '🚆＋ Combine two ways'}
                        </Text>
                      </TouchableOpacity>
                      {loc.viaStation ? (
                        <Text style={styles.viaText} numberOfLines={1}>
                          {he ? `דרך ${loc.viaStation}` : `via ${loc.viaStation}`}
                        </Text>
                      ) : null}
                    </View>

                    {comboFor === task.id && (
                      <View style={styles.comboBox}>
                        <Text style={styles.comboLabel}>
                          {he ? 'רכבת עד התחנה, ואז…' : 'Train to the station, then…'}
                        </Text>
                        <View style={styles.comboModes}>
                          {(['car', 'taxi', 'bike', 'scooter', 'walk'] as LastLegMode[]).map((m) => (
                            <TouchableOpacity
                              key={m}
                              style={styles.comboMode}
                              onPress={() => planCombo(task, m)}
                              disabled={replanningId === task.id}
                              activeOpacity={0.85}
                            >
                              <Text style={styles.comboModeText}>{LAST_LEG_ICON[m]}</Text>
                            </TouchableOpacity>
                          ))}
                        </View>
                        {combo[task.id] ? (
                          <TouchableOpacity
                            style={styles.comboResult}
                            onPress={() => useCombo(
                              task, combo[task.id]!, combo[task.id]!.lastLeg.mode,
                            )}
                            activeOpacity={0.85}
                          >
                            <Text style={styles.comboResultText}>
                              {he
                                ? `יציאה ${combo[task.id]!.plan.leaveHomeAt} · ${combo[task.id]!.station.name} · ${combo[task.id]!.lastLeg.minutes} דק׳ ${MODE_WORD_HE[combo[task.id]!.lastLeg.mode]} · הגעה ${combo[task.id]!.plan.arriveAt}`
                                : `leave ${combo[task.id]!.plan.leaveHomeAt} · ${combo[task.id]!.station.name} · ${combo[task.id]!.lastLeg.minutes} min by ${combo[task.id]!.lastLeg.mode} · arrive ${combo[task.id]!.plan.arriveAt}`}
                              {combo[task.id]!.savedMinutes
                                ? (he ? ` · חוסך ${combo[task.id]!.savedMinutes} דק׳` : ` · saves ${combo[task.id]!.savedMinutes} min`)
                                : ''}
                            </Text>
                            <Text style={styles.wayPick}>{he ? 'בחרי' : 'Use'}</Text>
                          </TouchableOpacity>
                        ) : null}
                      </View>
                    )}

                    {/* HOW she travels — and the reason "other ways" used to
                        answer with buses forever: nothing here could change it. */}
                    <View style={styles.modeRow}>
                      {(['bus', 'train', 'car', 'bike', 'walk'] as TransportType[]).map((mode) => {
                        const active = (loc.transportType || 'bus') === mode;
                        return (
                          <TouchableOpacity
                            key={mode}
                            style={[styles.modeChip, active && styles.modeChipOn]}
                            onPress={() => changeMode(task, mode)}
                            disabled={replanningId === task.id}
                            activeOpacity={0.85}
                          >
                            <Text style={[styles.modeChipText, active && styles.modeChipTextOn]}>
                              {LEG_ICON[mode as TransitLeg['type']] || '🚌'}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                      <TouchableOpacity
                        style={styles.waysBtn}
                        onPress={() => showWays(task)}
                        disabled={replanningId === task.id}
                        activeOpacity={0.85}
                      >
                        <Text style={styles.waysBtnText}>
                          {replanningId === task.id
                            ? (he ? '…' : '…')
                            : (he ? '🔀 אפשרויות' : '🔀 Other ways')}
                        </Text>
                      </TouchableOpacity>
                    </View>

                    {/* The list that already solves this.
                        "on the trips screens, the alternatives are not clear
                        at all! i don't see the text clearly, i don't know what
                        to choose." — and TransitOptionsList's own docstring
                        describes precisely this failure, because it was
                        written to replace it: one long sentence sharing a row
                        with a "Use" label, so in Hebrew, at any real line
                        name, the two clock times were the first thing pushed
                        off screen. The times are the entire point of the list.
                        This screen simply never adopted the fix.

                        max 5, not the 3 the panic screen uses: Trips is where
                        she browses, and she asked to SEE the options. */}
                    {(alternatives[task.id] || []).length > 0 && (
                      <View style={styles.waysList}>
                        <TransitOptionsList
                          options={rankDepartureOptions(alternatives[task.id], {
                            appointment: task.fixedTime || task.scheduledTime,
                            currentDeparture: loc.leaveHomeBy,
                            max: 5,
                          })}
                          language={language}
                          onPick={(p) => pickWay(task, p)}
                          pickingDeparture={pickingDeparture}
                          originNote={he ? 'מהבית' : 'from home'}
                          // The DAY, not just the clock. Passing `now` as
                          // undefined was not enough: the list falls back to
                          // the real time, so at 23:35 every one of tomorrow's
                          // departures read as already gone and the list came
                          // back empty. It needs the date to know that.
                          date={task.date}
                          now={task.date === today
                            ? new Date().toTimeString().slice(0, 5)
                            : undefined}
                        />
                      </View>
                    )}

                    <View style={styles.actions}>
                      <TouchableOpacity
                        style={styles.navBtn}
                        onPress={() => openLocationInMaps(place, { lat: loc.lat, lng: loc.lng })}
                        activeOpacity={0.85}
                      >
                        <Text style={styles.navBtnText}>{he ? 'נווט ↗' : 'Navigate ↗'}</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.ghostBtn}
                        onPress={() => navigation.navigate('TaskDetail', { taskId: task.id })}
                        activeOpacity={0.85}
                      >
                        <Text style={styles.ghostBtnText}>{he ? 'המשימה' : 'Task'}</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                )}
              </View>
            );
          })}
          <View style={{ height: 120 }} />
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BRAND.cream },
  modeRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10, flexWrap: 'wrap' },
  modeChip: {
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999,
    borderWidth: 1, borderColor: BRAND.line, backgroundColor: BRAND.creamCard,
  },
  modeChipOn: { backgroundColor: BRAND.timeChipBg, borderColor: BRAND.sunGold },
  modeChipText: { fontSize: 15 },
  modeChipTextOn: { fontSize: 15 },
  waysBtn: {
    marginLeft: 'auto', paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999,
    backgroundColor: BRAND.timeChipBg,
  },
  waysBtnText: { fontFamily: FONTS.bodyHeavy, fontSize: 12, color: BRAND.timeChipText },
  lastMile: {
    marginTop: 10, borderRadius: RADIUS.chip, backgroundColor: BRAND.honey,
    paddingHorizontal: 10, paddingVertical: 8,
  },
  lastMileText: { fontFamily: FONTS.bodyBold, fontSize: 12, color: '#4A3512' },
  comboRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },
  comboBtn: {
    borderRadius: 999, borderWidth: 1, borderColor: BRAND.sunGold,
    paddingHorizontal: 12, paddingVertical: 7,
  },
  comboBtnText: { fontFamily: FONTS.bodyHeavy, fontSize: 12, color: BRAND.timeChipText },
  viaText: { flex: 1, fontFamily: FONTS.body, fontSize: 11, color: BRAND.inkFaint },
  comboBox: {
    marginTop: 8, borderWidth: 1, borderColor: BRAND.line, borderRadius: RADIUS.chip,
    padding: 10, backgroundColor: BRAND.creamCard, gap: 8,
  },
  comboLabel: { fontFamily: FONTS.bodyBold, fontSize: 12, color: BRAND.inkSoft },
  comboModes: { flexDirection: 'row', gap: 8 },
  comboMode: {
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999,
    borderWidth: 1, borderColor: BRAND.line, backgroundColor: BRAND.white,
  },
  comboModeText: { fontSize: 16 },
  comboResult: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderRadius: RADIUS.chip, backgroundColor: BRAND.timeChipBg,
    paddingHorizontal: 10, paddingVertical: 9,
  },
  comboResultText: { flex: 1, fontFamily: FONTS.bodyBold, fontSize: 12, color: BRAND.warmInk },

  wayOption: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8,
    borderWidth: 1, borderColor: BRAND.line, borderRadius: RADIUS.chip,
    paddingHorizontal: 10, paddingVertical: 8, backgroundColor: BRAND.creamCard,
  },
  wayOptionText: { flex: 1, fontFamily: FONTS.body, fontSize: 12, color: BRAND.warmInk },
  waysList: { marginTop: 8 },
  wayPick: {
    fontFamily: FONTS.bodyHeavy, fontSize: 11, color: BRAND.timeChipText,
    backgroundColor: BRAND.timeChipBg, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4,
  },
  header: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 14 },
  rtlText: { textAlign: 'right', writingDirection: 'rtl' },
  title: { fontFamily: FONTS.display, fontSize: 30, color: BRAND.warmInk },
  subtitle: { fontFamily: FONTS.body, fontSize: 13, color: BRAND.inkSoft, marginTop: 2 },
  scroll: { paddingHorizontal: 16 },

  empty: { alignItems: 'center', marginTop: 60, marginHorizontal: 20, padding: 24, gap: 12, borderRadius: 24, backgroundColor: 'rgba(255,255,255,0.82)' },
  emptyIcon: { fontSize: 40 },
  emptyText: {
    fontFamily: FONTS.body, fontSize: 14, color: BRAND.inkSoft,
    textAlign: 'center', lineHeight: 21,
  },

  card: {
    backgroundColor: BRAND.creamCard,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: BRAND.line,
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginBottom: 12,
    ...SHADOWS.card,
  },
  // The nearest trip carries the brand accent — the one card meant to catch
  // the eye from across the screen.
  cardNext: { borderColor: BRAND.sunGold, borderWidth: 1.5 },

  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  dayChip: {
    backgroundColor: BRAND.timeChipBg, borderRadius: 999,
    paddingHorizontal: 10, paddingVertical: 3,
  },
  dayChipText: { fontFamily: FONTS.bodyHeavy, fontSize: 11, color: BRAND.timeChipText },
  nextTag: {
    fontFamily: FONTS.bodyHeavy, fontSize: 10, letterSpacing: 1,
    color: BRAND.sunGold,
  },
  chevron: { fontSize: 11, color: BRAND.inkFaint },

  dest: { fontFamily: FONTS.display, fontSize: 20, color: BRAND.warmInk },
  reason: { fontFamily: FONTS.body, fontSize: 13, color: BRAND.inkSoft, marginTop: 2 },

  leaveRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 12 },
  leaveBox: {
    backgroundColor: BRAND.sunGold, borderRadius: 14,
    paddingHorizontal: 16, paddingVertical: 8, alignItems: 'center',
  },
  leaveLabel: { fontFamily: FONTS.bodyHeavy, fontSize: 11, letterSpacing: 1, color: BRAND.onGold },
  leaveTime: { fontFamily: FONTS.display, fontSize: 24, color: '#4A3512', lineHeight: 27 },
  leaveMeta: { flex: 1, gap: 2 },
  leaveRel: { fontFamily: FONTS.bodyHeavy, fontSize: 15, color: BRAND.warmInk },
  arriveText: { fontFamily: FONTS.body, fontSize: 12, color: BRAND.inkSoft },
  arriveLate: { color: '#EF476F', fontFamily: FONTS.bodyHeavy },
  note: {
    backgroundColor: BRAND.honey, borderRadius: 12,
    paddingVertical: 10, paddingHorizontal: 12,
  },
  noteText: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.inkSoft, lineHeight: 19 },
  planning: { fontFamily: FONTS.body, fontSize: 13, color: BRAND.inkFaint, marginTop: 10 },

  details: {
    marginTop: 14, paddingTop: 14,
    borderTopWidth: 1, borderTopColor: BRAND.line, gap: 12,
  },
  wakeRow: {
    alignSelf: 'flex-start', backgroundColor: BRAND.honey,
    borderRadius: 999, paddingHorizontal: 12, paddingVertical: 5,
  },
  wakeText: { fontFamily: FONTS.bodyHeavy, fontSize: 12, color: BRAND.goldInk },

  legs: { gap: 0 },
  legRow: { flexDirection: 'row', gap: 12 },
  rail: { width: 12, alignItems: 'center' },
  dot: {
    width: 9, height: 9, borderRadius: 5,
    backgroundColor: BRAND.sunGold, marginTop: 5,
  },
  railLine: { flex: 1, width: 2, backgroundColor: BRAND.line, marginVertical: 2 },
  legBody: { flex: 1, paddingBottom: 12 },
  legTitle: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.warmInk },
  legDetail: { fontFamily: FONTS.body, fontSize: 12, color: BRAND.inkSoft, marginTop: 1 },

  // Same as LeaveNow: RouteMap carries its own Navigate button below the map,
  // so a fixed height with overflow:hidden clipped it off the card.
  mapBox: {
    borderRadius: RADIUS.card,
    borderWidth: 1, borderColor: BRAND.line, padding: 8,
  },

  notLeftBtn: {
    backgroundColor: BRAND.sunGold, borderRadius: RADIUS.button,
    paddingVertical: 12, alignItems: 'center', marginBottom: 8,
  },
  notLeftText: { fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.inkSoft },
  actions: { flexDirection: 'row', gap: 10 },
  navBtn: {
    flex: 1, backgroundColor: BRAND.warmInk, borderRadius: 14,
    paddingVertical: 12, alignItems: 'center', ...SHADOWS.button,
  },
  navBtnText: { fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.honey },
  ghostBtn: {
    borderWidth: 1, borderColor: BRAND.line, borderRadius: 14,
    paddingVertical: 12, paddingHorizontal: 20, alignItems: 'center',
  },
  ghostBtnText: { fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.inkSoft },
});
