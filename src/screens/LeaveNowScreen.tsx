/**
 * LeaveNowScreen — the "צא עכשיו" focus screen (design 3b).
 * Opened from the leave-now notification: shows ONLY the next task —
 * countdown, route map, condensed travel chain, and "I left" / "+5 min".
 * Drop into src/screens/. Uses RouteMap (polyline), buildTravelChain,
 * NotificationService for the snooze re-ping.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BRAND, FONTS, RADIUS, SHADOWS } from '../constants/theme';
import { getCategoryMeta } from '../constants/categories';
import { Task, UserProfile, AppLanguage } from '../types';
import { timeToMinutes } from '../utils/timeUtils';
import {
  minutesUntilDeparture, isLate, formatCountdown, countdownLabel,
} from '../utils/leaveCountdown';
import {
  buildWayThere, asLocation, effectiveTransport, taskStart, toChainProfile,
} from '../utils/buildTravelChain';
import {
  replanFromNextDeparture, confirmDeparture, nextDepartureOptions, applyDepartureOption,
} from '../services/LiveRoute';
import { DepartureOption } from '../utils/departureOptions';
import TransitOptionsList from '../components/TransitOptionsList';
import { sendInstantNotification } from '../services/NotificationService';
import { getSettings } from '../services/TaskStorage';
import { loadProfile } from '../services/UserProfileStorage';
// RouteMap renders the Google overview polyline on EAS builds; falls back to
// a flat placeholder in Expo Go — same behavior as WakeCalculator.
import RouteMap from '../components/RouteMap';
import { WashedSky } from '../components/ui/SkyBackdrop';

interface Props {
  navigation: any;
  route: { params: { task: Task; isFirstOfDay?: boolean } };
}

export default function LeaveNowScreen({ navigation, route }: Props) {
  const insets = useSafeAreaInsets();
  const { task, isFirstOfDay = false } = route.params;
  const [profile, setProfile] = useState<UserProfile | null>(null);
  // The profile as STORED (models shape). The chain needs the normalized one,
  // the planner normalizes for itself — keep both rather than converting twice.
  const [rawProfile, setRawProfile] = useState<any>(null);
  const [now, setNow] = useState(new Date());
  // Language lives in settings, not on the stored profile (which has no
  // `language` field at all — reading it there always yielded 'en').
  const [language, setLanguage] = useState<AppLanguage>('en');
  const he = language === 'he';
  // The task can be re-planned in place when she says she hasn't left — the
  // route param is immutable, so the live copy is what the screen renders.
  const [liveTask, setLiveTask] = useState<Task>(route.params.task);
  const [replanning, setReplanning] = useState(false);
  const [replanNote, setReplanNote] = useState<string | null>(null);
  // The next few departures — a CHOICE, not a verdict. Null until she asks.
  const [options, setOptions] = useState<DepartureOption[] | null>(null);
  const [optionsOrigin, setOptionsOrigin] = useState<'home' | 'here'>('home');
  const [picking, setPicking] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [leftNote, setLeftNote] = useState<string | null>(null);

  useEffect(() => {
    // toChainProfile: the stored profile uses transportMode/totalMorningRoutineMinutes.
    loadProfile().then((p) => { setRawProfile(p); setProfile(toChainProfile(p)); }).catch(() => {});
    getSettings().then((s) => setLanguage(s.language)).catch(() => {});
  }, []);
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  const loc = asLocation(liveTask);
  const meta = getCategoryMeta(liveTask.category);
  const mode = effectiveTransport(liveTask, profile);
  const steps = useMemo(
    () => buildWayThere(liveTask, mode, profile, isFirstOfDay),
    [liveTask, mode, profile, isFirstOfDay],
  );
  // Countdown to the "leave home" (highlight) step.
  const leaveStep = steps.find((s) => s.kind === 'highlight');
  // Counted against the task's DATE, not just the clock.
  //
  // This was `timeToMinutes(leaveStep.time) - minutes-since-midnight`, which
  // threw the calendar away: tomorrow's 13:18 departure, seen at 16:03 today,
  // rendered as a red "LATE BY 165 min" over a route arriving 13 minutes
  // early. Every future trip read as already missed.
  const minutesLeft = minutesUntilDeparture(liveTask.date, leaveStep?.time, now);
  const late = isLate(minutesLeft);

  /**
   * "✓ יצאתי" — confirm the departure.
   *
   * This used to stamp a field and close the screen, which is indistinguishable
   * from doing nothing: the "🚪 עדיין בבית?" nags at +4 and +8 min still fired,
   * so saying "I left" was answered by two more notifications asking whether
   * she had left. confirmDeparture silences them AND takes a real GPS fix, so
   * the trip is measured from where she actually is rather than from the home
   * address every route is planned from.
   */
  const handleLeft = async () => {
    if (leaving) return;
    setLeaving(true);
    try {
      const { position } = await confirmDeparture(liveTask.id);
      // Say what happened, briefly, before the screen goes — a silent close is
      // exactly what made this button feel broken.
      setLeftNote(
        position
          ? (he ? '✓ יצאת — סגרתי את התזכורות 🚶' : "✓ You're off — reminders silenced 🚶")
          : (he ? '✓ יצאת — סגרתי את התזכורות (בלי מיקום)' : '✓ Off you go — reminders silenced (no location)'),
      );
    } catch {
      setLeftNote(he ? 'לא הצלחתי לעדכן 🙁' : "Couldn't update 🙁");
      setLeaving(false);
      return;
    }
    setTimeout(() => navigation.goBack(), 900);
  };

  // "I haven't left yet" — recompute from the NEXT departure and show it here,
  // rather than re-pinging a notification for a bus that has already gone. This
  // is the whole point: current time in, next bus + real arrival + how late out.
  const handleNotLeft = async () => {
    const dest = loc?.displayName || loc?.address;
    if (!profile || !dest) {
      // No route to recompute — fall back to the old 5-minute re-ping.
      await sendInstantNotification(
        he ? '🚌 עכשיו באמת הזמן לצאת!' : "🚌 Now it's really time to go!",
        he ? `${liveTask.text} ב-${taskStart(liveTask)}` : `${liveTask.text} at ${taskStart(liveTask)}`,
        { taskId: liveTask.id, screen: 'LeaveNow' }, 5 * 60,
      );
      navigation.goBack();
      return;
    }
    setReplanning(true);
    setOptions(null);
    setReplanNote(null);
    try {
      // Three departures, not one. Missing the 08:30 does not mean the 09:15
      // is the answer — it means she needs to see the 09:15, the 09:45 and the
      // 10:05 with their arrival times and decide. Nothing is written until
      // she picks one, so opening this list never changes her alerts.
      const { options: found, origin } = await nextDepartureOptions(
        liveTask, rawProfile ?? profile, { mode, count: 3 },
      );
      setOptionsOrigin(origin);
      if (found.length) {
        setOptions(found);
        return;
      }
      // No timetable came back (a car trip, or a route Google would not
      // serve). Fall back to the single recompute, which at least re-arms the
      // alerts for a real departure.
      const result = await replanFromNextDeparture(liveTask, rawProfile ?? profile, {
        mode, language,
      });
      if (!result.replanned || !result.task) {
        setOptions([]);
        setReplanNote(he ? 'לא מצאתי נסיעה הבאה כרגע 🙁' : "Couldn't find the next departure 🙁");
        return;
      }
      setLiveTask(result.task);
      setReplanNote(result.message ?? null);
    } catch {
      setReplanNote(he ? 'משהו השתבש בחישוב 🙁' : 'Something went wrong recalculating 🙁');
    } finally {
      setReplanning(false);
    }
  };

  /** She picked one — it becomes the route, the times and the alerts. */
  const handlePickOption = async (plan: any) => {
    if (picking) return;
    setPicking(plan.leaveHomeAt);
    try {
      const updated = await applyDepartureOption(liveTask, plan, language);
      setLiveTask(updated);
      setOptions(null);
      setReplanNote(
        he ? `✓ נעול על ${plan.leaveHomeAt} · הגעה ${plan.arriveAt}`
          : `✓ Locked in ${plan.leaveHomeAt} · arrive ${plan.arriveAt}`,
      );
    } catch {
      setReplanNote(he ? 'לא הצלחתי לעדכן 🙁' : "Couldn't update 🙁");
    } finally {
      setPicking(null);
    }
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <WashedSky />
      <ScrollView contentContainerStyle={styles.content}>
        {/* top bar */}
        <View style={styles.topBar}>
          <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Text style={styles.close}>✕</Text>
          </TouchableOpacity>
          <View style={styles.nextChip}>
            <Text style={styles.nextChipText}>{he ? 'הבא בתור' : 'NEXT UP · הבא בתור'}</Text>
          </View>
          <View style={{ width: 22 }} />
        </View>

        {/* title */}
        <Text style={styles.title}>{meta.icon} {liveTask.text}</Text>
        <Text style={styles.subtitle}>
          {taskStart(liveTask)}{loc ? ` · ${loc.displayName || loc.address}` : ''}
        </Text>

        {/* countdown */}
        <View style={[styles.countdown, late && styles.countdownLate]}>
          <Text style={styles.countdownLabel}>
            {countdownLabel(minutesLeft, language)}
          </Text>
          <Text style={styles.countdownValue}>
            {minutesLeft === null ? '—' : formatCountdown(minutesLeft, language).value}
            {minutesLeft === null ? null : (
              // "165 min" is fine for the next hour and meaningless for
              // tomorrow. Hours and days once the number stops being felt.
              <Text style={styles.countdownUnit}>
                {' '}{formatCountdown(minutesLeft, language).unit}
              </Text>
            )}
          </Text>
        </View>

        {/* map */}
        {/* RouteMap draws the map AND its own Navigate button, and sizes itself.
            This used to force it into a fixed 210px box — so the button was cut
            off — and then paint a SECOND "Open in Google Maps" on top of it,
            absolutely positioned. Two buttons doing one thing, overlapping, in a
            clipped frame. The map keeps its own height; there is one button. */}
        {loc && loc.transitPlan ? (
          <View style={styles.mapBox}>
            <RouteMap
              plan={loc.transitPlan}
              destLat={loc.lat}
              destLng={loc.lng}
              destLabel={loc.displayName || loc.address}
              height={190}
            />
          </View>
        ) : null}

        {/* condensed chain */}
        <View style={styles.chain}>
          {steps.map((s, i) => (
            <View key={`${s.time}-${i}`} style={[styles.stepRow, s.kind === 'highlight' && styles.stepHl]}>
              <Text style={[styles.stepTime, s.kind === 'success' && styles.ok]}>{s.time}</Text>
              <Text style={styles.stepIcon}>{s.icon}</Text>
              <Text style={[styles.stepLabel, s.kind === 'success' && styles.okBold]} numberOfLines={1}>
                {he ? s.labelHe : s.labelEn}
              </Text>
              {(he ? s.noteHe : s.noteEn) ? (
                <Text style={[styles.stepNote, s.kind === 'highlight' && styles.stepNoteHl]}>
                  {he ? s.noteHe : s.noteEn}
                </Text>
              ) : null}
            </View>
          ))}
        </View>

        {/* Departure confirmed — what tapping "I left" actually did. */}
        {leftNote && (
          <View style={styles.leftNote}>
            <Text style={styles.leftNoteText}>{leftNote}</Text>
          </View>
        )}

        {/* Recalculated result — the next bus and the new arrival, right here. */}
        {replanNote && (
          <View style={styles.replanNote}>
            <Text style={styles.replanNoteText}>{replanNote}</Text>
          </View>
        )}

        {/* The choice itself. Rendered above the buttons, because once it is on
            screen it is the thing she came here to act on. */}
        {(replanning || options) && (
          <TransitOptionsList
            options={options ?? []}
            language={language}
            loading={replanning}
            originNote={optionsOrigin === 'here'
              ? (he ? '📍 מחושב מהמיקום שלך עכשיו' : '📍 timed from where you are now')
              : (he ? '🏠 מחושב מהבית' : '🏠 timed from home')}
            onPick={handlePickOption}
            pickingDeparture={picking}
          />
        )}

        {/* actions */}
        {/* Two equal columns, each free to be two lines tall.
            This used to be `leftBtn: flex 1` beside a `snoozeBtn` sized by its
            own horizontal padding — so the longer label decided the width of
            the row, pushed past the screen edge and had its text clipped. Both
            buttons now share the width, and the labels wrap rather than being
            cut: a button whose text you cannot read is a button you do not
            press. */}
        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.actionBtn, styles.leftBtn, leaving && styles.leftBtnBusy]}
            onPress={handleLeft}
            activeOpacity={0.85}
            disabled={leaving}
          >
            <Text style={styles.leftBtnText} numberOfLines={2}>
              {leaving
                ? (he ? '…מעדכן' : '…updating')
                : (he ? '✓ יצאתי' : '✓ I left')}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.actionBtn, styles.snoozeBtn, replanning && styles.leftBtnBusy]}
            onPress={handleNotLeft}
            activeOpacity={0.85}
            disabled={replanning}
          >
            <Text style={styles.snoozeBtnText} numberOfLines={2}>
              {replanning
                ? (he ? '…מחשב' : '…checking')
                : (he ? '🚏 עוד לא יצאתי' : "🚏 Haven't left")}
            </Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BRAND.cream },
  content: { padding: 22, paddingBottom: 40, gap: 12 },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  close: { fontSize: 22, color: BRAND.warmInk },
  nextChip: { backgroundColor: BRAND.timeChipBg, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 5 },
  nextChipText: { fontFamily: FONTS.bodyHeavy, fontSize: 12, color: BRAND.timeChipText },
  title: { fontFamily: FONTS.display, fontSize: 24, color: BRAND.warmInk, textAlign: 'center' },
  subtitle: { fontFamily: FONTS.bodyBold, fontSize: 14, color: BRAND.inkSoft, textAlign: 'center' },
  countdown: {
    alignSelf: 'center', backgroundColor: BRAND.sunGold, borderRadius: 18,
    paddingHorizontal: 22, paddingVertical: 10, alignItems: 'center', ...SHADOWS.button,
  },
  countdownLate: { backgroundColor: '#EF476F' },
  countdownLabel: { fontFamily: FONTS.bodyHeavy, fontSize: 11, letterSpacing: 1, color: BRAND.goldInk },
  countdownValue: { fontFamily: FONTS.display, fontSize: 34, color: '#4A3512', lineHeight: 38 },
  countdownUnit: { fontSize: 15 },
  // No fixed height and no clipping: the child decides how tall it is, and a
  // button at its bottom edge must not be cut off by its parent.
  mapBox: { borderRadius: RADIUS.card, borderWidth: 1, borderColor: BRAND.line, padding: 8 },
  chain: {
    backgroundColor: BRAND.creamCard, borderWidth: 1, borderColor: BRAND.line,
    borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10, gap: 2,
  },
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4, paddingHorizontal: 6, borderRadius: 8 },
  stepHl: { backgroundColor: BRAND.timeChipBg },
  stepTime: { width: 42, fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.timeChipText },
  stepIcon: { fontSize: 14 },
  stepLabel: { flex: 1, fontFamily: FONTS.bodyBold, fontSize: 13, color: BRAND.warmInk },
  stepNote: { fontSize: 11, fontFamily: FONTS.bodyHeavy, color: BRAND.inkFaint },
  stepNoteHl: { color: BRAND.timeChipText },
  ok: { color: BRAND.success },
  okBold: { color: BRAND.success, fontFamily: FONTS.bodyHeavy },
  actions: { flexDirection: 'row', gap: 10, marginTop: 4, alignItems: 'stretch' },
  // Equal halves. No fixed height — a wrapped label makes the pair taller,
  // never narrower, and never clipped.
  actionBtn: {
    flex: 1, flexBasis: 0, minWidth: 0, borderRadius: 18,
    paddingVertical: 13, paddingHorizontal: 10,
    alignItems: 'center', justifyContent: 'center',
  },
  leftBtn: { backgroundColor: BRAND.warmInk, ...SHADOWS.button },
  leftBtnBusy: { opacity: 0.6 },
  leftBtnText: { fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.honey, textAlign: 'center' },
  leftNote: {
    backgroundColor: BRAND.success,
    borderRadius: RADIUS.chip,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginTop: 4,
  },
  leftNoteText: { fontFamily: FONTS.bodyHeavy, fontSize: 14, color: '#0B3D2E' },
  replanNote: {
    backgroundColor: BRAND.honey,
    borderRadius: RADIUS.chip,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginTop: 4,
    marginBottom: 4,
  },
  replanNoteText: { fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.inkSoft, lineHeight: 20 },
  snoozeBtn: {
    backgroundColor: BRAND.creamCard, borderWidth: 1, borderColor: BRAND.line,
  },
  snoozeBtnText: {
    fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.inkSoft, textAlign: 'center',
  },
});
