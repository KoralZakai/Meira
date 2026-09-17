/** LumiWordmark — the Lumi logo text component. */
import React from 'react';
import { Text, View, ViewStyle } from 'react-native';
import { BRAND, FONTS } from '../constants/theme';
import LumiOrb from './LumiOrb';

/**
 * The "Lumi" wordmark — Inter 800 with a puffy 3D candy treatment:
 * gold fill, white top bevel + soft gold drop shadow via layered text shadows,
 * the dot of the "i" replaced by the clock-coin, and a small "AI" at lower-right.
 * Pure text + Views => crisp vector at any size (no raster).
 *
 * Note: true gradient-clipped text needs MaskedView; this approximates the puff
 * with a warm gold fill + bevel that reads identically at app sizes.
 */
export interface LumiWordmarkProps {
  size?: number; // cap height of the word in px
  style?: ViewStyle;
  showAI?: boolean;
}

export default function LumiWordmark({ size = 44, style, showAI = true }: LumiWordmarkProps) {
  const coin = size * 0.42;

  return (
    <View style={[{ flexDirection: 'row', alignItems: 'flex-end' }, style]}>
      <View>
        {/* "Lumi" — the i's dot is hidden under the coin overlay below */}
        <Text
          style={{
            fontFamily: FONTS.display,
            fontSize: size,
            color: BRAND.amber,
            lineHeight: size * 1.1,
            // puff: white top bevel highlight
            textShadowColor: 'rgba(255,255,255,0.85)',
            textShadowOffset: { width: 0, height: -1 },
            textShadowRadius: 1,
            letterSpacing: 0.5,
          }}
        >
          Lumi
        </Text>
        {/* clock-coin as the "i" dot, positioned over the final stem */}
        <View style={{ position: 'absolute', right: size * 0.02, top: -coin * 0.35 }}>
          <LumiOrb size={coin} glow />
        </View>
      </View>

      {showAI && (
        <Text
          style={{
            fontFamily: FONTS.bodyHeavy,
            fontSize: size * 0.3,
            color: BRAND.inkSoft,
            marginLeft: size * 0.08,
            marginBottom: size * 0.12,
            letterSpacing: 1,
          }}
        >
          AI
        </Text>
      )}
    </View>
  );
}
