/** RewardToast — '+N pts' toast shown on completions and rewards. */
import React, { useEffect, useState } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { BRAND, FONTS, RADIUS, SHADOWS } from '../constants/theme';

interface Props {
  visible: boolean;
  message: string;
  icon?: string;
  points?: number;
  duration?: number;
  onDismiss: () => void;
}

export function RewardToast({ visible, message, icon = '⭐', points, duration = 2000, onDismiss }: Props) {
  const [fadeAnim] = useState(new Animated.Value(0));

  useEffect(() => {
    if (visible) {
      Animated.sequence([
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }),
        Animated.delay(duration),
        Animated.timing(fadeAnim, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start(() => {
        onDismiss();
      });
    }
  }, [visible]);

  if (!visible) return null;

  return (
    <Animated.View
      style={[
        styles.toast,
        {
          opacity: fadeAnim,
        },
      ]}
    >
      <View style={styles.content}>
        <Text style={styles.icon}>{icon}</Text>
        <View style={styles.textContainer}>
          <Text style={styles.message}>{message}</Text>
          {points && <Text style={styles.points}>+{points} pts</Text>}
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  toast: {
    position: 'absolute',
    bottom: 40,
    left: 16,
    right: 16,
    backgroundColor: BRAND.sunGold,
    borderRadius: RADIUS.chip,
    paddingVertical: 12,
    paddingHorizontal: 16,
    shadowColor: SHADOWS.card.shadowColor,
    shadowOpacity: 0.2,
    shadowRadius: 6,
    elevation: 4,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  icon: {
    fontSize: 20,
  },
  textContainer: {
    flex: 1,
  },
  message: {
    fontSize: 14,
    fontFamily: FONTS.bodySemi,
    color: '#FFF',
  },
  points: {
    fontSize: 12,
    color: BRAND.sunGold,
    fontFamily: FONTS.bodyBold,
  },
});
