/**
 * WhatMeiraKnows — the top of Profile in the v3 design: the facts every leave
 * time is built from, as line-icon tiles. A missing one is a dashed tile that
 * says so and opens the chat to tell her (utils/profileFacts).
 */
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BRAND, FONTS } from '../../constants/theme';
import LineIcon from '../ui/LineIcon';
import { ProfileFact, knownCount } from '../../utils/profileFacts';

interface Props {
  facts: ProfileFact[];
  he: boolean;
  onTell: () => void;
}

export default function WhatMeiraKnows({ facts, he, onTell }: Props) {
  const { known, total } = knownCount(facts);
  const rtl = he && styles.rtl;
  return (
    <View style={styles.wrap}>
      <View style={[styles.head, he && styles.rowRtl]}>
        <Text style={[styles.title, { flex: 1, minWidth: 0 }, rtl]} numberOfLines={2}>{he ? 'מה אני יודעת עלייך' : 'What I know about you'}</Text>
        <Text style={styles.count}>{`${known}/${total}`}</Text>
      </View>
      <View style={[styles.grid, he && styles.rowRtl]}>
        {facts.map((f) => {
          const missing = f.value === null;
          const tint = missing ? (f.needed ? BRAND.danger : BRAND.inkSoft) : BRAND.goldInk;
          const body = (
            <>
              <View style={[styles.iconTile, he && { alignSelf: 'flex-end' }, { backgroundColor: missing ? 'rgba(20,27,46,0.05)' : BRAND.goldSoft }]}>
                <LineIcon name={f.icon} size={18} color={tint} />
              </View>
              <Text style={[styles.label, rtl]} numberOfLines={1}>{f.label}</Text>
              <Text style={[styles.value, missing && { color: tint, fontFamily: FONTS.bodySemi }, rtl]} numberOfLines={2}>
                {missing
                  ? (f.needed ? (he ? 'חסר — בלי זה אין שעת יציאה' : 'Missing — no leave times without it') : (he ? '+ עוד לא ידוע' : '+ Not known yet'))
                  : f.value}
              </Text>
              {f.source === 'learned' ? <Text style={[styles.learned, rtl]}>{he ? 'למדתי' : 'learned'}</Text> : null}
            </>
          );
          return missing ? (
            <TouchableOpacity key={f.key} style={[styles.tile, styles.tileMissing, f.needed && styles.tileNeeded]}
              onPress={onTell} accessibilityRole="button"
              accessibilityLabel={he ? `${f.label}: עוד לא ידוע — לספר למאירה` : `${f.label}: not known — tell Meira`}>
              {body}
            </TouchableOpacity>
          ) : (
            <View key={f.key} style={styles.tile} accessibilityLabel={`${f.label}: ${f.value}`}>{body}</View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    padding: 14, gap: 10, borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.88)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.9)',
  },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowRtl: { flexDirection: 'row-reverse' },
  rtl: { textAlign: 'right', writingDirection: 'rtl' },
  title: { fontFamily: FONTS.display, fontSize: 17, color: BRAND.warmInk },
  count: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.goldInk, fontVariant: ['tabular-nums'] },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tile: {
    flexBasis: '48%', flexGrow: 1, minWidth: 0, minHeight: 92, padding: 10, gap: 3,
    borderRadius: 16, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: BRAND.line,
  },
  tileMissing: { borderStyle: 'dashed', backgroundColor: 'rgba(255,255,255,0.6)' },
  tileNeeded: { borderColor: BRAND.danger },
  iconTile: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', marginBottom: 2 },
  label: { fontFamily: FONTS.bodyBold, fontSize: 11.5, color: BRAND.inkSoft },
  value: { fontFamily: FONTS.bodyHeavy, fontSize: 13.5, color: BRAND.warmInk },
  learned: { fontFamily: FONTS.bodyHeavy, fontSize: 10.5, color: '#3B3486' },
});
