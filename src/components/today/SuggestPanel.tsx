/**
 * SuggestPanel — what "+ Add something" on Today opens, in place.
 *
 * Koral, 17.10: "I want Meira to suggest me — on the same screen — tasks to do
 * according to urgency, location…, and at the bottom of the suggested list
 * '+ add yours', which leads to the 'what do you want to add' screen". The +
 * went straight to the Add screen (or, inside a free window, to gap ideas
 * only), so the open CV task, the errand on her way and tomorrow's prep were
 * one screen away and never seen.
 *
 * Her picks (mockup, 17.10): the list opens on a tap of the + (Today stays
 * clean until then); a tap on a suggestion APPLIES it at once with a 5-second
 * Undo; a new idea that has no task yet ('prefill') opens the Add screen with
 * the words in the box. "+ Add your own ›" is always the last row.
 *
 * The rows are the Add screen's own (useAddSuggestions → utils/addSuggestions:
 * open tasks, on your way, free gaps, tomorrow), ranked the same, so the two
 * places can never suggest different things. Loading, "couldn't look" and
 * "nothing to suggest" are three different lines (SuggestionList).
 *
 * Trigger (rule 7): her tap on the + — the list exists only while it is open.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { BRAND, FONTS, MIN_TOUCH, RADIUS } from '../../constants/theme';
import SuggestionList from '../add/SuggestionList';
import { pinned } from '../add/LiveChips';
import { readingRow } from './readingRow';
import { useAddSuggestions } from '../../hooks/useAddSuggestions';
import { useApplySuggestion } from '../../hooks/useApplySuggestion';
import type { SuggestionAction } from '../../utils/addSuggestions';
import { useNight } from '../ui/SkyBackdrop';
import { N } from '../../constants/nightTone';

type Prefill = Extract<SuggestionAction, { kind: 'prefill' }>;

interface Props {
  he: boolean;
  /** The day on screen (YYYY-MM-DD). */
  date: string;
  /** "+ Add your own ›" — the Add screen, empty. */
  onAddOwn: () => void;
  /** A new idea with no task behind it — the Add screen with these words in the box. */
  onPrefill: (a: Prefill) => void;
  /** An open task with no window today: open it so she picks the time. */
  onOpenTask: (taskId: string) => void;
  /** A suggestion moved or placed a task (or Undo put it back): redraw the day. */
  onChanged: () => Promise<void> | void;
}

export default function SuggestPanel({ he, date, onAddOwn, onPrefill, onOpenTask, onChanged }: Props) {
  const night = useNight();
  const view = useAddSuggestions(date);
  // What a tap does (apply + 5 s Undo) is shared with the chat home's card.
  const { onPick, takeBack, busyId, used, undo, failed } = useApplySuggestion({ he, onPrefill, onOpenTask, onChanged });

  const rows = view.rows.filter((r) => !used.has(r.id));

  return (
    <View style={styles.panel}>
      <SuggestionList
        he={he}
        rows={rows}
        loading={view.loading}
        allFailed={view.allFailed}
        onPick={onPick}
        busyId={busyId}
        onToday
      />
      {undo ? (
        <View style={[styles.undoRow, night && N.card, { flexDirection: readingRow(he) }]}>
          <Text style={[styles.undoText, night && N.inkSoft]} numberOfLines={2}>{pinned(he, undo.line)}</Text>
          <Pressable onPress={takeBack} style={styles.undoBtn} accessibilityRole="button">
            <Text style={styles.undoBtnText}>{he ? 'ביטול' : 'Undo'}</Text>
          </Pressable>
        </View>
      ) : null}
      {failed ? <Text style={styles.failed}>{pinned(he, failed)}</Text> : null}
      <Pressable
        onPress={onAddOwn}
        style={({ pressed }) => [styles.own, night && N.card, { flexDirection: readingRow(he) }, pressed && styles.pressed]}
        accessibilityRole="button"
      >
        <Text style={[styles.ownText, night && N.ink]}>{pinned(he, he ? '+ הוסיפי משלך' : '+ Add your own')}</Text>
        <Text style={[styles.ownArrow, night && N.goldInk]}>{he ? '‹' : '›'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    gap: 10, marginTop: 8, marginBottom: 4, padding: 12,
    backgroundColor: BRAND.timeChipBg, borderRadius: RADIUS.card,
    borderWidth: 1, borderColor: BRAND.line,
  },
  undoRow: {
    alignItems: 'center', gap: 8, paddingLeft: 12, borderRadius: 14,
    backgroundColor: BRAND.creamCard, borderWidth: 1, borderColor: BRAND.line,
  },
  undoText: { flex: 1, fontFamily: FONTS.bodySemi, fontSize: 13, lineHeight: 18, color: BRAND.inkSoft },
  undoBtn: { minHeight: MIN_TOUCH, paddingHorizontal: 14, justifyContent: 'center' },
  undoBtnText: { fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.timeChipText },
  failed: { fontFamily: FONTS.bodySemi, fontSize: 13, color: BRAND.lateInk },
  own: {
    minHeight: MIN_TOUCH, alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, borderTopWidth: 1, borderTopColor: BRAND.line,
  },
  ownText: { fontFamily: FONTS.bodyHeavy, fontSize: 15, color: BRAND.warmInk },
  ownArrow: { fontFamily: FONTS.bodyHeavy, fontSize: 18, color: BRAND.timeChipText },
  pressed: { opacity: 0.6 },
});
