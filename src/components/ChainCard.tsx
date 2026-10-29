/**
 * ChainCard — "my bike is on Florentin": the ways, one at a time, on a map.
 *
 * Koral 19.10, mockup pick B: numbered chips above (1 · after Baot · +12),
 * the map below draws ONLY the chosen way — each leg in its mode's colour
 * (bus purple, bike gold, walk grey), a leg after the event dashed — and the
 * legs as words under it, the bus number first. Tapping a chip switches.
 *
 * The plan is the server's (vehicle_chain); this card only draws it. With no
 * map (Expo Go, no line from Google) the legs as words still say everything.
 */
import React, { useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BRAND, FONTS, MIN_TOUCH, RADIUS } from '../constants/theme';
import { isExpoGo } from '../utils/isExpoGo';
import { decodePolyline } from './RouteMap';
import { ChainAnswer, MODE_COLOR, chipTitle, framePoints, stepLine } from '../utils/chainAnswer';

interface Props {
  chain: ChainAnswer;
  he: boolean;
}

const MAP_H = 190;

export default function ChainCard({ chain, he }: Props) {
  const [sel, setSel] = useState(0);
  const option = chain.options[Math.min(sel, chain.options.length - 1)];
  const vehicle = chain.vehicle ?? 'bike';
  const eventName = option.event ?? chain.event ?? '';
  const mapRef = useRef<any>(null);

  const lines = useMemo(() => option.steps
    .map((st, i) => ({ i, st, pts: st.polyline ? decodePolyline(st.polyline) : [] }))
    .filter((l) => l.pts.length > 1), [option]);

  let map: React.ReactNode = null;
  if (!isExpoGo && lines.length) {
    const Maps = require('react-native-maps');
    const MapView = Maps.default;
    const { Polyline, Marker } = Maps;
    const frame = [...framePoints(option).map((p) => ({ latitude: p.lat, longitude: p.lng })),
      ...lines.flatMap((l) => l.pts)];
    const lats = frame.map((p) => p.latitude);
    const lngs = frame.map((p) => p.longitude);
    // initialRegion is read once, before the map has a size — on her phone
    // (19.10) the map opened on the north coast with no line in view. The
    // frame is fitted once the map is ready, and again when the way changes.
    const fit = () => mapRef.current?.fitToCoordinates?.(frame, {
      edgePadding: { top: 30, right: 30, bottom: 30, left: 30 }, animated: false,
    });
    console.warn('[ChainCard] drawing', option.kind, `${lines.length} lines`, `${frame.length} points`);
    const region = {
      latitude: (Math.min(...lats) + Math.max(...lats)) / 2,
      longitude: (Math.min(...lngs) + Math.max(...lngs)) / 2,
      latitudeDelta: Math.max(0.01, (Math.max(...lats) - Math.min(...lats)) * 1.4),
      longitudeDelta: Math.max(0.01, (Math.max(...lngs) - Math.min(...lngs)) * 1.4),
    };
    map = (
      // key: a new region for each way — initialRegion is read once.
      <MapView key={`m${sel}`} ref={mapRef} style={styles.map} initialRegion={region}
        onMapReady={fit} onLayout={fit} pointerEvents="none">
        {lines.map(({ i, st, pts }) => (
          <Polyline key={`l${i}`} coordinates={pts} strokeWidth={5} zIndex={10 + i}
            strokeColor={MODE_COLOR[st.mode] ?? BRAND.warmInk}
            lineDashPattern={st.after ? [8, 6] : undefined} />
        ))}
        {option.steps.map((st, i) => (st.to_pt && (st.to_pt.lat !== 0 || st.to_pt.lng !== 0) ? (
          <Marker key={`p${i}`} coordinate={{ latitude: st.to_pt.lat, longitude: st.to_pt.lng }}
            title={stepLine(st, he, vehicle, eventName)}
            pinColor={st.to === 'vehicle' ? BRAND.sunGold : st.to === 'home' ? BRAND.warmInk : MODE_COLOR.bus} />
        ) : null))}
      </MapView>
    );
  }

  const rtl = he ? styles.rtl : null;
  return (
    <View style={styles.card}>
      {chain.clash ? (
        <Text style={[styles.clash, rtl]}>
          {he ? `⚠️ ${chain.wish ?? 'האימון'} נופל בתוך ${chain.clash.with} (${chain.clash.start}–${chain.clash.end ?? ''})`
            : `⚠️ ${chain.wish ?? 'The workout'} falls inside ${chain.clash.with} (${chain.clash.start}–${chain.clash.end ?? ''})`}
        </Text>
      ) : null}
      <View style={[styles.chips, he && styles.rowRtl]}>
        {chain.options.map((o, i) => (
          <TouchableOpacity key={`c${i}`} onPress={() => setSel(i)} accessibilityRole="button"
            accessibilityState={{ selected: i === sel }}
            style={[styles.chip, i === sel && styles.chipOn]}>
            <Text style={[styles.chipText, i === sel && styles.chipTextOn]} numberOfLines={1}>
              {chipTitle(o, i, he, vehicle)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      {map}
      <Text style={[styles.leave, rtl]}>
        {he ? `🚪 לצאת ${option.leave_at ?? ''}` : `🚪 Leave ${option.leave_at ?? ''}`}
        {option.home_at ? (he ? ` · בבית ${option.home_at}` : ` · home ${option.home_at}`) : ''}
        {option.leave_event_at ? (he ? ` · לצאת מ${chain.clash?.with ?? ''} ${option.leave_event_at}` : ` · leave ${chain.clash?.with ?? ''} ${option.leave_event_at}`) : ''}
      </Text>
      {option.steps.map((st, i) => (
        <Text key={`s${i}`} style={[styles.step, rtl, st.after && styles.stepAfter]}>
          {stepLine(st, he, vehicle, eventName)}
        </Text>
      ))}
      <Text style={[styles.legend, rtl]}>
        {he ? 'סגול = אוטובוס · זהב = אופניים · אפור = הליכה · מקווקו = אחרי האירוע'
          : 'purple = bus · gold = bike · grey = walk · dashed = after the event'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: BRAND.creamCard, borderRadius: RADIUS.card, borderWidth: 1, borderColor: BRAND.line,
    padding: 12, gap: 8, marginTop: 6, maxWidth: 360,
  },
  rtl: { textAlign: 'right', writingDirection: 'rtl' },
  rowRtl: { flexDirection: 'row-reverse' },
  clash: { fontFamily: FONTS.bodyBold, fontSize: 13, color: BRAND.warmInk },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    minHeight: MIN_TOUCH, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 999,
    borderWidth: 1.5, borderColor: BRAND.line, backgroundColor: BRAND.creamCard,
  },
  chipOn: { backgroundColor: BRAND.goldSoft, borderColor: BRAND.sunGold },
  chipText: { fontFamily: FONTS.bodyBold, fontSize: 13, color: BRAND.inkSoft },
  chipTextOn: { color: BRAND.warmInk },
  map: { height: MAP_H, borderRadius: RADIUS.chip },
  leave: { fontFamily: FONTS.bodyHeavy, fontSize: 15, color: BRAND.warmInk },
  step: { fontFamily: FONTS.body, fontSize: 13, color: BRAND.warmInk, lineHeight: 20 },
  stepAfter: { color: BRAND.inkSoft },
  legend: { fontFamily: FONTS.body, fontSize: 11, color: BRAND.inkFaint },
});
