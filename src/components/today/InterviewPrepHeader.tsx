/**
 * InterviewPrepHeader — the top of the interview-prep sheet (canvas v4, 27.10).
 *
 * Koral: "a link to the invitation email, who interviews me, the job, ways to
 * prepare". The researched brief (MeetingBriefCard — job, questions, company,
 * person, every line cited) was already there; what the sheet lacked was the
 * interview itself: when and where (with the צאי pill), the way back to the
 * invitation, and the study block Meira already put on her calendar. A missing
 * one says so — "no study block yet" — never a blank (rule 1).
 */
import React from 'react';
import { Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BRAND, FONTS, MIN_TOUCH } from '../../constants/theme';
import TaskSheetHero from './TaskSheetHero';
import { sourceLinkOf } from '../../utils/sourceLink';
import type { PrepSlot } from '../../utils/interviewBrief';
import type { Task } from '../../types';

interface Props {
  task: Task;
  prep: PrepSlot | null;
  he: boolean;
}

export default function InterviewPrepHeader({ task, prep, he }: Props) {
  const link = sourceLinkOf(task);
  const dir = he ? 'row-reverse' : 'row';
  return (
    <View style={styles.wrap}>
      <Text style={[styles.title, he && styles.rtl]} numberOfLines={2}>{`🎯 ${task.text}`}</Text>
      <TaskSheetHero task={task} he={he} />
      <View style={[styles.row, { flexDirection: dir }]}>
        {link ? (
          <TouchableOpacity
            style={styles.chip}
            accessibilityRole="link"
            onPress={() => Linking.openURL(link.url).catch((e) => console.warn('[InterviewPrep] open invitation', e))}
          >
            <Text style={styles.chipText} numberOfLines={1}>
              {`${link.kind === 'gmail' ? '📧' : '📅'} ${he ? 'ההזמנה' : 'The invitation'}`}
            </Text>
          </TouchableOpacity>
        ) : (
          <View style={[styles.chip, styles.chipOff]}>
            <Text style={styles.chipOffText} numberOfLines={1}>{he ? '📧 אין קישור להזמנה' : '📧 No invitation link'}</Text>
          </View>
        )}
        <View style={[styles.chip, prep ? styles.chipPrep : styles.chipOff]}>
          <Text style={prep ? styles.chipText : styles.chipOffText} numberOfLines={1}>
            {prep
              ? (he ? `📚 הכנה ${prep.date.slice(8)}.${Number(prep.date.slice(5, 7))} ${prep.time} · ${prep.minutes} דק׳`
                : `📚 Prep ${prep.date.slice(8)}.${Number(prep.date.slice(5, 7))} ${prep.time} · ${prep.minutes} min`)
              : (he ? '📚 עוד אין בלוק הכנה' : '📚 No study block yet')}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8, marginBottom: 10 },
  rtl: { textAlign: 'right', writingDirection: 'rtl' },
  title: { fontFamily: FONTS.bodyHeavy, fontSize: 19, color: BRAND.warmInk },
  row: { flexWrap: 'wrap', gap: 8 },
  chip: {
    minHeight: MIN_TOUCH, justifyContent: 'center', paddingHorizontal: 14, borderRadius: 999,
    backgroundColor: '#EEF0FF', borderWidth: 1, borderColor: '#D9DCFF', maxWidth: '100%',
  },
  chipPrep: { backgroundColor: '#E6FAF3', borderColor: '#9FE6CC' },
  chipText: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: '#3B3486' },
  chipOff: { backgroundColor: 'rgba(20,27,46,0.04)', borderColor: BRAND.line, borderStyle: 'dashed' },
  chipOffText: { fontFamily: FONTS.bodySemi, fontSize: 13, color: BRAND.inkSoft },
});
