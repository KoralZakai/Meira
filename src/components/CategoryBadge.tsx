/** CategoryBadge — colored icon+label chip for a TaskCategory (CATEGORY_META). */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { TaskCategory } from '../types/index';
import { BRAND, CATEGORY_META, FONTS, RADIUS } from '../constants/theme';

interface Props {
  category: TaskCategory;
  size?: 'small' | 'medium' | 'large';
}

export function CategoryBadge({ category, size = 'medium' }: Props) {
  const meta = CATEGORY_META[category] || CATEGORY_META.general;

  const sizeStyles = {
    small: styles.small,
    medium: styles.medium,
    large: styles.large,
  };

  const iconSizes = {
    small: 12,
    medium: 16,
    large: 20,
  };

  return (
    <View style={[styles.badge, sizeStyles[size], { backgroundColor: meta.color }]}>
      <Text style={[styles.icon, { fontSize: iconSizes[size] }]}>{meta.icon}</Text>
      <Text style={[styles.label, sizeStyles[size] === styles.large && styles.labelLarge]}>
        {meta.labelEn}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: RADIUS.card,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  small: {
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  medium: {
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  large: {
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  icon: {
    fontFamily: FONTS.bodySemi,
  },
  label: {
    fontSize: 12,
    fontFamily: FONTS.bodySemi,
    color: BRAND.warmInk,
  },
  labelLarge: {
    fontSize: 14,
  },
});
