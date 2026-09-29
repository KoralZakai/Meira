/** SectionLabel — the 11px tracked eyebrow ("NEXT UP", "IDEAS FOR THIS WINDOW"). */
import React from 'react';
import { StyleSheet, Text, TextStyle } from 'react-native';
import { BRAND, FONTS } from '../../constants/theme';

export default function SectionLabel({ children, tone = 'faint', style }:
{ children: React.ReactNode; tone?: 'faint' | 'time'; style?: TextStyle }) {
  return <Text style={[styles.label, { color: tone === 'time' ? BRAND.goldInk : BRAND.inkFaint }, style]}>{children}</Text>;
}

const styles = StyleSheet.create({
  label: { fontFamily: FONTS.bodyHeavy, fontSize: 11, letterSpacing: 1.2, textTransform: 'uppercase' },
});
