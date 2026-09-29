/** TimeChip — "🚪 Leave 19:12 · 🚴 12 min" on #FCF1D6. */
import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { BRAND, FONTS } from '../../constants/theme';

export default function TimeChip({ children }: { children: React.ReactNode }) {
  return <Text style={styles.chip}>{children}</Text>;
}

const styles = StyleSheet.create({
  chip: {
    alignSelf: 'flex-start', overflow: 'hidden',
    backgroundColor: BRAND.timeChipBg, color: BRAND.timeChipText,
    fontFamily: FONTS.bodyHeavy, fontSize: 12,
    borderRadius: 12, paddingHorizontal: 9, paddingVertical: 5,
  },
});
