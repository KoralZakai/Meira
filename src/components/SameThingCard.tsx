/**
 * SameThingCard — "is this the same interview?"
 *
 * Three rows for one appointment, each with a different hour and a different
 * place, is what a conversation leaves behind: every new detail arrives as a
 * new task because the words changed. Silently merging them would mean picking
 * an hour for her, and the wrong hour on an interview is the worst thing this
 * app can get wrong. So it asks — once, plainly, with the disagreement shown
 * rather than described.
 *
 * The whole design is the comparison: each candidate is a row with its clock
 * time and its place side by side, and the values that DISAGREE are marked, so
 * the choice is a glance rather than a reading exercise. One tap keeps that
 * version; the others are folded into it (recoverable — 'moved', not deleted).
 * "They're different" dismisses the question for good.
 *
 * Presentational: the caller owns the tasks and both actions.
 * Dependencies: constants/theme, constants/categories, likelySameTask (types).
 * Consumed by screens/TodaySchedule.
 */
import React, { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BRAND, FONTS, RADIUS, SHADOWS } from '../constants/theme';
import { getCategoryMeta } from '../constants/categories';
import { AppLanguage, Task } from '../types/index';
import { SameThingGroup } from '../utils/likelySameTask';

interface Props {
  group: SameThingGroup;
  language: AppLanguage;
  /** Keep this one; fold the rest into it. */
  onKeep: (chosen: Task, others: Task[]) => void;
  /** They really are different things — stop asking. */
  onDismiss: (group: SameThingGroup) => void;
}

const placeText = (task: Task): string => {
  const loc: any = task.location;
  return (typeof loc === 'string' ? loc : (loc?.displayName || loc?.address || '')) || '';
};

export default function SameThingCard({ group, language, onKeep, onDismiss }: Props) {
  const he = language === 'he';
  const [busy, setBusy] = useState(false);
  const meta = getCategoryMeta(group.tasks[0].category);

  // Name the disagreement in her words — this is WHY she is being asked.
  const what = group.differs.map((d) => (
    d === 'time' ? (he ? 'שעה' : 'time')
      : d === 'place' ? (he ? 'מקום' : 'place')
        : (he ? 'משך' : 'length')
  ));
  const why = what.length
    ? (he ? `נבדלות ב${what.join(' וב')}` : `they disagree on ${what.join(' and ')}`)
    : (he ? 'נראות זהות' : 'they look identical');

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Text style={styles.sign}>🔁</Text>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>
            {he
              ? `${group.tasks.length} משימות נראות כמו אותו ${meta.labelHe || 'דבר'}`
              : `${group.tasks.length} tasks look like the same ${meta.labelEn || 'thing'}`}
          </Text>
          <Text style={styles.why}>{why} · {he ? 'איזו נכונה?' : 'which one is right?'}</Text>
        </View>
      </View>

      {group.tasks.map((task) => (
        <TouchableOpacity
          key={task.id}
          style={styles.row}
          activeOpacity={0.85}
          disabled={busy}
          onPress={() => {
            setBusy(true);
            onKeep(task, group.tasks.filter((t) => t.id !== task.id));
          }}
        >
          <View style={[styles.stripe, { backgroundColor: meta.color }]} />
          <View style={{ flex: 1 }}>
            <Text style={styles.rowText} numberOfLines={2}>{task.text}</Text>
            <View style={styles.facts}>
              <Text style={[styles.fact, group.differs.includes('time') && styles.factDiffers]}>
                🕐 {task.fixedTime || task.scheduledTime || (he ? 'ללא שעה' : 'no time')}
              </Text>
              <Text style={[styles.fact, group.differs.includes('place') && styles.factDiffers]}>
                📍 {placeText(task) || (he ? 'ללא מקום' : 'no place')}
              </Text>
            </View>
          </View>
          <Text style={styles.keep}>{he ? 'זו הנכונה' : 'This one'}</Text>
        </TouchableOpacity>
      ))}

      <TouchableOpacity
        style={styles.different}
        onPress={() => onDismiss(group)}
        disabled={busy}
        activeOpacity={0.85}
      >
        <Text style={styles.differentText}>
          {he ? 'הן דברים שונים — אל תשאלי שוב' : "They're different — stop asking"}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: BRAND.creamCard,
    borderRadius: RADIUS.card,
    borderWidth: 1,
    borderColor: BRAND.honey,
    padding: 12,
    marginBottom: 12,
    ...SHADOWS.card,
  },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: 8 },
  sign: { fontSize: 18 },
  title: { fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.warmInk },
  why: { fontFamily: FONTS.body, fontSize: 12, color: BRAND.inkSoft, marginTop: 2 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderWidth: 1, borderColor: BRAND.line, borderRadius: RADIUS.chip,
    padding: 8, marginTop: 6, backgroundColor: BRAND.white,
  },
  stripe: { width: 4, alignSelf: 'stretch', borderRadius: 2 },
  rowText: { fontFamily: FONTS.bodyBold, fontSize: 13, color: BRAND.warmInk },
  facts: { flexDirection: 'row', gap: 10, marginTop: 3, flexWrap: 'wrap' },
  fact: { fontFamily: FONTS.body, fontSize: 11, color: BRAND.inkFaint },
  // The values that disagree are the reason she is being asked — mark them.
  factDiffers: {
    fontFamily: FONTS.bodyHeavy, color: BRAND.danger,
  },
  keep: {
    fontFamily: FONTS.bodyHeavy, fontSize: 11, color: '#4A3512',
    backgroundColor: BRAND.sunGold, borderRadius: 999,
    paddingHorizontal: 10, paddingVertical: 5,
  },
  different: { alignItems: 'center', paddingTop: 10, marginTop: 4, borderTopWidth: 1, borderTopColor: BRAND.line },
  differentText: { fontFamily: FONTS.bodyBold, fontSize: 12, color: BRAND.inkFaint },
});
