/**
 * FocusNowScreen — one task, full screen, nothing else.
 *
 * The Today tab answers "what does my day look like". This answers the harder
 * question: "what do I do RIGHT NOW". Starting is the step that stalls, and a
 * list of twelve things is the worst possible prompt for starting — so this
 * screen shows exactly one, with a running clock and no way to browse.
 *
 * The "too big" path is a timebox, not a decomposition: committing to 10
 * minutes is a far lower bar than committing to a 90-minute task, and the
 * timer running is usually enough to carry past the ten. (There is no
 * text-level subtask splitter in the repo — LLMService's split_into_subtasks
 * chunks HOURS across DAYS, which is a different thing entirely — and adding a
 * new app-side LLM call is exactly what the pending WhatsApp-brain decision is
 * about, so this deliberately needs no model at all.)
 *
 * Follows the LeaveNowScreen pattern: fullScreenModal, 30 s tick, two or three
 * actions and no navigation chrome.
 *
 * Dependencies: TaskStorage, constants/theme, constants/categories.
 * Consumed by App (route "FocusNow"), opened from TodaySchedule + NextUpCard.
 */
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BRAND, FONTS, RADIUS, SHADOWS } from '../constants/theme';
import { getCategoryMeta } from '../constants/categories';
import { AppLanguage, Subtask, Task } from '../types';
import {
  getSettings, markTaskComplete, updateTaskFields,
} from '../services/TaskStorage';

/** The "just start" timebox. Small enough that saying no feels silly. */
const MICRO_MINUTES = 10;

interface Props {
  navigation: any;
  route: { params: { task: Task } };
}

