/** OptimizeButton — the yellow 'Optimize my day' action button. */
import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';
import { BRAND, FONTS, RADIUS, SHADOWS } from '../constants/theme';

interface Props {
  onPress: () => void;
  loading?: boolean;
}

export function OptimizeButton({ onPress, loading }: Props) {
  return (
    <Pressable
      onPress={onPress}
      disabled={loading}
      style={({ pressed }) => [styles.button, pressed && !loading && styles.buttonPressed]}
    >
      {loading ? (
        <ActivityIndicator color={BRAND.white} size="small" />
      ) : (
        <>
          <Text style={styles.icon}>✨</Text>
          <Text style={styles.text}>Optimize my day</Text>
        </>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    backgroundColor: BRAND.sunGold,
    borderRadius: RADIUS.chip,
    paddingVertical: 14,
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginVertical: 12,
    shadowColor: SHADOWS.card.shadowColor,
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  buttonPressed: {
    opacity: 0.8,
  },
  icon: {
    fontSize: 18,
  },
  text: {
    fontSize: 16,
    fontFamily: FONTS.bodyBold,
    color: BRAND.white,
  },
});
