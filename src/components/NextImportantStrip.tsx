/**
 * NextImportantStrip — the one thing that matters next, as a gold pill.
 *
 * Koral, 28.9 (option N2): the big NEXT UP card was "too big". This keeps its
 * three facts on one line — what, when, and the ⏰ wake alarm when one is
 * planned (CLAUDE.md rule 5: a plan that exists must be visible without a
 * tap; the NEXT UP card was the alarm's only home) — and puts the meeting
 * brief underneath as one tappable line.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { BRAND, FONTS } from '../constants/theme';
import { getCategoryMeta } from '../constants/categories';
import { Task } from '../types';

const HEB = /[֐-׿]/;

interface Props {
  task: Task;
  he: boolean;
  /** "11:00", or "Tue 11:00" when it is not today. */
  when: string;
  /** The planned wake alarm for this task, if any; muted = she turned it off. */
  wake?: { at: string; muted: boolean } | null;
  leaveAt?: string | null;
  briefReady?: boolean;
  /** The line under the pill; defaults to the meeting-brief wording. */
  briefLabel?: string;
  /** Late to it: started, not there yet. Turns the pill red with the live ETA. */
  late?: { minutes: number; arriveAt?: string | null } | null;
  onPress: () => void;
  onAlarm?: () => void;
  onBrief?: () => void;
}

export default function NextImportantStrip({ task, he, when, wake, leaveAt, briefReady, briefLabel, late, onPress, onAlarm, onBrief }: Props) {
  const meta = getCategoryMeta(task.category);
  const rtl = HEB.test(task.text);
  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [styles.pill, late && styles.pillLate, pressed && { opacity: 0.85 }]}
        accessibilityRole="button"
        accessibilityLabel={`${he ? 'הדבר החשוב הבא' : 'Next important'}: ${task.text}, ${when}`}
      >
        <Text style={styles.icon}>{meta.icon}</Text>
        <Text style={[styles.title, rtl && styles.rtl, late && styles.onLate]} numberOfLines={1}>{task.text}</Text>
        {late ? (
          <Text style={[styles.when, styles.onLate]} numberOfLines={1}>
            {he ? `באיחור ${late.minutes} דק׳` : `${late.minutes} min late`}
            {late.arriveAt ? (he ? ` · הגעה ${late.arriveAt}` : ` · arrive ${late.arriveAt}`) : (he ? ' · צאי עכשיו' : ' · leave now')}
          </Text>
        ) : (
          <Text style={styles.when}>{when}</Text>
        )}
        {leaveAt ? <Text style={styles.when}>· 🚪 {leaveAt}</Text> : null}
        {wake ? (
          <Pressable onPress={onAlarm} hitSlop={10} accessibilityRole="button"
            accessibilityLabel={he ? `שעון מעורר ${wake.at}` : `Wake alarm ${wake.at}`}>
            <Text style={styles.when}>· {wake.muted ? '🔕' : '⏰'} {wake.at}</Text>
          </Pressable>
        ) : null}
        <Text style={[styles.chev, late && styles.onLate]}>›</Text>
      </Pressable>
      {briefReady ? (
        <Pressable onPress={onBrief} style={({ pressed }) => [styles.brief, pressed && { opacity: 0.7 }]} accessibilityRole="button">
          <Text style={styles.briefText} numberOfLines={1}>
            {briefLabel ?? (he ? '🔎 המחקר מוכן: החברה, האדם ו-3 שאלות ›' : '🔎 Brief ready: the company, the person, 3 questions ›')}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 12 },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: BRAND.sunGold, borderRadius: 999,
    paddingVertical: 10, paddingHorizontal: 14, minHeight: 44,
  },
  icon: { fontSize: 15 },
  title: { flex: 1, fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.onGold },
  rtl: { writingDirection: 'rtl', textAlign: 'right' },
  pillLate: { backgroundColor: BRAND.danger },
  onLate: { color: BRAND.white },
  when: { fontFamily: FONTS.bodyBold, fontSize: 12, color: '#7A5A18' },
  chev: { fontFamily: FONTS.bodyHeavy, fontSize: 16, color: BRAND.onGold, marginLeft: 2 },
  brief: { paddingTop: 6, paddingHorizontal: 14 },
  briefText: { fontFamily: FONTS.bodyHeavy, fontSize: 12, color: BRAND.goldInk },
});
