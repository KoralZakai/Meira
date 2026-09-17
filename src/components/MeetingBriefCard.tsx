/**
 * MeetingBriefCard — "here is who you're about to meet".
 *
 * Shows the researched brief for the next meeting: one headline sentence, a
 * few facts about the company, what we could find about the person, and three
 * questions worth asking. Collapsed to the headline until tapped, because the
 * Today screen answers "what is next", not "read this dossier".
 *
 * TWO THINGS THIS CARD IS CAREFUL ABOUT.
 *
 * Provenance. Every bullet arrives with its source marker ("[1]") already in
 * the text — the server drops any bullet that cannot cite one. The markers are
 * rendered, not stripped, and the sources are listed at the bottom, so a claim
 * about a person the user is about to meet can always be traced.
 *
 * Doubt. `confidence` and `caution` are shown, not hidden. Two companies share
 * a name far more often than people expect (Ceva the processor-IP firm and
 * CEVA Logistics, to take the one that started this), and a brief that looks
 * certain about the wrong company is worse than no brief.
 *
 * Purely presentational. Fetching is MeetingBriefService.
 *
 * Dependencies: constants/theme, services/LumiServer (types).
 * Consumed by screens/TodaySchedule.
 */
import React, { useState } from 'react';
import { ActivityIndicator, Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BRAND, FONTS, RADIUS } from '../constants/theme';
import { MeetingBriefResult } from '../services/LumiServer';
import { AppLanguage } from '../types/index';

interface Props {
  brief: MeetingBriefResult;
  language: AppLanguage;
  /** Re-research, bypassing both caches. Omitted → no refresh control. */
  onRefresh?: () => void;
  refreshing?: boolean;
}

const CONFIDENCE_LABEL: Record<string, { he: string; en: string; color: string }> = {
  high: { he: 'ודאות גבוהה', en: 'high confidence', color: BRAND.success },
  medium: { he: 'ודאות בינונית', en: 'medium confidence', color: BRAND.goldInk },
  low: { he: 'ודאות נמוכה', en: 'low confidence', color: BRAND.danger },
};

export default function MeetingBriefCard({ brief, language, onRefresh, refreshing }: Props) {
  const [open, setOpen] = useState(false);
  const he = language === 'he';

  const headline = (he ? brief.headline_he : brief.headline_en) || '';
  const company = (he ? brief.company_he : brief.company_en) || [];
  const person = (he ? brief.person_he : brief.person_en) || [];
  const questions = (he ? brief.questions_he : brief.questions_en) || [];
  const caution = (he ? brief.caution_he : brief.caution_en) || '';
  const sources = brief.sources || [];
  const conf = CONFIDENCE_LABEL[brief.confidence || 'medium'];

  if (!headline && !company.length) return null;

  return (
    <View style={[styles.card, he && styles.rtl]}>
      <TouchableOpacity
        style={styles.header}
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityLabel={he ? 'תדריך לפגישה' : 'Meeting brief'}
        accessibilityState={{ expanded: open }}
      >
        <Text style={styles.badge}>🔎 {he ? 'לפני הפגישה' : 'Before the meeting'}</Text>
        <Text style={[styles.chev, he && styles.chevRtl]}>{open ? '⌃' : '⌄'}</Text>
      </TouchableOpacity>

      <Text style={[styles.headline, he && styles.rtlText]}>{headline}</Text>

      {!!caution && (
        <Text style={[styles.caution, he && styles.rtlText]}>⚠️ {caution}</Text>
      )}

      {open && (
        <View style={styles.body}>
          {company.length > 0 && (
            <Section title={he ? 'החברה' : 'The company'} lines={company} he={he} />
          )}
          {person.length > 0 && (
            <Section title={he ? 'מי מולך' : 'Who you are meeting'} lines={person} he={he} />
          )}
          {questions.length > 0 && (
            <Section
              title={he ? 'שאלות לשאול' : 'Questions to ask'}
              lines={questions}
              he={he}
              numbered
            />
          )}

          {sources.length > 0 && (
            <View style={styles.sources}>
              <Text style={[styles.sourceTitle, he && styles.rtlText]}>
                {he ? 'מקורות' : 'Sources'}
              </Text>
              {sources.map((s) => (
                <TouchableOpacity
                  key={s.n}
                  onPress={() => s.link && Linking.openURL(s.link).catch(() => {})}
                  accessibilityRole="link"
                >
                  <Text style={[styles.sourceLine, he && styles.rtlText]} numberOfLines={1}>
                    [{s.n}] {s.title || s.link}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          <View style={[styles.footer, he && styles.rtl]}>
            <Text style={[styles.confidence, { color: conf.color }]}>
              ● {he ? conf.he : conf.en}
            </Text>
            {!!onRefresh && (
              <TouchableOpacity onPress={onRefresh} disabled={refreshing} accessibilityRole="button">
                {refreshing
                  ? <ActivityIndicator size="small" color={BRAND.goldInk} />
                  : <Text style={styles.refresh}>{he ? 'רענון' : 'Refresh'}</Text>}
              </TouchableOpacity>
            )}
          </View>
        </View>
      )}
    </View>
  );
}

function Section({ title, lines, he, numbered }: {
  title: string; lines: string[]; he: boolean; numbered?: boolean;
}) {
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, he && styles.rtlText]}>{title}</Text>
      {lines.map((line, i) => (
        <Text key={`${title}-${i}`} style={[styles.bullet, he && styles.rtlText]}>
          {numbered ? `${i + 1}. ` : '• '}{line}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: BRAND.creamCard,
    borderRadius: RADIUS.card,
    borderWidth: 1,
    borderColor: BRAND.line,
    padding: 16,
    marginHorizontal: 16,
    marginTop: 12,
  },
  rtl: { direction: 'rtl' },
  rtlText: { textAlign: 'right', writingDirection: 'rtl' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  badge: { fontFamily: FONTS.bodyBold, fontSize: 12, color: BRAND.goldInk, letterSpacing: 0.3 },
  chev: { fontSize: 16, color: BRAND.inkFaint },
  chevRtl: {},
  headline: { fontFamily: FONTS.displaySemi, fontSize: 16, color: BRAND.warmInk, marginTop: 8, lineHeight: 22 },
  caution: { fontFamily: FONTS.bodySemi, fontSize: 13, color: BRAND.danger, marginTop: 8, lineHeight: 19 },
  body: { marginTop: 12 },
  section: { marginBottom: 14 },
  sectionTitle: { fontFamily: FONTS.bodyBold, fontSize: 13, color: BRAND.inkSoft, marginBottom: 6 },
  bullet: { fontFamily: FONTS.body, fontSize: 14, color: BRAND.warmInk, lineHeight: 21, marginBottom: 5 },
  sources: { borderTopWidth: 1, borderTopColor: BRAND.line, paddingTop: 10, marginTop: 2 },
  sourceTitle: { fontFamily: FONTS.bodyBold, fontSize: 12, color: BRAND.inkFaint, marginBottom: 4 },
  sourceLine: { fontFamily: FONTS.body, fontSize: 12, color: BRAND.goldInk, marginBottom: 3 },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 },
  confidence: { fontFamily: FONTS.bodySemi, fontSize: 12 },
  refresh: { fontFamily: FONTS.bodyBold, fontSize: 12, color: BRAND.goldInk },
});
