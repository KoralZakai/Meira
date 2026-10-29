/**
 * MeetingBriefCard — "here is who you're about to meet".
 *
 * Shows the researched brief for the next meeting: one headline sentence, a
 * few facts about the company, what we could find about the person, and three
 * questions worth asking. Collapsed to the headline until tapped, because the
 * Today screen answers "what is next", not "read this dossier".
 *
 * FOR AN INTERVIEW (17.10) the card is the preparation, so it opens by default
 * and puts the useful half first: the job, the questions candidates report
 * being asked there, and what to do about them — then the company and the
 * person. Every line keeps its [n] and the sources are listed underneath.
 *
 * THREE THINGS THIS CARD IS CAREFUL ABOUT.
 *
 * Provenance. Every bullet arrives with its source marker ("[1]") already in
 * the text — the server drops any bullet that cannot cite one. The markers are
 * rendered, not stripped, and the sources are listed at the bottom, so a claim
 * about a person the user is about to meet can always be traced.
 *
 * Doubt. `confidence` and `caution` are shown, not hidden. Two companies share
 * a name far more often than people expect (Ceva the processor-IP firm and
 * CEVA Logistics, to take the one that started this), and a brief that looks
 * certain about the wrong company is worse than no brief. When the employer
 * was GUESSED from the event's venue, the card says so in one line.
 *
 * Absence. A brief that could not be made is a card that says why
 * ("no company on the event", "search unavailable"), and an interview section
 * that came out empty says "I found no reported questions" — never a gap that
 * could mean either "nothing exists" or "nobody looked" (silent-state rule 1).
 *
 * Purely presentational. Fetching is MeetingBriefService.
 *
 * Dependencies: constants/theme, services/LumiServer (types), utils/interviewBrief (words).
 * Consumed by screens/TodaySchedule.
 */
import React, { useState } from 'react';
import { ActivityIndicator, Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BRAND, FONTS, RADIUS } from '../constants/theme';
import { MeetingBriefResult } from '../services/LumiServer';
import { AppLanguage } from '../types/index';
import { briefReasonLine, missingLine, InterviewSection } from '../utils/interviewBrief';

interface Props {
  brief: MeetingBriefResult;
  language: AppLanguage;
  /** Re-research, bypassing both caches. Omitted → no refresh control. */
  onRefresh?: () => void;
  refreshing?: boolean;
}

/** Android's minimum comfortable touch target. */
const TOUCH = 44;

const CONFIDENCE_LABEL: Record<string, { he: string; en: string; color: string }> = {
  high: { he: 'ודאות גבוהה', en: 'high confidence', color: BRAND.success },
  medium: { he: 'ודאות בינונית', en: 'medium confidence', color: BRAND.goldInk },
  low: { he: 'ודאות נמוכה', en: 'low confidence', color: BRAND.danger },
};

/** The list in her language, or the other language's when hers came out empty. */
const pickList = (he: boolean, hebrew?: string[], english?: string[]): string[] => {
  const mine = (he ? hebrew : english) || [];
  const other = (he ? english : hebrew) || [];
  return mine.length ? mine : other;
};

