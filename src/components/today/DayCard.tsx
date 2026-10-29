/**
 * DayCard — one event on Today, collapsed (1D) and tapped open (1).
 *
 * Koral's picks, 30.9: a card per event — category, time, title, place — with
 * the leave time in a gold pill on the right, so the plan is visible without a
 * tap (silent-state rule 5). A tap opens it in place: when to leave and how
 * long until then, how she goes and when she lands, the five ways to go, and
 * I left / Done / Move.
 *
 * A card never shows an empty space where a leave time should be: no place, a
 * route not worked out yet, a route that failed — each says so (rule 1), and
 * the open card says why and what fixes it (travelRowState).
 */
import React, { useEffect, useState } from 'react';
import { Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Task, TransitPlan, TransportType } from '../../types/index';
import { BRAND, FONTS, MIN_TOUCH, SHADOWS, surf, nink, nline } from '../../constants/theme';
import { getCategoryMeta } from '../../constants/categories';
import { addMinutes, timeToMinutes } from '../../utils/timeUtils';
import { isRemoteTask } from '../../utils/meetingLink';
import { isFlexibleTask } from '../../utils/taskShape';
import { describeTravelRow, routeFailureOf, travelRowState } from '../../utils/travelRowState';
import { formatSpan } from './NowAddRow';
import { Heartbeat } from './NowLine';
import { headsignText } from '../../utils/transitParse';
import { moovitLinks } from '../../utils/moovitLink';
import OnYourWayCard from '../OnYourWayCard';
import { readingRow } from './readingRow';
import { isStudyTask } from '../../utils/taskShape';
import { RIDE_ICON, ridesOf, journeySteps, routeChips, walkRideWalkLine } from '../../utils/rideLine';
import { StepDir, neighbourLine } from '../../utils/neighbourDeparture';
import TripTimeline from './TripTimeline';
import { useNight } from '../ui/SkyBackdrop';
import { N } from '../../constants/nightTone';

export const MODE_EMOJI: Record<string, string> = { walk: '🚶', bike: '🚴', bus: '🚌', train: '🚆', car: '🚗' };
const MODE_LABEL: Record<string, [string, string]> = {
  walk: ['Walk', 'הליכה'], bike: ['Bike', 'אופניים'], bus: ['Bus', 'אוטובוס'],
  train: ['Train', 'רכבת'], car: ['Car', 'רכב'],
};
const MODES: TransportType[] = ['walk', 'bike', 'bus', 'train', 'car'];

const HEBREW = /[֐-׿]/;
/** Right-to-left mark. Android takes a Text's direction from its first strong
 *  letter and ignores `writingDirection`, so a Hebrew line that happens to open
 *  with a clock time ("10:34 ← 12:07") would be laid out left-to-right and its
 *  arrow would point the wrong way. One RLM up front settles it. */
const RLM = String.fromCharCode(0x200f);

/**
 * ‹ earlier · later › — which way each arrow points, and where each button sits.
 *
 * The arrows point OUTWARD, towards the side of the row where that time lives,
 * like Moovit. English reads left to right: earlier on the left (←), later on
 * the right (→). Hebrew reads right to left, and so does its timeline — the
 * "10:34 ← 12:07" line above the buttons runs leftwards, the same call
 * OverlapPick makes for "X ← 14:30" — so earlier sits on the RIGHT with →, and
 * later on the LEFT with ←.
 *
 * ← and → are drawn as their own Text, never inside the Hebrew label: the
 * bidi algorithm MIRRORS ‹ and › inside a right-to-left run, so the same
 * string showed the arrow of the opposite button. ← and → are not mirrored.
 * Which side each button sits on is `readingRow` (see there for why it is not
 * a plain `he && row-reverse`).
 */
const stepArrow = (dir: StepDir, he: boolean): string => ((dir === 'earlier') === !he ? '←' : '→');

interface Props {
  task: Task;
  he: boolean;
  /** Today's clock, HH:MM — enables "leave now" and "in 1h 23m". */
  now?: string;
  isNext?: boolean;
  /** She lands late here — the ride from the event before does not fit. */
  late?: { lateBy: number; leaveAt: string } | null;
  /** Meira prepared something for this one (meeting brief, prep) — one tap away. */
  brief?: { label: string; onPress: () => void } | null;
  expanded: boolean;
  onToggleExpand: () => void;
  onToggleComplete: () => void;
  onMove: () => void;
  onModeChange: (mode: TransportType) => void;
  onLeft?: () => void;
  onRetryRoute?: () => void;
  onAddPlace?: () => void;
  /** The place could not be found: open "Where is X?" (kinds/place) — 15.10. */
  onWhereIs?: () => void;
  /** Every way there, departures and origins — the Trips screen. */
  onOpenRoute?: () => void;
  /** Minutes by every way of going, from where she is — asked when the card opens. */
  onCompareModes?: () => Promise<{ mode: string; minutes: number }[]>;
  /** Route it from where she actually is, not the chain's guess. */
  onFromHere?: () => void;
  /** What just happened to this card's route ("🧭 checking…", "📍 From Azrieli"). */
  note?: string;
  /** HH:MM — set only on the card that is HAPPENING now: the now line moves
   *  inside it, as a progress bar with the heart (1.10). */
  nowAt?: string;
  /** Save what an on-the-way suggestion picked (place + hour). */
  onPlan?: (patch: Partial<Task>) => void;
  /** Her home, for "study spots near home". */
  home?: { lat?: number; lng?: number };
  /** The backward chain's first step, from utils/alarmPlan (wakeChipFor /
   *  getReadyTimeFor) — the same answer NextUpCard and the alarm use. */
  wake?: { at: string; muted?: boolean } | null;
  getReady?: string;
  /** This task owns the morning's alarm (utils/morningAlarm): a small ⏰ beside
   *  its hour — tap on/off, hold for another hour, same as Today's pill. */
  morningAlarm?: { at: string; on: boolean; onToggle: () => void; onLongPress: () => void } | null;
  /** ‹ earlier · later › — the journey before/after one, like Moovit (13.10). */
  onStepDeparture?: (from: TransitPlan, dir: StepDir) => Promise<{ plan: TransitPlan | null; reason?: string }>;
  /** Take the journey the arrows landed on: route, leave time and alerts. */
  onPickDeparture?: (plan: TransitPlan) => Promise<void> | void;
}

