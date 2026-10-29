/**
 * MyWeekCard — "My week", option A (Koral, 20.10): workouts, learning, road time
 * and reschedules, this week vs last, and the one firm line. Words and states:
 * utils/myWeekView. Data: GET /app/history/week (server/history_store.report).
 * A failed load says so (rule 3); "off" says where to turn it on.
 */
import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Text, TouchableOpacity, View, StyleSheet } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { historyWeek } from '../services/LumiServer';
import { myWeekView, type MyWeekView } from '../utils/myWeekView';
import { BRAND, FONTS, MIN_TOUCH } from '../constants/theme';

export default function MyWeekCard({ he }: { he: boolean }) {
  const [view, setView] = useState<MyWeekView | null>(null);

  const load = useCallback(() => {
    setView(null);
    historyWeek('this week')
      .then((r) => setView(myWeekView(r, he)))
      .catch((e) => {
        console.warn('[MyWeekCard] load failed', e);
        setView(myWeekView({ ok: false, reason: String(e).slice(0, 80) }, he));
      });
  }, [he]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const rtl = he ? styles.rtl : null;
  if (!view) {
    return <View style={styles.card}><ActivityIndicator color={BRAND.goldInk} /></View>;
  }
  if (view.state !== 'ok') {
    return (
      <View style={styles.card}>
        <Text style={[styles.title, rtl]}>{he ? 'השבוע שלי' : 'My week'}</Text>
        <Text style={[styles.note, rtl]}>{view.text}</Text>
        {view.state === 'failed' ? (
          <TouchableOpacity onPress={load} style={styles.retry} accessibilityRole="button">
            <Text style={styles.retryText}>{he ? 'לנסות שוב' : 'Try again'}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    );
  }
  return (
    <View style={styles.card}>
      <Text style={[styles.title, rtl]}>{view.title}</Text>
      <View style={[styles.grid, he && styles.gridRtl]}>
        {view.tiles.map((t) => (
          <View key={t.label} style={styles.tile} accessible accessibilityLabel={`${t.label} ${t.value}, ${t.before}`}>
            <Text style={[styles.tileLabel, rtl]}>{t.icon} {t.label}</Text>
            <Text style={[styles.tileValue, rtl]}>{t.value}</Text>
            <Text style={[styles.tileBefore, rtl]}>{t.before}</Text>
          </View>
        ))}
      </View>
      {view.line ? <Text style={[styles.line, rtl]}>{view.line}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: BRAND.creamCard, borderRadius: 16, padding: 14, marginBottom: 14,
    borderWidth: 0.5, borderColor: BRAND.line },
  title: { fontFamily: FONTS.displaySemi, fontSize: 15, color: BRAND.warmInk, marginBottom: 10 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  gridRtl: { flexDirection: 'row-reverse' },
  tile: { width: '48%', backgroundColor: BRAND.goldSoft, borderRadius: 10, padding: 10, minHeight: MIN_TOUCH },
  tileLabel: { fontFamily: FONTS.body, fontSize: 12, color: BRAND.inkSoft },
  tileValue: { fontFamily: FONTS.displaySemi, fontSize: 20, color: BRAND.warmInk, marginTop: 2 },
  tileBefore: { fontFamily: FONTS.body, fontSize: 11, color: BRAND.inkFaint, marginTop: 2 },
  line: { fontFamily: FONTS.body, fontSize: 14, color: BRAND.warnInk, marginTop: 10 },
  note: { fontFamily: FONTS.body, fontSize: 13, color: BRAND.inkSoft },
  retry: { marginTop: 8, minHeight: MIN_TOUCH, justifyContent: 'center' },
  retryText: { fontFamily: FONTS.body, fontSize: 14, color: BRAND.goldInk, textDecorationLine: 'underline' },
  rtl: { textAlign: 'right', writingDirection: 'rtl' },
});