export default function MeetingBriefCard({ brief, language, onRefresh, refreshing }: Props) {
  const he = language === 'he';
  const interview = Boolean(brief.interview);
  // An interview brief IS the thing she opened the sheet to read.
  const [open, setOpen] = useState(interview);

  // No brief — and the card says why instead of not being there.
  if (!brief.ok) {
    return (
      <View style={[styles.card, he && styles.rtl]}>
        <Text style={styles.badge}>📄 {he ? 'תדריך לראיון' : 'Interview brief'}</Text>
        <Text style={[styles.reason, he && styles.rtlText]}>
          {briefReasonLine(brief.reason, he)}
        </Text>
        {!!onRefresh && <RefreshButton he={he} onRefresh={onRefresh} refreshing={refreshing} />}
      </View>
    );
  }

  const headline = (he ? brief.headline_he : brief.headline_en) || (he ? brief.headline_en : brief.headline_he) || '';
  const company = pickList(he, brief.company_he, brief.company_en);
  const person = pickList(he, brief.person_he, brief.person_en);
  const role = pickList(he, brief.role_he, brief.role_en);
  const likely = pickList(he, brief.likely_questions_he, brief.likely_questions_en);
  const prep = pickList(he, brief.prep_he, brief.prep_en);
  const questions = pickList(he, brief.questions_he, brief.questions_en);
  const caution = (he ? brief.caution_he : brief.caution_en) || '';
  const sources = brief.sources || [];
  const conf = CONFIDENCE_LABEL[brief.confidence || 'medium'];
  const missing = new Set(brief.missing || []);
  const guessed = brief.subjects?.company_from === 'venue';
  const employer = (he ? brief.subjects?.name_he : brief.subjects?.name_en) || brief.subjects?.company || '';

  if (!headline && !company.length && !role.length && !likely.length) return null;

  const gone = (section: InterviewSection, lines: string[]) => interview && !lines.length && missing.has(section);

  return (
    <View style={[styles.card, he && styles.rtl]}>
      <TouchableOpacity
        style={styles.header}
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityLabel={he ? (interview ? 'תדריך לראיון' : 'תדריך לפגישה') : (interview ? 'Interview brief' : 'Meeting brief')}
        accessibilityState={{ expanded: open }}
      >
        <Text style={[styles.badge, styles.shrink]} numberOfLines={1}>
          {interview ? '🎯' : '🔎'} {interview ? (he ? 'לפני הראיון' : 'Before the interview') : (he ? 'לפני הפגישה' : 'Before the meeting')}
        </Text>
        <Text style={[styles.chev, he && styles.chevRtl]}>{open ? '⌃' : '⌄'}</Text>
      </TouchableOpacity>

      {!!headline && <Text style={[styles.headline, he && styles.rtlText]}>{headline}</Text>}

      {guessed && !!employer && (
        <Text style={[styles.guess, he && styles.rtlText]} numberOfLines={2}>
          🏢 {he ? `זיהיתי: ${employer} — לפי המקום באירוע` : `Identified as ${employer} — from the event's venue`}
        </Text>
      )}

      {!!caution && (
        <Text style={[styles.caution, he && styles.rtlText]}>⚠️ {caution}</Text>
      )}

      {open && (
        <View style={styles.body}>
          {interview && (
            <>
              <Section title={he ? 'על התפקיד' : 'The job'} lines={role} he={he}
                empty={gone('role', role) ? missingLine('role', he) : undefined} />
              <Section title={he ? 'שאלות שדווחו שנשאלו שם' : 'Questions reported there'} lines={likely} he={he} numbered
                empty={gone('likely_questions', likely) ? missingLine('likely_questions', he) : undefined} />
              <Section title={he ? 'איך להתכונן' : 'How to prepare'} lines={prep} he={he}
                empty={gone('prep', prep) ? missingLine('prep', he) : undefined} />
            </>
          )}
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
                  style={styles.sourceRow}
                  hitSlop={{ top: 3, bottom: 3 }}
                  // Only https: a poisoned search result must not open tel:/intent:/market: (security review 29.10).
                  onPress={() => s.link && /^https:\/\//i.test(s.link) && Linking.openURL(s.link).catch((e) => console.warn('[MeetingBrief] link', e))}
                  accessibilityRole="link"
                >
                  <Text style={[styles.sourceLine, he && styles.rtlText]} numberOfLines={1}>
                    [{s.n}] {s.title || s.link || (he ? 'המייל שלך' : 'Your email')}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          <View style={[styles.footer, he && styles.rtl]}>
            <Text style={[styles.confidence, styles.shrink, { color: conf.color }]} numberOfLines={1}>
              ● {he ? conf.he : conf.en}
            </Text>
            {!!onRefresh && <RefreshButton he={he} onRefresh={onRefresh} refreshing={refreshing} />}
          </View>
        </View>
      )}
    </View>
  );
}

function RefreshButton({ he, onRefresh, refreshing }: { he: boolean; onRefresh: () => void; refreshing?: boolean }) {
  return (
    <TouchableOpacity
      style={styles.refreshBtn}
      onPress={onRefresh}
      disabled={refreshing}
      accessibilityRole="button"
      accessibilityLabel={he ? 'רענון התדריך' : 'Refresh the brief'}
    >
      {refreshing
        ? <ActivityIndicator size="small" color={BRAND.goldInk} />
        : <Text style={styles.refresh}>{he ? 'רענון' : 'Refresh'}</Text>}
    </TouchableOpacity>
  );
}

/**
 * One titled list. `empty` is the sentence for a section that came out empty on
 * purpose: shown instead of the list, never alongside it, and never as a blank.
 * A section with neither lines nor a reason to be empty is simply not drawn
 * (the plain meeting brief has no "job" section at all).
 */
function Section({ title, lines, he, numbered, empty }: {
  title: string; lines: string[]; he: boolean; numbered?: boolean; empty?: string;
}) {
  if (!lines.length && !empty) return null;
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, he && styles.rtlText]}>{title}</Text>
      {lines.length === 0 && !!empty && (
        <Text style={[styles.empty, he && styles.rtlText]}>{empty}</Text>
      )}
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
  shrink: { flexShrink: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: TOUCH },
  badge: { fontFamily: FONTS.bodyBold, fontSize: 12, color: BRAND.goldInk, letterSpacing: 0.3 },
  chev: { fontSize: 16, color: BRAND.inkFaint, paddingHorizontal: 8 },
  chevRtl: {},
  headline: { fontFamily: FONTS.displaySemi, fontSize: 16, color: BRAND.warmInk, marginTop: 4, lineHeight: 22 },
  reason: { fontFamily: FONTS.bodySemi, fontSize: 14, color: BRAND.warmInk, marginTop: 8, lineHeight: 21 },
  guess: { fontFamily: FONTS.bodySemi, fontSize: 12, color: BRAND.inkSoft, marginTop: 6, lineHeight: 18 },
  caution: { fontFamily: FONTS.bodySemi, fontSize: 13, color: BRAND.danger, marginTop: 8, lineHeight: 19 },
  body: { marginTop: 12 },
  section: { marginBottom: 14 },
  sectionTitle: { fontFamily: FONTS.bodyBold, fontSize: 13, color: BRAND.inkSoft, marginBottom: 6 },
  bullet: { fontFamily: FONTS.body, fontSize: 14, color: BRAND.warmInk, lineHeight: 21, marginBottom: 5 },
  empty: { fontFamily: FONTS.bodySemi, fontSize: 13, color: BRAND.inkSoft, lineHeight: 19 },
  sources: { borderTopWidth: 1, borderTopColor: BRAND.line, paddingTop: 10, marginTop: 2 },
  sourceTitle: { fontFamily: FONTS.bodyBold, fontSize: 12, color: BRAND.inkFaint, marginBottom: 4 },
  sourceRow: { minHeight: 38, justifyContent: 'center' },
  sourceLine: { fontFamily: FONTS.body, fontSize: 12, color: BRAND.goldInk },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 },
  confidence: { fontFamily: FONTS.bodySemi, fontSize: 12 },
  refreshBtn: { minHeight: TOUCH, minWidth: TOUCH, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  refresh: { fontFamily: FONTS.bodyBold, fontSize: 12, color: BRAND.goldInk },
});
