/**
 * TransitAlertLine — option A under a trip row: the headline, its source and
 * when it was checked; tap opens the report. "Couldn't check" is drawn too,
 * muted, so a failed check never looks like a clear road (rule 3).
 * Words: utils/transitAlertLine. Data: location.transitAlerts, written by
 * TransitAlertService on every calendar-sync path.
 */
import React from 'react';
import { Linking, Text, TouchableOpacity, View, StyleSheet } from 'react-native';
import type { TaskTransitAlerts } from '../types';
import { transitAlertLine } from '../utils/transitAlertLine';
import { BRAND, FONTS } from '../constants/theme';

export default function TransitAlertLine({ state, he }: { state?: TaskTransitAlerts; he: boolean }) {
  const line = transitAlertLine(state, he);
  if (!line) return null;
  const warn = line.kind === 'warn';
  const body = (
    <View style={styles.wrap}>
      <Text style={[styles.text, warn ? styles.warn : styles.muted]} numberOfLines={2}>
        {line.text}
        {line.source ? <Text style={styles.source}>{` · ${line.source} ↗`}</Text> : null}
      </Text>
      <Text style={styles.checked}>
        {line.checked}
        {line.more ? (he ? ` · ועוד ${line.more}` : ` · +${line.more} more`) : ''}
      </Text>
    </View>
  );
  if (!warn || !line.link) return body;
  return (
    <TouchableOpacity
      accessibilityRole="link"
      accessibilityLabel={`${line.text}. ${line.source ?? ''}`}
      activeOpacity={0.7}
      hitSlop={{ top: 8, bottom: 8 }}
      onPress={() => {
        Linking.openURL(line.link!).catch((e) => console.warn('[TransitAlertLine] open failed', e));
      }}
    >
      {body}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 12, paddingBottom: 8, paddingTop: 2, minHeight: 44, justifyContent: 'center' },
  text: { fontSize: 13, fontFamily: FONTS.body },
  warn: { color: BRAND.warnInk },
  muted: { color: BRAND.inkFaint },
  source: { textDecorationLine: 'underline' },
  checked: { fontSize: 11, color: BRAND.inkFaint, marginTop: 2 },
});
