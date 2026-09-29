/**
 * MeiraCoin — the brand mark: a gold clock whose hands make an "L".
 *
 * "The L is a clock — a smart clock, a smart assistant" (Lumi design system
 * readme). Same geometry as the design-system MeiraCoin and the app icon, in
 * react-native-svg so it stays crisp from 28 to 56 px. It is Meira's face
 * everywhere: the Today header, the menu, chat and voice.
 *
 * Still, never pulsing — the design system allows no idle animation.
 */
import React from 'react';
import { View, ViewStyle } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { BRAND, SHADOWS } from '../constants/theme';

interface Props {
  size?: number;
  /** White disc with an amber ring and hand — for use ON gold. */
  invert?: boolean;
  /** The orb shadow; only worth it at 56px and up. */
  glow?: boolean;
  /** Screen-reader label; omit when a visible name sits beside the coin. */
  label?: string;
  style?: ViewStyle;
}

export default function MeiraCoin({ size = 36, invert = false, glow = false, label, style }: Props) {
  const disc = invert ? BRAND.white : BRAND.sunGold;
  const ink = invert ? BRAND.amber : BRAND.white;
  const unit = 40 / size;                               // viewBox units per px
  const ringW = Math.max(2, 1.5 * unit);                // ring ≥ 1.5px
  const handW = Math.max(2.8, 2 * unit);                // hand ≥ 2px
  return (
    <View
      pointerEvents="none"
      accessible={Boolean(label)}
      accessibilityRole={label ? 'image' : undefined}
      accessibilityLabel={label}
      style={[{ width: size, height: size, borderRadius: size / 2 }, glow && { backgroundColor: disc, ...SHADOWS.orb }, style]}
    >
      <Svg width={size} height={size} viewBox="0 0 40 40">
        <Circle cx={20} cy={20} r={20} fill={disc} />
        <Circle cx={20} cy={20} r={15.8} fill="none" stroke={ink} strokeOpacity={invert ? 1 : 0.95} strokeWidth={ringW} />
        <Path d="M20 11V20h9" fill="none" stroke={ink} strokeWidth={handW} strokeLinecap="round" strokeLinejoin="round" />
        <Circle cx={20} cy={20} r={2} fill={ink} />
      </Svg>
    </View>
  );
}
