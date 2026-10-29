/**
 * HourRuler — the hours she can drop a lifted task on (28.10).
 *
 * Koral: "dragging doesn't work well — let me drag onto the hours of the day".
 * The old drop targets were the free windows drawn inside the day list: a later
 * hour needed scrolling while dragging, which the list does not do, and a drop
 * anywhere else did nothing. While a task is lifted this ruler lies over the
 * screen: every half hour from now to the end of the day, the busy ones
 * marked with what is there. Drop on a row → that hour (utils/hourRows).
 */
import React, { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { BRAND, FONTS } from '../../constants/theme';
import type { HourRow } from '../../utils/hourRows';

export interface RulerHandle {
  /** The row under the finger (window Y), highlighted — or null. */
  hover: (pageY: number) => HourRow | null;
}

interface Props {
  rows: HourRow[];
  he: boolean;
  top: number;
  bottom: number;
}

export const HourRuler = forwardRef<RulerHandle, Props>(({ rows, he, top, bottom }, ref) => {
  const box = useRef<{ y: number; h: number } | null>(null);
  const view = useRef<View>(null);
  const [hot, setHot] = useState<number | null>(null);
  useImperativeHandle(ref, () => ({
    hover: (pageY: number) => {
      const b = box.current;
      if (!b || !rows.length) return null;
      const i = Math.floor(((pageY - b.y) / b.h) * rows.length);
      const row = i >= 0 && i < rows.length ? rows[i] : null;
      setHot((prev) => (prev === (row ? i : null) ? prev : (row ? i : null)));
      return row;
    },
  }), [rows]);
  return (
    <View ref={view} pointerEvents="none" style={[styles.wrap, { top, bottom }]}
      onLayout={() => view.current?.measureInWindow((_x, y, _w, h) => { box.current = { y, h }; })}>
      <Text style={[styles.cap, he && styles.rtl]} numberOfLines={1}>{he ? 'שחררי על השעה' : 'Drop on the hour'}</Text>
      {rows.map((r, i) => (
        <View key={r.start} style={[styles.row, { flexDirection: he ? 'row-reverse' : 'row' }, r.busy && styles.busy, hot === i && styles.hot]}>
          <Text style={[styles.time, hot === i && styles.hotText]} numberOfLines={1}>{r.start}</Text>
          <Text style={[styles.what, he && styles.rtl, hot === i && styles.hotText]} numberOfLines={1}>
            {r.busy ? r.busy : (he ? 'פנוי' : 'free')}
          </Text>
        </View>
      ))}
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute', left: 12, right: 12, zIndex: 40, elevation: 10, padding: 8, gap: 2, borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.96)', borderWidth: 2, borderColor: '#7B6CFF',
  },
  cap: { fontFamily: FONTS.bodyHeavy, fontSize: 12, color: '#5A4FE0', marginBottom: 2, paddingHorizontal: 4 },
  rtl: { textAlign: 'right', writingDirection: 'rtl' },
  row: { flex: 1, minHeight: 22, alignItems: 'center', gap: 10, paddingHorizontal: 8, borderRadius: 10 },
  busy: { backgroundColor: 'rgba(20,27,46,0.06)' },
  hot: { backgroundColor: '#7B6CFF' },
  hotText: { color: BRAND.white },
  time: { minWidth: 48, fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.warmInk, fontVariant: ['tabular-nums'] },
  what: { flex: 1, minWidth: 0, fontFamily: FONTS.bodySemi, fontSize: 12.5, color: BRAND.inkSoft },
});
