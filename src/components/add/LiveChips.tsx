/**
 * LiveChips — a wrapping row of small answers: "what I understood", and
 * "what Meira concluded".
 *
 * A chip is one fact in one pill. When it can be acted on it is at least
 * MIN_TOUCH tall and says what a tap does (tap = edit); when it carries a ✕ the
 * ✕ has its own 44 dp target (visually small, reached with hitSlop). A chip
 * that only informs is not pressable at all and not drawn like a button.
 *
 * Text never overflows: the label is a single line that gives way
 * (flexShrink + numberOfLines), the pill never grows past the row, and the row
 * wraps. In Hebrew the row reads from the right (utils readingRow) and every
 * label is pinned to the app language with a direction mark, because
 * `writingDirection` is ignored on Android.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { BRAND, FONTS, MIN_TOUCH } from '../../constants/theme';
import { readingRow } from '../today/readingRow';

export type ChipTone = 'gold' | 'soft' | 'meira' | 'warn';

export interface Chip {
  key: string;
  icon?: string;
  label: string;
  tone?: ChipTone;
  /** Tap = edit / act. Absent = the chip only informs. */
  onPress?: () => void;
  /** ✕ — removes it (and, for a chip made of her words, those words). */
  onRemove?: () => void;
  /** Screen-reader sentence for the body; defaults to the label. */
  a11y?: string;
  a11yHint?: string;
  removeLabel?: string;
  /** Drawn as done: struck back to a quiet tint, not pressable. */
  done?: boolean;
}

/** Pin a string to the app language so a Hebrew name inside English UI (and the reverse) keeps its place. */
export const pinned = (he: boolean, s: string): string => (he ? '‏' : '‎') + s;
/** A clock range that must read left to right even inside Hebrew: 13:30–14:00. */
export const ltr = (s: string): string => `‎${s}‎`;

interface Props { chips: Chip[]; he: boolean; testID?: string }

export default function LiveChips({ chips, he, testID }: Props) {
  if (!chips.length) return null;
  return (
    <View style={[styles.wrap, { flexDirection: readingRow(he) }]} testID={testID}>
      {chips.map((c) => {
        const tone = TONES[c.done ? 'soft' : c.tone ?? 'soft'];
        const interactive = Boolean(c.onPress) && !c.done;
        return (
          <View
            key={c.key}
            style={[
              styles.chip, { backgroundColor: tone.bg, borderColor: tone.border, flexDirection: readingRow(he) },
              interactive || c.onRemove ? styles.touch : styles.info,
              c.done && styles.done,
            ]}
          >
            {interactive ? (
              <Pressable
                onPress={c.onPress}
                accessibilityRole="button"
                accessibilityLabel={c.a11y ?? c.label}
                accessibilityHint={c.a11yHint}
                style={({ pressed }) => [styles.body, { flexDirection: readingRow(he) }, pressed && styles.pressed]}
              >
                {c.icon ? <Text style={styles.icon}>{c.icon}</Text> : null}
                <Text style={[styles.label, { color: tone.ink }]} numberOfLines={1}>{pinned(he, c.label)}</Text>
              </Pressable>
            ) : (
              <View
                style={[styles.body, { flexDirection: readingRow(he) }]}
                accessible
                accessibilityLabel={c.a11y ?? c.label}
              >
                {c.done || c.icon ? <Text style={styles.icon}>{c.done ? '✅' : c.icon}</Text> : null}
                <Text style={[styles.label, { color: tone.ink }]} numberOfLines={1}>{pinned(he, c.label)}</Text>
              </View>
            )}
            {c.onRemove && !c.done ? (
              <Pressable
                onPress={c.onRemove}
                hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
                accessibilityRole="button"
                accessibilityLabel={c.removeLabel ?? (he ? 'להסיר' : 'Remove')}
                style={({ pressed }) => [styles.x, pressed && styles.pressed]}
              >
                <Text style={[styles.xText, { color: tone.ink }]}>×</Text>
              </Pressable>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

const TONES: Record<ChipTone, { bg: string; border: string; ink: string }> = {
  // What the screen understood.
  gold: { bg: BRAND.goldSoft, border: BRAND.sunGold, ink: BRAND.warmInk },
  // Plain facts and finished things.
  soft: { bg: BRAND.creamCard, border: BRAND.line, ink: BRAND.warmInk },
  // What Meira concluded.
  meira: { bg: BRAND.honey, border: BRAND.sunGold, ink: BRAND.onGold },
  // Needs a decision from her (two contacts answer to one name).
  warn: { bg: BRAND.creamCard, border: BRAND.goldInk, ink: BRAND.goldInk },
};

const styles = StyleSheet.create({
  wrap: { flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  chip: {
    maxWidth: '100%', borderWidth: 1, borderRadius: 999, alignItems: 'center',
    overflow: 'hidden',
  },
  touch: { minHeight: MIN_TOUCH },
  info: { minHeight: 32 },
  done: { opacity: 0.85 },
  body: {
    flexShrink: 1, minWidth: 0, alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 6, alignSelf: 'stretch',
  },
  pressed: { opacity: 0.6 },
  icon: { fontSize: 14 },
  label: { flexShrink: 1, fontFamily: FONTS.bodyBold, fontSize: 13 },
  x: { minWidth: 32, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center', paddingEnd: 6 },
  xText: { fontFamily: FONTS.bodyHeavy, fontSize: 18, lineHeight: 20 },
});
