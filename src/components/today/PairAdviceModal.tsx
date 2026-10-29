/**
 * PairAdviceModal — "2 events overlap · Meira suggests…"
 *
 * Two events at one hour used to be a one-line grey note. This is the popup:
 * Meira's pick first with its reasons, the other option with ITS reasons, and
 * what each leaves her next to (utils/pairAdvice — code, no model call). She
 * decides; picking records the answer and hides the warning. The other event is
 * NOT deleted — it stays on her calendar, because declining an invitation is a
 * message to other people and is hers to send.
 */
import React, { useEffect, useState } from 'react';
import { Linking, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BRAND, FONTS, SHADOWS, surf } from '../../constants/theme';
import { GoogleService } from '../../services/GoogleService';
import { sourceLinkOf } from '../../utils/sourceLink';
import type { PairAdvice, SideAdvice } from '../../utils/pairAdvice';

interface Props {
  advice: PairAdvice | null;
  he: boolean;
  onChoose: (taskId: string) => void;
  onLater: () => void;
}

export default function PairAdviceModal({ advice, he, onChoose, onLater }: Props) {
  // The one connected Google account, so a link opens the exact item.
  const [email, setEmail] = useState<string | undefined>();
  const open = Boolean(advice);
  useEffect(() => {
    if (!open) return undefined; // no popup, no account lookup
    let alive = true;
    GoogleService.listGoogleAccounts()
      .then((a) => { if (alive) setEmail(a.length === 1 && a[0].email ? a[0].email : undefined); })
      .catch((e) => console.warn('[PairAdvice] google accounts', String(e?.message || e)));
    return () => { alive = false; };
  }, [open]);
  if (!advice) return null;

  const first: SideAdvice = advice.pick === 'a' ? advice.a : advice.b;
  const second: SideAdvice = advice.pick === 'a' ? advice.b : advice.a;
  const at = first.task.fixedTime || first.task.scheduledTime || '';

  const block = (side: SideAdvice, recommended: boolean) => {
    const link = sourceLinkOf(side.task, email);
    const pros = side.pros.slice(0, 3);
    return (
      <View style={[styles.block, recommended && styles.blockPick]}>
        <Text style={styles.tag}>
          {recommended ? (he ? '✨ מאירה ממליצה' : '✨ Meira suggests') : (he ? 'או' : 'Or')}
        </Text>
        <Text style={styles.title}>
          {he ? `לבחור ב-${side.task.text}` : `Choose ${side.task.text}`}
        </Text>
        <Text style={styles.because}>{he ? 'כי:' : 'Because:'}</Text>
        {pros.length === 0 ? (
          <Text style={styles.line}>• {he ? 'אין הבדל ברור — זו החלטה שלך' : 'nothing clearly tips it — your call'}</Text>
        ) : pros.map((r, i) => <Text key={i} style={styles.line}>• {he ? r.he : r.en}</Text>)}
        {side.cons.slice(0, 2).map((r, i) => (
          <Text key={`c${i}`} style={styles.con}>– {he ? r.he : r.en}</Text>
        ))}
        {link ? (
          <TouchableOpacity onPress={() => Linking.openURL(link.url).catch((e) => console.warn('[PairAdvice] open', String(e?.message || e)))}>
            <Text style={styles.link}>↗ {he ? link.labelHe : link.labelEn}</Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity style={[styles.btn, recommended && styles.btnPick]} onPress={() => onChoose(side.task.id)} accessibilityRole="button">
          <Text style={styles.btnText}>{he ? 'בוחרת בזה' : 'Go with this'}</Text>
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onLater}>
      <View style={styles.scrim}>
        <View style={styles.sheet}>
          <Text style={styles.head}>
            {he ? `⚠️ שני אירועים חופפים ${at ? `ב-${at}` : ''}` : `⚠️ 2 events overlap${at ? ` at ${at}` : ''}`}
          </Text>
          <ScrollView style={{ maxHeight: 460 }} showsVerticalScrollIndicator={false}>
            {advice.closeCall ? (
              <Text style={styles.close}>{he ? 'קרוב מאוד — זה מה שמטה את הכף:' : 'Close call — this is what tips it:'}</Text>
            ) : null}
            {block(first, true)}
            {block(second, false)}
            <Text style={styles.note}>
              {he ? 'האירוע השני נשאר ביומן — לדחות הזמנה זה שלך.' : 'The other one stays on your calendar — declining an invite is yours to send.'}
            </Text>
          </ScrollView>
          <TouchableOpacity onPress={onLater} style={styles.later} accessibilityRole="button">
            <Text style={styles.laterText}>{he ? 'אחר כך' : 'Decide later'}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', padding: 16 },
  sheet: { backgroundColor: BRAND.creamCard, borderRadius: 22, padding: 16, ...SHADOWS.card },
  head: { fontFamily: FONTS.display, fontSize: 18, color: BRAND.warmInk, marginBottom: 10 },
  close: { fontFamily: FONTS.bodyBold, fontSize: 12, color: BRAND.inkFaint, marginBottom: 6 },
  block: { borderRadius: 16, borderWidth: 1.5, borderColor: BRAND.line, backgroundColor: surf(BRAND.white), padding: 12, marginBottom: 10 },
  blockPick: { borderColor: BRAND.sunGold, backgroundColor: BRAND.honey },
  tag: { fontFamily: FONTS.bodyHeavy, fontSize: 12, color: BRAND.goldInk },
  title: { fontFamily: FONTS.bodyHeavy, fontSize: 16, color: BRAND.warmInk, marginTop: 2 },
  because: { fontFamily: FONTS.bodyBold, fontSize: 12, color: BRAND.inkFaint, marginTop: 8 },
  line: { fontFamily: FONTS.body, fontSize: 13, color: BRAND.warmInk, marginTop: 3 },
  con: { fontFamily: FONTS.body, fontSize: 12, color: BRAND.inkSoft, marginTop: 3 },
  link: { fontFamily: FONTS.bodyHeavy, fontSize: 12, color: BRAND.danger, marginTop: 8 },
  btn: { marginTop: 10, alignItems: 'center', borderRadius: 999, borderWidth: 1.5, borderColor: BRAND.line, paddingVertical: 9 },
  btnPick: { backgroundColor: BRAND.sunGold, borderColor: BRAND.sunGold },
  btnText: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.warmInk },
  note: { fontFamily: FONTS.body, fontSize: 11, color: BRAND.inkFaint, marginBottom: 4 },
  later: { alignItems: 'center', paddingTop: 8 },
  laterText: { fontFamily: FONTS.bodyBold, fontSize: 13, color: BRAND.inkSoft },
});
