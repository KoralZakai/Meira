/**
 * TrayDock — today's tasks that have no hour yet, ready to be dragged into the day.
 *
 * Koral, 27.10: "add today's tasks that were not put in the diary yet, and
 * let me drag them to a place — and then everything arranges itself". The
 * tray sits above All day; a long-press lifts a task (a ghost follows the
 * finger), the day's free windows light up as drop targets, and letting go
 * over one gives the task that hour (utils/dropSlot). The chain re-routes the
 * trips around it, as any other change does.
 *
 * Gesture: react-native-gesture-handler Pan, activated after a long press, on
 * the JS thread (the project has no Reanimated). The ghost moves through an
 * Animated.ValueXY so the big Today screen does not re-render on every frame.
 */
import React, { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { Animated, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import type { Task } from '../../types/index';
import { BRAND, FONTS, MIN_TOUCH, surf, nink } from '../../constants/theme';
import { getCategoryMeta } from '../../constants/categories';
import { useNight } from '../ui/SkyBackdrop';
import { N } from '../../constants/nightTone';

export interface DragHandlers {
  onLift: (task: Task, x: number, y: number) => void;
  onMove: (x: number, y: number) => void;
  onDrop: (x: number, y: number) => void;
  onCancel: () => void;
}

interface Props extends DragHandlers {
  tasks: Task[];
  he: boolean;
  /** A tap (not a drag) opens the task. */
  onOpen: (task: Task) => void;
}

function TrayChip({ task, he, onOpen, ...h }: { task: Task; he: boolean; onOpen: (t: Task) => void } & DragHandlers) {
  const night = useNight();
  const meta = getCategoryMeta(task.category);
  const pan = Gesture.Pan()
    .activateAfterLongPress(300)
    .runOnJS(true)
    .onStart((e) => h.onLift(task, e.absoluteX, e.absoluteY))
    .onUpdate((e) => h.onMove(e.absoluteX, e.absoluteY))
    .onEnd((e, success) => (success ? h.onDrop(e.absoluteX, e.absoluteY) : h.onCancel()));
  const tap = Gesture.Tap().runOnJS(true).onEnd((_e, success) => { if (success) onOpen(task); });
  return (
    <GestureDetector gesture={Gesture.Exclusive(pan, tap)}>
      <View style={[styles.chip, night && N.card, { flexDirection: he ? 'row-reverse' : 'row' }]} accessible
        accessibilityLabel={he ? `${task.text} — לחיצה ארוכה וגרירה לשעה` : `${task.text} — long-press and drag to an hour`}>
        <Text style={styles.grip}>⋮⋮</Text>
        <View style={[styles.icon, { backgroundColor: `${meta.color}22` }]}><Text>{meta.icon}</Text></View>
        <Text style={[styles.chipText, night && N.ink]} numberOfLines={1}>{task.text}</Text>
        <Text style={[styles.mins, night && N.inkSoft]}>{`${task.durationMinutes || 30}′`}</Text>
      </View>
    </GestureDetector>
  );
}

export default function TrayDock({ tasks, he, onOpen, ...h }: Props) {
  const night = useNight();
  if (!tasks.length) return null;
  return (
    <View style={styles.wrap}>
      <Text style={[styles.cap, night && N.ink, he && styles.rtl]}>
        {he ? `לשבץ היום · ${tasks.length} · לחיצה ארוכה וגרירה לשעה` : `To fit in today · ${tasks.length} · long-press and drag to an hour`}
      </Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
        {tasks.map((t) => <TrayChip key={t.id} task={t} he={he} onOpen={onOpen} {...h} />)}
      </ScrollView>
    </View>
  );
}

export interface GhostHandle {
  show: (task: Task, x: number, y: number) => void;
  move: (x: number, y: number) => void;
  hide: () => void;
}

/** The lifted task under the finger. Lives at the screen root. */
export const DragGhost = forwardRef<GhostHandle, { he: boolean }>(({ he }, ref) => {
  const pos = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const [task, setTask] = useState<Task | null>(null);
  useImperativeHandle(ref, () => ({
    show: (t, x, y) => { pos.setValue({ x: x - 90, y: y - 26 }); setTask(t); },
    move: (x, y) => pos.setValue({ x: x - 90, y: y - 26 }),
    hide: () => setTask(null),
  }), [pos]);
  if (!task) return null;
  return (
    <Animated.View pointerEvents="none" style={[styles.ghost, { transform: [...pos.getTranslateTransform(), { rotate: '-2deg' }] }]}>
      <Text style={styles.chipText} numberOfLines={1}>{`${getCategoryMeta(task.category).icon} ${task.text}`}</Text>
      <Text style={styles.ghostHint}>{he ? 'שחררי על שעה' : 'drop on an hour'}</Text>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  wrap: { gap: 6, marginBottom: 10 },
  cap: { fontFamily: FONTS.bodyHeavy, fontSize: 12, color: BRAND.warmInk },
  rtl: { textAlign: 'right', writingDirection: 'rtl' },
  row: { gap: 8, paddingVertical: 2 },
  chip: {
    alignItems: 'center', gap: 8, minHeight: MIN_TOUCH + 4, paddingHorizontal: 10, borderRadius: 16, maxWidth: 260,
    backgroundColor: surf('rgba(255,253,247,0.95)'), borderWidth: 1, borderColor: BRAND.line,
  },
  grip: { fontSize: 14, color: BRAND.inkFaint, letterSpacing: -2 },
  icon: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  chipText: { flexShrink: 1, fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.warmInk },
  mins: { fontFamily: FONTS.bodySemi, fontSize: 11, color: BRAND.inkSoft },
  ghost: {
    position: 'absolute', top: 0, left: 0, width: 180, padding: 10, borderRadius: 16, zIndex: 50, elevation: 12,
    backgroundColor: surf(BRAND.white), borderWidth: 2, borderColor: '#7B6CFF',
  },
  ghostHint: { fontFamily: FONTS.bodySemi, fontSize: 11, color: nink('#5A4FE0'), marginTop: 2 },
});
