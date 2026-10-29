/**
 * AlertsSheet — what the 🔔 on Today opens: what is waiting for her.
 *
 * Canvas v4 (27.10): conflicts first (they need a decision), then what an
 * earlier day left unclosed, then today's tasks with no place. Each row
 * opens its fix. Empty says "nothing waiting" — only because the list was
 * actually computed (silent-state rule 3), never as a default.
 */
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { BRAND, FONTS, MIN_TOUCH } from '../../constants/theme';
import BottomSheet from '../ui/BottomSheet';
import type { WaitingItem } from '../../utils/waitingList';
import { ChangeCard } from '../ChangeCards';
import type { ChangeRecord } from '../../utils/changeRecord';

interface Props {
  visible: boolean;
  items: WaitingItem[];
  he: boolean;
  onClose: () => void;
  onPick: (item: WaitingItem) => void;
  /** "+ N more" of a section — the place where all of them are handled. */
  onMore: (kind: WaitingItem['kind']) => void;
  /** What the calendar moved or cancelled, drawn in full (before → after, what it means, the offers). */
  changes?: ChangeRecord[];
  /** The changes could not be read — said, never an empty list (rule 1). */
  changesError?: string | null;
  /** Open a task's card (from a change or any row). */
  onOpenTask?: (taskId: string) => void;
}

const SECTION: Record<WaitingItem['kind'], { icon: string; en: string; he: string; bg: string; act: [string, string] }> = {
  change: { icon: '🔄', en: 'What changed', he: 'מה השתנה', bg: '#FFF6E0', act: ['Open', 'לפתוח'] },
  followup: { icon: '⏳', en: 'Waiting for a new date', he: 'מחכה למועד חדש', bg: '#EEF0FF', act: ['Set date', 'לקבוע'] },
  unscheduled: { icon: '🕐', en: 'When will you do it?', he: 'מתי תעשי?', bg: '#E6FAF3', act: ['Find a time', 'למצוא זמן'] },
  clash: { icon: '⚠️', en: 'Needs a decision', he: 'צריך החלטה', bg: '#FDE7EC', act: ['Resolve', 'לפתור'] },
  unclosed: { icon: '🕓', en: 'Not closed', he: 'לא נסגר', bg: '#FFF1C7', act: ['Did you go?', 'הלכת?'] },
  place: { icon: '📍', en: 'Missing a place', he: 'חסר מקום', bg: '#E5F0FF', act: ['Add', 'להוסיף'] },
};

const DAY_HE = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
const DAY_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** "ב׳ 27.10" — never a raw 2026-10-27 (silent-state rule 4: the date is shown, readably). */
function whenLabel(when: string, he: boolean): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(when);
  if (!m) return when;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return `${(he ? DAY_HE : DAY_EN)[d.getDay()]} ${Number(m[3])}.${Number(m[2])}`;
}

export default function AlertsSheet({ visible, items, he, onClose, onPick, onMore, changes = [], changesError, onOpenTask }: Props) {
  // Changes are drawn as their own cards, above; the rows are everything else.
  const kinds = (['followup', 'unscheduled', 'clash', 'unclosed', 'place'] as const).filter((k) => items.some((i) => i.kind === k));
  const dir = he ? 'row-reverse' : 'row';
  return (
    <BottomSheet visible={visible} onClose={onClose} heightRatio={0.85}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.body} nestedScrollEnabled showsVerticalScrollIndicator>
        <Text style={[styles.title, he && styles.rtl]}>
          {items.length
            ? (he ? `🔔 ${items.length} דברים מחכים לך` : `🔔 ${items.length} thing${items.length === 1 ? '' : 's'} waiting`)
            : (he ? '🔔 אין כלום שמחכה — הכול סגור ✓' : '🔔 Nothing waiting — all closed ✓')}
        </Text>
        {changesError ? (
          <Text style={[styles.err, he && styles.rtl]}>
            {he ? 'לא הצלחתי לקרוא את השינויים ביומן — משכי לרענון.' : "Couldn't read calendar changes — pull to refresh."}
          </Text>
        ) : null}
        {changes.length ? (
          <View style={styles.section}>
            <Text style={[styles.cap, he && styles.rtl]}>{`${SECTION.change.icon} ${he ? SECTION.change.he : SECTION.change.en}`}</Text>
            {changes.map((r) => <ChangeCard key={r.key} rec={r} language={he ? 'he' : 'en'} onOpen={onOpenTask} />)}
          </View>
        ) : null}
        {kinds.map((k) => (
          <View key={k} style={styles.section}>
            <Text style={[styles.cap, he && styles.rtl]}>{`${SECTION[k].icon} ${he ? SECTION[k].he : SECTION[k].en}`}</Text>
            {/* All of them, one scroll (28.10: "show everything, scroll like Facebook"). */}
            {items.filter((i) => i.kind === k).map((i) => (
              <Pressable key={i.key} onPress={() => onPick(i)} style={[styles.row, { flexDirection: dir, backgroundColor: SECTION[k].bg }]}
                accessibilityRole="button" accessibilityLabel={`${i.title} — ${he ? SECTION[k].act[1] : SECTION[k].act[0]}`}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={[styles.rowTitle, he && styles.rtl]} numberOfLines={2}>{i.title}</Text>
                  {i.when ? <Text style={[styles.rowWhen, he && styles.rtl]}>{whenLabel(i.when, he)}</Text> : null}
                </View>
                <Text style={styles.act} numberOfLines={1}>{he ? SECTION[k].act[1] : SECTION[k].act[0]}</Text>
              </Pressable>
            ))}
          </View>
        ))}
      </ScrollView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 16, paddingBottom: 24, gap: 14 },
  rtl: { textAlign: 'right', writingDirection: 'rtl' },
  title: { fontFamily: FONTS.bodyHeavy, fontSize: 19, color: BRAND.warmInk },
  section: { gap: 8 },
  cap: { fontFamily: FONTS.bodyHeavy, fontSize: 12, color: BRAND.inkSoft },
  row: { alignItems: 'center', gap: 10, minHeight: MIN_TOUCH + 12, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16 },
  rowTitle: { fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.warmInk },
  rowWhen: { fontFamily: FONTS.bodySemi, fontSize: 12, color: BRAND.inkSoft, marginTop: 2 },
  more: { alignSelf: 'flex-start', minHeight: MIN_TOUCH, justifyContent: 'center', paddingHorizontal: 6 },
  moreText: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.goldInk },
  act: { maxWidth: '40%', flexShrink: 0, fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.goldInk },
  err: { fontFamily: FONTS.bodySemi, fontSize: 13, color: BRAND.danger },
});
