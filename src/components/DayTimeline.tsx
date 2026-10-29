/**
 * DayTimeline — hour-by-hour view of one day's scheduled tasks, and of the
 * time BETWEEN them.
 *
 * The gap rows used to come from a local loop that only looked at the space
 * between two consecutive tasks, and skipped the two places free time actually
 * accumulates: before the first task ("nothing before first task" was a
 * comment in the code) and after the last one. They were also blind to travel
 * — an hour before a meeting you must leave for in ten minutes was drawn as an
 * hour free. findDayGaps answers all three, and each window carries Lumi's
 * ideas for filling it (GapSlotRow).
 *
 * Blocks are PROPORTIONAL (utils/timelineLayout): a nine-hour conference is a
 * nine-hour shape, overlapping tasks sit side by side like a calendar rather
 * than stacking into a lie, and the moment is drawn where it actually falls.
 * The journey between two blocks is inline (TimelineTravelLeg) instead of
 * living only on Today, and everything with no hour yet is one reach away in
 * the drawer instead of buried under the day.
 *
 * Dependencies: timelineLayout, findGaps, routines, GapSlotRow, timelineNow,
 * TimelineTravelLeg, TaskPoolDrawer, timeUtils, categories, theme.
 * Consumed by screens/TodaySchedule.
 */
import React, { useEffect, useMemo, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated, Easing } from 'react-native';
import { Task, AppLanguage } from '../types';
import { BRAND, FONTS, RADIUS, SHADOWS } from '../constants/theme';
import { getCategoryMeta } from '../constants/categories';
import { formatDuration, timeToMinutes, addMinutes, getTodayString } from '../utils/timeUtils';
import { locationTextOf } from '../utils/dayPlanning';
import { travelRowState } from '../utils/travelRowState';
import { DayGap, findDayGaps } from '../utils/findGaps';
import { nowInBlock, describeRemaining } from '../utils/timelineNow';
import { Routine, constrainGaps } from '../utils/routines';
import { layoutDay, TimelineBlock, BLOCK_GAP_PX } from '../utils/timelineLayout';
import { buildTimelineRows } from '../utils/timelineRows';
import { classifyOverlap, OverlapVerdict } from '../utils/overlapKind';
import { yieldToFixed, describeYield, YieldPlan } from '../utils/yieldToFixed';
import TimelineTravelLeg, { ModeQuote } from './TimelineTravelLeg';
import TaskPoolDrawer from './TaskPoolDrawer';
import { TransportType, TransitPlan } from '../types';
import { DepartureOption } from '../utils/departureOptions';
import { GapIdea } from '../services/GapFillService';
import GapSlotRow from './GapSlotRow';
import TaskCheckbox from './TaskCheckbox';

const GUTTER = 48;


interface DayTimelineProps {
  tasks: Task[];
  language: AppLanguage;
  onTaskTap: (task: Task) => void;
  /**
   * Long press opens the full editor. Tapping a block is for looking at the
   * day; holding one is for changing it — without this the timeline could
   * only ever hand a task to whatever `onTaskTap` did, so there was no route
   * from the schedule into the task's own fields.
   */
  onTaskHold?: (task: Task) => void;
  onAddAtTime: (hhmm: string) => void;
  /** Lumi's ideas for one window. Omit and the slot only offers "add your own". */
  onRequestIdeas?: (gap: DayGap) => Promise<GapIdea[]>;
  /** Accept an idea into its window. */
  onPickIdea?: (idea: GapIdea, gap: DayGap) => void | Promise<void>;
  /** Clock HH:MM — nothing before it is free. Pass only when showing TODAY. */
  now?: string;
  /** Bounds of the usable day (wake / wind-down). */
  dayStart?: string;
  dayEnd?: string;
  /** Standing obligations — their hours are cut out of the free windows. */
  routines?: Routine[];
  /** The day being drawn (for the weekday a routine applies to). */
  date?: string;
  /** Change the vehicle for one task's journey and re-plan it. */
  onModeChange?: (task: Task, mode: TransportType) => void | Promise<void>;
  /** Open the full route/map for a journey. */
  onOpenRoute?: (task: Task) => void;
  /** The next few departures for a trip whose planned one has gone. */
  onShowOptions?: (task: Task) => Promise<DepartureOption[]>;
  /** Commit one of them. */
  onPickOption?: (task: Task, plan: TransitPlan) => void | Promise<void>;
  /** Tick a block off. Without it the blocks render with no checkbox at all. */
  onToggleComplete?: (task: Task) => void | Promise<void>;
  /** Re-plan a journey from the chain's guess ('auto') or a live fix ('current'). */
  onChangeOrigin?: (task: Task, origin: 'auto' | 'current') => void | Promise<void>;
  /** Price every mode for this journey, from where she is. */
  onCompareModes?: (task: Task) => Promise<ModeQuote[]>;
  /** Put a pooled task on the day. */
  onPlaceTask?: (task: Task) => void;
  /**
   * Resolve a collision.
   *
   *   leave-early / arrive-late — a hard spatial conflict: two places at once.
   *   shorten-to / move-to      — a movable block covering a departure, where
   *                               `first` is the block that gives way.
   */
  onResolveConflict?: (
    opts: {
      first: Task; second: Task;
      action: 'leave-early' | 'arrive-late' | 'shorten-to' | 'move-to';
      at: string;
    },
  ) => void | Promise<void>;
}

