/**
 * HistorySwitch — "Learn from my history", option 1 (Koral, 20.10): a switch in
 * Menu → More with one sentence of what it means. Off by default. Turning it on
 * asks the server (consent + 90-day backfill); turning it off deletes the log.
 * A refused switch flips back and says why — never a silent ✓ (rule 3).
 */
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Switch, Text, View, StyleSheet } from 'react-native';
import { historyOptedIn, setHistoryOptIn } from '../services/HistoryService';
import { BRAND, FONTS, MIN_TOUCH } from '../constants/theme';

export default function HistorySwitch({ he }: { he: boolean }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    historyOptedIn().then(setOn).catch((e) => { console.warn('[HistorySwitch] read failed', e); setOn(false); });
  }, []);

  const flip = async (next: boolean) => {
    setBusy(true);
    setNote(null);
    const r = await setHistoryOptIn(next).catch((e) => ({ ok: false as const, reason: String(e).slice(0, 80) }));
    setBusy(false);
    if (!r.ok) {
      setNote(he ? `לא נשמר · ${r.reason}` : `Not saved · ${r.reason}`);
      return;
    }
    setOn(next);
    if (next) {
      const n = (r as { backfilled?: number }).backfilled ?? 0;
      setNote(he ? `פועל · נקלטו ${n} אירועים מ-3 החודשים האחרונים` : `On · ${n} events from the last 3 months`);
    } else {
      setNote(he ? 'כבוי · ההיסטוריה נמחקה' : 'Off · your history was deleted');
    }
  };

  const rtl = he ? styles.rtl : null;
  return (
    <View style={styles.wrap}>
      <View style={[styles.row, he && styles.rowRtl]}>
        <Text style={[styles.label, rtl]}>{he ? '🧠 ללמוד מההיסטוריה שלי' : '🧠 Learn from my history'}</Text>
        {on === null || busy ? <ActivityIndicator color={BRAND.goldInk} /> : (
          <Switch value={on} onValueChange={flip} accessibilityLabel={he ? 'ללמוד מההיסטוריה שלי' : 'Learn from my history'}
            trackColor={{ true: BRAND.sunGold, false: BRAND.line }} />
        )}
      </View>
      <Text style={[styles.sub, rtl]}>
        {he
          ? 'מירה סופרת אימונים, למידה, זמן בדרכים ודחיות, ודוחפת אותך ליעדים. נשמר 3 חודשים. כיבוי = מחיקה.'
          : 'Meira counts workouts, learning, road time and reschedules, and pushes you on your goals. Kept 3 months. Off = deleted.'}
      </Text>
      {note ? <Text style={[styles.note, rtl]}>{note}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingVertical: 8 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: MIN_TOUCH, gap: 8 },
  rowRtl: { flexDirection: 'row-reverse' },
  label: { flex: 1, fontFamily: FONTS.body, fontSize: 15, color: BRAND.warmInk },
  sub: { fontFamily: FONTS.body, fontSize: 12, color: BRAND.inkSoft, marginTop: 2 },
  note: { fontFamily: FONTS.body, fontSize: 12, color: BRAND.inkFaint, marginTop: 4 },
  rtl: { textAlign: 'right', writingDirection: 'rtl' },
});