/** "Ibn Gabirol St 120, Tel Aviv-Yafo" → "Ibn Gabirol St 120" — the card has no room for the city. */
function shortPlace(text?: string): string {
  return String(text || '').split(',')[0].trim();
}

export default function DayCard(props: Props) {
  const night = useNight();
  const { task, he, now, isNext, late, expanded, nowAt } = props;
  const start = task.fixedTime || task.scheduledTime || '';
  const end = start ? addMinutes(start, task.durationMinutes || 30) : '';
  const done = task.status === 'complete';
  const loc: any = task.location && typeof task.location === 'object' ? task.location : undefined;
  const place = shortPlace(loc?.displayName || loc?.address || (typeof task.location === 'string' ? task.location : ''));
  const remote = isRemoteTask(task);
  // She tapped a vehicle: it is selected AT ONCE, and the previous route is not
  // drawn while the new one is worked out (18.10: "don't show the previous state").
  const [picked, setPicked] = useState<TransportType | null>(null);
  const [switching, setSwitching] = useState(false);
  const rowStateBase = remote ? 'none' : travelRowState(task);
  const rowState = switching && !remote ? 'pending' : rowStateBase;
  const leave: string | undefined = loc?.leaveHomeBy || loc?.transitPlan?.leaveHomeAt;
  const travel: number | undefined = loc?.transitPlan?.totalDurationMinutes ?? loc?.travelMinutes;
  const mode: string | undefined = picked ?? loc?.transportType;
  // The rides of a timetabled plan, in order — bike / car / walk have none.
  const rides: any[] = ridesOf(task);
  // Which bus, from where, at what time — on the CLOSED card (rule 5). 1.10:
  // "it's not clear which bus to take and from where": the leave pill said
  // when, and the line and the stop were a tap away.
  const showRoute = rowState === 'route' && task.status !== 'complete';
  const route = showRoute ? routeChips(task, he) : { chips: [], from: '' };
  const routeLine: string = showRoute ? walkRideWalkLine(task, he) : '';
  // Public transport opens in Moovit with the place already filled in.
  const transit = rides.length > 0 || mode === 'bus' || mode === 'train';
  const moovit = transit && place && !remote && task.status !== 'complete'
    ? moovitLinks({ lat: loc?.lat, lng: loc?.lng, name: loc?.address || loc?.displayName || place })
    : null;
  const openMoovit = () => {
    if (!moovit) return;
    Linking.openURL(moovit.app).catch((e) => {
      console.warn('[DayCard] Moovit app not opened — trying the web', e);
      Linking.openURL(moovit.web).catch((err) => console.warn('[DayCard] Moovit web not opened', err));
    });
  };
  // A timetable says when the train lands; anything else lands at leave + ride.
  // The bike plan's arriveAt is the TARGET (11:00), not the arrival (10:50).
  // A bus or train trip with no timetable says nothing: leave + minutes is not
  // when a train arrives (4.10 — "Arrive 14:57", 33 min early, for a train that
  // reaches Ra'anana South at 15:16). Today re-routes such a trip on view.
  const arrive: string | undefined = transit
    ? (rides.length ? loc?.transitPlan?.arriveAt : undefined)
    : (leave && travel ? addMinutes(leave, travel) : loc?.transitPlan?.arriveAt);
  const untilLeave = now && leave ? timeToMinutes(leave) - timeToMinutes(now) : undefined;
  const leaveNow = Boolean(isNext && untilLeave !== undefined && untilLeave <= 1 && !done);
  // Over already (today only — `now` is passed for today alone): asking where
  // it was is a question that no longer fits the thing (rule 6).
  const over = Boolean(now && end && timeToMinutes(end) <= timeToMinutes(now));
  // The card in progress: how far through it she is.
  const span = start && end ? timeToMinutes(end) - timeToMinutes(start) : 0;
  const gone = nowAt && start ? timeToMinutes(nowAt) - timeToMinutes(start) : 0;
  const pct = span > 0 ? Math.max(0, Math.min(100, Math.round((gone / span) * 100))) : 0;
  const left = Math.max(0, span - gone);
  const showNow = Boolean(nowAt && span > 0 && !done);
  const icon = getCategoryMeta(task.category).icon;

  // ‹ earlier · later ›: the journey she is LOOKING at, which is not saved
  // until she takes it. Resets when the stored plan changes.
  const stored: TransitPlan | undefined = loc?.transitPlan;
  const [peek, setPeek] = useState<TransitPlan | null>(null);
  const [stepping, setStepping] = useState<StepDir | null>(null);
  const [stepNote, setStepNote] = useState<string>('');
  useEffect(() => { setPeek(null); setStepNote(''); }, [stored?.leaveHomeAt, stored?.arriveAt]);
  const canStep = expanded && rides.length > 0 && Boolean(stored) && !done && Boolean(props.onStepDeparture);
  const step = (dir: StepDir) => {
    const from = peek ?? stored;
    if (!from || stepping || !props.onStepDeparture) return;
    setStepping(dir);
    setStepNote('');
    props.onStepDeparture(from, dir)
      .then(({ plan, reason }) => {
        if (plan) { setPeek(plan); return; }
        setStepNote(reason === 'none'
          ? (dir === 'later' ? (he ? 'אין נסיעה מאוחרת יותר היום' : 'No later one today') : (he ? 'אין נסיעה מוקדמת יותר' : 'No earlier one'))
          : (he ? 'לא הצלחתי לבדוק עכשיו — נסי שוב' : "Couldn't check right now — try again"));
      })
      .catch((e) => { console.warn('[DayCard] step departure failed', e); setStepNote(he ? 'לא הצלחתי לבדוק עכשיו — נסי שוב' : "Couldn't check right now — try again"); })
      .finally(() => setStepping(null));
  };
  const shown = peek ?? stored;

  // "By car, by bus, by train, on foot — all at once": asked once, when she opens it.
  const [quotes, setQuotes] = useState<Record<string, number> | null>(null);
  const canCompare = expanded && Boolean(place) && !remote && !done && Boolean(props.onCompareModes);
  useEffect(() => {
    if (!canCompare || quotes) return undefined;
    let alive = true;
    props.onCompareModes!()
      .then((list) => { if (alive) setQuotes(Object.fromEntries(list.map((q) => [q.mode, q.minutes]))); })
      .catch((e) => console.warn('[DayCard] modes not compared', task.id, e));
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canCompare]);

  // ── The pill on the right: the plan, or the honest reason there is none. ──
  let pill: React.ReactNode = null;
  if (late) {
    pill = (
      <View style={[styles.lv, styles.lvLate]}>
        <Text style={[styles.lvSmall, styles.lateInk]}>{he ? '🚪 יציאה' : '🚪 leave'}</Text>
        <Text style={[styles.lvBig, styles.lateInk]}>{late.leaveAt}</Text>
        <Text style={[styles.lvSmall, styles.lateInk]}>{he ? `${late.lateBy} דק׳ איחור` : `${late.lateBy} late`}</Text>
      </View>
    );
  } else if (rowState === 'route' && leave) {
    pill = (
      <View style={[styles.lv, done && styles.lvDone, done && night && N.chip]}>
        {/* "צאי 15:19" — her words for the moment to walk out (v3, 27.10). */}
        <Text style={[styles.lvSmall, done && styles.lvDoneInk, done && night && N.inkSoft]}>{he ? 'צאי' : 'leave'}</Text>
        <Text style={[styles.lvBig, done && styles.lvDoneInk, done && night && N.inkSoft]}>{leaveNow ? (he ? 'עכשיו' : 'now') : leave}</Text>
        {/* 28.10 (Koral): only the leave time is marked; the train's exact minute
            is bold in the route line beside it, not on the yellow. */}
      </View>
    );
  } else if (remote) {
    pill = <View style={[styles.soft, night && N.chip]}><Text style={[styles.softText, night && N.goldInk]}>{he ? '💻 אונליין' : '💻 online'}</Text></View>;
  } else if (rowState === 'pending' || rowState === 'unroutable') {
    pill = (
      <View style={[styles.soft, night && N.chip]}>
        <Text style={[styles.softText, night && N.goldInk]}>{rowState === 'pending' ? (he ? '🧭 מחשבת…' : '🧭 routing…') : (he ? '🚫 אין מסלול' : '🚫 no route')}</Text>
      </View>
    );
  } else if (rowState === 'none' && props.onAddPlace && !done && !over && !isFlexibleTask(task)) {
    pill = (
      <TouchableOpacity style={styles.addPlace} onPress={props.onAddPlace} accessibilityRole="button"
        accessibilityLabel={he ? 'להוסיף מקום' : 'Add the place'}>
        <Text style={styles.addPlaceIcon}>📍</Text>
        <Text style={[styles.addPlaceText, night && N.goldInk]}>{he ? 'להוסיף מקום' : 'add place'}</Text>
      </TouchableOpacity>
    );
  }

  // Wake / get ready: the alarm's own answer first, else the route's get-ready.
  const readyAt = !done && leave ? (props.wake?.at || props.getReady) : undefined;
  const readyIsWake = Boolean(props.wake && loc?.wakeUpBy && props.wake.at === loc.wakeUpBy);
  const readyMinutesLeft = readyAt && leave ? timeToMinutes(leave) - timeToMinutes(readyAt) : 0;

  const why = (rowState === 'pending' || rowState === 'unroutable')
    ? describeTravelRow(rowState, he, routeFailureOf(task)) : null;
  const earlyBy = arrive && start ? timeToMinutes(start) - timeToMinutes(arrive) : undefined;

  return (
    <View style={[styles.card, night && N.card, (isNext || nowAt) && styles.next, done && styles.done]}>
      <TouchableOpacity activeOpacity={0.85} onPress={props.onToggleExpand} onLongPress={props.onMove}
        accessibilityRole="button" accessibilityState={{ expanded }}>
        <View>
        {nowAt && !done ? <Text style={[styles.eyebrow, night && N.goldInk]}>{he ? 'עכשיו' : 'NOW'}</Text>
          : isNext && !done ? <Text style={[styles.eyebrow, night && N.goldInk]}>{he ? 'הבא בתור' : 'NEXT UP'}</Text> : null}
        <View style={styles.head}>
          {/* Did it or not — on the card itself, never behind the tap (Koral, 1.10). */}
          <TouchableOpacity style={[styles.check, done && styles.checkOn]} onPress={props.onToggleComplete}
            hitSlop={{ top: 14, bottom: 14, left: 14, right: 6 }} accessibilityRole="checkbox"
            accessibilityState={{ checked: done }} accessibilityLabel={he ? 'בוצע' : 'Done'}>
            {done ? <Text style={styles.checkMark}>✓</Text> : null}
          </TouchableOpacity>
          <View style={[styles.icon, night && N.chip]}><Text style={styles.iconText}>{icon}</Text></View>
          <View style={styles.body}>
            {props.morningAlarm ? (
              <View style={[styles.whenRow, { flexDirection: readingRow(he) }]}>
                <Text style={[styles.when, night && N.goldInk]}>{end ? `${start}–${end}` : start}</Text>
                <TouchableOpacity onPress={props.morningAlarm.onToggle} onLongPress={props.morningAlarm.onLongPress}
                  delayLongPress={350} hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
                  style={[styles.alarmTag, !props.morningAlarm.on && styles.alarmTagOff]}
                  accessibilityRole="switch" accessibilityState={{ checked: props.morningAlarm.on }}
                  accessibilityLabel={`${he ? 'שעון מעורר' : 'Alarm'} ${props.morningAlarm.at}`}>
                  <Text style={[styles.alarmTagText, !props.morningAlarm.on && styles.alarmTagTextOff]}>
                    {`${props.morningAlarm.on ? '⏰' : '🔕'} ${props.morningAlarm.at}`}
                  </Text>
                </TouchableOpacity>
              </View>
            ) : (
              <Text style={[styles.when, night && N.goldInk]}>{end ? `${start}–${end}` : start}</Text>
            )}
            <Text style={[styles.title, night && N.ink, done && styles.strike, done && night && N.inkSoft, HEBREW.test(task.text) && styles.rtl]} numberOfLines={2}>
              {task.text}
            </Text>
            {place ? <Text style={[styles.place, night && N.inkSoft]} numberOfLines={1}>{place}</Text> : null}
            {/* Every step whole, wrapping onto the next line when the card is
                narrow — the bus NUMBER first. One cut sentence lost the second
                bus's number and the stop (18.10: "missed the bus line!"). */}
            {route.chips.length ? (
              <View accessible accessibilityLabel={routeLine} style={[styles.chips, { flexDirection: readingRow(he) }]}>
                {route.chips.map((c, i) => (
                  <React.Fragment key={`${c.kind}-${i}`}>
                    {i > 0 ? <Text style={[styles.chipArrow, night && N.goldInk]}>{he ? '←' : '→'}</Text> : null}
                    {c.kind === 'walk' ? (
                      <Text style={[styles.walkChip, night && N.inkSoft]}>{`${c.icon} ${c.text}`}</Text>
                    ) : (
                      <View style={[styles.rideChip, { flexDirection: readingRow(he) }]}>
                        <Text style={styles.rideChipIcon}>{c.icon}</Text>
                        {c.line ? <Text style={styles.lineBadge}>{c.line}</Text> : null}
                        {c.time ? <Text style={[styles.rideChipTime, night && N.ink]}>{c.time}</Text> : null}
                      </View>
                    )}
                  </React.Fragment>
                ))}
              </View>
            ) : null}
            {route.from ? <Text style={[styles.routeFrom, night && N.inkSoft]} numberOfLines={1}>{(he ? RLM : '') + route.from}</Text> : null}
            {readyAt && rowState === 'route' && !over ? (
              <Text style={[styles.routeLine, night && N.goldInk]} numberOfLines={1}>
                {`${he ? RLM : ''}${props.wake?.muted ? '🔕' : '⏰'} ${readyAt}`}
              </Text>
            ) : null}
          </View>
          {nowAt && !late && rowState === 'route' ? null : pill}
        </View>
        {/* The now, in a row of its own under the words — never across them
            (2.10: "the line with the heart runs over the task's text"). The
            time and the heart walk along the line as the hour goes: 22:05 in
            a 22:00–23:00 call is at the start; solid gold behind them has
            gone, faint ahead is left (1.10: "the time on the left by the
            heart, and you see the pace"). */}
        {showNow ? (
          <View style={styles.nowTrack} accessible
            accessibilityLabel={he ? `עכשיו ${nowAt}, נשארו ${formatSpan(left, true)}` : `Now ${nowAt}, ${formatSpan(left, false)} left`}>
            <View style={[styles.nowGone, { flex: pct }]} />
            <View style={styles.nowPill}><Text style={styles.nowPillText}>{nowAt}</Text></View>
            <Heartbeat size={22} />
            <View style={[styles.nowAhead, { flex: 100 - pct }]} />
            <Text style={[styles.leftText, night && N.goldInk]}>{he ? `עוד ${formatSpan(left, true)}` : `${formatSpan(left, false)} left`}</Text>
          </View>
        ) : null}
        </View>
      </TouchableOpacity>
      {props.note ? <Text style={[styles.note, night && N.inkSoft]}>{props.note}</Text> : null}
      {props.brief && !done ? (
        <TouchableOpacity onPress={props.brief.onPress} style={styles.brief} accessibilityRole="button">
          <Text style={[styles.briefText, night && N.goldInk]} numberOfLines={2}>{props.brief.label}</Text>
        </TouchableOpacity>
      ) : null}

      {expanded ? (
        <View style={styles.open}>
          {rowState === 'route' && leave ? (
            <>
              {/* The chain backwards from the arrival, in the order she lives
                  it: wake / get ready, THEN leave (8.10, Koral: "the alarm's
                  reasoning disappeared — it says Leave straight away, where is
                  wake up, get ready?"). The Today redesign of 1.10 kept only
                  the door; TimelineTravelLeg had both. */}
              {/* 28.10, her pick B — shared with the task page (TripTimeline). */}
              <TripTimeline task={task} he={he} now={now} readyAt={readyAt} wakeMuted={props.wake?.muted} mode={mode} night={night} />
            </>
          ) : null}

          {canStep && shown ? (
            <View style={[styles.stepper, night && N.goldSoft]}>
              {/* The journey she is looking at gets a row of its own: squeezed
                  between the two buttons it was cut to "10:34 → 12:…", and the
                  minutes early / late — the point of the line — went first. */}
              <Text style={[styles.stepperLine, night && N.ink, (shown.arriveAt > (task.fixedTime || '99:99')) && styles.lateInk]}>
                {(he ? RLM : '') + neighbourLine(shown, task.fixedTime || task.scheduledTime, he)}
              </Text>
              <View style={[styles.stepperRow, { flexDirection: readingRow(he) }]}>
                {(['earlier', 'later'] as StepDir[]).map((dir) => {
                  const arrow = <Text style={[styles.stepArrow, night && N.goldInk]}>{stepArrow(dir, he)}</Text>;
                  const word = dir === 'earlier' ? (he ? 'מוקדם' : 'Earlier') : (he ? 'מאוחר' : 'Later');
                  return (
                    <TouchableOpacity key={dir} style={[styles.stepBtn, { flexDirection: readingRow(he) }]}
                      onPress={() => step(dir)} accessibilityRole="button"
                      accessibilityLabel={dir === 'earlier'
                        ? (he ? 'נסיעה מוקדמת יותר' : 'Earlier departure')
                        : (he ? 'נסיעה מאוחרת יותר' : 'Later departure')}>
                      {dir === 'earlier' ? arrow : null}
                      <Text style={[styles.stepBtnText, night && N.ink]}>{stepping === dir ? '…' : word}</Text>
                      {dir === 'later' ? arrow : null}
                    </TouchableOpacity>
                  );
                })}
              </View>
              {peek && props.onPickDeparture ? (
                <View style={styles.stepperRow}>
                  <Text style={[styles.stepperHint, night && N.inkSoft, styles.stepperHintFlex]}>{he ? `יציאה ${peek.leaveHomeAt} · עוד לא נשמר` : `Leave ${peek.leaveHomeAt} · not saved yet`}</Text>
                  <TouchableOpacity style={[styles.btn, styles.btnGold, styles.btnTake]} accessibilityRole="button"
                    onPress={() => { Promise.resolve(props.onPickDeparture!(peek)).catch((e) => console.warn('[DayCard] pick failed', e)); }}>
                    <Text style={styles.btnGoldText}>{he ? 'לבחור את זו' : 'Take this one'}</Text>
                  </TouchableOpacity>
                </View>
              ) : null}
              {stepNote ? <Text style={[styles.stepperHint, night && N.inkSoft]}>{stepNote}</Text> : null}
            </View>
          ) : null}

          {why ? (
            <View style={styles.why}>
              <Text style={[styles.whyText, night && N.inkSoft]}>{why.text}</Text>
              {why.action && props.onRetryRoute ? (
                <TouchableOpacity onPress={props.onRetryRoute} accessibilityRole="button" style={styles.whyBtn}>
                  <Text style={[styles.whyBtnText, night && N.goldInk]}>{why.action}</Text>
                </TouchableOpacity>
              ) : null}
              {/* Google could not place it: Meira's suggestions, one tap away. */}
              {routeFailureOf(task)?.kind === 'not_found' && props.onWhereIs && !done ? (
                <TouchableOpacity onPress={props.onWhereIs} accessibilityRole="button" style={styles.whyBtn}>
                  <Text style={[styles.whyBtnText, night && N.goldInk]}>{he ? '📍 איפה זה? הצעות ›' : '📍 Where is it? Suggestions ›'}</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          ) : null}

          {/* A to-do with no place: places ON her planned routes, open when she
              passes (server/errands_along.py) — "on the way", on Today itself. */}
          {!place && !remote && !done && props.onPlan && !isStudyTask(task) ? (
            <OnYourWayCard task={task} he={he} onPlan={props.onPlan} />
          ) : null}
          {/* Study is at home — or a study spot near it (Koral, 1.10). */}
          {!place && !done && isStudyTask(task) && props.home?.lat && props.home?.lng ? (
            <TouchableOpacity style={styles.moovit} accessibilityRole="link"
              onPress={() => Linking.openURL(`geo:${props.home!.lat},${props.home!.lng}?q=${encodeURIComponent(he ? 'מרחב למידה' : 'study space')}`)
                .catch((e) => console.warn('[DayCard] maps not opened', e))}>
              <Text style={styles.moovitText}>{he ? '🏠 בבית · 📍 מקומות ללמוד ליד הבית ›' : '🏠 At home · 📍 study spots nearby ›'}</Text>
            </TouchableOpacity>
          ) : null}
          {/* The same trip in Moovit, destination already in — live
              arrivals and platforms live there (Koral, 1.10). */}
          {moovit ? (
            <TouchableOpacity style={styles.moovit} onPress={openMoovit} accessibilityRole="link"
              accessibilityLabel={he ? 'לפתוח את הנסיעה במוביט' : 'Open this trip in Moovit'}>
              <Text style={styles.moovitText}>{he ? '🟠 לפתוח במוביט ›' : '🟠 Open in Moovit ›'}</Text>
            </TouchableOpacity>
          ) : null}
          {place && !remote && !done ? (
            <View style={styles.modes}>
              {MODES.map((m) => (
                <TouchableOpacity key={m} style={[styles.mode, m === mode && styles.modeOn]}
                  onPress={() => {
                    if (switching || m === mode) return;
                    setPicked(m);
                    setSwitching(true);
                    Promise.resolve(props.onModeChange(m))
                      .catch((e) => console.warn('[DayCard] mode change failed', e))
                      .finally(() => { setSwitching(false); setPicked(null); });
                  }} accessibilityRole="button"
                  accessibilityState={{ selected: m === mode }}
                  accessibilityLabel={(MODE_LABEL[m] || [m, m])[he ? 1 : 0]}>
                  <Text style={styles.modeText}>{MODE_EMOJI[m]}</Text>
                  {quotes && quotes[m] ? (
                    <Text style={[styles.modeMin, night && N.inkSoft, m === mode && styles.modeMinOn]}>{quotes[m]}′</Text>
                  ) : null}
                </TouchableOpacity>
              ))}
            </View>
          ) : null}
          {props.onFromHere && place && !remote && !done ? (
            <TouchableOpacity onPress={props.onFromHere} style={styles.routeLink} accessibilityRole="button">
              <Text style={[styles.routeLinkText, night && N.goldInk]}>{he ? '📍 מהמקום שבו אני עכשיו' : '📍 From where I am now'}</Text>
            </TouchableOpacity>
          ) : null}

          {props.onOpenRoute && rowState === 'route' && !done ? (
            <TouchableOpacity onPress={props.onOpenRoute} style={styles.routeLink} accessibilityRole="link">
              <Text style={[styles.routeLinkText, night && N.goldInk]}>{he ? '🧭 כל הדרכים להגיע ›' : '🧭 See the way there ›'}</Text>
            </TouchableOpacity>
          ) : null}

          <View style={styles.actions}>
            {props.onLeft && rowState === 'route' && !done && !(task as any).lastDepartureDetectedAt ? (
              <TouchableOpacity style={[styles.btn, styles.btnGold]} onPress={props.onLeft} accessibilityRole="button">
                <Text style={styles.btnGoldText}>{he ? '🚪 יצאתי' : '🚪 I left'}</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity style={[styles.btn, styles.btnSoft, night && N.chip]} onPress={props.onToggleComplete} accessibilityRole="button">
              <Text style={[styles.btnSoftText, night && N.ink]}>{done ? (he ? '↺ לא בוצע' : '↺ Undo') : (he ? '✓ בוצע' : '✓ Done')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.btn, styles.btnSoft, night && N.chip]} onPress={props.onMove} accessibilityRole="button">
              <Text style={[styles.btnSoftText, night && N.ink]}>{he ? 'להזיז' : 'Move'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: BRAND.creamCard, borderRadius: 20, padding: 12, ...SHADOWS.card },
  next: { borderWidth: 1.5, borderColor: BRAND.sunGold },
  nowTrack: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 },
  nowGone: { height: 3, borderRadius: 2, backgroundColor: BRAND.sunGold },
  nowAhead: { height: 2, borderRadius: 1, backgroundColor: 'rgba(233,174,60,0.28)' },
  nowPill: { backgroundColor: BRAND.sunGold, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  nowPillText: { fontFamily: FONTS.bodyHeavy, fontSize: 12, color: BRAND.onGold, fontVariant: ['tabular-nums'] },
  leftText: { fontFamily: FONTS.bodyHeavy, fontSize: 12, color: BRAND.goldInk },
  // Done is quiet, not see-through: opacity on the whole card dimmed the green tick
  // (the one thing that says it is finished) along with the text. Only the title
  // fades (strike), the flat card drops its shadow, the leave pill goes pale.
  done: { shadowOpacity: 0, elevation: 0 },
  eyebrow: { fontFamily: FONTS.bodyHeavy, fontSize: 11, letterSpacing: 1.2, color: BRAND.goldInk, marginBottom: 8 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  check: { width: 26, height: 26, borderRadius: 13, borderWidth: 2, borderColor: BRAND.goldInk, alignItems: 'center', justifyContent: 'center' },
  checkOn: { backgroundColor: BRAND.success, borderColor: BRAND.success },
  checkMark: { color: '#FFFFFF', fontSize: 14, fontFamily: FONTS.bodyHeavy, lineHeight: 16 },
  icon: { width: 44, height: 44, borderRadius: 22, backgroundColor: BRAND.timeChipBg, alignItems: 'center', justifyContent: 'center' },
  iconText: { fontSize: 20, color: BRAND.success },
  body: { flex: 1, minWidth: 0 },
  when: { fontFamily: FONTS.bodyHeavy, fontSize: 12, color: BRAND.goldInk, fontVariant: ['tabular-nums'] },
  whenRow: { alignItems: 'center', gap: 8 },
  alarmTag: { backgroundColor: BRAND.sunGold, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  alarmTagOff: { backgroundColor: 'transparent', borderWidth: 1, borderColor: BRAND.honey },
  alarmTagText: { fontFamily: FONTS.bodyHeavy, fontSize: 12, color: BRAND.onGold, fontVariant: ['tabular-nums'] },
  alarmTagTextOff: { color: BRAND.goldInk },
  title: { fontFamily: FONTS.displaySemi, fontSize: 17, lineHeight: 21, color: BRAND.warmInk },
  rtl: { writingDirection: 'rtl' },
  strike: { textDecorationLine: 'line-through', color: BRAND.inkFaint },
  moovit: { alignSelf: 'flex-start', marginTop: 10, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999, backgroundColor: surf('#FFF1E0'), borderWidth: 1, borderColor: '#FF9F1C' },
  moovitText: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: nink('#B25E00') },
  routeLine: { marginTop: 3, fontFamily: FONTS.bodyHeavy, fontSize: 12, color: BRAND.goldInk },
  // The closed card's route: steps that wrap, so none is ever cut.
  chips: { flexWrap: 'wrap', alignItems: 'center', columnGap: 5, rowGap: 4, marginTop: 5 },
  chipArrow: { fontFamily: FONTS.bodyHeavy, fontSize: 12, color: BRAND.goldInk },
  walkChip: { fontFamily: FONTS.bodySemi, fontSize: 11, color: BRAND.inkSoft },
  // No fill (28.10): the exact departure is bold, the yellow belongs to "צאי" alone.
  rideChip: { alignItems: 'center', gap: 5, paddingVertical: 2 },
  rideChipIcon: { fontSize: 13 },
  rideChipTime: { fontFamily: FONTS.bodyHeavy, fontSize: 16, color: BRAND.warmInk, fontVariant: ['tabular-nums'] },
  // The bus number, like the sign on the bus: dark, bold, never shortened.
  lineBadge: {
    minWidth: 28, textAlign: 'center', overflow: 'hidden', borderRadius: 8, paddingVertical: 1, paddingHorizontal: 6,
    backgroundColor: BRAND.warmInk, color: BRAND.creamCard, fontFamily: FONTS.bodyHeavy, fontSize: 13,
    fontVariant: ['tabular-nums'],
  },
  routeFrom: { marginTop: 3, fontFamily: FONTS.bodyBold, fontSize: 12, color: BRAND.inkSoft },
  place: { marginTop: 2, fontFamily: FONTS.bodyBold, fontSize: 12, color: BRAND.inkFaint },
  hero: { gap: 12, padding: 14, borderRadius: 20, backgroundColor: BRAND.sunGold, marginBottom: 8 },
  heroHalf: { flex: 1, minWidth: 0, gap: 2 },
  heroSplit: { borderLeftWidth: 1, borderRightWidth: 1, borderColor: 'rgba(74,53,18,0.18)', paddingHorizontal: 10 },
  heroCap: { fontFamily: FONTS.bodyHeavy, fontSize: 12, color: BRAND.onGold },
  heroBig: { fontFamily: FONTS.bodyHeavy, fontSize: 38, lineHeight: 42, color: BRAND.onGold, fontVariant: ['tabular-nums'] },
  heroMid: { fontFamily: FONTS.bodyHeavy, fontSize: 26, lineHeight: 30, color: BRAND.onGold, fontVariant: ['tabular-nums'] },
  heroSub: { fontFamily: FONTS.bodySemi, fontSize: 12, color: BRAND.onGold },
  lv: { minWidth: 64, alignItems: 'center', gap: 2, paddingVertical: 6, paddingHorizontal: 8, borderRadius: 14, backgroundColor: BRAND.sunGold },
  lvLate: { backgroundColor: surf('#F8ECE9') },
  lvDone: { backgroundColor: BRAND.timeChipBg },
  lvDoneInk: { color: BRAND.inkSoft },
  lvSmall: { fontFamily: FONTS.bodyHeavy, fontSize: 11, color: BRAND.onGold },
  lvBig: { fontFamily: FONTS.bodyHeavy, fontSize: 15, color: BRAND.onGold, fontVariant: ['tabular-nums'] },
  lvRide: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.onGold, fontVariant: ['tabular-nums'] },
  lateInk: { color: BRAND.lateInk },
  soft: { borderRadius: 12, paddingVertical: 6, paddingHorizontal: 9, backgroundColor: BRAND.timeChipBg },
  softText: { fontFamily: FONTS.bodyHeavy, fontSize: 12, color: BRAND.goldInk },
  addPlace: {
    minWidth: 64, minHeight: 58, borderRadius: 14, borderWidth: 1.5, borderStyle: 'dashed', borderColor: BRAND.goldInk,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6,
  },
  addPlaceIcon: { fontSize: 16 },
  addPlaceText: { fontFamily: FONTS.bodyHeavy, fontSize: 12, color: BRAND.goldInk },
  brief: { minHeight: MIN_TOUCH, justifyContent: 'center', marginTop: 4, marginLeft: 56 },
  briefText: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.goldInk },
  open: { marginTop: 12, borderTopWidth: 1, borderTopColor: BRAND.line },
  step: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: MIN_TOUCH, borderBottomWidth: 1, borderBottomColor: BRAND.line },
  stepLast: { borderBottomWidth: 0 },
  ride: { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: BRAND.line, gap: 2 },
  rideRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  rideText: { flex: 1, fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.warmInk },
  rideTime: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.goldInk },
  rideSub: { marginLeft: 34, fontFamily: FONTS.bodyBold, fontSize: 12, color: BRAND.inkSoft },
  rideNote: { marginTop: 6, fontFamily: FONTS.bodyBold, fontSize: 11, color: BRAND.inkFaint },
  // minWidth, not width: the wake step draws two emoji (alarm + shower) and a fixed 24 clipped the second.
  stepIcon: { minWidth: 24, textAlign: 'center', fontSize: 17 },
  stepText: { flex: 1, fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.warmInk },
  stepSoft: { flex: 1, fontFamily: FONTS.bodyBold, fontSize: 14, color: BRAND.inkSoft },
  chip: {
    fontFamily: FONTS.bodyHeavy, fontSize: 12, color: BRAND.goldInk, backgroundColor: BRAND.timeChipBg,
    borderRadius: 12, paddingVertical: 5, paddingHorizontal: 9, overflow: 'hidden',
  },
  early: { fontFamily: FONTS.bodyHeavy, fontSize: 12, color: BRAND.success },
  why: { paddingVertical: 10, gap: 8 },
  whyText: { fontFamily: FONTS.bodyBold, fontSize: 13, lineHeight: 18, color: BRAND.inkSoft },
  whyBtn: { alignSelf: 'flex-start', minHeight: MIN_TOUCH, justifyContent: 'center' },
  whyBtnText: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.goldInk },
  modes: { flexDirection: 'row', gap: 6, marginTop: 8 },
  mode: {
    flex: 1, minHeight: MIN_TOUCH, borderRadius: 10, borderWidth: 1, borderColor: BRAND.line, backgroundColor: BRAND.cream,
    alignItems: 'center', justifyContent: 'center', paddingVertical: 2,
  },
  modeOn: { backgroundColor: BRAND.warmInk, borderColor: BRAND.warmInk },
  modeText: { fontSize: 18 },
  modeMin: { fontFamily: FONTS.bodyHeavy, fontSize: 11, color: BRAND.inkSoft, marginTop: -2 },
  modeMinOn: { color: BRAND.creamCard },
  note: { marginTop: 6, marginLeft: 56, fontFamily: FONTS.bodyBold, fontSize: 12, color: BRAND.inkSoft },
  routeLink: { minHeight: MIN_TOUCH, justifyContent: 'center', marginTop: 4 },
  stepper: { marginTop: 10, padding: 10, borderRadius: 14, backgroundColor: BRAND.goldSoft, gap: 8 },
  stepperRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  // Two equal halves (flex 1), each a full MIN_TOUCH tall: a 40 dp pill the size of its
  // word was easy to miss with a thumb. creamCard + a goldInk edge so the fill still
  // reads as a button on the goldSoft tray.
  stepBtn: {
    flex: 1, minHeight: MIN_TOUCH, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1.5, borderColor: BRAND.goldInk,
    backgroundColor: BRAND.creamCard, alignItems: 'center', justifyContent: 'center', gap: 6,
  },
  stepBtnText: { fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.warmInk },
  stepArrow: { fontFamily: FONTS.bodyHeavy, fontSize: 16, color: BRAND.goldInk },
  stepperLine: { textAlign: 'center', fontFamily: FONTS.bodyHeavy, fontSize: 14, lineHeight: 20, color: BRAND.warmInk },
  stepperHint: { fontFamily: FONTS.bodySemi, fontSize: 12, lineHeight: 17, color: BRAND.inkSoft },
  // In a row with "Take this one" the hint is what gives way; alone in a column it must not stretch.
  stepperHintFlex: { flex: 1 },
  routeLinkText: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.goldInk },
  actions: { flexDirection: 'row', gap: 8, marginTop: 12 },
  btn: { flex: 1, minHeight: 46, borderRadius: 14, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  btnGold: { backgroundColor: BRAND.sunGold },
  // "Take this one" sits beside its hint: it takes the room its label needs, no more.
  btnTake: { flex: 0, paddingHorizontal: 16 },
  btnGoldText: { fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.onGold },
  btnSoft: { backgroundColor: BRAND.creamCard, borderWidth: 1.5, borderColor: nline('#E6D9BC') },
  btnSoftText: { fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.warmInk },
});
