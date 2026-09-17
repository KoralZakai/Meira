/**
 * ClashCard — two things at once, laid out so the decision is obvious.
 *
 * The clash resolver has always produced good options; the screen showed them
 * as a line of small grey chips under a one-line title. So the hardest moment
 * in a day — "I cannot do both, what gives?" — looked like a footnote, and the
 * information needed to choose (which one other people are holding, which one
 * is only travel time, how much is actually at stake) was not on screen at all.
 *
 * What this shows, in order:
 *   - a SIGN and a colour that match the severity: a real overlap is red, a
 *     journey that does not fit is amber. They are different problems and they
 *     used to look identical.
 *   - both tasks, side by side, each with its hour, its place, and a lock 🔒
 *     when it is someone else's arrangement — that lock is the whole reason
 *     one of them can move and the other cannot, and it was invisible.
 *   - the minutes at stake, said plainly ("40 min short", "overlap 30 min").
 *   - the options as full-width rows, each with an icon for the KIND of
 *     compromise it is and the consequence spelled out, so "shorten" and
 *     "delay" are not two identical-looking chips.
 *   - the "which matters more?" pair last and visually separated, because
 *     dropping something is a different class of answer from rescheduling it.
 *
 * Presentational: the caller owns the tasks and applies the chosen option.
 * Dependencies: constants/theme, constants/categories, resolveClashes (types).
 * Consumed by screens/TodaySchedule.
 */
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BRAND, FONTS, RADIUS, SHADOWS } from '../constants/theme';
import { getCategoryMeta } from '../constants/categories';
import { AppLanguage, Task } from '../types/index';
import { Clash, ClashOption, ClashResolutionKind } from '../utils/resolveClashes';

interface Props {
  clash: Clash;
  language: AppLanguage;
  onApply: (option: ClashOption) => void;
  /** Open a task to look at it properly before deciding. */
  onOpenTask?: (task: Task) => void;
}

/** What kind of compromise each option is — an icon does this faster than words. */
const OPTION_ICON: Record<ClashResolutionKind, string> = {
  'attend-remotely': '💻',
  move: '🔀',
  shorten: '⏱',
  'end-earlier': '🏃',
  'delay-next': '⏳',
  choose: '⭐',
};

/** Categories other people hold: you cannot decide they will be shorter. */
const THEIRS = ['interview', 'doctor', 'meeting', 'conference', 'class', 'course', 'call', 'zoom'];

const placeText = (task: Task): string => {
  const loc: any = task.location;
  return (typeof loc === 'string' ? loc : (loc?.displayName || loc?.address || '')) || '';
};

