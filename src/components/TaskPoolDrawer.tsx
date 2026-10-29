/**
 * TaskPoolDrawer — the tasks with no hour yet, one reach away.
 *
 * Everything without a clock time lived at the BOTTOM of the timeline, under
 * the whole day, so on a busy day the backlog was a scroll nobody made. The
 * work she keeps meaning to do was the hardest thing on the screen to reach.
 *
 * Closed it is a glass bar over the day; open it is a sheet of the pending
 * pool, each row droppable into a free window. Blur is a real BlurView on
 * both platforms (expo-blur) over a translucent tint, because a flat fill at
 * this opacity muddies the cards scrolling underneath it.
 */
import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
  LayoutAnimation, Platform, UIManager,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { Task, AppLanguage } from '../types';
import { BRAND, FONTS, RADIUS, surf } from '../constants/theme';
import { getCategoryMeta } from '../constants/categories';
import { formatDuration } from '../utils/timeUtils';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

interface Props {
  tasks: Task[];
  language: AppLanguage;
  /** Put this task on the day — the caller picks the slot. */
  onPlace: (task: Task) => void;
  onOpenTask?: (task: Task) => void;
}

export default function TaskPoolDrawer({ tasks, language, onPlace, onOpenTask }: Props) {
  const [open, setOpen] = useState(false);
  const he = language === 'he';
  if (!tasks.length) return null;

  const toggle = () => {
    LayoutAnimation.configureNext(LayoutAnimation.create(
      240, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.opacity,
    ));
    setOpen((v) => !v);
  };

  return (
    <BlurView intensity={38} tint="light" style={styles.wrap}>
      <TouchableOpacity activeOpacity={0.85} onPress={toggle} style={styles.handleArea}>
        <View style={styles.handle} />
        <View style={styles.headerRow}>
          <Text style={styles.title}>
            {he ? `מאגר משימות · ${tasks.length} ממתינות` : `Task pool · ${tasks.length} waiting`}
          </Text>
          <Text style={styles.hint}>{open ? (he ? 'סגור' : 'Close') : (he ? 'פתח' : 'Open')}</Text>
        </View>
      </TouchableOpacity>

      {open ? (
        <ScrollView style={styles.list} contentContainerStyle={styles.listInner}>
          {tasks.map((task) => {
            const meta = getCategoryMeta(task.category);
            return (
              <View key={task.id} style={styles.row}>
                <View style={[styles.stripe, { backgroundColor: meta.color }]} />
                <TouchableOpacity
                  style={styles.rowText}
                  onPress={() => onOpenTask?.(task)}
                  onLongPress={() => onOpenTask?.(task)}
                >
                  <Text style={styles.rowTitle} numberOfLines={1}>{meta.icon}  {task.text}</Text>
                  <Text style={styles.rowMeta}>{formatDuration(task.durationMinutes || 30, language)}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.placeBtn} onPress={() => onPlace(task)}>
                  <Text style={styles.placeBtnText}>{he ? 'שבצי' : 'Place'}</Text>
                </TouchableOpacity>
              </View>
            );
          })}
        </ScrollView>
      ) : null}
    </BlurView>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderTopWidth: 1, borderTopColor: BRAND.line,
    borderTopLeftRadius: RADIUS.card, borderTopRightRadius: RADIUS.card,
    overflow: 'hidden', backgroundColor: surf('rgba(255,253,247,0.55)'),
  },
  handleArea: { paddingTop: 9, paddingHorizontal: 16, paddingBottom: 11 },
  handle: {
    width: 38, height: 4, borderRadius: 2, backgroundColor: BRAND.line,
    alignSelf: 'center', marginBottom: 9,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontFamily: FONTS.bodyBold, fontSize: 12.5, color: BRAND.warmInk },
  hint: { fontFamily: FONTS.bodySemi, fontSize: 11, color: BRAND.timeChipText },
  list: { maxHeight: 260 },
  listInner: { paddingHorizontal: 14, paddingBottom: 16, gap: 8 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: BRAND.creamCard, borderWidth: 1, borderColor: BRAND.line,
    borderRadius: RADIUS.chip, paddingVertical: 9, paddingHorizontal: 10,
  },
  stripe: { width: 3, height: 26, borderRadius: 2 },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { fontFamily: FONTS.bodySemi, fontSize: 13, color: BRAND.warmInk },
  rowMeta: { fontFamily: FONTS.body, fontSize: 11, color: BRAND.inkFaint },
  placeBtn: {
    backgroundColor: BRAND.sunGold, borderRadius: RADIUS.pill,
    paddingHorizontal: 12, paddingVertical: 6,
  },
  placeBtnText: { fontFamily: FONTS.bodyBold, fontSize: 11, color: BRAND.warmInk },
});
