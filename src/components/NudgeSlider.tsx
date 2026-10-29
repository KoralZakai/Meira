/**
 * NudgeSlider — "how much should Meira nudge?" as a slider (20.10, Koral: "need a slide bar").
 * Three stops: alarm only · gentle · encouraging. Tap a stop or drag the knob; it snaps to the
 * nearest stop and saves on release. The line under the track says what the chosen stop does
 * (the same words the cards had), so she sees the effect, not just a position.
 *
 * The track is left→right in BOTH languages (quietest → most), like a volume bar, so the knob
 * moves the same way everyone expects. Touch height 44dp (MIN_TOUCH). Also adjustable for
 * screen readers (swipe up/down steps it).
 */
import React, { useRef, useState } from 'react';
import { PanResponder, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BRAND, FONTS, MIN_TOUCH } from '../constants/theme';
import { NUDGE_LEVELS, NudgeLevel, levelAtX, nudgeCard, stepLevel, stopRatio } from '../utils/nudgeLevel';
import type { AppLanguage } from '../types/index';

interface Props { level: NudgeLevel; language: AppLanguage; onChange: (l: NudgeLevel) => void }

const KNOB = 28;

export default function NudgeSlider({ level, language, onChange }: Props) {
  const [width, setWidth] = useState(0);
  const [dragging, setDragging] = useState<NudgeLevel | null>(null);
  const widthRef = useRef(0);
  const shown = dragging ?? level;

  // The responder is created once; it must call the LATEST onChange.
  const latest = useRef(onChange); latest.current = onChange;
  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (e) => setDragging(levelAtX(e.nativeEvent.locationX - KNOB / 2, widthRef.current - KNOB)),
    onPanResponderMove: (e) => setDragging(levelAtX(e.nativeEvent.locationX - KNOB / 2, widthRef.current - KNOB)),
    onPanResponderRelease: (e) => {
      const next = levelAtX(e.nativeEvent.locationX - KNOB / 2, widthRef.current - KNOB);
      setDragging(null);
      latest.current(next);
    },
    onPanResponderTerminate: () => setDragging(null),
  })).current;

  const usable = Math.max(0, width - KNOB);
  const knobLeft = usable * stopRatio(shown);
  const card = nudgeCard(shown, language);

  return (
    <View style={styles.wrap}>
      <View
        style={styles.track}
        onLayout={(e) => { widthRef.current = e.nativeEvent.layout.width; setWidth(e.nativeEvent.layout.width); }}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={language === 'he' ? 'כמה להציק' : 'How much to nudge'}
        accessibilityValue={{ text: card.title }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(e) => onChange(stepLevel(level, e.nativeEvent.actionName === 'increment' ? 1 : -1))}
        {...pan.panHandlers}
      >
        <View style={styles.rail} pointerEvents="none" />
        <View style={[styles.fill, { width: knobLeft + KNOB / 2 }]} pointerEvents="none" />
        {NUDGE_LEVELS.map((l) => (
          <View key={l} pointerEvents="none"
            style={[styles.stop, { left: usable * stopRatio(l) + KNOB / 2 - 4 }]} />
        ))}
        <View style={[styles.knob, { left: knobLeft }]} pointerEvents="none" />
      </View>
      <View style={styles.labels}>
        {NUDGE_LEVELS.map((l) => (
          <TouchableOpacity key={l} style={styles.labelHit} onPress={() => onChange(l)} accessibilityRole="button"
            accessibilityLabel={nudgeCard(l, language).title}>
            <Text style={[styles.label, shown === l && styles.labelOn]} numberOfLines={1}>{nudgeCard(l, language).title}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <Text style={styles.how}>{card.how}</Text>
      <Text style={styles.sample}>{card.sample}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 14, gap: 4, direction: 'ltr' },
  track: { height: MIN_TOUCH, justifyContent: 'center' },
  rail: { position: 'absolute', left: KNOB / 2, right: KNOB / 2, height: 6, borderRadius: 3, backgroundColor: BRAND.line },
  fill: { position: 'absolute', left: 0, height: 6, borderRadius: 3, backgroundColor: BRAND.sunGold },
  stop: { position: 'absolute', width: 8, height: 8, borderRadius: 4, backgroundColor: BRAND.inkFaint, top: (MIN_TOUCH - 8) / 2 },
  knob: {
    position: 'absolute', width: KNOB, height: KNOB, borderRadius: KNOB / 2, top: (MIN_TOUCH - KNOB) / 2,
    backgroundColor: BRAND.sunGold, borderWidth: 3, borderColor: BRAND.white,
    shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 3,
  },
  labels: { flexDirection: 'row', justifyContent: 'space-between' },
  labelHit: { minHeight: MIN_TOUCH, justifyContent: 'center', paddingHorizontal: 2 },
  label: { fontFamily: FONTS.bodySemi, fontSize: 12, color: BRAND.inkSoft },
  labelOn: { fontFamily: FONTS.bodyHeavy, color: BRAND.warmInk },
  how: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.warmInk, textAlign: 'left' },
  sample: { fontFamily: FONTS.body, fontSize: 12, color: BRAND.inkSoft, textAlign: 'left' },
});
