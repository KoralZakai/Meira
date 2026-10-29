/**
 * PairCard — two appointments at the same hour, drawn SIDE BY SIDE.
 *
 * Koral, 27.10 (design canvas v3): "overlap needs to be shown one next to each
 * other". It replaces the one-line "⚠️ two places at once" note AND the second
 * card under it: both halves in one card, each with its hour, its title, its
 * done tick and — when it has a route — the gold "leave" pill with the ride's
 * exact departure. "Resolve ›" opens Meira's advice (PairAdviceModal); tapping
 * a half opens that task's full card under the pair.
 */
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import type { DragHandlers } from './TrayDock';
import type { Task } from '../../types/index';
import { BRAND, FONTS } from '../../constants/theme';
import { getCategoryMeta } from '../../constants/categories';
import { addMinutes } from '../../utils/timeUtils';
import { RIDE_ICON, ridesOf } from '../../utils/rideLine';

interface Props {
  a: Task;
  b: Task;
  overlapMinutes: number;
  he: boolean;
  openId?: string | null;
  onOpen: (t: Task) => void;
  onComplete: (t: Task) => void;
  onResolve: () => void;
  /** Hold a half to drag it to another hour — the way OUT of an overlap (28.10). */
  drag?: DragHandlers;
}

function Half({ t, he, open, onOpen, onComplete, drag }: { t: Task; he: boolean; open: boolean; onOpen: () => void; onComplete: () => void; drag?: DragHandlers }) {
  const meta = getCategoryMeta(t.category);
  const start = t.fixedTime || t.scheduledTime || '';
  const end = start && t.durationMinutes ? addMinutes(start, t.durationMinutes) : '';
  const done = t.status === 'complete';
  const leave = typeof t.location === 'object' ? t.location?.leaveHomeBy : undefined;
  const ride = ridesOf(t)[0];
  const pan = Gesture.Pan()
    .enabled(Boolean(drag) && !done)
    .activateAfterLongPress(350)
    .runOnJS(true)
    .onStart((e) => drag?.onLift(t, e.absoluteX, e.absoluteY))
    .onUpdate((e) => drag?.onMove(e.absoluteX, e.absoluteY))
    .onEnd((e, success) => (success ? drag?.onDrop(e.absoluteX, e.absoluteY) : drag?.onCancel()));
  return (
    <GestureDetector gesture={pan}>
    <TouchableOpacity style={[styles.half, open && styles.halfOpen]} onPress={onOpen} activeOpacity={0.85}
      accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`${start} ${t.text}`}>
      <View style={styles.halfHead}>
        <View style={[styles.icon, { backgroundColor: `${meta.color}22` }]}><Text style={styles.iconText}>{meta.icon}</Text></View>
        <Text style={styles.when} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{end ? `${start}–${end}` : start}</Text>
        <TouchableOpacity style={[styles.check, done && styles.checkOn]} onPress={onComplete}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} accessibilityRole="checkbox"
          accessibilityState={{ checked: done }} accessibilityLabel={he ? 'בוצע' : 'Done'}>
          {done ? <Text style={styles.checkMark}>✓</Text> : null}
        </TouchableOpacity>
      </View>
      <Text style={[styles.title, done && styles.strike]} numberOfLines={2}>{t.text}</Text>
      {leave && !done ? (
        <View style={styles.leaveRow}>
          <View style={styles.leavePill}>
            <Text style={styles.leaveSmall}>{he ? 'צאי' : 'leave'}</Text>
            <Text style={styles.leaveBig}>{leave}</Text>
          </View>
          {ride?.departureTime ? (
            <Text style={styles.ride} numberOfLines={1}>{`${RIDE_ICON[ride.type] || '🚌'} ${ride.departureTime}`}</Text>
          ) : null}
        </View>
      ) : null}
    </TouchableOpacity>
    </GestureDetector>
  );
}

export default function PairCard({ a, b, overlapMinutes, he, openId, onOpen, onComplete, onResolve, drag }: Props) {
  return (
    <View style={styles.card}>
      <View style={styles.top}>
        <Text style={styles.topText} numberOfLines={1}>
          {he ? `⚠️ חפיפה של ${overlapMinutes} דק׳ · איזו?` : `⚠️ ${overlapMinutes} min overlap · which one?`}
        </Text>
        <TouchableOpacity onPress={onResolve} hitSlop={10} accessibilityRole="button">
          <Text style={styles.resolve}>{he ? 'לפתור ›' : 'Resolve ›'}</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.row}>
        <Half t={a} he={he} open={openId === a.id} onOpen={() => onOpen(a)} onComplete={() => onComplete(a)} drag={drag} />
        <Half t={b} he={he} open={openId === b.id} onOpen={() => onOpen(b)} onComplete={() => onComplete(b)} drag={drag} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: 'rgba(255,253,247,0.92)', borderRadius: 20, padding: 10, gap: 8 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 },
  topText: { flex: 1, fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.lateInk },
  resolve: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.goldInk },
  row: { flexDirection: 'row', gap: 8 },
  half: { flex: 1, minWidth: 0, backgroundColor: BRAND.white, borderRadius: 16, padding: 10, gap: 6 },
  halfOpen: { borderWidth: 2, borderColor: BRAND.sunGold },
  halfHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  icon: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  iconText: { fontSize: 16 },
  when: { flex: 1, fontFamily: FONTS.bodyHeavy, fontSize: 12, color: BRAND.timeChipText, fontVariant: ['tabular-nums'] },
  check: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: BRAND.goldInk, alignItems: 'center', justifyContent: 'center' },
  checkOn: { backgroundColor: BRAND.success, borderColor: BRAND.success },
  checkMark: { color: BRAND.white, fontFamily: FONTS.bodyHeavy, fontSize: 13 },
  title: { fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.warmInk },
  strike: { textDecorationLine: 'line-through', color: BRAND.inkSoft },
  leaveRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  leavePill: { flexDirection: 'row', alignItems: 'baseline', gap: 4, backgroundColor: BRAND.sunGold, borderRadius: 12, paddingHorizontal: 8, paddingVertical: 3 },
  leaveSmall: { fontFamily: FONTS.bodyHeavy, fontSize: 11, color: BRAND.onGold },
  leaveBig: { fontFamily: FONTS.bodyHeavy, fontSize: 15, color: BRAND.onGold, fontVariant: ['tabular-nums'] },
  ride: { fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.warmInk, fontVariant: ['tabular-nums'] },
});
