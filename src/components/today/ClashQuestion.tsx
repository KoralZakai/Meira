/**
 * ClashQuestion — "Can't make 12:15": one question, ready answers (3C).
 *
 * 30.9: Nebius at Azrieli until 12:00, coffee with Dana in Herzliya at 12:15,
 * 54 minutes by train. The screen said it twice ("Clash at 12:15 — see it",
 * "15 min to reach … the ride is 54 · arrive 12:54 (39 min late)") and
 * offered nothing to do about it. Koral picked this: one card between the two
 * events, each answer showing what it costs — a taxi and how late, asking the
 * other person for a round time, or going late and when she lands.
 */
import React from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BRAND, FONTS, SHADOWS } from '../../constants/theme';
import { TravelProblem } from '../../utils/dayProblems';
import { MODE_EMOJI } from './DayCard';

interface Props {
  problem: TravelProblem;
  he: boolean;
  /** The car option — undefined while asking, null when there is none. */
  faster?: { minutes: number; lateBy: number } | null;
  /** Who to ask, when the event says ("Dana"). */
  askName?: string;
  onTaxi: () => void;
  onAsk: () => void;
  onGoLate: () => void;
}

const MODE_WORD: Record<string, [string, string]> = {
  walk: ['Walking', 'הליכה'], bike: ['Bike', 'אופניים'], bus: ['Bus', 'אוטובוס'], train: ['Train', 'רכבת'], car: ['Car', 'רכב'],
};

export default function ClashQuestion({ problem, he, faster, askName, onTaxi, onAsk, onGoLate }: Props) {
  const at = problem.to.fixedTime || problem.to.scheduledTime || '';
  const how = (MODE_WORD[problem.mode || ''] || ['The ride', 'הנסיעה'])[he ? 1 : 0];
  const lateText = (n: number) => (n <= 0 ? (he ? 'בזמן' : 'on time') : he ? `${n} דק׳ איחור` : `${n} min late`);
  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <View style={styles.coin} />
        <View style={styles.headText}>
          <Text style={styles.title}>{he ? `לא מגיעים ב-${at}` : `Can't make ${at}`}</Text>
          <Text style={styles.sub}>
            {he
              ? `${how} ${problem.travelMinutes} דק׳ · יש לך ${problem.gapMinutes}`
              : `${how} ${problem.travelMinutes} min · you have ${problem.gapMinutes}`}
          </Text>
        </View>
      </View>

      <View style={styles.answers}>
        {faster === undefined ? (
          <View style={[styles.answer, styles.soft]}><ActivityIndicator color={BRAND.sunGold} /></View>
        ) : faster ? (
          <TouchableOpacity style={[styles.answer, styles.gold]} onPress={onTaxi} accessibilityRole="button">
            <Text style={styles.goldText} numberOfLines={2}>{he ? '🚗 מונית' : '🚗 Taxi'}</Text>
            <Text style={styles.goldSmall}>{lateText(faster.lateBy)}</Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity style={[styles.answer, faster ? styles.soft : styles.gold]} onPress={onAsk} accessibilityRole="button">
          <Text style={faster ? styles.softText : styles.goldText} numberOfLines={2}>
            {askName ? (he ? `💬 לשאול את ${askName}` : `💬 Ask ${askName}`) : (he ? '💬 לבקש לדחות' : '💬 Ask to move it')}
          </Text>
          <Text style={faster ? styles.softSmall : styles.goldSmall}>{problem.askFor}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.answer, styles.soft, styles.dashed]} onPress={onGoLate} accessibilityRole="button">
          <Text style={styles.softText} numberOfLines={2}>{`${MODE_EMOJI[problem.mode || ''] || '🧭'} ${he ? 'להגיע באיחור' : 'Go late'}`}</Text>
          <Text style={styles.softSmall}>{problem.arriveAt}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: BRAND.creamCard, borderRadius: 20, borderWidth: 1.5, borderColor: BRAND.danger,
    padding: 14, ...SHADOWS.card,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  coin: {
    width: 28, height: 28, borderRadius: 14, backgroundColor: BRAND.sunGold,
    shadowColor: '#EAB23F', shadowOpacity: 0.45, shadowRadius: 11, shadowOffset: { width: 0, height: 6 }, elevation: 3,
  },
  headText: { flex: 1 },
  title: { fontFamily: FONTS.bodyHeavy, fontSize: 15, color: BRAND.lateInk },
  sub: { fontFamily: FONTS.bodyBold, fontSize: 12, color: BRAND.inkSoft },
  answers: { marginTop: 12, gap: 8 },
  answer: {
    minHeight: 46, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 8, flexDirection: 'row',
    alignItems: 'center', justifyContent: 'space-between', gap: 8,
  },
  gold: { backgroundColor: BRAND.sunGold },
  // The label gives way (flexShrink 1, two lines); the time beside it never does (flexShrink 0).
  goldText: { flexShrink: 1, fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.onGold },
  goldSmall: { flexShrink: 0, fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.onGold },
  soft: { backgroundColor: BRAND.creamCard, borderWidth: 1.5, borderColor: '#E6D9BC' },
  dashed: { borderStyle: 'dashed' },
  softText: { flexShrink: 1, fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.warmInk },
  softSmall: { flexShrink: 0, fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.inkSoft },
});
