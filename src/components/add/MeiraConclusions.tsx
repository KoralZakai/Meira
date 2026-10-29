/**
 * MeiraConclusions — what Meira worked out about the sentence, and the greeting
 * she drafted.
 *
 * Three honest states, never silence:
 *   thinking  a line with a spinner (the space is reserved, so nothing jumps)
 *   failed    ONE short line — "couldn't think that through, add as usual" —
 *             and the chips and Add keep working; an allowance that is used up
 *             reads differently from a model that is down
 *   ok        chips: some act (a reminder, the greeting, WhatsApp), some only
 *             inform ("prep brief + likely questions")
 *
 * The greeting is a draft she can edit. "Send on WhatsApp" OPENS WhatsApp with
 * that text for her to send herself; nothing here ever sends anything.
 */
import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { BRAND, FONTS, MIN_TOUCH, RADIUS } from '../../constants/theme';
import type { Conclusion } from '../../utils/addConclusions';
import { understandFailureLine } from '../../utils/addConclusions';
import type { UnderstandView } from '../../hooks/useAddUnderstand';
import { readingRow } from '../today/readingRow';
import LiveChips, { pinned, type Chip } from './LiveChips';

interface Props {
  he: boolean;
  view: UnderstandView;
  /** Conclusions already acted on (a reminder added): drawn done. */
  doneKeys: Set<string>;
  onAct: (c: Conclusion, key: string) => void;
}

export const conclusionKey = (c: Conclusion, i: number): string => `${c.kind}-${c.action.type}-${i}`;

export default function MeiraConclusions({ he, view, doneKeys, onAct }: Props) {
  if (view.status === 'idle') return null;

  if (view.status === 'thinking') {
    return (
      <View style={[styles.line, { flexDirection: readingRow(he) }]} accessibilityLiveRegion="polite">
        <ActivityIndicator size="small" color={BRAND.goldInk} />
        <Text style={styles.lineText}>{pinned(he, he ? 'מאירה חושבת על זה…' : 'Meira is thinking…')}</Text>
      </View>
    );
  }

  if (view.status === 'failed') {
    return (
      <View style={styles.line} accessibilityLiveRegion="polite">
        <Text style={styles.lineText}>💭 {pinned(he, understandFailureLine(view.reason, he))}</Text>
      </View>
    );
  }

  if (!view.conclusions.length) return null;
  const chips: Chip[] = view.conclusions.map((c, i) => {
    const key = conclusionKey(c, i);
    const acts = c.action.type !== 'none';
    return {
      key,
      label: he ? c.text_he : c.text_en,
      tone: 'meira',
      done: doneKeys.has(key),
      onPress: acts ? () => onAct(c, key) : undefined,
    };
  });
  return (
    <View style={styles.box}>
      <Text style={styles.kicker}>{pinned(he, he ? 'מה מאירה הבינה' : 'What Meira worked out')}</Text>
      <LiveChips chips={chips} he={he} />
    </View>
  );
}

interface GreetingProps {
  he: boolean;
  to: string;
  text: string;
  onChange: (t: string) => void;
  onSend: () => void;
  onClose: () => void;
  /** The contact has a number on this phone. */
  hasPhone: boolean;
}

export function GreetingCard({ he, to, text, onChange, onSend, onClose, hasPhone }: GreetingProps) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle} numberOfLines={1}>
        {pinned(he, he ? `ברכה ל${to}` : `Greeting for ${to}`)}
      </Text>
      <TextInput
        style={[styles.input, { textAlign: he ? 'right' : 'left' }]}
        value={text}
        onChangeText={onChange}
        multiline
        accessibilityLabel={he ? 'נוסח הברכה' : 'Greeting text'}
        placeholderTextColor={BRAND.inkSoft}
      />
      <Text style={styles.hint}>
        {pinned(he, hasPhone
          ? (he ? 'וואטסאפ ייפתח עם הנוסח הזה — את שולחת בעצמך' : 'WhatsApp opens with this text — you press send')
          : (he ? `אין לי מספר של ${to} — נבחר איש קשר קודם` : `No number for ${to} yet — you'll pick a contact first`))}
      </Text>
      <View style={[styles.buttons, { flexDirection: readingRow(he) }]}>
        <Pressable
          onPress={onSend}
          accessibilityRole="button"
          style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
        >
          <Text style={styles.primaryText} numberOfLines={1}>
            {pinned(he, he ? '💬 לשלוח בוואטסאפ' : '💬 Send on WhatsApp')}
          </Text>
        </Pressable>
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
        >
          <Text style={styles.secondaryText}>{pinned(he, he ? 'סגירה' : 'Close')}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: 8 },
  kicker: { fontFamily: FONTS.bodyHeavy, fontSize: 12, color: BRAND.goldInk, letterSpacing: 0.4, textTransform: 'uppercase' },
  line: { minHeight: 32, alignItems: 'center', gap: 8 },
  lineText: { flexShrink: 1, fontFamily: FONTS.bodySemi, fontSize: 13, lineHeight: 18, color: BRAND.inkSoft },
  card: {
    gap: 8, backgroundColor: BRAND.creamCard, borderWidth: 1, borderColor: BRAND.sunGold,
    borderRadius: RADIUS.card, padding: 12,
  },
  cardTitle: { fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.warmInk },
  input: {
    minHeight: 76, textAlignVertical: 'top', fontFamily: FONTS.body, fontSize: 15, lineHeight: 21,
    color: BRAND.warmInk, backgroundColor: BRAND.cream, borderWidth: 1, borderColor: BRAND.line,
    borderRadius: RADIUS.chip, padding: 10,
  },
  hint: { fontFamily: FONTS.bodySemi, fontSize: 12, lineHeight: 16, color: BRAND.inkSoft },
  buttons: { gap: 8, flexWrap: 'wrap' },
  primary: {
    flexGrow: 1, flexShrink: 1, minHeight: MIN_TOUCH, borderRadius: RADIUS.button, backgroundColor: BRAND.sunGold,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14,
  },
  primaryText: { fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.onGold },
  secondary: {
    minHeight: MIN_TOUCH, minWidth: 88, borderRadius: RADIUS.button, borderWidth: 1, borderColor: BRAND.line,
    backgroundColor: BRAND.creamCard, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14,
  },
  secondaryText: { fontFamily: FONTS.bodyBold, fontSize: 14, color: BRAND.warmInk },
  pressed: { opacity: 0.6 },
});
