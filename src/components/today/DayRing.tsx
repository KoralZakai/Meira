/**
 * DayRing — the day as a 24-hour ring, with the beating heart at now.
 *
 * Koral's v3 picks (27.10): the heart that says where she is in the day stays;
 * the ring shows daylight (real sunrise → sunset), every event in its category
 * colour, each trip out in gold, an overlap beside — not on top of — what it
 * overlaps, and in the middle how many of today's tasks are done.
 * Geometry: utils/dayRing. The heart: NowLine's Heartbeat (reduced motion → still).
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import type { Task } from '../../types/index';
import { BRAND, FONTS } from '../../constants/theme';
import { getCategoryMeta } from '../../constants/categories';
import { arcPath, pointAt, ringArcs, RING } from '../../utils/dayRing';
import { Heartbeat } from './NowLine';

interface Props {
  tasks: Task[];
  /** Minutes after midnight, or undefined when the day on screen is not today. */
  nowMin?: number;
  sunriseMin: number;
  sunsetMin: number;
  done: number;
  total: number;
  he: boolean;
  size?: number;
  /** Ink for the count in the middle — light on a night sky. */
  ink?: string;
}

const HEART = 18;

export default function DayRing({ tasks, nowMin, sunriseMin, sunsetMin, done, total, he, size = 120, ink }: Props) {
  const k = size / 150;
  const arcs = ringArcs(tasks, (c) => getCategoryMeta(c).color);
  const beat = nowMin === undefined ? null : pointAt(nowMin);
  return (
    <View
      style={{ width: size, height: size }}
      accessible
      accessibilityLabel={he ? `${done} מתוך ${total} בוצעו היום` : `${done} of ${total} done today`}
    >
      <Svg width={size} height={size} viewBox="0 0 150 150">
        <Circle cx={RING.c} cy={RING.c} r={RING.r} fill="none" stroke="rgba(20,30,90,0.12)" strokeWidth={RING.width} />
        <Path d={arcPath(sunriseMin, sunsetMin)} fill="none" stroke="rgba(255,209,102,0.75)" strokeWidth={RING.width} />
        {nowMin !== undefined ? (
          <Path d={arcPath(0, nowMin)} fill="none" stroke="rgba(255,255,255,0.95)" strokeWidth={4} strokeLinecap="round" />
        ) : null}
        {arcs.map((a) => (
          <Path key={a.id} d={a.d} fill="none" stroke={a.color} strokeWidth={a.width} strokeLinecap="round" />
        ))}
      </Svg>
      <View style={[StyleSheet.absoluteFill, styles.center]} pointerEvents="none">
        <Text style={[styles.count, ink ? { color: ink } : null]}>{`${done}/${total}`}</Text>
        <Text style={[styles.label, ink ? { color: ink, opacity: 0.85 } : null]}>{he ? 'בוצעו' : 'done'}</Text>
      </View>
      {beat ? (
        <View pointerEvents="none" style={[styles.heart, { left: beat[0] * k - HEART / 2, top: beat[1] * k - HEART / 2 }]}>
          <Heartbeat size={HEART} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  count: { fontFamily: FONTS.bodyHeavy, fontSize: 20, color: BRAND.warmInk },
  label: { fontFamily: FONTS.bodySemi, fontSize: 10, color: BRAND.inkSoft },
  heart: { position: 'absolute', width: HEART, height: HEART },
});
