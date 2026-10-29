/**
 * LearnedCard — what the chat just saved about her, said back with Undo (6.10).
 *
 * Her pick: ONE chat, and "whatever Meira learns appears as a card with ✓ / ×,
 * then shows in You". The server reports each change of the turn
 * (agent_turn.profile_changes); a routine she told can be undone right here,
 * anything else is edited in You. An Undo that did not land says so (rule 3).
 */
import React, { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BRAND, FONTS } from '../constants/theme';
import { ProfileChange, removeToldRoutines } from '../services/LumiServer';
import { invalidateRoutines } from '../services/GapFillService';

const HEBREW = /[֐-׿]/;
const FIELD: Record<string, { icon: string; en: string; he: string }> = {
  homeAddress: { icon: '🏠', en: 'Home', he: 'בית' },
  transportType: { icon: '🚌', en: 'Usual transport', he: 'תחבורה רגילה' },
  hobbies: { icon: '🎨', en: 'Hobbies', he: 'תחביבים' },
  morningRoutineMinutes: { icon: '⏰', en: 'Mornings take (min)', he: 'הבוקר לוקח (דק׳)' },
  name: { icon: '👤', en: 'Name', he: 'שם' },
};

interface Props {
  change: ProfileChange;
  he: boolean;
  onOpenYou: () => void;
}

export default function LearnedCard({ change, he, onOpenYou }: Props) {
  const [state, setState] = useState<{ busy?: boolean; undone?: boolean; error?: string }>({});
  const routine = change.kind === 'routine_added';

  const undo = async () => {
    setState({ busy: true });
    const r = await removeToldRoutines([change.text || '']);
    if (!r.ok) return setState({ error: r.reason });
    if (!r.data.removed.length) {
      return setState({ error: he ? 'השורה כבר לא שם' : 'That line is no longer there' });
    }
    invalidateRoutines();
    setState({ undone: true });
  };

  if (change.kind === 'routine_removed') {
    return (
      <View style={styles.card}>
        <Text style={[styles.what, HEBREW.test(change.text || '') && styles.rtl]}>{`🗑 ${change.text}`}</Text>
        <Text style={styles.so}>{he ? '→ הורדתי מהשגרה שלך' : '→ Taken out of your routines'}</Text>
      </View>
    );
  }

  const field = FIELD[change.field || ''];
  const what = routine
    ? `🔁 ${change.text}`
    : `${field?.icon ?? '•'} ${field ? (he ? field.he : field.en) : change.field}: ${String(change.after ?? '')}`;
  return (
    <View style={[styles.card, state.undone && styles.cardOff]}>
      <Text style={styles.kicker}>{he ? 'אזכור:' : "I'll remember:"}</Text>
      <Text style={[styles.what, HEBREW.test(what) && styles.rtl, state.undone && styles.struck]}>{what}</Text>
      <Text style={styles.so}>
        {state.undone ? (he ? '↩ בוטל' : '↩ Undone')
          : routine ? (he ? '→ אתכנן סביבו את הימים שלך' : "→ I'll plan your days around it")
            : (he ? '→ מעכשיו התכנונים משתמשים בזה' : '→ Plans use this from now on')}
      </Text>
      {state.error ? <Text style={styles.error}>{he ? `לא בוטל: ${state.error}` : `Not undone: ${state.error}`}</Text> : null}
      {!state.undone && (
        <View style={[styles.actions, he && styles.rowRtl]}>
          {routine ? (
            <TouchableOpacity style={styles.btn} disabled={state.busy} onPress={undo} accessibilityRole="button">
              <Text style={styles.btnText}>{state.busy ? '…' : he ? '↩ בטלי' : '↩ Undo'}</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity style={styles.btn} onPress={onOpenYou} accessibilityRole="button">
            <Text style={styles.btnText}>{he ? 'ב„את” ›' : 'In You ›'}</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    alignSelf: 'stretch', marginVertical: 4, padding: 12, gap: 4, borderRadius: 16,
    borderWidth: 1.5, borderColor: BRAND.line, backgroundColor: BRAND.creamCard,
  },
  cardOff: { opacity: 0.6 },
  kicker: { fontFamily: FONTS.bodyHeavy, fontSize: 12, color: BRAND.goldInk },
  what: { fontFamily: FONTS.bodyHeavy, fontSize: 15, color: BRAND.warmInk },
  struck: { textDecorationLine: 'line-through' },
  rtl: { textAlign: 'right', writingDirection: 'rtl' },
  so: { fontFamily: FONTS.body, fontSize: 12, color: BRAND.inkSoft },
  error: { fontFamily: FONTS.bodyHeavy, fontSize: 12, color: BRAND.danger },
  actions: { flexDirection: 'row', gap: 8, marginTop: 4, justifyContent: 'flex-end' },
  rowRtl: { flexDirection: 'row-reverse' },
  btn: { borderRadius: 999, borderWidth: 1, borderColor: BRAND.line, paddingHorizontal: 12, paddingVertical: 6 },
  btnText: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.warmInk },
});
