/**
 * CustomTabBar — Today · [🎙️ | 💬] · Tasks · Trips.
 *
 * Design handoff "Calm Today" (2026-09-28). What changed and why:
 *
 * - The centre is the TalkControl split pill: 🎙️ opens the voice sheet, 💬
 *   the chat. Chat used to hide behind a long-press on the mic.
 * - Profile is no longer a tab. ☰ Menu opens the profile / settings as a
 *   sheet over whatever screen she is on — it is not a place she goes.
 * - Timeline was already merged into Today (the day chips moved into Today's
 *   header; two tabs drawing one day is how they drift apart).
 *
 * Slots address routes by NAME, not by position: a routeIndex silently
 * re-pointed every slot after an insertion ("Tasks" opened whatever sat at
 * index 1). A name cannot drift when the navigator changes.
 */
import React, { useState } from 'react';
import { View, Pressable, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BRAND, FONTS } from '../constants/theme';
import VoiceSheet from './VoiceSheet';
import TalkControl from './TalkControl';
import { useAppLanguage } from '../hooks/useAppLanguage';

interface TabBarProps {
  state: any;
  descriptors: any;
  navigation: any;
}

type Slot =
  | { kind: 'route'; route: string; icon: string; en: string; he: string }
  | { kind: 'talk' }
  | { kind: 'menu'; icon: string; en: string; he: string };

const SLOTS: Slot[] = [
  { kind: 'route', route: 'Today', icon: '☀️', en: 'Today', he: 'היום' },
  { kind: 'talk' },
  { kind: 'route', route: 'Tasks', icon: '☑️', en: 'Tasks', he: 'משימות' },
  { kind: 'route', route: 'Trips', icon: '🗺️', en: 'Trips', he: 'נסיעות' },
  // ☰ Menu moved to the Today header, beside the profile (Koral, 28.9).
];

/** The bar's height above the safe area; 88 including it, per the spec. */
const BAR_HEIGHT = 60;

export default function CustomTabBar({ state, navigation }: TabBarProps) {
  const insets = useSafeAreaInsets();
  const { he } = useAppLanguage();
  const [voiceOpen, setVoiceOpen] = useState(false);

  const root = () => navigation.getParent?.() ?? navigation;
  const openChat = (initialText?: string) => {
    root().navigate('CoachChat', initialText ? { initialText } : undefined);
  };
  const openMenu = () => root().navigate('SettingsMenu');

  // After a voice plan the answer is the day, so land on Today to see it.
  const closeVoice = (planned?: boolean) => {
    setVoiceOpen(false);
    if (!planned) return;
    if (state.routes[state.index]?.name !== 'Today') navigation.navigate('Today');
  };

  return (
    <View style={[styles.container, { paddingBottom: Math.max(insets.bottom, 28) }]}>
      {voiceOpen && (
        <VoiceSheet onClose={closeVoice} onTypeInstead={(text) => openChat(text)} />
      )}
      <View style={styles.bar}>
        {SLOTS.map((slot) => {
          if (slot.kind === 'talk') {
            return (
              <View key="talk" style={styles.talkSlot}>
                <View style={styles.talkRaise}>
                  <TalkControl he={he} onVoice={() => setVoiceOpen(true)} onChat={() => openChat()} />
                </View>
              </View>
            );
          }
          if (slot.kind === 'menu') {
            return (
              <Pressable
                key="menu"
                onPress={openMenu}
                style={({ pressed }) => [styles.tab, pressed && styles.pressed]}
                accessibilityRole="button"
                accessibilityLabel={he ? slot.he : slot.en}
              >
                <Text style={[styles.icon, styles.menuIcon, styles.inactive]}>{slot.icon}</Text>
                <Text style={[styles.label, styles.inactive]}>{he ? slot.he : slot.en}</Text>
              </Pressable>
            );
          }
          const routeIndex = state.routes.findIndex((r: { name: string }) => r.name === slot.route);
          const route = state.routes[routeIndex];
          if (!route) return <View key={slot.route} style={styles.tab} />;
          const focused = state.index === routeIndex;
          const onPress = () => {
            const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
            if (!focused && !event.defaultPrevented) navigation.navigate(route.name);
          };
          return (
            <Pressable
              key={slot.route}
              onPress={onPress}
              style={({ pressed }) => [styles.tab, pressed && styles.pressed]}
              accessibilityRole="tab"
              accessibilityState={{ selected: focused }}
              accessibilityLabel={he ? slot.he : slot.en}
            >
              <Text style={[styles.icon, !focused && styles.inactive]}>{slot.icon}</Text>
              <Text style={[styles.label, !focused && styles.inactive]}>{he ? slot.he : slot.en}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: BRAND.creamCard,
    borderTopWidth: 1,
    borderTopColor: BRAND.line,
  },
  bar: {
    flexDirection: 'row',
    height: BAR_HEIGHT,
    alignItems: 'center',
  },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 2, height: BAR_HEIGHT },
  pressed: { opacity: 0.7 },
  talkSlot: { width: 132, height: BAR_HEIGHT, alignItems: 'center' },
  // Raised −32px above the bar, per the spec.
  talkRaise: { position: 'absolute', top: -32 },
  icon: { fontSize: 21 },
  menuIcon: { color: BRAND.warmInk, fontSize: 22, lineHeight: 26 },
  label: { fontSize: 10, fontFamily: FONTS.bodyHeavy, color: BRAND.warmInk },
  inactive: { opacity: 0.5 },
});
