/**
 * GapSlotRow — a free window in the day, offered instead of left blank.
 *
 * The schedule used to draw only the tasks, so the hour between them was
 * literally nothing on screen: no way to see it was free, and no way to put
 * anything in it without going to Add Task and typing the time by hand. This
 * is the empty hour, drawn, with one tap to fill it.
 *
 * Tapping expands into Lumi's ideas for THIS slot (GapFillService ranks them
 * from where you are, what you didn't finish, what's coming and how heavy the
 * morning was). Each idea shows why it is being offered — a suggestion whose
 * reason is invisible is just noise. "Something else" is always last, so the
 * slot is never a closed list of Lumi's opinions.
 *
 * Travel is shown, not hidden: a window that starts late because she is still
 * getting home says so, and an idea somewhere else shows the hour it can
 * really start rather than the top of the window.
 *
 * Presentational: the caller loads the ideas and performs the action.
 * Dependencies: constants/theme, services/GapFillService (types only).
 * Consumed by screens/TodaySchedule.
 */
import React, { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BRAND, FONTS, RADIUS } from '../constants/theme';
import { AppLanguage } from '../types/index';
import { DayGap, describeGap } from '../utils/findGaps';
import { GapIdea, ideaReason, ideaTitle } from '../services/GapFillService';

interface Props {
  gap: DayGap;
  language: AppLanguage;
  /** Ranked ideas for this slot — fetched on first expand. */
  onRequestIdeas: (gap: DayGap) => Promise<GapIdea[]>;
  /** Put this idea in the slot. */
  onPick: (idea: GapIdea, gap: DayGap) => void | Promise<void>;
  /** Open Add Task with the slot's time already filled in. */
  onAddOwn: (gap: DayGap) => void;
  /**
   * Draw this instead of the dashed "free" line — the same ideas open under
   * it. Today's "Free now, until …" row uses it (6.10: "the + opens a new
   * task — I want it to open the suggestions").
   */
  trigger?: (open: boolean, toggle: () => void) => React.ReactNode;
}

export default function GapSlotRow({ gap, language, onRequestIdeas, onPick, onAddOwn, trigger }: Props) {
  const he = language === 'he';
  const [open, setOpen] = useState(false);
  const [ideas, setIdeas] = useState<GapIdea[] | null>(null);
  const [loading, setLoading] = useState(false);

  const expand = async () => {
    const next = !open;
    setOpen(next);
    if (!next || ideas) return;
    setLoading(true);
    try {
      setIdeas(await onRequestIdeas(gap));
    } catch (e) {
      console.warn('[GapSlotRow] ideas could not be fetched', e);
      setIdeas([]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.wrap}>
      {trigger ? trigger(open, expand) : (
      <TouchableOpacity style={styles.row} onPress={expand} activeOpacity={0.8}>
        <View style={styles.dashes} />
        <Text style={styles.label}>
          {describeGap(gap, language)}
          {gap.endsAtDeparture ? (he ? ' · עד היציאה' : ' · until you leave') : ''}
          {gap.travelHomeMinutes
            ? (he ? ' · אחרי שתגיעי הביתה' : " · once you're home")
            : ''}
        </Text>
        <Text style={styles.plus}>{open ? '×' : '+'}</Text>
      </TouchableOpacity>
      )}

      {open && (
        <View style={styles.body}>
          {loading && <ActivityIndicator color={BRAND.sunGold} style={{ marginVertical: 8 }} />}

          {!loading && ideas?.length === 0 && (
            <Text style={styles.emptyText}>
              {he ? 'אין לי רעיון מוצלח לחלון הזה.' : 'No strong idea for this window.'}
            </Text>
          )}

          {!loading && ideas?.map((idea) => (
            <TouchableOpacity
              key={idea.id}
              style={styles.idea}
              onPress={() => onPick(idea, gap)}
              activeOpacity={0.85}
            >
              <Text style={styles.ideaIcon}>{idea.icon}</Text>
              <View style={styles.ideaTexts}>
                <Text style={styles.ideaTitle} numberOfLines={1}>{ideaTitle(idea, language)}</Text>
                <Text style={styles.ideaReason} numberOfLines={1}>
                  {ideaReason(idea, language)} · {idea.minutes}{he ? ' דק׳' : ' min'}
                </Text>
                {idea.startAt && idea.startAt !== gap.start && (
                  <Text style={styles.ideaStart}>
                    {he ? `מתחיל ב-${idea.startAt}` : `starts ${idea.startAt}`}
                  </Text>
                )}
              </View>
              <Text style={styles.ideaAdd}>{he ? 'הוסף' : 'Add'}</Text>
            </TouchableOpacity>
          ))}

          <TouchableOpacity style={styles.own} onPress={() => onAddOwn(gap)} activeOpacity={0.85}>
            <Text style={styles.ownText}>
              {he ? `+ משהו אחר ב-${gap.start}` : `+ Something else at ${gap.start}`}
            </Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginVertical: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, paddingHorizontal: 4 },
  dashes: {
    width: 18, borderBottomWidth: 1, borderStyle: 'dashed', borderColor: BRAND.line,
  },
  label: { flex: 1, fontFamily: FONTS.body, fontSize: 12, color: BRAND.inkFaint },
  plus: { fontFamily: FONTS.bodyHeavy, fontSize: 15, color: BRAND.timeChipText, paddingHorizontal: 6 },
  body: {
    borderWidth: 1, borderStyle: 'dashed', borderColor: BRAND.line, borderRadius: RADIUS.chip,
    backgroundColor: BRAND.creamCard, padding: 8, gap: 6,
  },
  emptyText: { fontFamily: FONTS.body, fontSize: 12, color: BRAND.inkFaint, paddingVertical: 4 },
  idea: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  ideaIcon: { fontSize: 15 },
  ideaTexts: { flex: 1 },
  ideaTitle: { fontFamily: FONTS.bodyBold, fontSize: 13, color: BRAND.warmInk },
  ideaReason: { fontFamily: FONTS.body, fontSize: 11, color: BRAND.inkFaint },
  ideaStart: { fontFamily: FONTS.bodyBold, fontSize: 11, color: BRAND.timeChipText },
  ideaAdd: {
    fontFamily: FONTS.bodyHeavy, fontSize: 11, color: BRAND.timeChipText,
    backgroundColor: BRAND.timeChipBg, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4,
  },
  own: {
    marginTop: 2, borderTopWidth: 1, borderTopColor: BRAND.line, paddingTop: 8, alignItems: 'center',
  },
  ownText: { fontFamily: FONTS.bodyBold, fontSize: 12, color: BRAND.inkSoft },
});
