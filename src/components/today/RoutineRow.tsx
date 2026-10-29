/**
 * RoutineRow — one of her routines, on the day it falls, at its hour (6.10,
 * her pick "A"). Dashed: it is not a task until she says she is going. "✓ Going"
 * makes it one (with the address, so it routes); "Not today" hides it for this
 * date only. Until she answers, its hour is not offered as free time.
 */
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BRAND, FONTS } from '../../constants/theme';
import type { RoutineRow as Row } from '../../utils/routineRows';

interface Props {
  row: Row;
  he: boolean;
  onGoing: () => void;
  onSkip: () => void;
  /** She never wrote its days: "every day? ›" opens Meira's question about it. */
  onAskDays?: () => void;
}

const HEBREW = /[֐-׿]/;

export default function RoutineRow({ row, he, onGoing, onSkip, onAskDays }: Props) {
  const from = row.routine.daysFrom;
  // Where its days come from, said on the row (rule 4): a rule she taught
  // Meira, or nothing yet — then the row carries the question itself.
  const daysNote = from === 'rule' ? (he ? ' · לפי כלל שלימדת' : ' · by your rule') : '';
  return (
    <View style={styles.card}>
      <View style={styles.top}>
        <Text style={styles.when}>{`🔁 ${row.start}–${row.end}`}</Text>
        {from === 'unsaid' && onAskDays && (
          <TouchableOpacity onPress={onAskDays} style={styles.askChip} accessibilityRole="button"
            accessibilityLabel={he ? `באילו ימים ${row.title}?` : `Which days is ${row.title}?`}>
            <Text style={styles.askChipText}>{he ? 'כל יום? ›' : 'every day? ›'}</Text>
          </TouchableOpacity>
        )}
      </View>
      <Text style={[styles.title, HEBREW.test(row.title) && styles.rtl]} numberOfLines={2}>{row.title}</Text>
      <Text style={styles.sub} numberOfLines={1}>
        {(he ? 'שגרה' : 'routine') + daysNote + (row.address ? ` · ${row.address}` : '')}
      </Text>
      <View style={styles.actions}>
        <TouchableOpacity style={styles.going} onPress={onGoing} accessibilityRole="button"
          accessibilityLabel={he ? `הולכת ל${row.title}` : `Going to ${row.title}`}>
          <Text style={styles.goingText}>{he ? '✓ הולכת' : '✓ Going'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.skip} onPress={onSkip} accessibilityRole="button">
          <Text style={styles.skipText}>{he ? 'לא היום' : 'Not today'}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1.5, borderStyle: 'dashed', borderColor: BRAND.sunGold, borderRadius: 20,
    padding: 12, gap: 4, backgroundColor: 'rgba(255,209,102,0.08)',
  },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  when: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.goldInk, fontVariant: ['tabular-nums'] },
  askChip: { borderRadius: 999, borderWidth: 1, borderColor: BRAND.sunGold, paddingHorizontal: 10, paddingVertical: 4 },
  askChipText: { fontFamily: FONTS.bodyHeavy, fontSize: 12, color: BRAND.goldInk },
  title: { fontFamily: FONTS.bodyHeavy, fontSize: 17, color: BRAND.warmInk },
  rtl: { textAlign: 'right', writingDirection: 'rtl' },
  sub: { fontFamily: FONTS.body, fontSize: 12, color: BRAND.inkSoft },
  actions: { flexDirection: 'row', gap: 8, marginTop: 6 },
  going: { backgroundColor: BRAND.sunGold, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 7 },
  goingText: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.onGold },
  skip: { borderWidth: 1, borderColor: BRAND.line, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 7 },
  skipText: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.inkSoft },
});
