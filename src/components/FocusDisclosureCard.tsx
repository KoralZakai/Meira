/**
 * FocusDisclosureCard — the prominent disclosure Play requires before Meira sends her to grant
 * Usage access or Display over other apps.
 *
 * Shown in place of the panel (or the lecture's fix notice) the first time she taps "Allow", so it
 * cannot be scrolled past. What it says lives in utils/focusSession `focusDisclosure`; whether she
 * has read it lives in FocusSessionService, which refuses to open Settings until she has — so no
 * caller can skip this card. "Not now" goes back without opening anything.
 */
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BRAND, FONTS, MIN_TOUCH, RADIUS } from '../constants/theme';
import { focusDisclosure } from '../utils/focusSession';
import type { AppLanguage } from '../types/index';

interface Props {
  lang: AppLanguage;
  onAccept: () => void;
  onDecline: () => void;
}

export default function FocusDisclosureCard({ lang, onAccept, onDecline }: Props) {
  const D = focusDisclosure(lang);
  const align = lang === 'he' ? ({ textAlign: 'right', writingDirection: 'rtl' } as const) : undefined;
  return (
    <View style={styles.card} accessibilityRole="alert">
      <Text style={[styles.title, align]}>{D.title}</Text>
      {D.lines.map((line) => (
        <Text key={line} style={[styles.line, align]}>{line}</Text>
      ))}
      <TouchableOpacity style={styles.primary} onPress={onAccept} accessibilityRole="button">
        <Text style={styles.primaryText}>{D.accept}</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.secondary} onPress={onDecline} accessibilityRole="button">
        <Text style={styles.secondaryText}>{D.decline}</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: BRAND.goldSoft, borderRadius: RADIUS.card, padding: 16, gap: 10,
  },
  title: { fontFamily: FONTS.display, fontSize: 18, color: BRAND.warmInk },
  line: { fontFamily: FONTS.body, fontSize: 14, lineHeight: 20, color: BRAND.warmInk },
  primary: {
    minHeight: 52, borderRadius: RADIUS.button, backgroundColor: BRAND.sunGold,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, paddingVertical: 8,
  },
  primaryText: { fontFamily: FONTS.bodyHeavy, fontSize: 16, color: BRAND.onGold, textAlign: 'center' },
  secondary: { minHeight: MIN_TOUCH, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  secondaryText: { fontFamily: FONTS.bodyBold, fontSize: 14, color: BRAND.inkSoft, textAlign: 'center' },
});
