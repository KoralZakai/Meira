/** FilterChip — a pill that is on or off ("Today", "Tomorrow", "Mon 5 Oct ▾"). */
import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { BRAND, FONTS } from '../../constants/theme';

interface Props { label: string; active?: boolean; onPress: () => void; tone?: 'plain' | 'honey' }

export default function FilterChip({ label, active = false, onPress, tone = 'plain' }: Props) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={({ pressed }) => [
        styles.chip,
        tone === 'honey' && styles.honey,
        active && styles.active,
        pressed && { opacity: 0.85 },
      ]}
    >
      <Text style={[styles.text, active && styles.activeText]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, backgroundColor: BRAND.creamCard, borderWidth: 1, borderColor: BRAND.line },
  honey: { backgroundColor: BRAND.goldSoft, borderColor: BRAND.goldSoft },
  active: { backgroundColor: BRAND.warmInk, borderColor: BRAND.warmInk },
  text: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.goldInk },
  activeText: { color: BRAND.white },
});
