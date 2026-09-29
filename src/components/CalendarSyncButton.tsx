/**
 * CalendarSyncButton — "📅↻ 12:04": re-read Google Calendar now, and show when
 * it was last read.
 *
 * The import already runs by itself (CalendarAutoSync: app open, foreground,
 * background task). This is the fourth trigger from rule 7 — "she went
 * looking" — with the throttle forced past, because "I added it in Google a
 * minute ago" must work on the first tap.
 *
 * The time on the button is the whole point. A sync button with no memory of
 * the last sync is a button she presses on faith. And when Google refused us,
 * the button turns red and says why on tap, in Google's own words (rule 3: a
 * check that cannot fail is not a check).
 *
 * Dependencies: CalendarAutoSync. Consumed by TodaySchedule's header.
 */
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, TouchableOpacity } from 'react-native';
import { BRAND, FONTS } from '../constants/theme';
import { AppLanguage } from '../types/index';
import { lastSyncAt, onCalendarSync, syncCalendarNow } from '../services/CalendarAutoSync';

const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export default function CalendarSyncButton({ language }: { language: AppLanguage }) {
  const he = language === 'he';
  const [busy, setBusy] = useState(false);
  const [at, setAt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    lastSyncAt().then(setAt).catch(() => undefined);
    const off = onCalendarSync((r) => {
      setError(r.error);
      if (r.ran) lastSyncAt().then(setAt).catch(() => undefined);
    });
    return () => {
      off();
      if (flashTimer.current) clearTimeout(flashTimer.current);
    };
  }, []);

  const showFlash = (text: string) => {
    setFlash(text);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 3500);
  };

  const onPress = async () => {
    if (error && !busy) {
      // Red button: say why first; the retry is one tap away inside.
      Alert.alert(
        he ? 'היומן לא נבדק' : 'Calendar not checked',
        error,
        [
          { text: he ? 'סגירה' : 'Close', style: 'cancel' },
          { text: he ? 'לנסות שוב' : 'Try again', onPress: () => { runSync(); } },
        ],
      );
      return;
    }
    runSync();
  };

  const runSync = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await syncCalendarNow(language, 'header-button');
      setError(r.error);
      setAt(await lastSyncAt().catch(() => Date.now()));
      if (r.error) {
        showFlash(he ? 'נכשל' : 'failed');
      } else {
        showFlash(r.added > 0 ? `+${r.added}` : '✓');
      }
    } catch (e) {
      console.warn('[CalendarSyncButton] sync threw', e);
      setError(String(e).slice(0, 160));
    } finally {
      setBusy(false);
    }
  };

  const label = flash ?? (at ? hhmm(at) : (he ? 'סנכרון' : 'Sync'));

  return (
    <TouchableOpacity
      onPress={onPress}
      style={[styles.pill, error ? styles.pillError : null]}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      accessibilityRole="button"
      accessibilityLabel={he
        ? `סנכרון יומן גוגל. אחרון: ${at ? hhmm(at) : 'אף פעם'}`
        : `Sync Google Calendar. Last: ${at ? hhmm(at) : 'never'}`}
    >
      {busy
        ? <ActivityIndicator size="small" color={BRAND.goldInk} />
        : <Text style={[styles.text, error ? styles.textError : null]}>📅↻ {label}</Text>}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  pill: {
    minWidth: 76, height: 36, borderRadius: 18, paddingHorizontal: 10,
    backgroundColor: BRAND.goldSoft, alignItems: 'center', justifyContent: 'center',
  },
  pillError: { backgroundColor: '#FBE3E8', borderWidth: 1, borderColor: BRAND.danger },
  text: { fontFamily: FONTS.bodyBold, fontSize: 12.5, color: BRAND.goldInk },
  textError: { color: BRAND.danger },
});
