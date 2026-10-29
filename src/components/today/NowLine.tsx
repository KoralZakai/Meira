/**
 * NowLine — where she is in the day: the time, a beating heart, a gold line.
 *
 * Koral, 30.9: "a line — with a beating heart and the time next to it — that
 * shows where you are in the day relative to the tasks". It sits between what
 * has passed and what is next, so the day reads from here downwards. When
 * something is HAPPENING, the now is inside that card instead (DayCard's
 * progress bar, 1.10: "it says 21:30 above the task that happens now").
 *
 * The heart is the only idle animation on Today, on purpose, and it stops when
 * the phone asks for reduced motion. A lub-dub every 1.4 s, like a resting
 * pulse — calm, not an alarm.
 */
import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { BRAND, FONTS } from '../../constants/theme';

interface Props {
  /** HH:MM */
  time: string;
  he: boolean;
}

/** The beating heart alone — the now line's, and the card-in-progress bar's. */
export function Heartbeat({ size = 26 }: { size?: number }) {
  const beat = useRef(new Animated.Value(1)).current;
  const ring = useRef(new Animated.Value(0)).current;
  const [still, setStill] = useState(false);

  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => { if (alive) setStill(v); })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setStill);
    return () => { alive = false; sub.remove(); };
  }, []);

  useEffect(() => {
    if (still) { beat.setValue(1); ring.setValue(0); return undefined; }
    const pulse = (to: number) => Animated.timing(beat, {
      toValue: to, duration: 140, easing: Easing.out(Easing.quad), useNativeDriver: true,
    });
    const loop = Animated.loop(Animated.parallel([
      Animated.sequence([pulse(1.22), pulse(1), pulse(1.12), pulse(1), Animated.delay(840)]),
      Animated.timing(ring, { toValue: 1, duration: 1400, easing: Easing.out(Easing.quad), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [still, beat, ring]);

  return (
    <View style={[styles.heartBox, { width: size, height: size }]}>
      <Animated.View
        style={[styles.ring, {
          width: size, height: size, borderRadius: size / 2,
          opacity: ring.interpolate({ inputRange: [0, 1], outputRange: [0.6, 0] }),
          transform: [{ scale: ring.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1.9] }) }],
        }]}
      />
      <Animated.Text style={[styles.heart, { fontSize: size * 0.77, lineHeight: size * 0.92, transform: [{ scale: beat }] }]}>
        ♥
      </Animated.Text>
    </View>
  );
}

export default function NowLine({ time, he }: Props) {
  return (
    <View style={styles.row} accessible accessibilityLabel={he ? `עכשיו ${time}` : `Now, ${time}`}>
      <View style={styles.pill}><Text style={styles.pillText}>{time}</Text></View>
      <Heartbeat />
      <View style={styles.line} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6, marginBottom: 10 },
  pill: { backgroundColor: BRAND.sunGold, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  pillText: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.onGold, fontVariant: ['tabular-nums'] },
  heartBox: { alignItems: 'center', justifyContent: 'center' },
  ring: { position: 'absolute', backgroundColor: 'rgba(233,174,60,0.35)' },
  heart: { color: BRAND.amber },
  line: { flex: 1, height: 2, borderRadius: 1, backgroundColor: BRAND.sunGold },
});