export default function FocusNowScreen({ navigation, route }: Props) {
  const insets = useSafeAreaInsets();
  const { task } = route.params;
  const [language, setLanguage] = useState<AppLanguage>('en');
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [budgetMinutes, setBudgetMinutes] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [subtasks, setSubtasks] = useState<Subtask[]>(task.subtasks ?? []);
  const he = language === 'he';

  useEffect(() => {
    getSettings().then((s) => setLanguage(s.language)).catch(() => {});
  }, []);

  // Only tick while something is actually running — an idle screen has no
  // reason to re-render, and this one may sit open for a long time.
  useEffect(() => {
    if (startedAt === null) return;
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [startedAt]);

  const elapsedMinutes = startedAt === null ? 0 : Math.floor((now - startedAt) / 60_000);
  const meta = getCategoryMeta(task.category);
  const overBudget = budgetMinutes !== null && elapsedMinutes >= budgetMinutes;

  const begin = (minutes: number | null) => {
    setBudgetMinutes(minutes);
    setStartedAt(Date.now());
    setNow(Date.now());
  };

  const finish = async () => {
    // Real elapsed time feeds the learned per-category averages, so the next
    // estimate for this kind of task comes from what actually happened.
    const actual = startedAt === null ? undefined : Math.max(1, elapsedMinutes);
    await markTaskComplete(task.id, true);
    if (actual !== undefined) {
      await updateTaskFields(task.id, {
        actualDurationMinutes: actual,
        historicalDurations: [...(task.historicalDurations ?? []), actual],
      }).catch(() => {});
    }
    navigation.goBack();
  };

  // Pausing records the time spent without claiming the task is done — the
  // point is that stopping early is a normal outcome, not a failure.
  const pause = async () => {
    if (startedAt !== null) {
      await updateTaskFields(task.id, {
        actualDurationMinutes: Math.max(1, elapsedMinutes),
      }).catch(() => {});
    }
    navigation.goBack();
  };

  const toggleSubtask = async (sub: Subtask) => {
    const next = subtasks.map((s) =>
      s.id === sub.id ? { ...s, status: s.status === 'complete' ? 'pending' as const : 'complete' as const } : s,
    );
    setSubtasks(next);
    await updateTaskFields(task.id, { subtasks: next }).catch(() => {});
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.topBar}>
          <TouchableOpacity
            onPress={() => navigation.goBack()}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Text style={styles.close}>✕</Text>
          </TouchableOpacity>
          <View style={styles.chip}>
            <Text style={styles.chipText}>{he ? 'רק זה' : 'JUST THIS'}</Text>
          </View>
          <View style={{ width: 22 }} />
        </View>

        <Text style={styles.icon}>{meta.icon}</Text>
        <Text style={styles.title}>{task.text}</Text>

        {startedAt === null ? (
          <Text style={styles.subtitle}>
            {task.durationMinutes
              ? he ? `הערכה: ${task.durationMinutes} דק'` : `Estimated ${task.durationMinutes} min`
              : ''}
          </Text>
        ) : (
          <View style={[styles.timer, overBudget && styles.timerOver]}>
            <Text style={styles.timerLabel}>
              {budgetMinutes !== null && !overBudget
                ? (he ? `מתוך ${budgetMinutes} דק'` : `of ${budgetMinutes} min`)
                : (he ? 'עובדת על זה' : 'WORKING')}
            </Text>
            <Text style={styles.timerValue}>
              {elapsedMinutes} <Text style={styles.timerUnit}>min</Text>
            </Text>
          </View>
        )}

        {overBudget && (
          <Text style={styles.overNote}>
            {he
              ? `עברו ${budgetMinutes} דק' — אפשר להמשיך או לעצור, שתיהן בסדר.`
              : `That's ${budgetMinutes} minutes. Keep going or stop — both are fine.`}
          </Text>
        )}

        {subtasks.length > 0 && (
          <View style={styles.subBox}>
            {[...subtasks].sort((a, b) => a.order - b.order).map((sub) => (
              <TouchableOpacity
                key={sub.id}
                style={styles.subRow}
                onPress={() => toggleSubtask(sub)}
                activeOpacity={0.7}
              >
                <Text style={styles.subBox2}>{sub.status === 'complete' ? '☑' : '☐'}</Text>
                <Text
                  style={[styles.subText, sub.status === 'complete' && styles.subDone]}
                  numberOfLines={2}
                >
                  {sub.text}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {startedAt === null ? (
          <View style={styles.actions}>
            <TouchableOpacity style={styles.primary} onPress={() => begin(task.durationMinutes || null)} activeOpacity={0.85}>
              <Text style={styles.primaryText}>{he ? 'מתחילה' : 'Start'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.secondary} onPress={() => begin(MICRO_MINUTES)} activeOpacity={0.85}>
              <Text style={styles.secondaryText}>
                {he ? `גדול מדי — ${MICRO_MINUTES} דק' בלבד` : `Too big — just ${MICRO_MINUTES} min`}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.tertiary} onPress={() => navigation.goBack()} activeOpacity={0.7}>
              <Text style={styles.tertiaryText}>{he ? 'לא עכשיו' : 'Not now'}</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.actions}>
            <TouchableOpacity style={styles.primary} onPress={finish} activeOpacity={0.85}>
              <Text style={styles.primaryText}>{he ? '✓ סיימתי' : '✓ Done'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.tertiary} onPress={pause} activeOpacity={0.7}>
              <Text style={styles.tertiaryText}>{he ? 'עוצרת כאן' : 'Stop here'}</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BRAND.cream },
  content: { padding: 22, paddingBottom: 40, gap: 12 },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  close: { fontSize: 22, color: BRAND.warmInk },
  chip: {
    backgroundColor: BRAND.timeChipBg, borderRadius: 12,
    paddingHorizontal: 12, paddingVertical: 5,
  },
  chipText: { fontFamily: FONTS.bodyHeavy, fontSize: 12, color: BRAND.timeChipText },
  icon: { fontSize: 40, textAlign: 'center', marginTop: 18 },
  title: { fontFamily: FONTS.display, fontSize: 26, color: BRAND.warmInk, textAlign: 'center' },
  subtitle: { fontFamily: FONTS.bodyBold, fontSize: 14, color: BRAND.inkSoft, textAlign: 'center' },
  timer: {
    alignSelf: 'center', backgroundColor: BRAND.sunGold, borderRadius: 18,
    paddingHorizontal: 26, paddingVertical: 12, alignItems: 'center', ...SHADOWS.button,
  },
  timerOver: { backgroundColor: BRAND.honey },
  timerLabel: { fontFamily: FONTS.bodyHeavy, fontSize: 11, letterSpacing: 1, color: '#7A5A18' },
  timerValue: { fontFamily: FONTS.display, fontSize: 40, color: '#4A3512', lineHeight: 44 },
  timerUnit: { fontSize: 16 },
  overNote: {
    fontFamily: FONTS.body, fontSize: 13, color: BRAND.inkSoft,
    textAlign: 'center', paddingHorizontal: 10,
  },
  subBox: {
    backgroundColor: BRAND.creamCard, borderWidth: 1, borderColor: BRAND.line,
    borderRadius: RADIUS.card, padding: 12, gap: 8, marginTop: 6,
  },
  subRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  subBox2: { fontSize: 16, color: BRAND.timeChipText },
  subText: { flex: 1, fontFamily: FONTS.body, fontSize: 14, color: BRAND.warmInk },
  subDone: { color: BRAND.inkFaint, textDecorationLine: 'line-through' },
  actions: { gap: 10, marginTop: 14 },
  primary: {
    backgroundColor: BRAND.warmInk, borderRadius: 18, paddingVertical: 16,
    alignItems: 'center', ...SHADOWS.button,
  },
  primaryText: { fontFamily: FONTS.bodyHeavy, fontSize: 16, color: BRAND.honey },
  secondary: {
    backgroundColor: BRAND.creamCard, borderWidth: 1, borderColor: BRAND.sunGold,
    borderRadius: 18, paddingVertical: 14, alignItems: 'center',
  },
  secondaryText: { fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.timeChipText },
  tertiary: { paddingVertical: 12, alignItems: 'center' },
  tertiaryText: { fontFamily: FONTS.bodyBold, fontSize: 14, color: BRAND.inkFaint },
});
