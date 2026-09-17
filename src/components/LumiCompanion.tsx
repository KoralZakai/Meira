/**
 * LumiCompanion — the floating Lumi docked above the tab bar on every screen
 * except Today (which has the big hero Lumi). She idles/blinks, talks whenever
 * TTS speaks (LumiCharacter's autoTalk), pops to celebrate on LumiMood events,
 * and a tap opens the Coach chat.
 *
 * Mounted ONCE in App.tsx as an absolute overlay inside NavigationContainer;
 * visibility follows the focused route (hidden on Today + modal-ish screens).
 * Dependencies: LumiCharacter, LumiMood. Navigation via the navRef prop.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet } from 'react-native';
import LumiCharacter, { LumiState } from './LumiCharacter';
import { onLumiMood } from '../services/LumiMood';

// Screens where the companion stays hidden: Today has the hero; chat/entry
// screens have their own Lumi.
const HIDDEN_ROUTES = new Set(['Today', 'CoachChat', 'Onboarding', 'AddTask', 'CheckIn', 'FocusNow', 'LeaveNow']);

interface Props {
  routeName?: string;
  onPress: () => void;
}

export default function LumiCompanion({ routeName, onPress }: Props) {
  const [mood, setMood] = useState<LumiState | undefined>(undefined);
  const bounce = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    return onLumiMood((m) => {
      setMood(m === 'celebrate' ? 'celebrate' : 'wave');
      Animated.sequence([
        Animated.timing(bounce, { toValue: -10, duration: 150, useNativeDriver: true }),
        Animated.spring(bounce, { toValue: 0, friction: 3, useNativeDriver: true }),
      ]).start();
      setTimeout(() => setMood(undefined), 1800); // back to idle/TTS-driven
    });
  }, [bounce]);

  if (routeName && HIDDEN_ROUTES.has(routeName)) return null;

  return (
    <Animated.View style={[styles.dock, { transform: [{ translateY: bounce }] }]} pointerEvents="box-none">
      <Pressable onPress={onPress} hitSlop={8}>
        <LumiCharacter size={56} state={mood} />
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  dock: {
    position: 'absolute',
    right: 12,
    bottom: 96, // above the tab bar
    zIndex: 50,
    elevation: 6,
  },
});
