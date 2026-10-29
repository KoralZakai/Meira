/**
 * HomeConfirmCard — "📍 home is here" asks before it changes home (7.10).
 *
 * Her pick (option A): the found address on a card, "Save as home?" with
 * Yes / No, and nothing written to home without the yes. The card shows the
 * home it would replace, says when the fix already IS home, and a save that
 * did not land says so instead of ✓ (silent-state rule 3).
 * Logic: utils/homeFromHere. Same look as LearnedCard.
 */
import React, { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BRAND, FONTS } from '../constants/theme';
import type { HomeAsk } from '../utils/homeFromHere';

const HEBREW = /[֐-׿]/;

interface Props {
  ask: HomeAsk;
  he: boolean;
  /** Yes → save (resolves with whether it landed); No → leave home alone. */
  onAnswer: (yes: boolean) => Promise<{ ok: true } | { ok: false; reason: string }>;
}

export default function HomeConfirmCard({ ask, he, onAnswer }: Props) {
  const [state, setState] = useState<{ busy?: boolean; error?: string }>({});

  const answer = async (yes: boolean) => {
    setState({ busy: true });
    const r = await onAnswer(yes);
    setState(r.ok ? {} : { error: r.reason });
  };

  const what = `🏠 ${ask.address}`;
  const why = state.error === 'not stored' ? (he ? 'לא נקלט באחסון — נסי שוב' : "it didn't stick — try again") : state.error;
  const asking = !ask.same && !ask.outcome;
  return (
    <View style={[styles.card, ask.outcome === 'declined' && styles.cardOff]}>
      <Text style={[styles.kicker, he && styles.rtl]}>
        {asking ? (he ? 'לשמור ככתובת הבית?' : 'Save as your home?') : (he ? '📍 המיקום שלך' : '📍 Where you are')}
      </Text>
      <Text style={[styles.what, HEBREW.test(what) && styles.rtl, ask.outcome === 'declined' && styles.struck]}>{what}</Text>
      <Text style={[styles.so, he && styles.rtl]}>
        {ask.same ? (he ? '✓ זה כבר הבית שלך — לא שיניתי כלום' : '✓ Already your home — nothing changed')
          : ask.outcome === 'saved' ? (he ? '✓ נשמר כבית — המסלולים יוצאים מכאן' : '✓ Saved as home — routes start here now')
            : ask.outcome === 'declined' ? (he ? '× הבית לא השתנה' : '× Home not changed')
              : ask.current ? (he ? `עכשיו בבית: ${ask.current}` : `Home now: ${ask.current}`)
                : (he ? 'עוד אין כתובת בית' : 'No home saved yet')}
      </Text>
      {state.error ? (
        <Text style={[styles.error, he && styles.rtl]}>{he ? `לא נשמר: ${why}` : `Not saved: ${why}`}</Text>
      ) : null}
      {asking && (
        <View style={[styles.actions, he && styles.rowRtl]}>
          <TouchableOpacity style={[styles.btn, styles.btnYes]} disabled={state.busy} onPress={() => answer(true)}
            accessibilityRole="button">
            <Text style={styles.btnText}>{state.busy ? '…' : he ? '🏠 כן, זה הבית' : "🏠 Yes, it's home"}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.btn} disabled={state.busy} onPress={() => answer(false)}
            accessibilityRole="button">
            <Text style={styles.btnText}>{he ? '× לא' : '× No'}</Text>
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
  btnYes: { backgroundColor: BRAND.honey, borderColor: BRAND.honey },
  btnText: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.warmInk },
});
