/**
 * TimelineTravelLeg — the journey between two blocks, on the timeline itself.
 *
 * The route used to live only on Today's TravelChainCard, so the schedule drew
 * the appointments and said nothing about getting to them: a day of three
 * places across town looked like three cards with air between them. Here the
 * journey sits where it happens — under the block you leave, above the block
 * you arrive at.
 *
 * Collapsed it is one row: leave time, vehicle, duration. Expanded it shows
 * the mode picker and every leg. LayoutAnimation (not Reanimated) does the
 * accordion: it is in core RN, it animates the height change the conditional
 * render causes, and it costs nothing when the row is closed.
 *
 * Mode is per-task and persisted by the caller (onModeChange -> the same
 * handler Today uses), so choosing "train" here is the same choice as choosing
 * it there — one preference, two places to set it.
 */
import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, LayoutAnimation, Platform, UIManager,
} from 'react-native';
import { Task, AppLanguage, TaskLocation, TransportType, TransitPlan } from '../types';
import { DepartureOption } from '../utils/departureOptions';
import { missedPlannedDeparture } from '../utils/liveRoutePlan';
import { getTodayString } from '../utils/timeUtils';
import TransitOptionsList from './TransitOptionsList';
import { BRAND, FONTS, RADIUS } from '../constants/theme';
import { travelRowState, describeTravelRow } from '../utils/travelRowState';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const MODES: { id: TransportType; icon: string }[] = [
  { id: 'bus', icon: '🚌' },
  { id: 'train', icon: '🚆' },
  { id: 'car', icon: '🚗' },
  { id: 'walk', icon: '🚶' },
  { id: 'bike', icon: '🚴' },
];

const LEG_ICON: Record<string, string> = {
  walk: '🚶', bus: '🚌', train: '🚆', subway: '🚇',
};

interface Props {
  task: Task;
  language: AppLanguage;
  /** Highlight — this is the journey she has to make next. */
  isNext?: boolean;
  onModeChange?: (task: Task, mode: TransportType) => void | Promise<void>;
  onOpenRoute?: (task: Task) => void;
  /** Fetch the next few departures for this trip (one Google probe per option). */
  onShowOptions?: (task: Task) => Promise<DepartureOption[]>;
  /** Commit one of them: it becomes the route, the times and the alerts. */
  onPickOption?: (task: Task, plan: TransitPlan) => void | Promise<void>;
  /**
   * Re-plan this journey from somewhere else. 'auto' hands it back to the
   * chain (home, or the previous stop); 'current' uses a live GPS fix.
   */
  onChangeOrigin?: (task: Task, origin: 'auto' | 'current') => void | Promise<void>;
  /**
   * Every way of making this journey, priced — from where she IS.
   *
   * The mode chips could only be tried one at a time: tap 🚆, wait for Google,
   * read the number, tap 🚗, wait again, and hold the first number in your
   * head while the second loads. That is the worst possible shape for the one
   * question being asked ("which of these is fastest?") and a particularly bad
   * one for a working memory that is already busy being late.
   *
   * With this the answer is on the chips themselves and the comparison is a
   * glance rather than a sequence.
   */
  onCompareModes?: (task: Task) => Promise<ModeQuote[]>;
}

/** One way of getting there: how long it takes, and whether it lands in time. */
export interface ModeQuote {
  mode: TransportType;
  minutes: number;
  /** HH:MM, so a mode that is fast but arrives late can say so. */
  arriveAt?: string;
}

const asLoc = (t: Task): TaskLocation | undefined =>
  t.location && typeof t.location === 'object' ? (t.location as TaskLocation) : undefined;


/** Minutes between waking and leaving — what "get ready" actually costs. */
function readyMinutes(wake: string, leave: string): number {
  const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  return Math.max(0, mins(leave) - mins(wake));
}

