/**
 * LearnedRules — "What I learned from you", in You (6.10, her pick: a rule is
 * proposed after two same answers, made only with her yes, listed here with ×).
 *
 * Shows the cached list (RulesCache) and, when the last refresh failed, says
 * so — "no rules" and "could not check" must not look alike (rule 1). Also
 * shows Meira's questions still waiting for an answer.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BRAND, FONTS } from '../../constants/theme';
import { cachedRules, refreshRules, RulesSnapshot } from '../../services/RulesCache';
import { removeRule } from '../../services/LumiServer';
import { invalidateRoutines } from '../../services/GapFillService';
import * as Questions from '../../services/QuestionService';
import type { MeiraQuestion } from '../../questions/types';

export default function LearnedRules({ he }: { he: boolean }) {
  const [snap, setSnap] = useState<RulesSnapshot>({ rules: [], at: 0 });
  const [open, setOpen] = useState<MeiraQuestion[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    cachedRules().then(setSnap);
    Questions.pending().then(setOpen).catch(() => setOpen([]));
  }, []);
  useEffect(() => {
    load();
    refreshRules().then(setSnap).catch(() => {});
    return Questions.onQuestionsChanged(load);
  }, [load]);

  const remove = async (id: string) => {
    const r = await removeRule(id);
    if (!r.ok) return setError(he ? `לא נמחק: ${r.reason}` : `Not removed: ${r.reason}`);
    setError(null);
    setSnap(await refreshRules());
    invalidateRoutines();
  };

  return (
    <View style={styles.wrap}>
      {open.length ? (
        <TouchableOpacity style={styles.questions} accessibilityRole="button"
          onPress={() => { Questions.askNow(open[0].key).catch(() => {}); }}>
          <Text style={[styles.qText, he && styles.rtl]}>
            {he ? `💬 מאירה שואלת (${open.length}) ›` : `💬 Meira's questions (${open.length}) ›`}
          </Text>
        </TouchableOpacity>
      ) : null}
      {snap.rules.map((r) => (
        <View key={r.id} style={[styles.row, he && styles.rowRtl]}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.text, he && styles.rtl]}>{he ? r.text.he : r.text.en}</Text>
            <Text style={[styles.tag, he && styles.rtl]}>{he ? 'למדתי מהתשובות שלך' : 'learned from your answers'}</Text>
          </View>
          <TouchableOpacity style={styles.x} onPress={() => remove(r.id)} accessibilityRole="button"
            accessibilityLabel={he ? 'מחיקת הכלל' : 'Remove this rule'}>
            <Text style={styles.xText}>×</Text>
          </TouchableOpacity>
        </View>
      ))}
      {!snap.rules.length ? (
        <Text style={[styles.empty, he && styles.rtl]}>
          {snap.error
            ? (he ? `לא הצלחתי לבדוק עכשיו: ${snap.error}` : `Couldn't check just now: ${snap.error}`)
            : (he ? 'עוד אין כללים. כשתעני אותו דבר פעמיים, אשאל אם להפוך את זה לכלל.'
              : "No rules yet. When you answer the same way twice, I'll ask whether to make it one.")}
        </Text>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 4 },
  questions: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: BRAND.line },
  qText: { fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.goldInk },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: BRAND.line },
  rowRtl: { flexDirection: 'row-reverse' },
  text: { fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.warmInk },
  tag: { fontFamily: FONTS.body, fontSize: 11, color: BRAND.inkSoft, marginTop: 2 },
  rtl: { textAlign: 'right', writingDirection: 'rtl' },
  x: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  // × is thinner than the old ballot-X at the same size, so it is drawn bigger.
  xText: { fontFamily: FONTS.bodyHeavy, fontSize: 22, lineHeight: 24, color: BRAND.inkSoft },
  empty: { fontFamily: FONTS.body, fontSize: 13, color: BRAND.inkSoft, paddingVertical: 8 },
  error: { fontFamily: FONTS.bodyHeavy, fontSize: 12, color: BRAND.danger },
});
