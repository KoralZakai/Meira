/**
 * EarlierRow — what already happened today, folded into one line.
 *
 * Past cards above the now line push what is next off the screen, which is
 * the opposite of what Today is for. They fold into "3 earlier today ▼" and
 * open on a tap — never hidden without a way back (rule 4 in spirit).
 */
import React from 'react';
import { StyleSheet, Text, TouchableOpacity } from 'react-native';
import { BRAND, FONTS } from '../../constants/theme';

interface Props {
  count: number;
  icons: string[];
  open: boolean;
  he: boolean;
  onToggle: () => void;
}

export default function EarlierRow({ count, icons, open, he, onToggle }: Props) {
  return (
    <TouchableOpacity style={styles.row} onPress={onToggle} activeOpacity={0.7}
      accessibilityRole="button" accessibilityState={{ expanded: open }}>
      <Text style={styles.icons}>{icons.slice(0, 3).join('')}</Text>
      <Text style={styles.label}>{he ? `${count} מוקדם יותר היום` : `${count} earlier today`}</Text>
      <Text style={styles.caret}>{open ? '▲' : '▼'}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 14, borderRadius: 16, backgroundColor: '#F5EEDD', marginBottom: 10,
  },
  icons: { fontSize: 15, letterSpacing: -2 },
  label: { flex: 1, fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.inkSoft },
  // ▲▼ exist in Inter; the small triangles (U+25B4 / U+25BE) do not and fell back to another face.
  caret: { fontFamily: FONTS.bodyHeavy, fontSize: 10, color: BRAND.inkSoft },
});