/** " · 7 min early" / " · 4 min late" — the bit she is really asking about. */
function slackNote(arriveAt: string, dueAt: string | undefined, he: boolean): string {
  if (!dueAt) return '';
  const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const slack = mins(dueAt) - mins(arriveAt);
  if (!Number.isFinite(slack) || slack === 0) return '';
  return slack > 0
    ? (he ? ` · ${slack} דק׳ מוקדם` : ` · ${slack} min early`)
    : (he ? ` · ${-slack} דק׳ באיחור` : ` · ${-slack} min late`);
}

export default function TimelineTravelLeg({
  task, language, isNext, onModeChange, onOpenRoute, onShowOptions, onPickOption,
  onChangeOrigin, onCompareModes,
}: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // The next few departures, once she asks. Null = not asked.
  const [options, setOptions] = useState<DepartureOption[] | null>(null);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [movingOrigin, setMovingOrigin] = useState(false);
  // Every mode, priced. Null = not asked yet; [] = asked and Google had
  // nothing, which is a different thing and must not read as "still loading".
  const [quotes, setQuotes] = useState<ModeQuote[] | null>(null);
  const [comparing, setComparing] = useState(false);
  const he = language === 'he';
  const loc = asLoc(task);
  const plan = loc?.transitPlan;
  const mode: TransportType = (loc?.transportType as TransportType) || 'bus';

  const toggle = () => {
    LayoutAnimation.configureNext(LayoutAnimation.create(
      220, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.opacity,
    ));
    setOpen((v) => !v);
  };

  const pickMode = async (m: TransportType) => {
    if (!onModeChange || busy) return;
    setBusy(true);
    // A mode switch invalidates the departures listed for the old one. Clear
    // them rather than leaving three train times under a 🚗 chip.
    setOptions(null);
    try { await onModeChange(task, m); } finally { setBusy(false); }
  };

  /**
   * One tap on a missed row does both things: opens the leg and asks for the
   * next departures. Making her expand, find a button and press it to learn
   * what she can still catch is three taps for one question.
   */
  const pickOrigin = async (origin: 'auto' | 'current') => {
    if (!onChangeOrigin || movingOrigin) return;
    setMovingOrigin(true);
    // The listed departures belong to the old starting point.
    setOptions(null);
    setQuotes(null);   // priced from the old starting point
    try {
      await onChangeOrigin(task, origin);
      if (onCompareModes) await compare();
    } finally { setMovingOrigin(false); }
  };

  const openAndLoad = () => {
    toggle();
    if (!options && onShowOptions) void showOptions();
    if (!quotes && onCompareModes) void compare();
  };

  /**
   * Ask once per opening, not once per render — this is five routing calls and
   * they are not free. Re-asked after a mode or origin change, because both
   * move the numbers: a comparison measured from her flat is the wrong answer
   * the moment she is not in it.
   */
  const compare = async () => {
    if (!onCompareModes || comparing) return;
    setComparing(true);
    try { setQuotes(await onCompareModes(task)); } catch { setQuotes([]); } finally {
      setComparing(false);
    }
  };

  const showOptions = async () => {
    if (!onShowOptions || loadingOptions) return;
    setLoadingOptions(true);
    LayoutAnimation.configureNext(LayoutAnimation.create(
      220, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.opacity,
    ));
    try { setOptions(await onShowOptions(task)); } catch { setOptions([]); } finally {
      setLoadingOptions(false);
    }
  };

  // No route yet. That used to be `return null` — a blank space where the
  // journey should be, identical to a task with nowhere to go. Koral asked
  // exactly this about a yoga class: "why doesn't it tell me how to get there,
  // when?". Three different situations produced that same silence, and only
  // one of them was temporary; travelRowState tells them apart and says which.
  if (!loc?.leaveHomeBy && !plan) {
    const state = travelRowState(task);
    const line = describeTravelRow(state, he);
    if (!line) return null;   // genuinely nowhere to go — silence is correct
    return (
      <TouchableOpacity
        style={styles.noRouteRow}
        activeOpacity={0.85}
        onPress={() => {
          // The action depends on what is missing. Without an hour there is
          // nothing to compute, so open the task so she can give it one;
          // otherwise ask the chain to work the route out now.
          if (state === 'no-time') onOpenRoute?.(task);
          else void pickOrigin('auto');
        }}
      >
        <Text style={styles.noRouteText} numberOfLines={2}>{line.text}</Text>
        {line.action ? (
          <Text style={styles.noRouteAction}>
            {movingOrigin ? (he ? '…מחשב' : '…working') : line.action}
          </Text>
        ) : null}
      </TouchableOpacity>
    );
  }

  const vehicle = plan?.legs?.find((l) => l.type !== 'walk');
  const summary = plan
    ? `${LEG_ICON[vehicle?.type ?? 'walk'] ?? '🚌'} ${vehicle?.lineNumber
        ? `${he ? 'קו' : 'Line'} ${vehicle.lineNumber}`
        : (he ? 'בדרך' : 'On the way')} · ${plan.totalDurationMinutes} ${he ? 'דק׳' : 'min'}`
    : (he ? 'עוד לא חושב מסלול' : 'No route yet');

  /**
   * "No train route to this destination" — only when that is still true.
   *
   * `noRouteForMode` is written the moment ONE lookup returns nothing: a
   * dropped request, a rate limit, a deadline that had already passed. It is
   * cleared only on the next SUCCESSFUL recompute, and a recompute only
   * happens when the plan goes stale or a mode chip is tapped. So a single
   * transient miss was displayed as a permanent fact about the world —
   * "🚆 No train route to this destination" for Tel Aviv HaHagana → Tel Aviv
   * University, a fifteen-minute ride Google offers six ways.
   *
   * The tell was that the same card showed the banner AND a full wake / leave
   * chain underneath it, computed from a plan that plainly existed. Two
   * guards: the flag must be about the mode currently selected, and it is
   * ignored outright when we are holding a route for that mode.
   */
  const noRoute = loc?.noRouteForMode === mode && !plan ? loc.noRouteForMode : undefined;
  // Where this route was actually measured from, and where it ends.
  const fromCurrent = plan?.originLabel === 'My location now' || plan?.originLabel === 'המיקום שלי עכשיו';
  const fromLabel = plan?.originLabel
    || plan?.originAddress
    || plan?.firstBusStop
    || (he ? 'הבית' : 'Home');
  const toLabel = loc?.displayName || loc?.address || task.text;
  // "Haven't left" is only a real question once the departure has passed.
  const departureGone = task.date === getTodayString()
    && missedPlannedDeparture(loc?.leaveHomeBy);

  return (
    <View style={[styles.wrap, isNext && styles.wrapNext, departureGone && styles.wrapMissed]}>
      <TouchableOpacity
        style={[styles.header, departureGone && styles.headerMissed]}
        activeOpacity={0.8}
        onPress={departureGone && !open ? openAndLoad : toggle}
      >
        {departureGone ? (
          <View style={styles.missedChip}>
            <Text style={styles.missedChipText}>{he ? 'פוספס' : 'MISSED'}</Text>
          </View>
        ) : isNext ? (
          <View style={styles.nextChip}><Text style={styles.nextChipText}>{he ? 'הבא' : 'NEXT'}</Text></View>
        ) : null}
        <View style={styles.headerText}>
          {/* A departure that has gone must say so ON THE COLLAPSED ROW.
              It read "Leave 08:52" at 11:00 in a calm voice, stating as fact a
              train that left two hours earlier, and the only way to find that
              out was to expand the leg and read further. The row now carries
              the verdict and the way out of it. */}
          <Text
            style={[styles.headerTitle, departureGone && styles.headerTitleMissed]}
            numberOfLines={1}
          >
            {loc?.leaveHomeBy
              ? `${he ? 'לצאת' : 'Leave'} ${loc.leaveHomeBy}`
              : (he ? 'נסיעה' : 'Travel')}
          </Text>
          <Text
            style={[styles.headerSub, departureGone && styles.headerSubMissed]}
            numberOfLines={1}
          >
            {departureGone
              ? (he ? 'היציאה עברה · לנסיעות הבאות' : 'Departure gone · tap for the next ones')
              : summary}
          </Text>
        </View>
        <Text style={[styles.chevron, departureGone && styles.chevronMissed]}>
          {open ? '▾' : '▸'}
        </Text>
      </TouchableOpacity>

      {open ? (
        <View style={styles.body}>
          {/* FROM → TO, stated. The card gave a leave time and a line number
              and never said where the journey started, so a route measured
              from home while she was across town looked identical to a
              correct one. It also has to be CHANGEABLE: the chain's guess is
              right most mornings and wrong exactly when the day stops going
              to plan. */}
          <View style={styles.routeEnds}>
            <View style={styles.endCol}>
              <Text style={styles.endLabel}>{he ? 'מ' : 'FROM'}</Text>
              <Text style={styles.endValue} numberOfLines={2}>{fromLabel}</Text>
            </View>
            <Text style={styles.endArrow}>→</Text>
            <View style={styles.endCol}>
              <Text style={styles.endLabel}>{he ? 'אל' : 'TO'}</Text>
              <Text style={styles.endValue} numberOfLines={2}>{toLabel}</Text>
            </View>
          </View>

          {onChangeOrigin ? (
            <View style={styles.originRow}>
              <TouchableOpacity
                style={[styles.originChip, !fromCurrent && styles.originChipOn]}
                disabled={movingOrigin}
                onPress={() => pickOrigin('auto')}
                activeOpacity={0.85}
              >
                <Text
                  style={[styles.originChipText, !fromCurrent && styles.originChipTextOn]}
                  numberOfLines={1}
                >
                  {he ? '🏠 אוטומטי' : '🏠 Automatic'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.originChip, fromCurrent && styles.originChipOn]}
                disabled={movingOrigin}
                onPress={() => pickOrigin('current')}
                activeOpacity={0.85}
              >
                <Text
                  style={[styles.originChipText, fromCurrent && styles.originChipTextOn]}
                  numberOfLines={1}
                >
                  {movingOrigin
                    ? (he ? '…מחשב' : '…routing')
                    : (he ? '📍 מהמיקום שלי' : '📍 From where I am')}
                </Text>
              </TouchableOpacity>
            </View>
          ) : null}

          {/* Every way of getting there, side by side. The fastest is marked
              rather than merely being first — she is reading this while late,
              and "which one" should not require comparing five numbers. A mode
              Google has no route for is dimmed, not hidden: its absence is an
              answer ("no train goes there"), and a chip that vanishes mid-read
              is worse than one that says nothing. */}
          <View style={styles.modeRow}>
            {MODES.map((m) => {
              const on = m.id === mode;
              const quote = quotes?.find((q) => q.mode === m.id);
              const fastest = quotes?.length
                ? quotes.reduce((a, b) => (b.minutes < a.minutes ? b : a)).mode === m.id
                : false;
              const dueAt = task.fixedTime || task.scheduledTime;
              const late = quote?.arriveAt && dueAt ? quote.arriveAt > dueAt : false;
              const missing = quotes !== null && !quote;
              return (
                <TouchableOpacity
                  key={m.id}
                  disabled={busy}
                  onPress={() => pickMode(m.id)}
                  style={[
                    styles.modeChip,
                    on && styles.modeChipOn,
                    fastest && !on && styles.modeChipFastest,
                    (busy || missing) && styles.modeChipBusy,
                  ]}
                >
                  <Text style={styles.modeIcon}>{m.icon}</Text>
                  {comparing && !quotes ? (
                    <Text style={styles.modeMins}>·</Text>
                  ) : quote ? (
                    <Text style={[styles.modeMins, late && styles.modeMinsLate]}>
                      {quote.minutes}′
                    </Text>
                  ) : missing ? (
                    <Text style={styles.modeMins}>—</Text>
                  ) : null}
                </TouchableOpacity>
              );
            })}
          </View>

          {noRoute ? (
            <Text style={styles.noRoute}>
              {noRoute === 'train'
                ? (he ? '🚆 אין מסלול רכבת ליעד הזה' : '🚆 No train route to this destination')
                : (he ? 'אין מסלול במצב שנבחר' : 'No route for the selected mode')}
            </Text>
          ) : null}

          {/* The chain, not just the vehicle. Wake and get-ready come from the
              route working backwards from the arrival time, and they are the
              part she actually acts on — a leave time with no "get up at" is
              a number she has to do arithmetic on at 7am. */}
          {loc?.wakeUpBy ? (
            <View style={styles.legRow}>
              <Text style={styles.legIcon}>⏰</Text>
              <View style={styles.legText}>
                <Text style={styles.legTitle}>{he ? 'לקום' : 'Wake up'}</Text>
                <Text style={styles.legSub}>{he ? 'לפני ההתארגנות' : 'before getting ready'}</Text>
              </View>
              <Text style={styles.legTime}>{loc.wakeUpBy}</Text>
            </View>
          ) : null}
          {loc?.wakeUpBy && loc?.leaveHomeBy ? (
            <View style={styles.legRow}>
              <Text style={styles.legIcon}>🚿</Text>
              <View style={styles.legText}>
                <Text style={styles.legTitle}>{he ? 'להתארגן' : 'Get ready'}</Text>
                <Text style={styles.legSub}>
                  {readyMinutes(loc.wakeUpBy, loc.leaveHomeBy)} {he ? 'דק׳' : 'min'}
                </Text>
              </View>
              <Text style={styles.legTime}>{loc.leaveHomeBy}</Text>
            </View>
          ) : null}
          {loc?.leaveHomeBy ? (
            <View style={[styles.legRow, styles.legRowLeave]}>
              <Text style={styles.legIcon}>🚪</Text>
              <View style={styles.legText}>
                <Text style={styles.legTitle}>{he ? 'לצאת מהבית' : 'Leave home'}</Text>
                <Text style={styles.legSub}>{he ? 'אל תפספסי' : "don't miss it"}</Text>
              </View>
              <Text style={styles.legTime}>{loc.leaveHomeBy}</Text>
            </View>
          ) : null}

          {/* Both ends of every leg. Showing only the departure meant the one
              question the chain exists to answer — "and when am I there?" —
              had to be worked out from a duration printed somewhere else. */}
          {plan?.legs?.map((leg, i) => (
            <View key={`${leg.type}-${leg.departureTime}-${i}`} style={styles.legRow}>
              <Text style={styles.legIcon}>{LEG_ICON[leg.type] ?? '•'}</Text>
              <View style={styles.legText}>
                <Text style={styles.legTitle} numberOfLines={1}>
                  {leg.lineNumber ? `${leg.type === 'walk' ? '' : `${leg.lineNumber} · `}` : ''}
                  {leg.to || leg.stopName || (he ? 'המשך' : 'Continue')}
                </Text>
                {leg.stopName ? <Text style={styles.legSub} numberOfLines={1}>{leg.stopName}</Text> : null}
              </View>
              <Text style={styles.legTime} numberOfLines={1}>
                {leg.arrivalTime && leg.arrivalTime !== leg.departureTime
                  ? `${leg.departureTime}→${leg.arrivalTime}`
                  : leg.departureTime}
              </Text>
            </View>
          ))}

          {/* …and the point of the whole chain: when she is actually there. */}
          {plan?.arriveAt ? (
            <View style={styles.arriveRow}>
              <Text style={styles.legIcon}>🎯</Text>
              <View style={styles.legText}>
                <Text style={styles.arriveTitle}>{he ? 'הגעה' : 'Arrive'}</Text>
                <Text style={styles.legSub}>
                  {plan.totalDurationMinutes} {he ? 'דק׳ מדלת לדלת' : 'min door to door'}
                  {slackNote(plan.arriveAt, task.fixedTime || task.scheduledTime, he)}
                </Text>
              </View>
              <Text style={styles.arriveTime}>{plan.arriveAt}</Text>
            </View>
          ) : null}

          {/* Departures, on the timeline itself. Offered only once the planned
              one has gone — before that "show me the next ones" is a way to
              accidentally replace a perfectly good plan with a later train. */}
          {onShowOptions && departureGone ? (
            <TouchableOpacity
              style={styles.optionsBtn}
              onPress={showOptions}
              activeOpacity={0.85}
              disabled={loadingOptions}
            >
              <Text style={styles.optionsBtnText} numberOfLines={2}>
                {loadingOptions
                  ? (he ? '…מחפשת' : '…checking')
                  : (he ? '🚏 עוד לא יצאתי — היציאות הבאות' : "🚏 Haven't left — next departures")}
              </Text>
            </TouchableOpacity>
          ) : null}

          {(options || loadingOptions) ? (
            <TransitOptionsList
              options={options ?? []}
              language={language}
              loading={loadingOptions}
              onPick={async (p) => {
                await onPickOption?.(task, p);
                setOptions(null);
              }}
            />
          ) : null}

          {onOpenRoute ? (
            <TouchableOpacity style={styles.mapBtn} onPress={() => onOpenRoute(task)}>
              <Text style={styles.mapBtnText} numberOfLines={2}>
                {he ? 'מפה ומסלול מלא ›' : 'Full route and map ›'}
              </Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: BRAND.creamCard, borderWidth: 1, borderColor: BRAND.line,
    borderRadius: RADIUS.chip + 4, overflow: 'hidden', marginBottom: 10,
  },
  wrapNext: { borderColor: BRAND.sunGold, borderWidth: 1.5 },
  wrapMissed: { borderColor: BRAND.danger, borderWidth: 1.5 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 11, paddingVertical: 10 },
  headerMissed: { backgroundColor: BRAND.goldSoft },
  headerTitleMissed: { color: BRAND.danger, textDecorationLine: 'line-through' },
  headerSubMissed: { fontFamily: FONTS.bodyBold, color: BRAND.danger },
  chevronMissed: { color: BRAND.danger },
  missedChip: {
    flexShrink: 0, backgroundColor: BRAND.danger, borderRadius: RADIUS.pill,
    paddingHorizontal: 8, paddingVertical: 3,
  },
  missedChipText: { fontFamily: FONTS.bodyBold, fontSize: 10, color: BRAND.white },
  nextChip: { backgroundColor: BRAND.sunGold, borderRadius: RADIUS.pill, paddingHorizontal: 8, paddingVertical: 3 },
  nextChipText: { fontFamily: FONTS.bodyBold, fontSize: 10, color: BRAND.warmInk },
  headerText: { flex: 1, gap: 1 },
  headerTitle: { fontFamily: FONTS.bodyBold, fontSize: 13, color: BRAND.warmInk },
  headerSub: { fontFamily: FONTS.body, fontSize: 11, color: BRAND.inkFaint },
  chevron: { fontFamily: FONTS.bodyBold, fontSize: 13, color: BRAND.timeChipText },
  body: { borderTopWidth: 1, borderTopColor: BRAND.line, padding: 11, gap: 9 },
  routeEnds: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  endCol: { flex: 1, flexShrink: 1, minWidth: 0, gap: 1 },
  endLabel: {
    fontFamily: FONTS.bodyBold, fontSize: 9.5, letterSpacing: 0.8, color: BRAND.inkFaint,
  },
  endValue: { fontFamily: FONTS.bodySemi, fontSize: 12, color: BRAND.warmInk, lineHeight: 16 },
  endArrow: { flexShrink: 0, fontFamily: FONTS.body, fontSize: 13, color: BRAND.inkFaint, paddingTop: 12 },
  originRow: { flexDirection: 'row', gap: 6 },
  originChip: {
    flex: 1, flexBasis: 0, minWidth: 0, alignItems: 'center', justifyContent: 'center',
    paddingVertical: 7, paddingHorizontal: 8, borderRadius: RADIUS.chip,
    borderWidth: 1, borderColor: BRAND.line, backgroundColor: BRAND.cream,
  },
  originChipOn: { backgroundColor: BRAND.goldSoft, borderColor: BRAND.sunGold },
  originChipText: {
    fontFamily: FONTS.bodySemi, fontSize: 11.5, color: BRAND.inkSoft, textAlign: 'center',
  },
  originChipTextOn: { fontFamily: FONTS.bodyBold, color: BRAND.goldInk },
  modeRow: { flexDirection: 'row', gap: 6 },
  modeChip: {
    flex: 1, alignItems: 'center', paddingVertical: 7, borderRadius: RADIUS.chip,
    borderWidth: 1.5, borderColor: BRAND.line, backgroundColor: BRAND.creamCard,
  },
  modeChipOn: { backgroundColor: BRAND.sunGold, borderColor: BRAND.amber },
  // The fastest one, when it is not already the chosen one. A border, not a
  // fill: the fill means "this is what you picked", and two chips that look
  // chosen is worse than no hint at all.
  modeChipFastest: { borderColor: BRAND.goldInk, backgroundColor: BRAND.goldSoft },
  modeChipBusy: { opacity: 0.5 },
  modeIcon: { fontSize: 15 },
  modeMins: { fontFamily: FONTS.bodyBold, fontSize: 10, color: BRAND.inkSoft, marginTop: 1 },
  modeMinsLate: { color: BRAND.danger },
  // The row that replaces a blank space. Quiet, tappable, and it names the
  // reason rather than just reporting an absence.
  noRouteRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    gap: 10, paddingVertical: 8, paddingHorizontal: 12, marginBottom: 6,
    backgroundColor: BRAND.creamCard, borderWidth: 1, borderColor: BRAND.line,
    borderRadius: RADIUS.chip, borderStyle: 'dashed',
  },
  noRouteText: { flex: 1, fontFamily: FONTS.body, fontSize: 12, color: BRAND.inkSoft, lineHeight: 17 },
  noRouteAction: { fontFamily: FONTS.bodyBold, fontSize: 12, color: BRAND.goldInk },
  noRoute: { fontFamily: FONTS.bodySemi, fontSize: 12, color: BRAND.danger },
  legRow: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  legIcon: { fontSize: 13, width: 18, textAlign: 'center' },
  legText: { flex: 1, flexShrink: 1, minWidth: 0, gap: 1 },
  legTitle: { fontFamily: FONTS.bodySemi, fontSize: 12, color: BRAND.warmInk },
  legSub: { fontFamily: FONTS.body, fontSize: 10.5, color: BRAND.inkFaint },
  // flexShrink: 0 — the clock times are the payload of this row, and a long
  // Hebrew station name was allowed to squeeze them out of it.
  legTime: {
    flexShrink: 0, fontFamily: FONTS.bodyBold, fontSize: 11,
    color: BRAND.timeChipText, textAlign: 'right',
  },
  legRowLeave: {
    backgroundColor: BRAND.goldSoft, borderRadius: RADIUS.chip,
    paddingHorizontal: 8, paddingVertical: 6, marginVertical: 2,
  },
  arriveRow: {
    flexDirection: 'row', alignItems: 'center', gap: 9,
    borderTopWidth: 1, borderTopColor: BRAND.line, paddingTop: 8, marginTop: 2,
  },
  arriveTitle: { fontFamily: FONTS.bodyBold, fontSize: 12, color: BRAND.success },
  arriveTime: { flexShrink: 0, fontFamily: FONTS.bodyBold, fontSize: 12, color: BRAND.success },
  mapBtn: { alignSelf: 'stretch', paddingTop: 4, paddingBottom: 2 },
  mapBtnText: { fontFamily: FONTS.bodySemi, fontSize: 12, color: BRAND.timeChipText },
  optionsBtn: {
    alignSelf: 'stretch', backgroundColor: BRAND.sunGold,
    borderRadius: RADIUS.chip, paddingVertical: 10, paddingHorizontal: 10,
    alignItems: 'center', justifyContent: 'center',
  },
  optionsBtnText: {
    fontFamily: FONTS.bodyBold, fontSize: 12.5, color: BRAND.onGold, textAlign: 'center',
  },
});
