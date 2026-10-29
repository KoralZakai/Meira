/**
 * DayGoalCard — "🎯 what matters most today?" at the top of Today (Koral's
 * pick B, 19.10). Unset: the day's three weightiest tasks as chips, or her own
 * words. Set: pinned, with a ✓. Done: one line of praise — a task goal is
 * completed through Today's own handler, so its points are the usual ones.
 */
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { BRAND, FONTS, MIN_TOUCH, surf } from '../../constants/theme';
import { Task } from '../../types/index';
import { DayGoal, goalCandidates, goalState } from '../../utils/dayGoal';
import { loadDayGoal, saveDayGoal } from '../../services/DayGoalService';
import { readingRow } from './readingRow';
import { useNight } from '../ui/SkyBackdrop';
import { N } from '../../constants/nightTone';

interface Props {
  he: boolean;
  date: string;
  tasks: Task[];
  onCompleteTask: (t: Task) => void;
}

export default function DayGoalCard({ he, date, tasks, onCompleteTask }: Props) {
  const night = useNight();
  const [goal, setGoal] = useState<DayGoal | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [writing, setWriting] = useState(false);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);

  useEffect(() => { loadDayGoal().then((r) => { setGoal(r.goal); setError(r.error); }); }, [date]);

  const set = (g: DayGoal | null) => {
    setGoal(g);
    setEditing(false);
    setWriting(false);
    saveDayGoal(g).catch((e) => { console.warn('[DayGoal] not saved', e); setError(String(e?.message || e)); });
  };

  const state = editing ? 'unset' : goalState(goal, tasks, date);
  const rtl = he ? styles.rtl : null;
  const row = { flexDirection: readingRow(he) } as const;

  if (error && !goal) {
    return <Text style={[styles.err, night && N.goldInk, rtl]}>{he ? '⚠️ לא הצלחתי לקרוא את המטרה של היום' : "⚠️ Couldn't read today's goal"}</Text>;
  }

  if (state === 'done') {
    return (
      <View style={[styles.card, night && N.surface, styles.doneCard]}>
        <Text style={[styles.title, night && N.ink, rtl]}>{he ? '🎉 עשית את הכי חשוב היום!' : '🎉 You did what mattered most today!'}</Text>
        <Text style={[styles.sub, night && N.goldInk, rtl]} numberOfLines={1}>{goal?.text}</Text>
      </View>
    );
  }

  if (state === 'open' && goal) {
    const task = goal.taskId ? tasks.find((t) => t.id === goal.taskId) : undefined;
    return (
      <View style={[styles.card, night && N.surface, row, styles.openRow]}>
        <TouchableOpacity style={styles.tick} onPress={() => (task ? onCompleteTask(task) : set({ ...goal, done: true }))}
          accessibilityRole="checkbox" accessibilityState={{ checked: false }}
          accessibilityLabel={he ? 'עשיתי' : 'Done'} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} />
        <View style={styles.body}>
          <Text style={[styles.eyebrow, night && N.goldInk, rtl]}>{he ? '🎯 הכי חשוב היום' : '🎯 MOST IMPORTANT TODAY'}</Text>
          <Text style={[styles.title, night && N.ink, rtl]} numberOfLines={2}>{goal.text}</Text>
        </View>
        <TouchableOpacity onPress={() => setEditing(true)} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Text style={[styles.change, night && N.goldInk]}>{he ? 'שינוי' : 'Change'}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const options = goalCandidates(tasks, date);
  return (
    <View style={[styles.card, night && N.surface]}>
      <Text style={[styles.title, night && N.ink, rtl]}>{he ? '🎯 מה הכי חשוב היום?' : '🎯 What matters most today?'}</Text>
      <View style={[styles.chips, row]}>
        {options.map((t) => (
          <TouchableOpacity key={t.id} style={[styles.chip, night && N.chip]} activeOpacity={0.8}
            onPress={() => set({ date, text: t.text, taskId: t.id })}>
            <Text style={[styles.chipText, night && N.ink]} numberOfLines={1}>{t.text}</Text>
          </TouchableOpacity>
        ))}
        {!writing ? (
          <TouchableOpacity style={[styles.chip, night && N.chip, styles.chipOwn]} onPress={() => setWriting(true)}>
            <Text style={[styles.chipText, night && N.ink]}>{he ? '✏️ משהו אחר' : '✏️ Something else'}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      {writing ? (
        <View style={[row, styles.writeRow]}>
          <TextInput style={[styles.input, night && N.input, rtl]} value={draft} onChangeText={setDraft} autoFocus
            placeholder={he ? 'לסיים את המצגת' : 'Finish the slides'} placeholderTextColor={BRAND.goldInk}
            returnKeyType="done" onSubmitEditing={() => draft.trim() && set({ date, text: draft.trim() })} />
          <TouchableOpacity style={[styles.chip, night && N.chip, styles.save]} onPress={() => draft.trim() && set({ date, text: draft.trim() })}>
            <Text style={styles.saveText}>{he ? 'שמירה' : 'Save'}</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: surf('#fff'), borderRadius: 16, borderWidth: 1.5, borderColor: BRAND.honey, padding: 14, marginBottom: 12 },
  doneCard: { borderColor: BRAND.sunGold, backgroundColor: BRAND.goldSoft },
  openRow: { alignItems: 'center', gap: 12 },
  body: { flex: 1 },
  eyebrow: { fontFamily: FONTS.bodyHeavy, fontSize: 11, color: BRAND.goldInk, letterSpacing: 0.5 },
  title: { fontFamily: FONTS.bodyHeavy, fontSize: 16, color: BRAND.warmInk },
  sub: { fontFamily: FONTS.body, fontSize: 13, color: BRAND.goldInk, marginTop: 2 },
  rtl: { textAlign: 'right', writingDirection: 'rtl' },
  tick: { width: 28, height: 28, borderRadius: 14, borderWidth: 2, borderColor: BRAND.goldInk },
  change: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.goldInk },
  chips: { flexWrap: 'wrap', gap: 8, marginTop: 10 },
  chip: { minHeight: MIN_TOUCH - 8, maxWidth: '100%', borderRadius: 999, borderWidth: 1, borderColor: BRAND.honey,
    backgroundColor: BRAND.goldSoft, paddingHorizontal: 12, justifyContent: 'center' },
  chipOwn: { backgroundColor: surf('#fff') },
  chipText: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.warmInk },
  writeRow: { gap: 8, marginTop: 10, alignItems: 'center' },
  input: { flex: 1, minHeight: MIN_TOUCH, borderRadius: 12, borderWidth: 1, borderColor: BRAND.honey, paddingHorizontal: 12,
    fontFamily: FONTS.body, fontSize: 14, color: BRAND.warmInk },
  save: { backgroundColor: BRAND.sunGold, borderColor: BRAND.sunGold },
  saveText: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.onGold },
  err: { fontFamily: FONTS.body, fontSize: 12, color: BRAND.goldInk, marginBottom: 8 },
});
