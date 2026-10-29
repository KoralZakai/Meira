/**
 * OverlapPick — two things at one hour: "Which one?" (2D).
 *
 * 30.9: a two-hour business plan laid exactly over the 18:30 meetup at Sarona.
 * The phone called it parallel and said nothing. Koral picked this shape —
 * both halves side by side, the word "Overlap" with a sign, and what happens
 * to the other one — and asked for the overlap to be named, not implied.
 *
 * Picking the appointment moves the work to the first window that fits it
 * whole (or tomorrow); picking the work keeps it at this hour and leaves the
 * appointment to her. Nothing is decided for her.
 */
import { firstRideLine, ridesOf } from '../../utils/rideLine';
import { moovitLinks } from '../../utils/moovitLink';
import React from 'react';
import { Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BRAND, FONTS, SHADOWS } from '../../constants/theme';
import { getCategoryMeta } from '../../constants/categories';
import { addMinutes } from '../../utils/timeUtils';
import { OverlapProblem } from '../../utils/dayProblems';
import { formatSpan } from './NowAddRow';

interface Props {
  problem: OverlapProblem;
  he: boolean;
  /** Where the work goes if she keeps the appointment: HH:MM, or 'tomorrow'. */
  movesTo: string;
  onKeepFixed: () => void;
  onKeepWork: () => void;
  /**
   * The third answer when the work starts first: end it as the appointment
   * begins (6.10 — "ask what to make shorter or what to change").
   */
  shortenTo?: string;
  onShorten?: () => void;
}

const HEBREW = /[֐-׿]/;

