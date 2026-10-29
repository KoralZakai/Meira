/**
 * NowAddRow — the + under the now line: the time she has, and a way to use it.
 *
 * Koral, 30.9: "like A, but with a plus below, like in Today later". When now
 * falls inside a free window it says how long is left of it ("Free now, until
 * 15:03 · 53 min"); when she is busy or leaving it points at the next window
 * instead of claiming time she does not have.
 *
 * The clock time is its OWN Text and never shrinks; the words before it do. In
 * one string the time was the end of the sentence, so on a narrow phone, or in
 * Hebrew where the words run longer, "next free 15:03" was cut to "next fr…" —
 * the one part of the line she was reading it for.
 */
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BRAND, FONTS, MIN_TOUCH } from '../../constants/theme';
import { readingRow } from './readingRow';

interface Props {
  he: boolean;
  /** Now is inside a free window that ends here. */
  freeUntil?: string;
  freeMinutes?: number;
  /** Otherwise: the next free window. */
  nextStart?: string;
  nextMinutes?: number;
  onPress: () => void;
  /** Its suggestions are open under it. */
  open?: boolean;
}

export function formatSpan(minutes: number, he: boolean): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (he) return h ? (m ? `${h} ש׳ ${m} דק׳` : `${h} ש׳`) : `${m} דק׳`;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m} min`;
}

export default function NowAddRow({ he, freeUntil, freeMinutes, nextStart, nextMinutes, onPress, open }: Props) {
  const label = freeUntil
    ? (he ? 'פנוי עכשיו, עד' : 'Free now, until')
    : nextStart
      ? (he ? 'להוסיף משהו · פנוי הבא' : 'Add something · next free')
      : (he ? 'להוסיף משהו' : 'Add something');
  const time = freeUntil ?? nextStart ?? '';
  const span = freeUntil ? freeMinutes : nextStart ? nextMinutes : undefined;
  return (
    <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.7} accessibilityRole="button"
      accessibilityLabel={time ? `${label} ${time}` : label}>
      <View style={styles.plus}><Text style={styles.plusText}>{open ? '×' : '+'}</Text></View>
      {/* Label then time, in the order the language reads them. */}
      <View style={[styles.words, { flexDirection: readingRow(he) }]}>
        <Text style={styles.label} numberOfLines={1}>{label}</Text>
        {time ? <Text style={styles.time}>{time}</Text> : null}
      </View>
      {span ? <Text style={styles.span}>{formatSpan(span, he)}</Text> : null}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: MIN_TOUCH + 4, flexDirection: 'row', alignItems: 'center', gap: 10,
    borderWidth: 1.5, borderColor: BRAND.sunGold, backgroundColor: BRAND.goldSoft,
    borderRadius: 14, paddingVertical: 8, paddingLeft: 8, paddingRight: 12, marginBottom: 10,
  },
  plus: {
    width: 28, height: 28, borderRadius: 14, backgroundColor: BRAND.honey,
    alignItems: 'center', justifyContent: 'center',
  },
  // "+" and "×" are in Inter; the full-width plus this used to draw is not.
  plusText: { fontFamily: FONTS.bodyHeavy, fontSize: 18, lineHeight: 22, color: BRAND.warmInk },
  words: { flex: 1, minWidth: 0, alignItems: 'center', gap: 6 },
  label: { flexShrink: 1, fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.warmInk },
  time: { flexShrink: 0, fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.warmInk, fontVariant: ['tabular-nums'] },
  span: { flexShrink: 0, fontFamily: FONTS.bodyHeavy, fontSize: 12, color: BRAND.goldInk },
});
