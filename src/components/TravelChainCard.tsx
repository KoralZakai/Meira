/**
 * TravelChainCard — expandable task row with its road plan.
 * Tap the row → the way there (or the way home, for at-home tasks after an
 * away appointment) opens as a wake→leave→ride→arrive chain; tap again closes.
 * Transport chips (🚌🚆🚗🚶🚴) recalculate the times per task.
 * Drop into src/components/. Uses BRAND theme + buildTravelChain util.
 */
import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { Task, TransportType, TransitPlan, UserProfile, AppLanguage } from '../types';
import { rankDepartureOptions } from '../utils/departureOptions';
import TransitOptionsList from './TransitOptionsList';
import { BRAND, FONTS, RADIUS, SHADOWS } from '../constants/theme';
import { needsLastMileHelp } from '../services/MultiModalPlanner';
import { getCategoryMeta } from '../constants/categories';
import {
  ChainStep, buildWayThere, buildWayHome, asLocation, isAtHome,
  effectiveTransport, taskStart,
} from '../utils/buildTravelChain';
import { missedPlannedDeparture } from '../utils/liveRoutePlan';
import { wakeChipFor, wakeInputs } from '../utils/alarmPlan';
import { getTodayString } from '../utils/timeUtils';

const MODES: { id: TransportType; icon: string }[] = [
  { id: 'bus', icon: '🚌' }, { id: 'train', icon: '🚆' }, { id: 'car', icon: '🚗' },
  { id: 'walk', icon: '🚶' }, { id: 'bike', icon: '🚴' },
];

interface Props {
  task: Task;
  /** The previous task of the day (chronologically) — used for way-home plans. */
  prevTask?: Task;
  profile?: UserProfile | null;
  /** The day's single wake hour — see utils/alarmPlan.dayWakeOwner. */
  dayEarliestWake?: string;
  language: AppLanguage;
  /** First away-appointment of the day gets wake/get-ready rows. */
  isFirstOfDay?: boolean;
  /** Open by default (use for the closest upcoming task). */
  initiallyExpanded?: boolean;
  onTap?: (task: Task) => void;
  /** "Haven't left" — recomputes the next departure and reports back via `note`. */
  onNotLeft?: (task: Task) => void;
  /** Open the full route screen (map + chain). */
  onOpenRoute?: (task: Task) => void;
  /** One line from the last recompute: the next bus, the new arrival, or why not. */
  note?: string;
  /** Other ways to make this appointment, best first (see getTransitAlternatives). */
  alternatives?: TransitPlan[];
  /** Ask for the alternatives (they cost a Google call, so only on request). */
  onShowAlternatives?: (task: Task) => void;
  /** Take one of them: it becomes this task's route, times and alerts. */
  onPickAlternative?: (task: Task, plan: TransitPlan) => void;
  onComplete?: (task: Task) => void;
  /** Persist a per-task transport override and refetch the route for that mode.
   *  Awaited: while it runs the chain shows scaled estimates + a spinner, then
   *  re-renders on the real Google plan. */
  onTransportChange?: (task: Task, mode: TransportType) => void | Promise<void>;
  /** Long-press → edit this task. A card you can only tick or expand is a card
   *  you cannot fix a typo in without hunting for the right screen. */
  onEdit?: (task: Task) => void;
  /** Tap the ⏰ chip: turn the wake alarm off/on, or move it. */
  onAlarmPress?: (task: Task) => void;
}