const taskTime = (t: Task): string | undefined => t.fixedTime || t.scheduledTime || undefined;

/**
 * The worst thing wrong with a group of blocks that share the same hours.
 *
 * A "group" is every block layoutDay put in one column set, which can easily
 * be three or four on a conference day. Only one verdict can be drawn, so it
 * has to be the most serious one — and it has to remember WHICH two tasks it
 * came from, because "leave early" and "arrive late" are instructions about a
 * specific pair, and the buttons cannot ask the user to act on the wrong one.
 *
 * Severity order is the order of harm: being due in two PLACES at once is a
 * problem no amount of goodwill solves; the same address twice is a
 * double-booking she may well have meant; a call inside a meeting is a normal
 * Tuesday. Ties keep the earliest pair, so a day with two separate spatial
 * clashes surfaces the one she hits first.
 *
 * `first`/`second` come back in CLOCK order, matching classifyOverlap's own
 * internal ordering — leaveEarlyAt belongs to the earlier task and
 * arriveLateAt to the later one, and swapping them inverts the advice.
 */
// 'displaced' outranks 'same-place': being double-booked in one room is
// awkward, whereas working through a departure means not arriving at all.
const OVERLAP_RANK: Record<string, number> = {
  parallel: 1, 'same-place': 2, displaced: 3, spatial: 4,
};

function worstOverlap(group: TimelineBlock[]):
  { verdict: OverlapVerdict; first: TimelineBlock; second: TimelineBlock } | null {
  let best: { verdict: OverlapVerdict; first: TimelineBlock; second: TimelineBlock } | null = null;
  for (let i = 0; i < group.length; i += 1) {
    for (let j = i + 1; j < group.length; j += 1) {
      // Blocks are sorted by start, so i is the earlier of the pair.
      const [a, b] = [group[i], group[j]];
      const verdict = classifyOverlap(
        a.task, b.task,
        (b.task.location as any)?.travelMinutes ?? (a.task.location as any)?.travelMinutes,
      );
      if (!verdict) continue;
      if (!best || OVERLAP_RANK[verdict.kind] > OVERLAP_RANK[best.verdict.kind]) {
        best = { verdict, first: a, second: b };
      }
    }
  }
  return best;
}
const pad = (n: number) => String(n).padStart(2, '0');
const hhmm = (h: number, m = 0) => `${pad(h)}:${pad(m)}`;

/**
 * The moment, beating.
 *
 * A static dot on a schedule reads as another bullet; the point of this one is
 * that it is ALIVE — it says "this is now" without a label. One shared
 * animation drives every instance, and it is stopped on unmount so a
 * backgrounded screen is not animating a dot nobody is looking at.
 */
function NowPulse() {
  const beat = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(beat, { toValue: 1, duration: 900, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.timing(beat, { toValue: 0, duration: 900, easing: Easing.in(Easing.quad), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [beat]);

  const scale = beat.interpolate({ inputRange: [0, 1], outputRange: [1, 1.55] });
  const halo = beat.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] });

  return (
    <View style={styles.pulseRow} pointerEvents="none">
      <View style={styles.nowDotWrap}>
        <Animated.View style={[styles.nowHalo, { opacity: halo, transform: [{ scale }] }]} />
        <View style={styles.nowDot} />
      </View>
      <View style={styles.pulseLine} />
    </View>
  );
}

