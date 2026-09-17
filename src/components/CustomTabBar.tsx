/** CustomTabBar — the app's bottom/edge navigation bar. */
import React from 'react';
import { View, TouchableOpacity, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BRAND, FONTS, SHADOWS } from '../constants/theme';

interface TabBarProps {
  state: any;
  descriptors: any;
  navigation: any;
}

// Visual slots: Today · Timeline · [orb] · Tasks · Trips · Profile
// Stats used to sit in the Trips slot. It charted Math.random() bar heights,
// while the routes that decide whether you arrive on time had no screen of
// their own at all — they were buried inside individual task detail sheets.
//
// Slots address routes by NAME, not by position. They used to carry a
// routeIndex, so inserting one screen into the navigator silently re-pointed
// every slot after it: the "Tasks" button opened whatever now sat at index 1.
// A name cannot drift when the navigator changes.
const SLOTS: Array<{ route: string; icon: string; label: string } | null> = [
  { route: 'Today', icon: '☀️', label: 'Today' },
  null, // center orb
  { route: 'Tasks', icon: '☑️', label: 'Tasks' },
  { route: 'Trips', icon: '🗺️', label: 'Trips' },
  // Profile moved to the avatar in the Today header — the corner every app
  // puts the account in.
  //
  // Timeline was here. It rendered the same DayTimeline from the same storage
  // as Today; the one thing it could do that Today could not was look at
  // another date, so the day chips moved into Today's header and the tab went.
  // Two tabs drawing the same day is how they drift apart.
];

export default function CustomTabBar({ state, descriptors, navigation }: TabBarProps) {
  const insets = useSafeAreaInsets();
  // A second infinite pulse used to live here, wrapping the orb — so the tab
  // bar breathed on every screen in the app. Removed for the same reason.

  const openChat = () => {
    const parent = navigation.getParent?.();
    (parent ?? navigation).navigate('CoachChat');
  };

  return (
    <View style={[styles.container, { paddingBottom: insets.bottom }]}>
      {/* Was a raised Lumi orb. It is a chat button — so it looks like one now
          rather than like a mascot that happens to be tappable. */}
      <View style={styles.orbWrap}>
        <TouchableOpacity onPress={openChat} activeOpacity={0.85} style={styles.chatBtn}>
          <Text style={styles.chatIcon}>💬</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.bar}>
        {SLOTS.map((slot, idx) => {
          if (!slot) {
            return <View key="orb-gap" style={styles.centerGap} />;
          }

          const routeIndex = state.routes.findIndex((r: { name: string }) => r.name === slot.route);
          const route = state.routes[routeIndex];
          if (!route) return null;
          const isFocused = state.index === routeIndex;

          const onPress = () => {
            const event = navigation.emit({ type: 'tabPress', target: route.key, preventDefault: false });
            if (!isFocused && !event.defaultPrevented) navigation.navigate(route.name);
          };

          return (
            <TouchableOpacity key={slot.label} onPress={onPress} style={styles.tab} activeOpacity={0.7}>
              <Text style={[styles.icon, { opacity: isFocused ? 1 : 0.4 }]}>{slot.icon}</Text>
              <Text style={[styles.label, isFocused ? styles.labelActive : styles.labelInactive]}>
                {slot.label}
              </Text>
              {isFocused && <View style={styles.activeDot} />}
            </TouchableOpacity>
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
    ...SHADOWS.card,
    shadowOffset: { width: 0, height: -4 },
  },
  bar: {
    flexDirection: 'row',
    height: 60,
    alignItems: 'flex-start',
    paddingTop: 10,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
  },
  icon: { fontSize: 22 },
  label: { fontSize: 10, fontFamily: FONTS.bodyBold },
  labelActive: { color: BRAND.sunGold, fontFamily: FONTS.bodyHeavy },
  labelInactive: { color: BRAND.inkFaint },
  activeDot: {
    width: 4, height: 4, borderRadius: 2,
    backgroundColor: BRAND.sunGold,
    marginTop: 2,
  },
  centerGap: { width: 72 },
  chatBtn: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: BRAND.sunGold,
    alignItems: 'center', justifyContent: 'center',
  },
  chatIcon: { fontSize: 24 },
  orbWrap: {
    position: 'absolute',
    top: -30,
    alignSelf: 'center',
    zIndex: 10,
    ...SHADOWS.orb,
  },
});