export default function TravelChainCard({
  task, prevTask, profile, language, isFirstOfDay = false,
  initiallyExpanded = false, onTap, onNotLeft, onOpenRoute, onComplete,
  onTransportChange, note, alternatives, onShowAlternatives, onPickAlternative,
  onEdit, onAlarmPress, dayEarliestWake,
}: Props) {
  const [altsOpen, setAltsOpen] = useState(false);
  const he = language === 'he';
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [mode, setMode] = useState<TransportType>(effectiveTransport(task, profile));
  // True while the real route for a just-picked mode is being fetched.
  const [routing, setRouting] = useState(false);

  const away = !!asLocation(task);
  // "I haven't left" only means something once the departure has GONE. Offered
  // before then it is a trap: pressing it at 11:53 for a 15:39 bus would
  // recompute "leave now" and overwrite a perfectly good plan with a trip four
  // hours early. Caught by pressing it on a real phone, not by a test.
  const departureGone = task.date === getTodayString()
    && missedPlannedDeparture(asLocation(task)?.leaveHomeBy);
  const plan = asLocation(task)?.transitPlan;
  const wayHome = !away && isAtHome(task) && !!asLocation(prevTask);
  const hasChain = away || wayHome;
  const done = task.status === 'complete';
  const meta = getCategoryMeta(task.category);

  const steps: ChainStep[] = !hasChain ? []
    : away ? buildWayThere(task, mode, profile, isFirstOfDay)
    : buildWayHome(task, prevTask!, mode, profile);

  const pickMode = async (m: TransportType) => {
    setMode(m);
    if (!onTransportChange) return;
    setRouting(true);
    try {
      await onTransportChange(task, m);
    } finally {
      setRouting(false);
    }
  };

  // Subtask progress was on the old row — keep it visible in the sub-line.
  const subtasks = task.subtasks || [];
  const doneCount = subtasks.filter((st) => st.status === 'complete').length;
  const subtaskTag = subtasks.length ? `  ☑ ${doneCount}/${subtasks.length}` : '';

  // What the alarm will actually do for this task — asked of the domain, so
  // this card and the phone cannot disagree. The hand-rolled version here read
  // only `alarmAt || location.wakeUpBy` and so missed the third source (start
  // minus morning routine), hiding the chip on every un-routed task; and it
  // called ANY 'not_needed' state "off", so a 14:00 trip that legitimately
  // needs no alarm drew a 🔕 she could not explain.
  const wake = wakeChipFor(task, wakeInputs(profile), { dayEarliestWake });
  const alarmAt = wake?.at;
  const alarmOff = Boolean(wake?.muted);

  const lastMileWalk = needsLastMileHelp(asLocation(task)?.transitPlan);

  // She picked a vehicle and the route came back on a different one. Say it
  // out loud — a 🚆 chip above "Bus 271" with no explanation reads as the app
  // having ignored her.
  // She is already there. Showing a journey to a place she is standing in is
  // the thing that made the card feel broken — and the chips would invite her
  // to re-plan a trip she has made.
  const hasArrived = Boolean(task.verifiedArrival);

  // She asked for a mode that has no route at all. Say that plainly — the one
  // thing that must never happen is a bus appearing under a train chip.
  // Same rule as TimelineTravelLeg: a stale "no route" flag must never
  // outlive the route it was about, and must never be shown next to a plan.
  const noRouteLoc = asLocation(task);
  const noRoute = noRouteLoc?.noRouteForMode === mode && !noRouteLoc?.transitPlan
    ? noRouteLoc.noRouteForMode
    : undefined;
  const noRouteNote = noRoute === 'train'
    ? (he ? '🚆 אין מסלול רכבת ליעד הזה' : '🚆 No train route to this destination')
    : noRoute
      ? (he ? 'אין מסלול במצב שנבחר' : 'No route for the selected mode')
      : '';

  const unmet = asLocation(task)?.transitPlan?.unavailableMode;
  const unmetNote = unmet === 'train'
    ? (he ? 'אין רכבת במסלול הזה — זו הדרך בתחב״צ' : 'No train on this route — this is the public-transport way')
    : unmet === 'bus'
      ? (he ? 'אין קו אוטובוס מתאים — זו הדרך בתחב״צ' : 'No suitable bus — this is the public-transport way')
      : '';

  const sub = away
    ? `📍 ${asLocation(task)?.displayName || asLocation(task)?.address || ''}`
    : wayHome
      ? (he ? '🏠 מהבית · צריך קודם את הדרך חזרה' : '🏠 from home · needs the way back first')
      : (he ? 'ללא נסיעה' : 'no travel');

  return (
    <View style={[styles.card, done && styles.cardDone]}>
      {/* header row — tap toggles the chain */}
      <TouchableOpacity
        activeOpacity={0.75}
        onPress={() => (hasChain ? setExpanded((e) => !e) : onTap?.(task))}
        onLongPress={() => onEdit?.(task)}
        delayLongPress={350}
        style={styles.header}
      >
        <TouchableOpacity
          onPress={() => onComplete?.(task)}
          style={[styles.checkbox, done && styles.checkboxDone]}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          {done ? <Text style={styles.checkmark}>✓</Text> : null}
        </TouchableOpacity>
        <Text style={styles.time}>{taskStart(task)}</Text>
        <View style={styles.titleBox}>
          <Text style={[styles.title, done && styles.titleDone]} numberOfLines={1}>
            {meta.icon} {task.text}
          </Text>
          <Text style={styles.sub} numberOfLines={1}>{sub}{subtaskTag}</Text>
        </View>
        {/* The alarm, where she can SEE it. A wake-up that exists only inside
            the scheduler is indistinguishable from one that was never set —
            which is exactly how a silent morning gets discovered too late.
            Tap it to turn it off, back on, or move it. */}
        {alarmAt ? (
          <TouchableOpacity
            onPress={() => onAlarmPress?.(task)}
            hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
            style={[styles.alarmChip, alarmOff && styles.alarmChipOff]}
          >
            <Text style={[styles.alarmChipText, alarmOff && styles.alarmChipTextOff]}>
              {alarmOff ? '🔕' : '⏰'} {alarmAt}
            </Text>
          </TouchableOpacity>
        ) : null}
        {hasChain ? <Text style={styles.chevron}>{expanded ? '▾' : '▸'}</Text> : null}
      </TouchableOpacity>

      {/* expanded chain */}
      {expanded && hasChain ? (
        <View style={styles.chain}>
          <View style={styles.chainHeader}>
            <Text style={styles.chainTitle}>
              {away ? (he ? 'הדרך לשם' : 'THE WAY THERE') : (he ? 'הדרך הביתה' : 'THE WAY HOME')}
              {routing ? (he ? ' · מחשב מסלול…' : ' · routing…') : ''}
            </Text>
            {routing ? <ActivityIndicator size="small" color={BRAND.amber} /> : null}
            <View style={styles.modeRow}>
              {MODES.map((m) => (
                <TouchableOpacity
                  key={m.id}
                  onPress={() => pickMode(m.id)}
                  style={[styles.modeChip, mode === m.id && styles.modeChipActive]}
                >
                  <Text style={styles.modeIcon}>{m.icon}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
          {noRouteNote && !hasArrived ? (
            <Text style={styles.noRouteNote}>{noRouteNote}</Text>
          ) : null}
          {unmetNote && !hasArrived && !noRouteNote ? <Text style={styles.unmetNote}>⚠️ {unmetNote}</Text> : null}
          {hasArrived ? (
            <Text style={styles.arrivedNote}>
              {he ? '✅ הגעת — אין יותר נסיעה לכאן' : "✅ You're here — no journey left to this one"}
            </Text>
          ) : null}
          {(hasArrived || noRouteNote ? [] : steps).map((s, i) => (
            <View key={`${s.time}-${i}`}>
              <View style={[styles.stepRow, s.kind === 'highlight' && styles.stepHl]}>
                <Text style={[styles.stepTime, s.kind === 'success' && styles.stepTimeOk]}>{s.time}</Text>
                <Text style={styles.stepIcon}>{s.icon}</Text>
                <Text style={[styles.stepLabel, s.kind === 'success' && styles.stepLabelOk, s.kind === 'highlight' && styles.stepLabelHl]} numberOfLines={1}>
                  {he ? s.labelHe : s.labelEn}
                </Text>
                {(he ? s.noteHe : s.noteEn) ? (
                  <Text style={[styles.stepNote, s.kind === 'highlight' && styles.stepNoteHl, s.kind === 'success' && styles.stepTimeOk]}>
                    {he ? s.noteHe : s.noteEn}
                  </Text>
                ) : null}
              </View>
              {i < steps.length - 1 ? <View style={styles.connector} /> : null}
            </View>
          ))}
          {/* The chain above is only as good as the route behind it. When there
              is no plan there is no line, no stop and no departure time — say
              that, and say which button fixes it, instead of showing an
              estimate that looks like a timetable. */}
          {away && !asLocation(task)?.transitPlan ? (
            <Text style={styles.noPlan}>
              {he
                ? 'אין עדיין פרטי נסיעה — הקישי על 🚌 כדי לקבל קו, תחנה ושעה.'
                : 'No ride details yet — tap 🚌 for the line, stop and time.'}
            </Text>
          ) : null}

          {/* The last mile has no service: Google finished the journey on
              foot, which is how a 10:00 interview produced a 06:00 departure.
              Say so here too — Today is where she actually looks. */}
          {lastMileWalk > 0 ? (
            <View style={styles.lastMileWarn}>
              <Text style={styles.lastMileWarnText}>
                {he
                  ? `⚠️ ${lastMileWalk} דק׳ הליכה בסוף — פתחי "נסיעות" לשילוב רכבת + הסעה`
                  : `⚠️ ends with a ${lastMileWalk} min walk — open Trips for train + a lift`}
              </Text>
            </View>
          ) : null}

          {/* What the last recompute said: the next bus and the new arrival. */}
          {note ? (
            <View style={styles.note}>
              <Text style={styles.noteText}>{note}</Text>
            </View>
          ) : null}

          {/* Other ways there. Google returns several routes and they are not
              equivalent — for this very trip it led with two buses while a
              single one, three minutes faster, sat further down the list. She
              could see that in Google Maps and not here, which made Lumi look
              wrong even when it was merely incurious. */}
          {away && onShowAlternatives && plan ? (
            <TouchableOpacity
              style={styles.altsBtn}
              onPress={() => {
                const next = !altsOpen;
                setAltsOpen(next);
                if (next && !alternatives) onShowAlternatives(task);
              }}
              activeOpacity={0.8}
            >
              <Text style={styles.altsBtnText} numberOfLines={2}>
                {altsOpen
                  ? (he ? '▾ דרכים אחרות' : '▾ Other departures')
                  : (he ? '▸ דרכים אחרות' : '▸ Other departures')}
              </Text>
            </TouchableOpacity>
          ) : null}

          {altsOpen && away ? (
            /* One rendering of "pick a departure", shared with the Leave-now
               screen. It used to be a row of one long sentence with a "use"
               label fighting it for width — in Hebrew the sentence wrapped and
               the two clock times, which are the only reason to open this at
               all, were what got pushed out. */
            <TransitOptionsList
              options={rankDepartureOptions(alternatives ?? [], {
                appointment: task.fixedTime || task.scheduledTime,
                currentDeparture: asLocation(task)?.leaveHomeBy,
                max: 4,
              })}
              language={language}
              loading={!alternatives}
              emptyNote={he ? 'לא מצאתי דרך אחרת.' : 'No other way found.'}
              onPick={(alt) => onPickAlternative?.(task, alt)}
            />
          ) : null}

          {/* "Haven't left" on the trip itself — recomputes from the NEXT
              departure and shows the result right here. */}
          {away && onNotLeft && departureGone ? (
            <TouchableOpacity
              style={styles.notLeftBtn}
              onPress={() => onNotLeft(task)}
              activeOpacity={0.85}
            >
              <Text style={styles.notLeftText} numberOfLines={2}>
                {he ? '🚏 עוד לא יצאתי — מה הבא?' : "🚏 Haven't left — show next options"}
              </Text>
            </TouchableOpacity>
          ) : null}

          {away && onOpenRoute ? (
            <TouchableOpacity
              style={styles.routeBtn}
              onPress={() => onOpenRoute(task)}
              activeOpacity={0.85}
            >
              <Text style={styles.routeBtnText}>
                {he ? 'המסלול המלא והמפה ›' : 'Full route and map ›'}
              </Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  noRouteNote: {
    fontFamily: FONTS.bodySemi, fontSize: 13, color: BRAND.danger,
    marginTop: 8, marginBottom: 2,
  },
  arrivedNote: {
    fontFamily: FONTS.bodySemi, fontSize: 13, color: BRAND.success,
    marginTop: 8, marginBottom: 2,
  },
  unmetNote: {
    fontFamily: FONTS.bodySemi, fontSize: 12, color: BRAND.amber,
    marginTop: 6, marginBottom: 2,
  },
  lastMileWarn: {
    marginTop: 8, borderRadius: RADIUS.chip, backgroundColor: BRAND.honey,
    paddingHorizontal: 10, paddingVertical: 7,
  },
  lastMileWarnText: { fontFamily: FONTS.bodyBold, fontSize: 11, color: '#4A3512' },
  // flexShrink: 0 — this row is checkbox · time · flexible title · alarm ·
  // chevron. Without it a long Hebrew task name compresses the chip and clips
  // "06:40" down to "06:…", which reads exactly like no alarm being set.
  alarmChip: {
    flexShrink: 0,
    backgroundColor: BRAND.timeChipBg, borderRadius: 999,
    paddingHorizontal: 8, paddingVertical: 3, marginLeft: 6,
  },
  alarmChipOff: { backgroundColor: 'transparent', borderWidth: 1, borderColor: BRAND.line },
  alarmChipText: { flexShrink: 0, fontFamily: FONTS.bodyHeavy, fontSize: 11, color: BRAND.timeChipText },
  alarmChipTextOff: { color: BRAND.inkFaint },
  // Full-width tap target, centred label, free to wrap. The old one relied on
  // the label fitting on one line at any language and font scale; it did not.
  altsBtn: {
    alignSelf: 'stretch', paddingVertical: 10, paddingHorizontal: 8,
    alignItems: 'center', justifyContent: 'center', marginTop: 6,
  },
  altsBtnText: {
    fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.timeChipText,
    textAlign: 'center',
  },
  noPlan: {
    fontFamily: FONTS.bodySemi, fontSize: 12.5, color: BRAND.inkSoft,
    marginTop: 8, lineHeight: 18,
  },
  note: {
    backgroundColor: BRAND.honey, borderRadius: 12,
    paddingVertical: 10, paddingHorizontal: 12, marginTop: 10,
  },
  noteText: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.inkSoft, lineHeight: 19 },
  routeBtn: {
    alignSelf: 'stretch', paddingVertical: 10, paddingHorizontal: 8,
    alignItems: 'center', justifyContent: 'center',
  },
  routeBtnText: {
    fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.timeChipText, textAlign: 'center',
  },
  notLeftBtn: {
    alignSelf: 'stretch', backgroundColor: BRAND.sunGold, borderRadius: 12,
    paddingVertical: 12, paddingHorizontal: 12,
    alignItems: 'center', justifyContent: 'center', marginTop: 10,
  },
  notLeftText: {
    fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.inkSoft, textAlign: 'center',
  },
  card: {
    backgroundColor: BRAND.creamCard, borderWidth: 1, borderColor: BRAND.line,
    borderRadius: 16, overflow: 'hidden', ...SHADOWS.card,
  },
  cardDone: { backgroundColor: BRAND.line },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 13 },
  checkbox: {
    width: 20, height: 20, borderRadius: 6, borderWidth: 2,
    borderColor: BRAND.amber, alignItems: 'center', justifyContent: 'center',
  },
  checkboxDone: { backgroundColor: BRAND.success, borderColor: BRAND.success },
  checkmark: { color: BRAND.white, fontSize: 12, fontFamily: FONTS.bodyHeavy },
  time: { width: 44, fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.timeChipText },
  titleBox: { flex: 1 },
  title: { fontFamily: FONTS.bodyHeavy, fontSize: 15, color: BRAND.warmInk },
  titleDone: { color: BRAND.inkSoft, textDecorationLine: 'line-through' },
  sub: { fontFamily: FONTS.bodySemi, fontSize: 12, color: BRAND.inkSoft, marginTop: 1 },
  chevron: { fontSize: 14, color: BRAND.timeChipText, fontFamily: FONTS.bodyHeavy },
  chain: {
    borderTopWidth: 1, borderColor: BRAND.line, borderStyle: 'dashed',
    paddingHorizontal: 14, paddingTop: 10, paddingBottom: 14, gap: 0,
  },
  chainHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  chainTitle: { fontFamily: FONTS.bodyHeavy, fontSize: 12, letterSpacing: 0.8, color: BRAND.inkFaint },
  modeRow: { flexDirection: 'row', gap: 5 },
  modeChip: {
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: 10,
    backgroundColor: BRAND.cream, borderWidth: 1, borderColor: BRAND.line,
  },
  modeChipActive: { backgroundColor: BRAND.warmInk, borderColor: BRAND.warmInk },
  modeIcon: { fontSize: 13 },
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 5, paddingHorizontal: 8, borderRadius: 10 },
  stepHl: { backgroundColor: BRAND.timeChipBg },
  stepTime: { width: 44, fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.timeChipText },
  stepTimeOk: { color: BRAND.success },
  stepIcon: { fontSize: 15 },
  stepLabel: { flex: 1, fontFamily: FONTS.bodyBold, fontSize: 14, color: BRAND.warmInk },
  stepLabelHl: { fontFamily: FONTS.bodyHeavy },
  stepLabelOk: { color: BRAND.success, fontFamily: FONTS.bodyHeavy },
  stepNote: { fontSize: 11, fontFamily: FONTS.bodyHeavy, color: BRAND.inkFaint },
  stepNoteHl: { color: BRAND.timeChipText },
  connector: { width: 2, height: 8, backgroundColor: BRAND.line, marginLeft: 64 },
});
