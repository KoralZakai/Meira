/**
 * RouteMap — in-app route preview for a task with a computed TransitPlan:
 * react-native-maps polyline + start/destination markers + a one-tap
 * "Navigate" button that deep-links Google Maps turn-by-turn.
 *
 * EAS builds only: react-native-maps has no native module inside Expo Go, so
 * there we render the text legs fallback (same info, no map). The conditional
 * require keeps Expo Go from crashing at import time.
 *
 * Dependencies: react-native-maps (EAS), utils/isExpoGo, types (TransitPlan).
 * Consumed by TaskDetailBottomSheet.
 */
import React from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { TransitPlan } from '../types/index';
import { hasRealCoords } from '../utils/placeCoords';
import { isExpoGo } from '../utils/isExpoGo';
import { BRAND, FONTS, RADIUS } from '../constants/theme';

const LUMI_PURPLE = '#6C63FF';

interface Props {
  plan: TransitPlan;
  destLat: number;
  destLng: number;
  destLabel?: string;
  height?: number;
  /** The page draws its own Google Maps / Waze / Moovit row (TaskDetailScreen). */
  hideNavigate?: boolean;
}

/** Decode a Google encoded polyline into lat/lng points. */
export function decodePolyline(encoded: string): Array<{ latitude: number; longitude: number }> {
  const points: Array<{ latitude: number; longitude: number }> = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    for (const which of [0, 1] as const) {
      let result = 0;
      let shift = 0;
      let b = 0x20;
      while (b >= 0x20) {
        b = encoded.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      }
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += delta;
      else lng += delta;
    }
    points.push({ latitude: lat / 1e5, longitude: lng / 1e5 });
  }
  return points;
}

const LEG_ICON: Record<string, string> = {
  walk: '🚶', bus: '🚌', train: '🚆', subway: '🚇', car: '🚗', bike: '🚲',
};

function openNavigation(lat: number, lng: number, label?: string) {
  const q = label ? encodeURIComponent(label) : `${lat},${lng}`;
  // google.navigation starts turn-by-turn directly on Android; web URL fallback.
  Linking.openURL(`google.navigation:q=${lat},${lng}`).catch(() =>
    Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${q}&travelmode=transit`),
  );
}

/** A coordinate the map can actually draw. 0,0 is the Atlantic — it is what a
 *  place stored with an address but no geocode looks like, and dropping a pin
 *  there is worse than dropping none.
 *
 *  This test was right and this map was the only thing in the app that applied
 *  it, so it sat quietly refusing to draw places the rest of the app believed
 *  it knew. It now lives in utils/placeCoords, where the PLANNER reads the same
 *  rule and goes and finds the real coordinates instead. */
const usable = hasRealCoords;

export default function RouteMap({ plan, destLat, destLng, destLabel, height = 180, hideNavigate }: Props) {
  const points = plan.overviewPolyline ? decodePolyline(plan.overviewPolyline) : [];
  const canMap = !isExpoGo && points.length > 1;
  const destOk = usable(destLat, destLng);

  let mapView: React.ReactNode = null;
  if (canMap) {
    // Conditional require: no native module in Expo Go.
    const Maps = require('react-native-maps');
    const MapView = Maps.default;
    const { Polyline, Marker } = Maps;
    const lats = points.map((p) => p.latitude);
    const lngs = points.map((p) => p.longitude);
    const region = {
      latitude: (Math.min(...lats) + Math.max(...lats)) / 2,
      longitude: (Math.min(...lngs) + Math.max(...lngs)) / 2,
      latitudeDelta: Math.max(0.01, (Math.max(...lats) - Math.min(...lats)) * 1.4),
      longitudeDelta: Math.max(0.01, (Math.max(...lngs) - Math.min(...lngs)) * 1.4),
    };
    mapView = (
      <MapView style={{ height, borderRadius: RADIUS.chip }} initialRegion={region} pointerEvents="none">
        <Polyline coordinates={points} strokeWidth={4} strokeColor={LUMI_PURPLE} />
        {usable(plan.startLat, plan.startLng) && (
          <Marker coordinate={{ latitude: plan.startLat, longitude: plan.startLng }} title="Start" pinColor={LUMI_PURPLE} />
        )}
        {destOk && (
          <Marker coordinate={{ latitude: destLat, longitude: destLng }} title={destLabel || 'Destination'} />
        )}
      </MapView>
    );
  }

  return (
    <View style={styles.wrap}>
      {mapView}
      {!canMap && (
        <View style={styles.legsBox}>
          {(plan.legs || []).map((leg, i) => (
            <Text key={i} style={styles.legText}>
              {LEG_ICON[leg.type] || '•'} {leg.from} → {leg.to}
              {leg.lineNumber ? ` (${leg.lineNumber})` : ''} · {leg.durationMinutes}m
            </Text>
          ))}
        </View>
      )}
      {destOk && !hideNavigate && (
        <Pressable style={styles.navBtn} onPress={() => openNavigation(destLat, destLng, destLabel)}>
          <Text style={styles.navText}>🧭 Navigate</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  legsBox: {
    backgroundColor: BRAND.creamCard,
    borderRadius: RADIUS.chip,
    padding: 10,
    gap: 4,
  },
  legText: { fontFamily: FONTS.body, fontSize: 13, color: BRAND.warmInk },
  navBtn: {
    backgroundColor: LUMI_PURPLE,
    borderRadius: RADIUS.chip,
    paddingVertical: 10,
    alignItems: 'center',
  },
  navText: { color: '#FFF', fontFamily: FONTS.bodyBold, fontSize: 14 },
});
