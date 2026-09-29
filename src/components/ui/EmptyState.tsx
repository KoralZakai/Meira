/** EmptyState — an emoji and one or two lines; an invitation, not an apology. */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { BRAND, FONTS } from '../../constants/theme';

export default function EmptyState({ emoji, text, rtl = false }: { emoji: string; text: string; rtl?: boolean }) {
  return (
    <View style={styles.box}>
      <Text style={styles.emoji}>{emoji}</Text>
      <Text style={[styles.text, rtl && { writingDirection: 'rtl' }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { alignItems: 'center', paddingVertical: 40, paddingHorizontal: 24, gap: 10 },
  emoji: { fontSize: 40 },
  text: { fontFamily: FONTS.bodyBold, fontSize: 15, lineHeight: 22, color: BRAND.inkSoft, textAlign: 'center' },
});
