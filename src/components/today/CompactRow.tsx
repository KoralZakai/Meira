/**
 * CompactRow — one line per task in All day's compact view (canvas v4, 27.10).
 *
 * Hour · icon · name · the leave pill ("צאי 16:17" + the ride's exact
 * departure) · done tick. The plan stays visible without a tap (silent-state
 * rule 5): the leave time is on the row itself. A tap opens the full card
 * (DayCard) in place — that is where the trip is edited.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import type { DragHandlers } from './TrayDock';
import type { Task } from '../../types/index';
import { BRAND, FONTS, MIN_TOUCH } from '../../constants/theme';
import { getCategoryMeta } from '../../constants/categories';
import { RIDE_ICON, ridesOf } from '../../utils/rideLine';

interface Props {
  task: Task;
  he: boolean;
  /** It moved because of a change elsewhere in the day — drawn gold for a few seconds. */
  moved?: boolean;
  onOpen: () => void;
  onToggleComplete: () => void;
  /** Long-press lifts it onto the hour ruler (28.10: drag within the day). */
  drag?: DragHandlers;
}

export default function CompactRow({ task, he, moved, onOpen, onToggleComplete, drag }: Props) {
  const meta = getCategoryMeta(task.category);
  const done = task.status === 'complete';
  // Postponed with no new date yet (RunningLate 'not going'): said, and no leave line for a trip that is off.
  const off = task.status === 'missed';
  const start = task.fixedTime || task.scheduledTime || '';
  const leave = typeof task.location === 'object' ? task.location?.leaveHomeBy : undefined;
  const ride = ridesOf(task)[0];
  const dir = he ? 'row-reverse' : 'row';
  // A short tap still opens it; only a held press becomes a drag (the Pan activates after the hold).
  const pan = Gesture.Pan()
    .enabled(Boolean(drag) && !done)
    .activateAfterLongPress(350)
    .runOnJS(true)
    .onStart((e) => drag?.onLift(task, e.absoluteX, e.absoluteY))
    .onUpdate((e) => drag?.onMove(e.absoluteX, e.absoluteY))
    .onEnd((e, success) => (success ? drag?.onDrop(e.absoluteX, e.absoluteY) : drag?.onCancel()));
  return (
    <GestureDetector gesture={pan}>
    <Pressable onPress={onOpen} style={[styles.wrap, moved && styles.moved, done && styles.done]}
      accessibilityRole="button" accessibilityLabel={`${start} ${task.text}${leave ? (he ? `, צאי ${leave}` : `, leave ${leave}`) : ''}`}>
      {/* Canvas v4 "כל היום · מצומצם": hour · icon · the whole name · tick — the trip on its own line under it. */}
      <View style={[styles.row, { flexDirection: dir }]}>
        <Text style={styles.time} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>{start}</Text>
        <View style={[styles.icon, { backgroundColor: `${meta.color}22` }]}><Text style={styles.iconText}>{meta.icon}</Text></View>
        <Text style={[styles.name, he && styles.rtl, (done || off) && styles.strike]} numberOfLines={1}>{task.text}</Text>
        {off ? <Text style={styles.offTag} numberOfLines={1}>{he ? 'נדחה' : 'postponed'}</Text> : null}
        <TouchableOpacity style={[styles.check, done && styles.checkOn]} onPress={onToggleComplete}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} accessibilityRole="checkbox"
          accessibilityState={{ checked: done }} accessibilityLabel={he ? 'בוצע' : 'Done'}>
          {done ? <Text style={styles.checkMark}>✓</Text> : null}
        </TouchableOpacity>
      </View>
      {leave && !done && !off ? (
        <View style={[styles.trip, he ? styles.tripHe : styles.tripEn, { flexDirection: dir }]}>
          {/* Only "צאי" is yellow; the ride's exact minute is bold beside it (28.10). */}
          <View style={[styles.pill, { flexDirection: dir }]}>
            <Text style={styles.pillSmall} numberOfLines={1}>{he ? 'צאי' : 'leave'}</Text>
            <Text style={styles.pillBig} numberOfLines={1}>{leave}</Text>
          </View>
          {ride?.departureTime ? (
            <Text style={styles.ride} numberOfLines={1}>
              {`${RIDE_ICON[ride.type] || '🚌'} ${ride.departureTime}${ride.lineNumber ? ` · ${ride.lineNumber}` : ''}`}
            </Text>
          ) : null}
        </View>
      ) : null}
    </Pressable>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  wrap: { borderRadius: 16, backgroundColor: 'rgba(255,253,247,0.88)', paddingHorizontal: 10, paddingVertical: 4 },
  row: { alignItems: 'center', gap: 8, minHeight: MIN_TOUCH },
  // The trip under its task, on a dashed thread — canvas v4 "tripln".
  trip: { alignItems: 'center', gap: 8, minHeight: 28, paddingBottom: 4, borderStyle: 'dashed', borderColor: 'rgba(90,79,224,0.35)' },
  tripHe: { marginRight: 52, paddingRight: 10, borderRightWidth: 2 },
  tripEn: { marginLeft: 52, paddingLeft: 10, borderLeftWidth: 2 },
  moved: { borderWidth: 2, borderColor: BRAND.sunGold, backgroundColor: '#FFF6D6' },
  done: { opacity: 0.6 },
  rtl: { textAlign: 'right', writingDirection: 'rtl' },
  time: { minWidth: 44, fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.timeChipText, fontVariant: ['tabular-nums'] },
  icon: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  iconText: { fontSize: 15 },
  name: { flex: 1, minWidth: 0, fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.warmInk },
  strike: { textDecorationLine: 'line-through' },
  offTag: { flexShrink: 0, fontFamily: FONTS.bodyHeavy, fontSize: 11, color: BRAND.inkSoft, backgroundColor: 'rgba(20,27,46,0.07)', borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2, overflow: 'hidden' },
  pill: { alignItems: 'baseline', gap: 4, backgroundColor: BRAND.sunGold, borderRadius: 11, paddingHorizontal: 8, paddingVertical: 2 },
  pillSmall: { fontFamily: FONTS.bodyHeavy, fontSize: 10, color: BRAND.onGold },
  pillBig: { fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.onGold, fontVariant: ['tabular-nums'] },
  ride: { flexShrink: 1, fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.warmInk, fontVariant: ['tabular-nums'] },
  check: { width: 26, height: 26, borderRadius: 13, borderWidth: 2, borderColor: BRAND.goldInk, alignItems: 'center', justifyContent: 'center' },
  checkOn: { backgroundColor: BRAND.success, borderColor: BRAND.success },
  checkMark: { color: BRAND.white, fontFamily: FONTS.bodyHeavy, fontSize: 13 },
});