export default function ClashCard({ clash, language, onApply, onOpenTask }: Props) {
  const he = language === 'he';
  // A journey that does not fit is a different problem from two things booked
  // at the same hour — and a different colour, so the day can be read at a
  // glance instead of item by item.
  const travelOnly = clash.overlapMinutes <= 0 && Boolean(clash.travelShortfall);
  const accent = travelOnly ? BRAND.amber : BRAND.danger;
  const sign = travelOnly ? '🚧' : '⚠️';

  const stake = travelOnly
    ? (he ? `חסרות ${clash.travelShortfall} דק׳ נסיעה` : `${clash.travelShortfall} min of travel don't fit`)
    : (he ? `חפיפה של ${clash.overlapMinutes} דק׳` : `${clash.overlapMinutes} min overlap`);

  const decisions = clash.options.filter((o) => o.kind === 'choose');
  const fixes = clash.options.filter((o) => o.kind !== 'choose');

  const side = (task: Task) => {
    const meta = getCategoryMeta(task.category);
    const locked = THEIRS.includes(String(task.category));
    return (
      <TouchableOpacity
        style={styles.side}
        activeOpacity={onOpenTask ? 0.85 : 1}
        onPress={() => onOpenTask?.(task)}
      >
        <View style={[styles.sideStripe, { backgroundColor: meta.color }]} />
        <View style={{ flex: 1 }}>
          <Text style={styles.sideTime}>
            {task.fixedTime || task.scheduledTime || '—'} {locked ? '🔒' : ''}
          </Text>
          <Text style={styles.sideText} numberOfLines={2}>{task.text}</Text>
          {placeText(task) ? (
            <Text style={styles.sidePlace} numberOfLines={1}>📍 {placeText(task)}</Text>
          ) : null}
          <Text style={styles.sideWho}>
            {locked
              ? (he ? 'לא בשליטתך — מישהו אחר מחזיק בשעה' : "not yours to move — someone else holds it")
              : (he ? 'שלך — אפשר להזיז או לקצר' : 'yours — can move or shorten')}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={[styles.card, { borderColor: accent }]}>
      <View style={[styles.head, { backgroundColor: travelOnly ? BRAND.honey : '#F7DDE3' }]}>
        <Text style={styles.sign}>{sign}</Text>
        <Text style={[styles.headText, { color: accent }]}>{stake}</Text>
      </View>

      <View style={styles.sides}>
        {side(clash.a)}
        <Text style={styles.vs}>{he ? 'מול' : 'vs'}</Text>
        {side(clash.b)}
      </View>

      <Text style={styles.question}>{he ? clash.questionHe : clash.questionEn}</Text>

      {fixes.map((option) => (
        <TouchableOpacity
          key={`${option.kind}-${option.taskId}-${option.newTime ?? ''}`}
          style={styles.fix}
          onPress={() => onApply(option)}
          activeOpacity={0.85}
        >
          <Text style={styles.fixIcon}>{OPTION_ICON[option.kind]}</Text>
          <Text style={styles.fixText} numberOfLines={2}>
            {he ? option.labelHe : option.labelEn}
          </Text>
        </TouchableOpacity>
      ))}

      {decisions.length > 0 && (
        <View style={styles.decide}>
          <Text style={styles.decideLabel}>
            {he ? 'אין פתרון מסודר — מה חשוב יותר היום?' : 'Nothing tidy fits — which matters more today?'}
          </Text>
          <View style={styles.decideRow}>
            {decisions.map((option) => (
              <TouchableOpacity
                key={`${option.kind}-${option.taskId}`}
                style={styles.decideBtn}
                onPress={() => onApply(option)}
                activeOpacity={0.85}
              >
                <Text style={styles.decideBtnText} numberOfLines={2}>
                  ⭐ {he ? option.labelHe : option.labelEn}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: BRAND.creamCard,
    borderRadius: RADIUS.card,
    borderWidth: 1.5,
    marginBottom: 12,
    overflow: 'hidden',
    ...SHADOWS.card,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8 },
  sign: { fontSize: 16 },
  headText: { fontFamily: FONTS.bodyHeavy, fontSize: 13 },
  sides: { flexDirection: 'row', alignItems: 'stretch', gap: 6, paddingHorizontal: 10, paddingTop: 10 },
  side: {
    flex: 1, flexDirection: 'row', gap: 8,
    borderWidth: 1, borderColor: BRAND.line, borderRadius: RADIUS.chip,
    padding: 8, backgroundColor: BRAND.white,
  },
  sideStripe: { width: 4, alignSelf: 'stretch', borderRadius: 2 },
  sideTime: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.timeChipText },
  sideText: { fontFamily: FONTS.bodyBold, fontSize: 12, color: BRAND.warmInk, marginTop: 1 },
  sidePlace: { fontFamily: FONTS.body, fontSize: 11, color: BRAND.inkFaint, marginTop: 2 },
  sideWho: { fontFamily: FONTS.body, fontSize: 10, color: BRAND.inkFaint, marginTop: 4 },
  vs: { alignSelf: 'center', fontFamily: FONTS.bodyBold, fontSize: 11, color: BRAND.inkFaint },
  question: {
    fontFamily: FONTS.body, fontSize: 12, color: BRAND.inkSoft,
    paddingHorizontal: 12, paddingTop: 10, paddingBottom: 4,
  },
  fix: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: 10, marginTop: 6,
    borderRadius: RADIUS.chip, backgroundColor: BRAND.timeChipBg,
    paddingHorizontal: 10, paddingVertical: 9,
  },
  fixIcon: { fontSize: 15 },
  fixText: { flex: 1, fontFamily: FONTS.bodyBold, fontSize: 12, color: BRAND.warmInk },
  decide: {
    marginTop: 10, paddingTop: 10, paddingHorizontal: 10, paddingBottom: 12,
    borderTopWidth: 1, borderTopColor: BRAND.line,
  },
  decideLabel: { fontFamily: FONTS.bodyBold, fontSize: 12, color: BRAND.danger, marginBottom: 8 },
  decideRow: { flexDirection: 'row', gap: 8 },
  decideBtn: {
    flex: 1, alignItems: 'center', borderRadius: RADIUS.chip,
    borderWidth: 1, borderColor: BRAND.sunGold, backgroundColor: BRAND.honey,
    paddingHorizontal: 8, paddingVertical: 10,
  },
  decideBtnText: { fontFamily: FONTS.bodyHeavy, fontSize: 12, color: '#4A3512', textAlign: 'center' },
});
