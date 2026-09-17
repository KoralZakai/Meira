/**
 * TaskCheckbox — the tick, and the small reward for earning it.
 *
 * The timeline lost its checkboxes when the day became blocks: a block could
 * be tapped to open, held to edit, and not finished at all. Ticking things off
 * is most of why a list gets opened, and a day you cannot tick is a day you
 * only ever read.
 *
 * The animation is the point, not decoration. A tap that changes a border
 * colour feels like a setting; a tick that springs in feels like finishing
 * something, and finishing something is the behaviour worth reinforcing. Two
 * springs on a shared Animated.Value — the box pops to 1.18 and settles, the
 * mark scales in behind it — both on the native driver so the list can be
 * scrolling underneath.
 *
 * Optimistic and self-correcting: it fills the instant she taps, before the
 * write. If the write throws it goes back, because a tick that stayed while
 * the save failed is the lie ("✓ עודכן" ≠ saved) this app has been bitten by
 * before.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BRAND, FONTS } from '../constants/theme';

/**
 * Which ink survives on top of the fill.
 *
 * The mark used to be hardcoded white, which was fine while the tick filled
 * with terracotta. On the brand gold it measures 1.7:1 — a tick you cannot
 * see is a tick you do not trust, and this is the control the whole screen
 * exists for. Relative luminance (WCAG) picks the ink, so a category tint as
 * dark as work-navy and a fill as bright as sunGold both stay legible.
 */
function inkOn(fill: string): string {
  const hex = fill.replace('#', '');
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  if (full.length !== 6) return BRAND.white;
  const chan = (i: number) => {
    const v = parseInt(full.slice(i * 2, i * 2 + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * chan(0) + 0.7152 * chan(1) + 0.0722 * chan(2);
  // Contrast against white vs against the dark gold ink; take the winner.
  const vsWhite = 1.05 / (L + 0.05);
  const vsInk = (L + 0.05) / 0.0904;   // luminance of BRAND.onGold + 0.05
  return vsInk > vsWhite ? BRAND.onGold : BRAND.white;
}

interface Props {
  done: boolean;
  onToggle: () => void | Promise<void>;
  /** Bigger target for the flexible list, where ticking IS the interaction. */
  size?: number;
  /**
   * Fill for the ticked state. Defaults to the brand gold: the tick is a
   * primary action, and the day should read as one interactive colour rather
   * than fourteen category colours competing for the same meaning.
   */
  color?: string;
  disabled?: boolean;
}

export default function TaskCheckbox({
  done, onToggle, size = 24, color = BRAND.sunGold, disabled,
}: Props) {
  const mark = inkOn(color);
  // What the user sees, which leads what is stored by one round trip.
  const [optimistic, setOptimistic] = useState(done);
  const [busy, setBusy] = useState(false);
  const anim = useRef(new Animated.Value(done ? 1 : 0)).current;
  const pop = useRef(new Animated.Value(1)).current;

  // Follow the prop when it changes underneath us — a reload, a sync, or the
  // failure path below putting it back.
  useEffect(() => { setOptimistic(done); }, [done]);

  useEffect(() => {
    Animated.spring(anim, {
      toValue: optimistic ? 1 : 0,
      useNativeDriver: true,
      friction: 6,
      tension: 90,
    }).start();
  }, [optimistic, anim]);

  const press = async () => {
    if (busy || disabled) return;
    const next = !optimistic;
    setOptimistic(next);
    setBusy(true);
    // The pop only plays on the way IN. Un-ticking is a correction, and
    // celebrating a correction reads as sarcasm.
    if (next) {
      Animated.sequence([
        Animated.timing(pop, {
          toValue: 1.18, duration: 110, easing: Easing.out(Easing.quad), useNativeDriver: true,
        }),
        Animated.spring(pop, { toValue: 1, useNativeDriver: true, friction: 4, tension: 120 }),
      ]).start();
    }
    try {
      await onToggle();
    } catch {
      setOptimistic(!next);   // the save failed; do not leave a tick that lied
    } finally {
      setBusy(false);
    }
  };

  const box = size;
  return (
    <TouchableOpacity
      onPress={press}
      disabled={disabled}
      activeOpacity={0.7}
      // A 24px box is a 24px box; the TAP is 44px, the platform minimum.
      hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: optimistic, disabled: Boolean(disabled) }}
    >
      <Animated.View
        style={[
          styles.box,
          {
            width: box,
            height: box,
            borderRadius: Math.round(box / 3),
            // Unticked, the outline is gold too — a faint hairline box read
            // as a decoration rather than something to press.
            borderColor: optimistic ? color : BRAND.goldInk,
            backgroundColor: optimistic ? color : 'transparent',
            transform: [{ scale: pop }],
          },
          disabled && styles.disabled,
        ]}
      >
        <Animated.View style={{ opacity: anim, transform: [{ scale: anim }] }}>
          <Text style={[styles.mark, { fontSize: Math.round(box * 0.58), color: mark }]}>✓</Text>
        </Animated.View>
      </Animated.View>
      {/* An invisible sibling keeps the row height stable whether or not the
          mark is showing — without it the row twitched on every tick. */}
      <View style={{ height: 0 }} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  box: {
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: { opacity: 0.4 },
  mark: {
    fontFamily: FONTS.bodyHeavy,
    lineHeight: undefined,
    includeFontPadding: false,
    textAlign: 'center',
  },
});
