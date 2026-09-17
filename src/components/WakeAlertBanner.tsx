/** WakeAlertBanner — 'wake by / leave by' banner driven by MorningRoutineService plans. */
import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, Animated, TouchableOpacity } from 'react-native';
import { BRAND, FONTS, RADIUS } from '../constants/theme';
import { AppLanguage } from '../types';

interface WakeAlertBannerProps {
  wakeTime: string;
  leaveTime: string;
  language: AppLanguage;
  onDismiss?: () => void;
}

export default function WakeAlertBanner({ wakeTime, leaveTime, language, onDismiss }: WakeAlertBannerProps) {
  const [slideAnim] = useState(new Animated.Value(-100));

  useEffect(() => {
    Animated.spring(slideAnim, {
      toValue: 0,
      useNativeDriver: true,
      tension: 80,
      friction: 10,
    }).start();
  }, []);

  return (
    <Animated.View style={[styles.container, { transform: [{ translateY: slideAnim }] }]}>
      <View style={styles.banner}>
        <View style={styles.content}>
          <View style={styles.alertItem}>
            <Text style={styles.emoji}>⏰</Text>
            <View>
              <Text style={styles.label}>{language === 'he' ? 'קום בבוקר:' : 'Wake up at:'}</Text>
              <Text style={styles.time}>{wakeTime}</Text>
            </View>
          </View>

          <View style={styles.divider} />

          <View style={styles.alertItem}>
            <Text style={styles.emoji}>🚪</Text>
            <View>
              <Text style={styles.label}>{language === 'he' ? 'צא מהבית:' : 'Leave home at:'}</Text>
              <Text style={styles.time}>{leaveTime}</Text>
            </View>
          </View>
        </View>

        {onDismiss && (
          <TouchableOpacity onPress={onDismiss} style={styles.closeButton}>
            <Text style={styles.closeIcon}>✕</Text>
          </TouchableOpacity>
        )}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  banner: {
    flexDirection: 'row',
    backgroundColor: BRAND.sunGold,
    borderRadius: RADIUS.chip,
    padding: 14,
    justifyContent: 'space-between',
    alignItems: 'center',
    shadowColor: BRAND.sunGold,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 5,
  },
  content: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  alertItem: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  emoji: {
    fontSize: 24,
    marginRight: 10,
  },
  label: {
    fontSize: 11,
    color: 'rgba(255, 255, 255, 0.8)',
    fontFamily: FONTS.bodySemi,
  },
  time: {
    fontSize: 16,
    color: 'white',
    fontFamily: FONTS.bodyBold,
  },
  divider: {
    width: 1,
    height: 40,
    backgroundColor: 'rgba(255, 255, 255, 0.3)',
    marginHorizontal: 12,
  },
  closeButton: {
    padding: 8,
  },
  closeIcon: {
    fontSize: 18,
    color: 'white',
    fontFamily: FONTS.bodyBold,
  },
});
