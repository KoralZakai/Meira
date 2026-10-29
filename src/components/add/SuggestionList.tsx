/**
 * SuggestionList — "Suggested for you", under an empty Add input.
 *
 * Up to five rows, each one tap. A row is an icon, what it is (bold, up to two
 * lines) and WHY it is offered (one short clause) — the why is what makes a
 * suggestion believable instead of random.
 *
 * It never lies by being empty: while it loads there is a line saying so (and
 * the space is reserved, so the screen does not jump when rows arrive); when
 * every source failed it says it could not look; when they answered with
 * nothing it says there is nothing — three different states, three different
 * lines (CLAUDE.md, silent-state rule 1).
 */
import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { BRAND, FONTS, MIN_TOUCH } from '../../constants/theme';
import type { Suggestion } from '../../utils/addSuggestions';
import { readingRow } from '../today/readingRow';
import { pinned } from './LiveChips';

interface Props {
  he: boolean;
  rows: Suggestion[];
  loading: boolean;
  allFailed: boolean;
  onPick: (row: Suggestion) => void;
  /** A row whose tap is being applied (it dims; a second tap is ignored). */
  busyId?: string | null;
  /**
   * Drawn on Today under "+ Add something" (Koral, 17.10), where there is no
   * input above it: the empty lines point at "Add your own" below instead.
   */
  onToday?: boolean;
}

export default function SuggestionList({ he, rows, loading, allFailed, onPick, busyId, onToday = false }: Props) {
  const kicker = onToday ? (he ? 'מאירה מציעה' : 'Meira suggests') : (he ? 'הצעות בשבילך' : 'Suggested for you');
  const where = onToday
    ? (he ? 'אפשר להוסיף משלך למטה' : 'add your own below')
    : (he ? 'אפשר לכתוב כל דבר למעלה' : 'type anything above');
  return (
    <View style={styles.box} accessibilityLabel={kicker}>
      <Text style={styles.kicker}>{pinned(he, kicker)}</Text>
      {loading ? (
        <View style={[styles.note, { flexDirection: readingRow(he) }]}>
          <ActivityIndicator size="small" color={BRAND.goldInk} />
          <Text style={styles.noteText}>{pinned(he, he ? 'מסתכלת על היום שלך…' : 'Looking at your day…')}</Text>
        </View>
      ) : rows.length === 0 ? (
        <Text style={styles.noteText}>
          {pinned(he, allFailed
            ? (he ? `לא הצלחתי להסתכל על היום עכשיו — ${where}` : `Couldn't look at your day just now — ${where}`)
            : (he ? `אין לי הצעה כרגע — ${where}` : `Nothing to suggest right now — ${where}`))}
        </Text>
      ) : (
        rows.map((r) => {
          const busy = busyId === r.id;
          return (
            <Pressable
              key={r.id}
              onPress={() => onPick(r)}
              disabled={Boolean(busyId)}
              accessibilityRole="button"
              accessibilityLabel={`${he ? r.titleHe : r.title}. ${he ? r.whyHe : r.why}`}
              style={({ pressed }) => [
                styles.row, { flexDirection: readingRow(he) }, (pressed || busy) && styles.pressed,
              ]}
            >
              <Text style={styles.icon}>{r.icon}</Text>
              <View style={styles.texts}>
                <Text style={styles.title} numberOfLines={2}>{pinned(he, he ? r.titleHe : r.title)}</Text>
                <Text style={styles.why} numberOfLines={2}>{pinned(he, he ? r.whyHe : r.why)}</Text>
              </View>
              {/* A + adds. An 'open' row adds nothing — it opens the task so she
                  picks the time — so it is drawn as a way in (›), never as a + that
                  does nothing (18.10: "the + doesn't add any task"). */}
              {busy
                ? <ActivityIndicator size="small" color={BRAND.goldInk} />
                : r.action.kind === 'open'
                  ? <View style={styles.open}><Text style={styles.openText}>{he ? '‹' : '›'}</Text></View>
                  : <View style={styles.plus}><Text style={styles.plusText}>+</Text></View>}
            </Pressable>
          );
        })
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: 8, minHeight: 96 },
  kicker: { fontFamily: FONTS.bodyHeavy, fontSize: 12, color: BRAND.goldInk, letterSpacing: 0.4, textTransform: 'uppercase' },
  note: { alignItems: 'center', gap: 8, minHeight: MIN_TOUCH },
  noteText: { flexShrink: 1, fontFamily: FONTS.bodySemi, fontSize: 13, lineHeight: 18, color: BRAND.inkSoft },
  row: {
    minHeight: MIN_TOUCH + 12, alignItems: 'center', gap: 12,
    backgroundColor: BRAND.creamCard, borderWidth: 1, borderColor: BRAND.line, borderRadius: 16,
    paddingVertical: 10, paddingHorizontal: 12,
  },
  pressed: { opacity: 0.6 },
  icon: { fontSize: 22 },
  texts: { flex: 1, minWidth: 0, gap: 2 },
  title: { fontFamily: FONTS.bodyBold, fontSize: 14, lineHeight: 19, color: BRAND.warmInk },
  why: { fontFamily: FONTS.bodySemi, fontSize: 12, lineHeight: 16, color: BRAND.inkSoft },
  plus: {
    width: 32, height: 32, borderRadius: 16, backgroundColor: BRAND.honey,
    alignItems: 'center', justifyContent: 'center',
  },
  plusText: { fontFamily: FONTS.bodyHeavy, fontSize: 18, lineHeight: 22, color: BRAND.warmInk },
  open: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  openText: { fontFamily: FONTS.bodyHeavy, fontSize: 22, lineHeight: 26, color: BRAND.goldInk },
});
