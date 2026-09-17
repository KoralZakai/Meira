/** LumiOrb — the gold clock-coin brand mark (logo contexts: LumiWordmark,
 * CustomTabBar, chat bubbles). For Lumi's illustrated CHARACTER avatar
 * (blink/talk/wave/celebrate) use LumiCharacter.tsx — TodaySchedule already
 * does. Kept under its original name so logo call sites stay untouched. */
import React from 'react';
import { View, ViewStyle } from 'react-native';
import { BRAND, SHADOWS } from '../constants/theme';

/**
 * Lumi's avatar = the clock-coin mark (same as the logo's "i" dot):
 * a gold disc, a white outer ring, and a white "L"-shaped hand pointing
 * 12 → 3 o'clock (up then right). On gold backgrounds, pass `invert` to flip
 * to a white disc with gold ring + hand. Built from Views so it stays crisp at
 * any size — never a raster image. Optional soft gold `pulse` for the splash.
 */
export interface LumiOrbProps {
  size?: number;
  invert?: boolean;
  pulse?: boolean;
  glow?: boolean;
  style?: ViewStyle;
}

export default function LumiOrb({ size = 64, invert = false, pulse = false, glow = false, style }: LumiOrbProps) {
  // `pulse` is accepted and ignored: the orb used to breathe on a 1200 ms
  // infinite loop, and it lives in the tab bar, so it animated on all four
  // tabs permanently — ambient motion with nothing to communicate, right
  // beside whatever the user was trying to do. The prop stays so callers do
  // not all have to change.

  const ringColor = invert ? BRAND.amber : BRAND.white;
  const handColor = invert ? BRAND.amber : BRAND.white;

  // Hand geometry: a thin bar from center → top, and center → right.
  const handThick = Math.max(2, size * 0.07);
  const armLen = size * 0.26;
  const center = size / 2;

  return (
    <View
      style={[
        { width: size, height: size },
        glow && SHADOWS.orb,
        style,
      ]}
    >
      {/* disc */}
      <View style={{
        width: size, height: size, borderRadius: size / 2,
        backgroundColor: invert ? BRAND.white : BRAND.sunGold,
      }} />

      {/* white outer ring */}
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          top: size * 0.08,
          left: size * 0.08,
          width: size * 0.84,
          height: size * 0.84,
          borderRadius: size / 2,
          borderWidth: Math.max(1.5, size * 0.05),
          borderColor: ringColor,
          opacity: invert ? 1 : 0.95,
        }}
      />

      {/* "L"-shaped hand: vertical arm (center→top) */}
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: center - handThick / 2,
          top: center - armLen,
          width: handThick,
          height: armLen,
          borderRadius: handThick,
          backgroundColor: handColor,
        }}
      />
      {/* horizontal arm (center→right) */}
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: center,
          top: center - handThick / 2,
          width: armLen,
          height: handThick,
          borderRadius: handThick,
          backgroundColor: handColor,
        }}
      />
      {/* center pivot */}
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: center - handThick * 0.7,
          top: center - handThick * 0.7,
          width: handThick * 1.4,
          height: handThick * 1.4,
          borderRadius: handThick,
          backgroundColor: handColor,
        }}
      />
    </View>
  );
}
