/**
 * FeedbackThumbs — 👍/👎 on one suggestion, and what it changes.
 *
 * The confirmation is the server's own sentence ("won't be recommended
 * again"), shown only after the verdict is SAVED — never a "thanks" for a
 * request that failed (lumi-fake-confirmations). A 👎 then offers an optional
 * reason; tapping one re-sends the verdict with it (the server keeps the latest).
 */
import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';

import { BRAND, FONTS } from '../constants/theme';
import { sendFeedback, type FeedbackInput } from '../services/LumiServer';

type Props = Omit<FeedbackInput, 'verdict' | 'reason'> & { he: boolean };

const REASONS: Record<FeedbackInput['surface'], { en: string; he: string }[]> = {
  errand: [
    { en: 'too far', he: 'רחוק מדי' },
    { en: 'too expensive', he: 'יקר מדי' },
    { en: "didn't like it", he: 'לא אהבתי' },
  ],
  prep: [
    { en: 'not useful', he: 'לא שימושי' },
    { en: 'wrong language', he: 'שפה לא נכונה' },
    { en: 'not relevant', he: 'לא רלוונטי' },
  ],
  brief: [
    { en: 'not useful', he: 'לא שימושי' },
    { en: 'wrong company', he: 'חברה לא נכונה' },
  ],
};

export default function FeedbackThumbs({ he, ...item }: Props) {
  const [state, setState] = useState<
    { s: 'idle' } | { s: 'sending'; v: 'up' | 'down' } | { s: 'done'; v: 'up' | 'down'; effect: string; reason?: string } | { s: 'failed'; why: string }
  >({ s: 'idle' });

  const send = async (verdict: 'up' | 'down', reason?: string) => {
    setState({ s: 'sending', v: verdict });
    const r = await sendFeedback({ ...item, verdict, reason });
    if (r.ok) setState({ s: 'done', v: verdict, effect: r.data.effect, reason });
    else setState({ s: 'failed', why: r.reason });
  };

  if (state.s === 'sending') return <ActivityIndicator size="small" color={BRAND.sunGold} style={styles.wrap} />;

  if (state.s === 'done') {
    return (
      <View style={styles.wrap}>
        <Text style={styles.done}>{state.v === 'up' ? '👍' : '👎'} ✓ {state.effect}</Text>
        {state.v === 'down' && !state.reason ? (
          <View style={styles.chips}>
            {REASONS[item.surface].map((r) => (
              <TouchableOpacity key={r.en} style={styles.chip} onPress={() => send('down', r.en)}>
                <Text style={styles.chipText}>{he ? r.he : r.en}</Text>
              </TouchableOpacity>
            ))}
          </View>
        ) : null}
      </View>
    );
  }

  return (
    <View style={[styles.wrap, styles.row]}>
      <TouchableOpacity onPress={() => send('up')} hitSlop={8} accessibilityLabel={he ? 'אהבתי' : 'Good suggestion'}>
        <Text style={styles.thumb}>👍</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={() => send('down')} hitSlop={8} accessibilityLabel={he ? 'לא אהבתי' : 'Not for me'}>
        <Text style={styles.thumb}>👎</Text>
      </TouchableOpacity>
      {state.s === 'failed' ? (
        <Text style={styles.failed} numberOfLines={2}>{he ? 'לא נשמר: ' : 'Not saved: '}{state.why}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  thumb: { fontSize: 16 },
  done: { fontSize: 12, fontFamily: FONTS.bodySemi, color: BRAND.success },
  failed: { flex: 1, fontSize: 11, fontFamily: FONTS.body, color: BRAND.danger },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  chip: { borderWidth: 1, borderColor: BRAND.line, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4, backgroundColor: BRAND.creamCard },
  chipText: { fontSize: 12, fontFamily: FONTS.body, color: BRAND.warmInk },
});
