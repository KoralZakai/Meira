/** WaveformAnimation — mic-listening waveform shown during STT. */
import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { BRAND } from '../constants/theme';

interface Props {
  active: boolean;
  level: number;
}

export function WaveformAnimation({ active, level }: Props) {
  const bars = useMemo(() => new Array(18).fill(null), []);
  const anims = useRef(bars.map(() => new Animated.Value(0.2))).current;

  useEffect(() => {
    if (!active) {
      anims.forEach((a) => a.setValue(0.2));
      return;
    }

    const loops = anims.map((a, idx) =>
      Animated.loop(
        Animated.sequence([
          Animated.timing(a, {
            toValue: Math.max(0.35, Math.min(1, level + ((idx % 3) * 0.15 + 0.1))),
            duration: 180 + idx * 15,
            useNativeDriver: true,
          }),
          Animated.timing(a, {
            toValue: 0.2,
            duration: 200 + idx * 12,
            useNativeDriver: true,
          }),
        ]),
      ),
    );

    loops.forEach((loop) => loop.start());
    return () => loops.forEach((loop) => loop.stop());
  }, [active, anims, level]);

  return (
    <View style={styles.container}>
      {anims.map((anim, index) => (
        <Animated.View
          key={index}
          style={[
            styles.bar,
            {
              transform: [{ scaleY: anim }],
              opacity: active ? 0.95 : 0.4,
            },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    height: 64,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'center',
    gap: 5,
    marginVertical: 12,
  },
  bar: {
    width: 6,
    height: 56,
    borderRadius: 5,
    backgroundColor: BRAND.sunGold,
  },
});