export default function OverlapPick({ problem, he, movesTo, onKeepFixed, onKeepWork, shortenTo, onShorten }: Props) {
  const { fixed, work } = problem;
  const at = fixed.fixedTime || fixed.scheduledTime || '';
  const loc: any = fixed.location && typeof fixed.location === 'object' ? fixed.location : undefined;
  const place = String(loc?.displayName || loc?.address || '').split(',')[0].trim();
  const until = at ? addMinutes(at, fixed.durationMinutes || 30) : '';
  const leave = loc?.leaveHomeBy;
  const routeLine = firstRideLine(problem.fixed, he);
  const transit = ridesOf(problem.fixed).length > 0 || ['bus', 'train'].includes(String(loc?.transportType || ''));
  const moovit = transit
    ? moovitLinks({ lat: loc?.lat, lng: loc?.lng, name: loc?.address || loc?.displayName })
    : null;
  const openMoovit = () => {
    if (!moovit) return;
    Linking.openURL(moovit.app).catch((e) => {
      console.warn('[OverlapPick] Moovit app not opened — trying the web', e);
      Linking.openURL(moovit.web).catch((err) => console.warn('[OverlapPick] Moovit web not opened', err));
    });
  };
  const workTitle = work.text.split('\n')[0].trim();
  const target = movesTo === 'tomorrow' ? (he ? 'מחר' : 'tomorrow') : movesTo;

  return (
    <View style={styles.card} accessible={false}>
      <View style={styles.head}>
        <Text style={styles.at}>{at}</Text>
        <View style={styles.badge}>
          <View style={styles.venn} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <View style={styles.ring} />
            <View style={[styles.ring, styles.ringTwo]} />
          </View>
          <Text style={styles.badgeText}>
            {he ? `חפיפה · ${formatSpan(problem.overlapMinutes, true)}` : `Overlap · ${formatSpan(problem.overlapMinutes, false)}`}
          </Text>
        </View>
      </View>
      <Text style={styles.ask}>{he ? 'מה מהשניים?' : 'Which one?'}</Text>

      <View style={styles.halves}>
        <TouchableOpacity style={[styles.half, styles.halfFixed]} onPress={onKeepFixed} accessibilityRole="button"
          accessibilityLabel={he ? `להשאיר את ${fixed.text}` : `Keep ${fixed.text}`}>
          <Text style={styles.emoji}>{getCategoryMeta(fixed.category).icon}</Text>
          <Text style={[styles.name, HEBREW.test(fixed.text) && styles.rtl]} numberOfLines={3}>{fixed.text}</Text>
          <Text style={styles.meta} numberOfLines={1}>{[place, until && (he ? `עד ${until}` : `until ${until}`)].filter(Boolean).join(' · ')}</Text>
          {leave ? <Text style={styles.leave}>{`🚪 ${leave}`}</Text> : null}
          {/* Which bus, from where — the trip she would keep (1.10). */}
          {routeLine ? <Text style={styles.route} numberOfLines={2}>{routeLine}</Text> : null}
          {moovit ? (
            <TouchableOpacity onPress={openMoovit} accessibilityRole="link" hitSlop={8}
              accessibilityLabel={he ? 'לפתוח במוביט' : 'Open in Moovit'}>
              <Text style={styles.moovit}>{he ? '🟠 במוביט ›' : '🟠 Moovit ›'}</Text>
            </TouchableOpacity>
          ) : null}
        </TouchableOpacity>
        <TouchableOpacity style={[styles.half, styles.halfWork]} onPress={onKeepWork} accessibilityRole="button"
          accessibilityLabel={he ? `להשאיר את ${workTitle}` : `Keep ${workTitle}`}>
          <Text style={styles.emoji}>📝</Text>
          <Text style={[styles.name, HEBREW.test(workTitle) && styles.rtl]} numberOfLines={3}>{workTitle}</Text>
          <Text style={styles.meta}>{`${formatSpan(work.durationMinutes || 30, he)} · ${he ? 'מכל מקום' : 'anywhere'}`}</Text>
        </TouchableOpacity>
        <View style={styles.or} pointerEvents="none"><Text style={styles.orText}>{he ? 'או' : 'or'}</Text></View>
      </View>

      {onShorten && shortenTo ? (
        <TouchableOpacity style={styles.shorten} onPress={onShorten} accessibilityRole="button">
          <Text style={[styles.shortenText, HEBREW.test(workTitle) && styles.rtl]} numberOfLines={2}>
            {he ? `✂️ לקצר: ${workTitle} עד ${shortenTo}` : `✂️ Shorten: ${workTitle} ends at ${shortenTo}`}
          </Text>
        </TouchableOpacity>
      ) : null}
      <Text style={styles.foot}>{he ? `↪︎ ${workTitle} ← ${target}` : `↪︎ ${workTitle} moves to ${target}`}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: BRAND.creamCard, borderRadius: 20, padding: 14, gap: 10, ...SHADOWS.card },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  at: { fontFamily: FONTS.display, fontSize: 24, color: BRAND.danger, fontVariant: ['tabular-nums'] },
  badge: {
    flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 999,
    paddingVertical: 5, paddingLeft: 8, paddingRight: 10, backgroundColor: '#F8ECE9',
  },
  venn: { width: 22, height: 14 },
  ring: { position: 'absolute', left: 0, top: 0, width: 14, height: 14, borderRadius: 7, borderWidth: 2, borderColor: BRAND.danger },
  ringTwo: { left: 8, backgroundColor: 'rgba(185,82,107,0.25)' },
  badgeText: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.lateInk },
  ask: { fontFamily: FONTS.bodyHeavy, fontSize: 15, color: BRAND.warmInk, marginTop: -4 },
  shorten: {
    borderWidth: 1.5, borderColor: BRAND.sunGold, borderRadius: 999,
    paddingVertical: 9, paddingHorizontal: 14, alignItems: 'center',
  },
  shortenText: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.warmInk },
  halves: { flexDirection: 'row', gap: 10 },
  half: { flex: 1, minHeight: 140, borderRadius: 18, padding: 12, gap: 6 },
  halfFixed: { backgroundColor: BRAND.cream, borderWidth: 1.5, borderColor: BRAND.line },
  halfWork: { borderWidth: 1.5, borderStyle: 'dashed', borderColor: BRAND.goldInk },
  emoji: { fontSize: 24 },
  name: { fontFamily: FONTS.bodyHeavy, fontSize: 15, lineHeight: 19, color: BRAND.warmInk },
  rtl: { writingDirection: 'rtl' },
  meta: { fontFamily: FONTS.bodyBold, fontSize: 12, color: BRAND.inkFaint },
  leave: { fontFamily: FONTS.bodyHeavy, fontSize: 12, color: BRAND.goldInk },
  route: { marginTop: 4, fontFamily: FONTS.bodyHeavy, fontSize: 11, color: BRAND.goldInk },
  moovit: { marginTop: 6, fontFamily: FONTS.bodyHeavy, fontSize: 12, color: '#B25E00' },
  or: {
    position: 'absolute', left: '50%', top: '50%', width: 32, height: 32, marginLeft: -16, marginTop: -16,
    borderRadius: 16, backgroundColor: BRAND.creamCard, borderWidth: 1.5, borderColor: BRAND.line,
    alignItems: 'center', justifyContent: 'center',
  },
  orText: { fontFamily: FONTS.bodyHeavy, fontSize: 12, color: BRAND.inkFaint },
  foot: { fontFamily: FONTS.bodyHeavy, fontSize: 12, color: BRAND.goldInk },
});
