/**
 * CustomTabBar — 💬 Meira · Today · Tasks · Trips (v3, 27.10; before: Today · 🎙️ Talk · 💬 Write · Tasks · Trips).
 *
 * Design handoff "Calm Today" (2026-09-28). What changed and why:
 *
 * - 🎙️ opens the voice sheet, 💬 the chat. Chat used to hide behind a
 *   long-press on the mic.
 * - Koral, 17.10: "the microphone and text buttons on the same menu in the
 *   bottom". They were a split pill raised 32px above the bar, which floated
 *   over the last card on Today (it hid the fourth unfinished row). Her pick
 *   of three mockups: five equal tabs, the two actions as ordinary slots with
 *   an icon AND a label — nothing sits above the bar any more.
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
import { useAppLanguage } from '../hooks/useAppLanguage';
import LineIcon, { LineIconName } from './ui/LineIcon';
import { useNight } from './ui/SkyBackdrop';
import { N, NIGHT_COLORS } from '../constants/nightTone';

interface TabBarProps {
  state: any;
  descriptors: any;
  navigation: any;
}

type Slot =
  | { kind: 'route'; route: string; icon: LineIconName; en: string; he: string }
  | { kind: 'action'; action: 'voice' | 'chat'; icon: string; en: string; he: string }
  | { kind: 'menu'; icon: string; en: string; he: string };

// v3 (Koral, 27.10): the chat with Meira is home and the first tab; talking
// and writing happen inside it (its 🎤 and its box), so the two action slots
// became one place.
const SLOTS: Slot[] = [
  { kind: 'route', route: 'Meira', icon: 'chat', en: 'Meira', he: 'מאירה' },
  { kind: 'route', route: 'Today', icon: 'sun', en: 'Today', he: 'היום' },
  { kind: 'route', route: 'Tasks', icon: 'tasks', en: 'Tasks', he: 'משימות' },
  { kind: 'route', route: 'Trips', icon: 'map', en: 'Trips', he: 'נסיעות' },
  // ☰ Menu moved to the Today header, beside the profile (Koral, 28.9).
];

/** The bar's height above the safe area; 88 including it, per the spec. */
const BAR_HEIGHT = 60;

export default function CustomTabBar({ state, navigation }: TabBarProps) {
  const insets = useSafeAreaInsets();
  const { he } = useAppLanguage();
  const night = useNight();
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
    <View style={[styles.container, night && N.bar, { paddingBottom: Math.max(insets.bottom, 28) }]}>
      {voiceOpen && (
        <VoiceSheet onClose={closeVoice} onTypeInstead={(text) => openChat(text)}
          onAnswer={(turn) => { closeVoice(); root().navigate('CoachChat', { voiceTurn: turn }); }} />
      )}
      <View style={styles.bar}>
        {SLOTS.map((slot) => {
          if (slot.kind === 'action') {
            // An action, not a place: it opens a sheet / the chat over the
            // current tab, so it never takes the selected bar.
            return (
              <Pressable
                key={slot.action}
                onPress={slot.action === 'voice' ? () => setVoiceOpen(true) : () => openChat()}
                style={({ pressed }) => [styles.tab, pressed && styles.pressed]}
                accessibilityRole="button"
                accessibilityLabel={he ? slot.he : slot.en}
              >
                <Text style={styles.icon}>{slot.icon}</Text>
                <Text style={[styles.label, styles.inactive, night && N.inkSoft]}>{he ? slot.he : slot.en}</Text>
              </Pressable>
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
                <Text style={[styles.icon, styles.menuIcon, styles.inactiveIcon, night && N.ink]}>{slot.icon}</Text>
                <Text style={[styles.label, styles.inactive, night && N.inkSoft]}>{he ? slot.he : slot.en}</Text>
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
              {focused ? <View style={[styles.selectedBar, night && { backgroundColor: NIGHT_COLORS.goldInk }]} /> : null}
              {/* v3 line icon; the selected one sits in a gold-tinted pill. */}
              <View style={[styles.iconPill, focused && styles.iconPillOn, focused && night && styles.iconPillNight]}>
                <LineIcon name={slot.icon} size={21} color={focused ? (night ? '#141B2E' : BRAND.goldInk) : (night ? NIGHT_COLORS.inkSoft : BRAND.inkSoft)} strokeWidth={focused ? 2.2 : 1.9} />
              </View>
              <Text style={[styles.label, !focused && styles.inactive, night && (focused ? N.ink : N.inkSoft)]}>{he ? slot.he : slot.en}</Text>
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
  icon: { fontSize: 21 },
  menuIcon: { color: BRAND.warmInk, fontSize: 22, lineHeight: 26 },
  label: { fontSize: 11, fontFamily: FONTS.bodyHeavy, color: BRAND.warmInk },
  // Inactive was opacity .5 on icon AND label: ink at half strength measured under 3:1 on the bar.
  // Now the label keeps solid ink (inkSoft, 6.8:1) and only the emoji is softened; the selected tab
  // also gets a bar, so "which one am I on" never rests on colour alone.
  inactive: { color: BRAND.inkSoft, fontFamily: FONTS.bodyBold },
  inactiveIcon: { opacity: 0.7 },
  iconPill: { width: 48, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  iconPillOn: { backgroundColor: BRAND.goldSoft },
  // v4 TabBar dark: the selected tab is a solid gold pill with dark ink.
  iconPillNight: { backgroundColor: NIGHT_COLORS.goldInk },
  selectedBar: { position: 'absolute', top: 0, width: 24, height: 3, borderBottomLeftRadius: 3, borderBottomRightRadius: 3, backgroundColor: BRAND.goldInk },
});
