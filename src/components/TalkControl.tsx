/**
 * TalkControl — the centre of the tab bar: 🎙️ speak | 💬 type.
 *
 * Design handoff "Calm Today", variant A (split pill), the default. Speaking
 * leads because it is the fast path; typing sits right beside it instead of
 * behind a long-press nobody discovers (the old 🎤 hid chat that way).
 *
 * One gold pill, a cream 4px rim, two 58×56 hit areas and a faint divider.
 * Press state is opacity 0.85, per the spec's motion section.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { BRAND, GRADIENTS, SHADOWS } from '../constants/theme';

interface Props {
  onVoice: () => void;
  onChat: () => void;
  he?: boolean;
}

export default function TalkControl({ onVoice, onChat, he = false }: Props) {
  return (
    <View style={styles.shadow}>
      <LinearGradient
        colors={[GRADIENTS.primary[0], GRADIENTS.primary[1]]}
        start={{ x: 0.3, y: 0 }}
        end={{ x: 0.7, y: 1 }}
        style={styles.pill}
      >
        <Pressable
          onPress={onVoice}
          style={({ pressed }) => [styles.half, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel={he ? 'לדבר עם מאירה' : 'Talk to Meira'}
        >
          <Text style={styles.mic}>🎙️</Text>
        </Pressable>
        <View style={styles.divider} />
        <Pressable
          onPress={onChat}
          style={({ pressed }) => [styles.half, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel={he ? 'לכתוב למאירה' : 'Chat with Meira'}
        >
          <Text style={styles.chat}>💬</Text>
        </Pressable>
      </LinearGradient>
    </View>
  );
}

const styles = StyleSheet.create({
  shadow: { borderRadius: 999, ...SHADOWS.orb },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 999,
    borderWidth: 4,
    borderColor: BRAND.creamCard,
    overflow: 'hidden',
  },
  half: { width: 58, height: 56, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.85 },
  divider: { width: 1, height: 28, backgroundColor: 'rgba(255,255,255,0.3)' },
  mic: { fontSize: 24 },
  chat: { fontSize: 22 },
});
