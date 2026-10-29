/**
 * TaskSheetHero — the top of the edit-task sheet in the v3 design (canvas v4).
 *
 * The sheet opened on a bare title and a list of rows; what she opens a task
 * FOR — when, where, and when to walk out — was rows down. This is the same
 * three answers the day card gives, at the top: the category in a pastel
 * circle, the day + hours, the place, and the gold "צאי HH:MM" with the exact
 * minute the train/bus leaves (rule 5: the plan visible without a tap).
 * Read-only — every field stays editable in the rows below.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { BRAND, FONTS, RADIUS } from '../../constants/theme';
import { getCategoryMeta } from '../../constants/categories';
import { ridesOf, RIDE_ICON } from '../../utils/rideLine';
import type { Task } from '../../types';
import { shortPlace } from '../../utils/tripPlaces';

const DAY_HE = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
const DAY_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The hours and the day, apart: "17:00–18:00" and "ה׳ 30.10" (rule 4: the date always shown). */
export function whenParts(task: Task, he: boolean): { span: string; day: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(task.date || '');
  const day = m
    ? `${(he ? DAY_HE : DAY_EN)[new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay()]} ${Number(m[3])}.${Number(m[2])}`
    : '';
  const start = task.fixedTime || task.scheduledTime || '';
  let span = '';
  if (start && /^\d{1,2}:\d{2}$/.test(start)) {
    const [h, mm] = start.split(':').map(Number);
    const end = (h * 60 + mm + (task.durationMinutes || 0)) % 1440;
    span = task.durationMinutes
      ? `${start}–${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`
      : start;
  }
  return { span: span || (he ? 'בלי שעה' : 'no time yet'), day };
}

export default function TaskSheetHero({ task, he }: { task: Task; he: boolean }) {
  const meta = getCategoryMeta(task.category);
  const loc: any = task.location && typeof task.location === 'object' ? task.location : undefined;
  const place = shortPlace(loc?.displayName || loc?.address);
  const leave: string = loc?.leaveHomeBy || loc?.transitPlan?.leaveHomeAt || '';
  const ride = ridesOf(task)[0];
  const done = task.status === 'complete';
  const parts = whenParts(task, he);
  const dir = he ? 'row-reverse' : 'row';
  return (
    <View style={[styles.wrap, { flexDirection: dir }]}>
      <View style={[styles.icon, { backgroundColor: `${meta.color}2E` }]}>
        <Text style={styles.iconText}>{meta.icon}</Text>
      </View>
      <View style={styles.mid}>
        {/* Two lines: an LTR hour range inside an RTL sentence reorders and
            then gets cut ("1…–16:00", 28.10 on the phone). */}
        <Text style={[styles.when, he && styles.rightLtr]} numberOfLines={1} adjustsFontSizeToFit>{parts.span}</Text>
        {parts.day ? <Text style={[styles.place, he && styles.rtl]} numberOfLines={1}>{parts.day}</Text> : null}
        {place ? <Text style={[styles.place, he && styles.rtl]} numberOfLines={1}>{`📍 ${place}`}</Text> : null}
        {/* The ride's exact minute: bold, not on the yellow (28.10). */}
        {leave && !done && ride?.departureTime ? (
          <Text style={[styles.ride, he && styles.rtl]} numberOfLines={1}>
            {`${RIDE_ICON[ride.type] || '🚌'} ${ride.lineNumber ? `${ride.lineNumber} · ` : ''}${ride.departureTime}`}
          </Text>
        ) : null}
        {done ? <Text style={[styles.done, he && styles.rtl]}>{he ? '✓ בוצע' : '✓ Done'}</Text> : null}
      </View>
      {leave && !done ? (
        <View style={styles.leave} accessibilityLabel={he ? `צאי ב־${leave}` : `Leave at ${leave}`}>
          <Text style={styles.leaveSmall} numberOfLines={1}>{he ? 'צאי' : 'leave'}</Text>
          <Text style={styles.leaveBig} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>{leave}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center', gap: 12, padding: 12, marginBottom: 12,
    borderRadius: 22, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: BRAND.line,
  },
  rtl: { textAlign: 'right', writingDirection: 'rtl' },
  // Numbers read left-to-right even on a Hebrew screen: 16:00–17:00, never 17:00–16:00.
  rightLtr: { textAlign: 'right', writingDirection: 'ltr' },
  icon: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center' },
  iconText: { fontSize: 22 },
  mid: { flex: 1, minWidth: 0, gap: 2 },
  when: { fontFamily: FONTS.bodyHeavy, fontSize: 18, color: BRAND.warmInk, fontVariant: ['tabular-nums'] },
  place: { fontFamily: FONTS.bodySemi, fontSize: 12.5, color: BRAND.inkSoft },
  done: { fontFamily: FONTS.bodyHeavy, fontSize: 12, color: BRAND.success },
  leave: {
    alignItems: 'center', paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: RADIUS.chip, backgroundColor: BRAND.sunGold, minWidth: 72,
  },
  leaveSmall: { fontFamily: FONTS.bodyHeavy, fontSize: 11, color: BRAND.onGold },
  leaveBig: { fontFamily: FONTS.bodyHeavy, fontSize: 20, color: BRAND.onGold, fontVariant: ['tabular-nums'] },
  ride: { fontFamily: FONTS.bodyHeavy, fontSize: 16, color: BRAND.warmInk, fontVariant: ['tabular-nums'] },
});