export default function DayTimeline({
  tasks, language, onTaskTap, onTaskHold, onAddAtTime, onRequestIdeas, onPickIdea,
  now, dayStart, dayEnd, routines, date, onModeChange, onOpenRoute, onPlaceTask,
  onResolveConflict, onShowOptions, onPickOption, onToggleComplete, onChangeOrigin,
  onCompareModes,
}: DayTimelineProps) {
  // What every movable block has to do about the fixed ones. Computed once
  // for the whole day rather than per pair: a block can be pushed by one
  // appointment into another, and only the day as a whole knows where it
  // lands. See utils/yieldToFixed — and Koral's evening of 2026-09-17, where
  // a two-hour prep block sat straight across the ride to a yoga class.
  const yields = useMemo(
    () => yieldToFixed(tasks, { now, dayEnd }),
    [tasks, now, dayEnd],
  );
  const yieldFor = (id: string): YieldPlan | undefined => yields.find((y) => y.taskId === id);

  const lineColor  = BRAND.line;
  const hourColor  = BRAND.inkSoft;
  const cardBg     = BRAND.creamCard;
  const textColor  = BRAND.warmInk;
  const isHe = language === 'he';

  const scheduled = [...tasks.filter(t => taskTime(t))].sort(
    (a, b) => timeToMinutes(taskTime(a)!) - timeToMinutes(taskTime(b)!)
  );
  const unscheduled = tasks.filter(t => !taskTime(t));

  // Build rows: task cards, with every real free window drawn between them —
  // including before the first task and after the last.
  type Row = { kind: 'gap'; gap: DayGap };

  const gaps = constrainGaps(
    findDayGaps(scheduled, {
      now,
      dayStart: dayStart || '08:00',
      dayEnd: dayEnd || '22:00',
      minMinutes: 20,
    }),
    // A standing obligation (the school run, a fixed shift) never appears as a
    // task, so its hours have to be removed here — otherwise the timeline
    // offers her time that was never hers.
    routines ?? [],
    // getTodayString, not toISOString: the latter is UTC and is a day behind
    // for the first three hours of every Israeli morning.
    date || getTodayString(),
  );
  // Proportional geometry for the day. Overlapping tasks come back sharing a
  // group (columns > 1) so a clash is drawn as a clash, not as a stack.
  const trailing = gaps.filter((g) => !g.after);
  const blocks = layoutDay(scheduled, { now });

  /**
   * Rows: a gap, or a GROUP of blocks that share the same clock space, or the
   * standalone "now" line when no visible block contains this minute.
   *
   * This used to be forty lines of loop right here, which meant the one
   * property that matters most on this screen — that the day reads top to
   * bottom in clock order — was asserted by nobody. Both timeline bugs Koral
   * has reported were ordering bugs, and both were found on a phone rather
   * than by a test, because a render loop offers nothing to put a test on.
   * buildTimelineRows is the same logic with a seam; the rules it must keep
   * are written down in tests/run-timeline-chronology.
   */
  const nowMin = now ? timeToMinutes(now) : null;
  const rows = buildTimelineRows({ scheduled, blocks, gaps, nowMin });
  void trailing;   // buildTimelineRows takes the untagged gaps from `gaps` itself

  const pool = tasks.filter((t) => !taskTime(t) && t.status === 'pending');
  // Two things running at 20:30 are both "active"; the clock is drawn once,
  // on the first of them. Two red "20:…" pills read as two different nows.
  const nowOwner = blocks.find((b) => b.active)?.task.id;

  return (
    <View style={styles.wrap}>
      {rows.map((row, idx) => {
        if (row.kind === 'now') {
          return (
            <View key={`now-${idx}`} style={styles.nowRow}>
              <View style={styles.nowRowTime}>
                <View style={styles.nowPillStandalone}>
                  <Text style={styles.nowPillText}>{now}</Text>
                </View>
              </View>
              <View style={styles.nowRowLine}>
                <View style={styles.nowRowRule} />
                <NowPulse />
              </View>
            </View>
          );
        }
        if (row.kind === 'gap') {
          return (
            <View key={`gap-${idx}`} style={styles.gapWrap}>
              <GapSlotRow
                gap={row.gap}
                language={language}
                onRequestIdeas={onRequestIdeas ?? (async () => [])}
                onPick={onPickIdea ?? (() => {})}
                onAddOwn={(g) => onAddAtTime(g.start)}
              />
            </View>
          );
        }

        const group = (row as { group: TimelineBlock[] }).group;
        const lead = group[0];
        // Not every collision is a conflict. A call inside a meeting is a
        // normal Tuesday; two addresses at once is not.
        //
        // This used to classify group[0] against group[1] and stop. A group is
        // every block sharing the same clock space, so THREE overlapping
        // things — an all-day conference, a call inside it, and a dentist
        // across town — were judged on the first two: the call made it
        // 'parallel', the dentist was never compared to anything, and the one
        // genuine "two places at once" in the group was silently dropped.
        // Worse, the red border keyed off that single verdict and was then
        // painted on EVERY block in the group, so when it did fire it accused
        // the innocent call as well.
        //
        // Every pair is judged now, the worst verdict wins (spatial beats
        // same-place beats parallel), and the two tasks it actually refers to
        // are carried with it — the resolve buttons used to act on
        // group[0]/group[1] regardless of which pair the verdict came from.
        const worst = worstOverlap(group);
        const verdict: OverlapVerdict | null = worst?.verdict ?? null;
        const hard = verdict?.kind === 'spatial';
        // The two blocks the verdict is ABOUT — the only ones allowed to wear
        // the conflict colour.
        const conflictIds = hard && worst
          ? new Set([worst.first.task.id, worst.second.task.id])
          : new Set<string>();
        // `lead` survives only as the group's React key and for the notes
        // below it. The group's TIMES are gone on purpose: every block now
        // labels itself, so there is no longer one task speaking for the rest.

        return (
          <View key={`blocks-${lead.task.id}`}>
            {/* The journey INTO this block, where it actually happens.
                Drawn for whichever task in the group HAS a journey — not for
                group[0]. That was the bug: an 09:00 desk task overlapping an
                11:30 trip to Nahariya made the desk task the lead, and
                TimelineTravelLeg renders nothing for a task with no route, so
                a fully planned train — wake, walk, line, arrival — simply did
                not appear on the timeline at all. It was visible on the
                Leave-now screen the whole time, which is what made it look
                like a styling problem rather than a missing render. */}
            {/* `travelRowState !== 'none'`, not `taskHasJourney`.
                taskHasJourney is true only once a route EXISTS
                (leaveHomeBy || transitPlan). So a task with a real address and
                no route yet rendered nothing at all — and TimelineTravelLeg is
                the one component that knows how to say "I have a place and no
                hour", "no route by that vehicle" or "not planned yet — tap to
                work it out", with the action that fixes each. The component
                that explains the absence was mounted only when there was no
                absence.

                That is why Wednesday showed the interview with its address and
                no leave-home row and no reason: whether the route had failed,
                was still pending, or had never been attempted, the screen drew
                the same nothing. Let the row decide what it says; it already
                returns null for a task with genuinely nowhere to go. */}
            {group.filter((b) => travelRowState(b.task) !== 'none').map((b) => (
              <TimelineTravelLeg
                key={`leg-${b.task.id}`}
                task={b.task}
                language={language}
                isNext={b.next}
                onModeChange={onModeChange}
                onOpenRoute={onOpenRoute}
                onShowOptions={onShowOptions}
                onPickOption={onPickOption}
                onChangeOrigin={onChangeOrigin}
                onCompareModes={onCompareModes}
              />
            ))}

            {/* One row per task, never a row of columns.
                A group used to render as ONE row: the lead task's time in the
                rail, and every block in the group side by side inside it. Both
                halves of that were wrong on a phone.

                The width: three overlapping things left ~100px each, so the
                title was clipped to nothing. Koral's words — "the tasks are not
                seen, the text disappears". A clash drawn so narrow that neither
                task can be read has told her nothing.

                The time: the rail showed the LEAD's start and end for the whole
                group, so a 09:00 task and an 11:30 one in the same group were
                both labelled 09:00 and drawn at the same height — "כולם ביחד
                באותו בלוק". Every task now carries its own clock.

                So overlapping tasks stack vertically at full width, in clock
                order, each with its own time. The clash itself is still said
                out loud — the red border, the time tag, and the notes below. */}
            {group.map((b) => {
              const bStart = taskTime(b.task)!;
              const bEnd = addMinutes(bStart, b.task.durationMinutes || 30);
              return (
                <View key={`row-${b.task.id}`} style={styles.blockRow}>
              {/* Time rail — anchored to this block, so it cannot drift.
                  The two labels sit at the block's real top and bottom edges
                  (space-between): on a nine-hour conference they were glued
                  together at the top, so a proportional block was labelled
                  like a fixed-height row and the end time claimed an hour it
                  had nothing to do with. */}
              <View style={[styles.timeCol, { minHeight: b.height }]}>
                <Text
                  style={[styles.timeStart, { color: textColor }]}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  minimumFontScale={0.85}
                >
                  {bStart}
                </Text>
                {b.active && now && b.task.id === nowOwner ? (
                  // Clamped into the middle band. At top:0% or top:100% this
                  // pill — ~40px of solid red in a 40px-wide rail — landed
                  // exactly on the start or end time and swallowed it whole.
                  <View
                    style={[styles.nowPill, {
                      top: `${Math.min(74, Math.max(26, Math.round(b.progress * 100)))}%`,
                    }]}
                  >
                    <Text style={styles.nowPillText} numberOfLines={1} allowFontScaling={false}>{now}</Text>
                  </View>
                ) : null}
                <Text
                  style={[styles.timeEnd, { color: hourColor }]}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  minimumFontScale={0.85}
                >
                  {bEnd}
                </Text>
              </View>

              <View style={styles.blockCols}>
                {[b].map((b) => {
                  const meta = getCategoryMeta(b.task.category);
                  const done = b.task.status === 'complete';
                  const here = nowInBlock(now, taskTime(b.task), addMinutes(taskTime(b.task)!, b.task.durationMinutes || 30));
                  const clash = b.columns > 1;
                  return (
                    <TouchableOpacity
                      key={b.task.id}
                      activeOpacity={0.85}
                      onPress={() => onTaskTap(b.task)}
                      onLongPress={() => (onTaskHold ?? onTaskTap)(b.task)}
                      delayLongPress={350}
                      style={[
                        styles.card,
                        { backgroundColor: cardBg, borderLeftColor: meta.color, minHeight: b.height },
                        b.past && styles.cardPast,
                        b.active && styles.cardActive,
                        b.next && styles.cardNext,
                        clash && styles.cardSideBySide,
                        // Red is reserved for being due in two PLACES at once,
                        // and now only for the TWO blocks that are actually in
                        // that conflict. It used to paint every side-by-side
                        // block, so three compatible evening things — a call, a
                        // deadline, a party — came out as a wall of
                        // emergencies and the colour stopped meaning anything.
                        clash && hard && conflictIds.has(b.task.id) && styles.cardClash,
                        // Dimmed, not vanished: a block you finished is
                        // evidence you finished it. 0.55 hid the text under
                        // the strike-through as well.
                        done && styles.cardDone,
                      ]}
                    >
                      {b.active ? (
                        <View style={styles.progressTrack}>
                          <View style={[styles.progressFill,
                            { width: `${Math.round(b.progress * 100)}%`, backgroundColor: meta.color }]} />
                        </View>
                      ) : null}
                      {clash ? (
                        // adjustsFontSizeToFit + one line: in a third-width
                        // column "16:00–21:00" was wrapping into "16:00–21:0"
                        // over a lonely "0". A time that has to be reassembled
                        // by the reader is worse than a smaller time.
                        <Text
                          style={[styles.clashTag, hard && styles.clashTagHard]}
                          numberOfLines={1}
                          adjustsFontSizeToFit
                          minimumFontScale={0.75}
                        >
                          {taskTime(b.task)}–{addMinutes(taskTime(b.task)!, b.task.durationMinutes || 30)}
                        </Text>
                      ) : null}
                      {/* Tick, then title. The block had no checkbox at all —
                          it could be opened and held but not finished, which is
                          most of what a day list is for. */}
                      <View style={styles.titleRow}>
                        {onToggleComplete ? (
                          <TaskCheckbox
                            done={done}
                            color={meta.color}
                            size={clash ? 20 : 22}
                            onToggle={() => onToggleComplete(b.task)}
                          />
                        ) : null}
                        <Text
                          numberOfLines={clash ? 3 : 2}
                          style={[
                            styles.cardTitle,
                            styles.cardTitleFlex,
                            { color: done ? hourColor : textColor },
                            done && styles.cardTitleDone,
                          ]}
                        >
                          {meta.icon}  {b.task.text}
                        </Text>
                      </View>
                      <Text style={[styles.cardMeta, { color: hourColor }]} numberOfLines={1}>
                        {formatDuration(b.task.durationMinutes || 30, language)}
                        {locationTextOf(b.task) ? `  ·  📍 ${locationTextOf(b.task)}` : ''}
                      </Text>
                      {here.active ? (
                        <Text style={styles.remaining}>{describeRemaining(here.minutesLeft, isHe)}</Text>
                      ) : null}
                    </TouchableOpacity>
                  );
                })}

                {/* The moment, on the block it falls inside. */}
                {b.active && b.task.id === nowOwner ? (
                  <View style={[styles.nowLine, { top: `${Math.round(b.progress * 100)}%` }]} pointerEvents="none">
                    <NowPulse />
                  </View>
                ) : null}
              </View>
                </View>
              );
            })}

            {/* A block of work laid across a departure. It is not a clash of
                places — it is work that has to move so she can leave. The
                timeline used to call this 'parallel' and print "you can take
                the call on the way", which, followed, means missing the
                class. */}
            {verdict && verdict.kind === 'displaced' && worst ? (() => {
              const displaced = [worst.first.task, worst.second.task]
                .find((t) => t.id === verdict.displacedTaskId);
              const anchorTask = [worst.first.task, worst.second.task]
                .find((t) => t.id !== verdict.displacedTaskId);
              const plan = displaced ? yieldFor(displaced.id) : undefined;
              if (!displaced || !anchorTask) return null;
              return (
                <View style={styles.conflictBox}>
                  <Text style={styles.conflictTitle}>
                    {verdict.departureAt
                      ? (isHe
                        ? `⚠️ "${displaced.text}" רץ מעבר ל-${verdict.departureAt}, השעה שצריך לצאת ל"${anchorTask.text}"`
                        : `⚠️ "${displaced.text}" runs past ${verdict.departureAt}, when you have to leave for "${anchorTask.text}"`)
                      : (isHe
                        ? `⚠️ "${displaced.text}" באותה שעה כמו "${anchorTask.text}"`
                        : `⚠️ "${displaced.text}" is at the same time as "${anchorTask.text}"`)}
                  </Text>
                  {plan && plan.action !== 'keep' ? (
                    <View style={styles.chipRow}>
                      <TouchableOpacity
                        style={styles.chip}
                        disabled={plan.action === 'no-room' || !onResolveConflict}
                        onPress={() => onResolveConflict && onResolveConflict({
                          first: displaced,
                          second: anchorTask,
                          action: plan.action === 'shorten' ? 'shorten-to' : 'move-to',
                          at: plan.action === 'shorten' ? plan.to!.end : plan.to?.start ?? '',
                        })}
                      >
                        <Text style={styles.chipText}>
                          {describeYield(plan, anchorTask.text, isHe)}
                        </Text>
                      </TouchableOpacity>
                    </View>
                  ) : null}
                </View>
              );
            })() : null}

            {verdict && verdict.kind === 'parallel' ? (
              <View style={styles.parallelNote}>
                <Text style={styles.parallelText}>
                  {verdict.suggestDuringTravel
                    ? (isHe ? '💻 אפשר לקחת את השיחה בדרך' : '💻 You can take the call on the way')
                    : (isHe ? '💻 אפשר לעשות את שתיהן יחד' : '💻 These two can happen together')}
                </Text>
              </View>
            ) : null}

            {verdict && verdict.kind === 'same-place' ? (
              <View style={styles.softNote}>
                <Text style={styles.softText}>
                  {isHe
                    ? `שתיהן באותו מקום — חופפות ב-${verdict.overlapMinutes} דק׳`
                    : `Both in the same place — ${verdict.overlapMinutes} min double-booked`}
                </Text>
              </View>
            ) : null}

            {/* Offered only when someone can actually act on the answer.
                Today passes no handler, so these two buttons rendered, took
                the tap and did nothing — the same silent no-op as a "✓ saved"
                that never saved. */}
            {hard && verdict && worst && onResolveConflict ? (
              <View style={styles.conflictBox}>
                <Text style={styles.conflictTitle}>
                  {isHe
                    ? `⚠️ שני מקומות באותו זמן — ${verdict.travelMinutes} דק׳ ביניהם`
                    : `⚠️ Two places at once — ${verdict.travelMinutes} min apart`}
                </Text>
                <View style={styles.chipRow}>
                  <TouchableOpacity
                    style={styles.chip}
                    onPress={() => onResolveConflict({
                      first: worst.first.task, second: worst.second.task,
                      action: 'leave-early', at: verdict.leaveEarlyAt!,
                    })}
                  >
                    <Text style={styles.chipText}>
                      {isHe ? `לצאת ב-${verdict.leaveEarlyAt}` : `Leave at ${verdict.leaveEarlyAt}`}
                    </Text>
                    <Text style={styles.chipSub}>{isHe ? 'להגיע בזמן' : 'arrive on time'}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.chip, styles.chipAlt]}
                    onPress={() => onResolveConflict({
                      first: worst.first.task, second: worst.second.task,
                      action: 'arrive-late', at: verdict.arriveLateAt!,
                    })}
                  >
                    <Text style={styles.chipText}>
                      {isHe ? `להישאר עד הסוף` : 'Stay to the end'}
                    </Text>
                    <Text style={styles.chipSub}>
                      {isHe ? `להגיע ב-${verdict.arriveLateAt} (${verdict.arriveLateBy} דק׳ באיחור)`
                            : `arrive ${verdict.arriveLateAt} · ${verdict.arriveLateBy} min late`}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : null}
          </View>
        );
      })}

      {/* Everything with no hour yet — one reach away, not buried under the
          day. Replaces the old bottom-of-the-page "No time set" list. */}
      {pool.length ? (
        <TaskPoolDrawer
          tasks={pool}
          language={language}
          onPlace={(task) => (onPlaceTask ? onPlaceTask(task) : onTaskTap(task))}
          onOpenTask={(task) => (onTaskHold ?? onTaskTap)(task)}
        />
      ) : null}

    </View>
  );
}

