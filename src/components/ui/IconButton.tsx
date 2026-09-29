/** IconButton — round, 36–44px: soft (cream) or gold. Press: scale 0.95. */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { BRAND, GRADIENTS, SHADOWS } from '../../constants/theme';

interface Props {
  icon: string;
  onPress: () => void;
  label: string;
  tone?: 'soft' | 'gold' | 'plain';
  size?: number;
}

export default function IconButton({ icon, onPress, label, tone = 'soft', size = 40 }: Props) {
  const round = { width: size, height: size, borderRadius: size / 2 };
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      style={({ pressed }) => [pressed && { transform: [{ scale: 0.95 }] }]}
    >
      {tone === 'gold' ? (
        <LinearGradient colors={[GRADIENTS.primary[0], GRADIENTS.primary[1]]} style={[styles.center, round, SHADOWS.button]}>
          <Text style={[styles.icon, { color: BRAND.onGold }]}>{icon}</Text>
        </LinearGradient>
      ) : (
        <View style={[styles.center, round, tone === 'soft' ? styles.soft : null]}>
          <Text style={[styles.icon, { color: BRAND.warmInk }]}>{icon}</Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  soft: { backgroundColor: BRAND.cream, borderWidth: 1, borderColor: BRAND.line },
  icon: { fontSize: 18, fontWeight: '800' },
});