const styles = StyleSheet.create({
  parallelNote: {
    marginTop: -4, marginBottom: BLOCK_GAP_PX, marginLeft: 58,
    backgroundColor: BRAND.honey, borderRadius: RADIUS.chip, paddingHorizontal: 10, paddingVertical: 7,
  },
  parallelText: { fontFamily: FONTS.bodySemi, fontSize: 11.5, color: BRAND.warmInk },
  softNote: {
    marginTop: -4, marginBottom: BLOCK_GAP_PX, marginLeft: 58,
    backgroundColor: BRAND.timeChipBg, borderRadius: RADIUS.chip, paddingHorizontal: 10, paddingVertical: 7,
  },
  softText: { fontFamily: FONTS.bodySemi, fontSize: 11.5, color: BRAND.timeChipText },
  conflictBox: {
    marginTop: -4, marginBottom: BLOCK_GAP_PX, marginLeft: 58,
    borderWidth: 1.5, borderColor: BRAND.danger, borderRadius: RADIUS.chip + 2,
    backgroundColor: BRAND.creamCard, padding: 10, gap: 8,
  },
  conflictTitle: { fontFamily: FONTS.bodyBold, fontSize: 12, color: BRAND.danger },
  chipRow: { flexDirection: 'row', gap: 8 },
  chip: {
    flex: 1, backgroundColor: BRAND.sunGold, borderRadius: RADIUS.chip,
    paddingHorizontal: 10, paddingVertical: 8, gap: 2,
  },
  chipAlt: { backgroundColor: BRAND.creamCard, borderWidth: 1.5, borderColor: BRAND.line },
  chipText: { fontFamily: FONTS.bodyBold, fontSize: 12, color: BRAND.warmInk },
  chipSub: { fontFamily: FONTS.body, fontSize: 10.5, color: BRAND.inkSoft, lineHeight: 14 },
  blockRow: { flexDirection: 'row', gap: 10, marginBottom: BLOCK_GAP_PX },
  blockCols: { flex: 1, flexDirection: 'row', gap: 7, position: 'relative' },
  nowPill: {
    position: 'absolute', right: 0, marginTop: -9, minWidth: 40, alignItems: 'center',
    backgroundColor: BRAND.danger, borderRadius: RADIUS.pill,
    paddingHorizontal: 6, paddingVertical: 2,
  },
  nowPillText: { fontFamily: FONTS.bodyBold, fontSize: 10, color: BRAND.white },
  nowLine: { position: 'absolute', left: -7, right: 0, marginTop: -7 },
  cardPast: { opacity: 0.45 },
  // The standalone marker: a rule across the day with the clock on the rail,
  // so "you are here" survives an hour with nothing scheduled in it.
  nowRow: { flexDirection: 'row', alignItems: 'center', minHeight: 26, marginVertical: 2 },
  nowRowTime: { width: GUTTER, alignItems: 'flex-start', justifyContent: 'center' },
  nowPillStandalone: {
    backgroundColor: BRAND.danger, borderRadius: RADIUS.pill,
    paddingHorizontal: 8, paddingVertical: 2,
  },
  nowRowLine: { flex: 1, justifyContent: 'center' },
  nowRowRule: { height: 1.5, backgroundColor: BRAND.danger, opacity: 0.5 },
  cardDone: { opacity: 0.62, backgroundColor: BRAND.cream },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  cardTitleFlex: { flex: 1, flexShrink: 1, minWidth: 0 },
  cardTitleDone: { textDecorationLine: 'line-through' },
  cardNext: { borderWidth: 1.5, borderColor: BRAND.sunGold, backgroundColor: BRAND.goldSoft },
  // Sharing a row is normal. Only the spatial impossibility is red.
  cardSideBySide: { flex: 1, borderWidth: 1, borderColor: BRAND.line },
  cardClash: { flex: 1, borderWidth: 1.5, borderColor: BRAND.danger },
  clashTag: {
    flexShrink: 0,
    fontFamily: FONTS.bodyBold, fontSize: 10, color: BRAND.goldInk, marginBottom: 2,
  },
  clashTagHard: { color: BRAND.danger },
  remaining: { fontFamily: FONTS.bodyBold, fontSize: 11, color: BRAND.timeChipText, marginTop: 3 },
  nowDotWrap: { width: 14, height: 14, alignItems: 'center', justifyContent: 'center' },
  nowHalo: {
    position: 'absolute', width: 14, height: 14, borderRadius: 7,
    backgroundColor: BRAND.danger,
  },
  nowDot: {
    width: 10, height: 10, borderRadius: 5, backgroundColor: BRAND.danger,
    borderWidth: 2.5, borderColor: BRAND.cream,
  },
  pulseRow: { flexDirection: 'row', alignItems: 'center' },
  pulseLine: { flex: 1, height: 1.5, backgroundColor: BRAND.danger, opacity: 0.35 },
  cardActive: {
    borderWidth: 1.5, borderColor: BRAND.sunGold,
    shadowColor: BRAND.amber, shadowOpacity: 0.18, shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 }, elevation: 4,
  },
  progressTrack: {
    height: 4, borderRadius: 2, backgroundColor: BRAND.line,
    overflow: 'hidden', marginBottom: 6,
  },
  progressFill: { height: 4, borderRadius: 2 },
  wrap: { paddingHorizontal: 12 },

  taskRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    marginBottom: 6,
  },
  timeCol: {
    width: GUTTER,
    paddingRight: 8,
    paddingTop: 4,
    paddingBottom: 4,
    alignItems: 'flex-end',
    // Top edge and bottom edge of the block it labels.
    justifyContent: 'space-between',
  },
  // flexShrink: 0 on both — the hour is the payload of this rail. A clock time
  // that has to be reassembled by the reader ("16:0" over a lonely "0") is
  // worse than no clock time, and worse again than a slightly smaller one.
  timeStart: { flexShrink: 0, fontSize: 12, fontFamily: FONTS.bodyBold },
  timeEnd:   { flexShrink: 0, fontSize: 11, marginTop: 2 },

  card: {
    flex: 1,
    // Softer and rounder than the old chip radius — the canvas reads as cards
    // resting on the day, not rows ruled onto it.
    borderRadius: RADIUS.card - 2,
    borderLeftWidth: 4,
    paddingHorizontal: 13,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: BRAND.line,
    elevation: 2,
    shadowColor: SHADOWS.card.shadowColor,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
  },
  cardTitle: { fontSize: 14, fontFamily: FONTS.bodyBold },
  cardMeta:  { fontSize: 12, marginTop: 3 },

  gapWrap: { paddingLeft: GUTTER, marginBottom: 4 },

  gapRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
    paddingVertical: 4,
  },
  gapLabel: { flexShrink: 0, width: GUTTER, fontSize: 11, textAlign: 'right', paddingRight: 8 },
  gapLine:  { flex: 1, borderTopWidth: StyleSheet.hairlineWidth, marginRight: 8 },
  gapFree:  { fontSize: 11, fontFamily: FONTS.bodySemi },

  unschedTitle:   { fontSize: 12, fontFamily: FONTS.bodyBold, marginBottom: 8, paddingLeft: GUTTER },
});
