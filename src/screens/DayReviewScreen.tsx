/**
 * DayReviewScreen — "מה עשית היום": every task of the day, one checkbox each.
 *
 * The existing check-in review flow asks you to TALK about what you did and
 * then matches your words back to tasks. That is a lot of executive function
 * for a question that is really just a list. This is the list: tick what's
 * done, and for anything that isn't, pick one of three exits instead of
 * leaving it to rot.
 *
 *   ✓ done      → markTaskComplete
 *   📅 reschedule → moveTasksToDate (in place, id kept, alerts re-armed)
 *   📦 archive   → letGoTasks (status 'moved' — recoverable, and already
 *                  filtered out of getTasksForDate)
 *   🗑 delete    → deleteTask (real removal)
 *
 * Deliberately no "you missed 4 tasks" summary anywhere: the point is to end
 * the day with an empty list, not a scoreboard.
 *
 * Dependencies: TaskStorage, constants/theme, constants/categories.
 * Consumed by App (route "DayReview"), opened from TodaySchedule.
 */
import React, { useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BRAND, FONTS, RADIUS, SHADOWS } from '../constants/theme';
import { getCategoryMeta } from '../constants/categories';
import { AppLanguage, Task } from '../types';
import {
  getTasksForDate, getSettings, markTaskComplete,
  moveTasksToDate, letGoTasks, deleteTask,
} from '../services/TaskStorage';
import { getTodayString } from '../utils/timeUtils';

/** Reschedule targets, as day offsets. No date picker — three taps, no modal. */
const MOVE_CHOICES: { days: number; en: string; he: string }[] = [
  { days: 1, en: 'Tomorrow', he: 'מחר' },
  { days: 2, en: 'In 2 days', he: 'בעוד יומיים' },
  { days: 7, en: 'Next week', he: 'שבוע הבא' },
];

/** YYYY-MM-DD `days` after `date`, on the local calendar (never UTC). */
function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

export default function DayReviewScreen({ navigation }: any) {
  const insets = useSafeAreaInsets();
  const today = getTodayString();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [language, setLanguage] = useState<AppLanguage>('en');
  const [loading, setLoading] = useState(true);
  // Which row has its reschedule/archive/delete strip open. One at a time.
  const [openId, setOpenId] = useState<string | null>(null);
  const he = language === 'he';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [data, settings] = await Promise.all([getTasksForDate(today), getSettings()]);
      setTasks(data);
      setLanguage(settings.language);
    } finally {
      setLoading(false);
    }
  }, [today]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const toggle = async (task: Task) => {
    await markTaskComplete(task.id, task.status !== 'complete');
    await load();
  };

  const reschedule = async (task: Task, days: number) => {
    setOpenId(null);
    await moveTasksToDate([task.id], addDays(today, days));
    await load();
  };

  const archive = async (task: Task) => {
    setOpenId(null);
    await letGoTasks([task.id]);
    await load();
  };

  const remove = async (task: Task) => {
    setOpenId(null);
    await deleteTask(task.id);
    await load();
  };

  const done = tasks.filter((t) => t.status === 'complete').length;

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.topBar}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Text style={styles.close}>✕</Text>
        </TouchableOpacity>
        <Text style={styles.heading}>{he ? 'מה עשית היום' : 'What did you do today'}</Text>
        <View style={{ width: 22 }} />
      </View>

      <Text style={styles.counter}>
        {done}/{tasks.length} {he ? 'סומנו' : 'ticked'}
      </Text>

      {loading ? (
        <ActivityIndicator color={BRAND.sunGold} size="large" style={{ marginTop: 40 }} />
      ) : tasks.length === 0 ? (
        <Text style={styles.empty}>{he ? 'אין משימות היום ✨' : 'Nothing on today ✨'}</Text>
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
          {tasks.map((task) => {
            const complete = task.status === 'complete';
            const open = openId === task.id;
            return (
              <View key={task.id} style={styles.card}>
                <View style={styles.row}>
                  <TouchableOpacity
                    style={styles.check}
                    onPress={() => toggle(task)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Text style={styles.checkMark}>{complete ? '☑' : '☐'}</Text>
                  </TouchableOpacity>

                  <View style={styles.body}>
                    <Text
                      style={[styles.text, complete && styles.textDone]}
                      numberOfLines={2}
                    >
                      {getCategoryMeta(task.category).icon} {task.text}
                    </Text>
                    {Boolean(task.fixedTime || task.scheduledTime) && (
                      <Text style={styles.time}>{task.fixedTime || task.scheduledTime}</Text>
                    )}
                  </View>

                  {/* Nothing to move or archive once it's done. */}
                  {!complete && (
                    <TouchableOpacity
                      onPress={() => setOpenId(open ? null : task.id)}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <Text style={styles.more}>{open ? '▲' : '⋯'}</Text>
                    </TouchableOpacity>
                  )}
                </View>

                {open && !complete && (
                  <View style={styles.strip}>
                    {MOVE_CHOICES.map((choice) => (
                      <TouchableOpacity
                        key={choice.days}
                        style={styles.moveBtn}
                        onPress={() => reschedule(task, choice.days)}
                      >
                        <Text style={styles.moveText}>{he ? choice.he : choice.en}</Text>
                      </TouchableOpacity>
                    ))}
                    <TouchableOpacity style={styles.plainBtn} onPress={() => archive(task)}>
                      <Text style={styles.plainText}>📦 {he ? 'ארכיון' : 'Archive'}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.plainBtn} onPress={() => remove(task)}>
                      <Text style={styles.dangerText}>🗑 {he ? 'מחיקה' : 'Delete'}</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            );
          })}
          <View style={{ height: 40 }} />
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BRAND.cream, paddingHorizontal: 16 },
  topBar: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', paddingVertical: 12,
  },
  close: { fontSize: 22, color: BRAND.warmInk },
  heading: { fontFamily: FONTS.display, fontSize: 19, color: BRAND.warmInk },
  counter: {
    fontFamily: FONTS.bodyBold, fontSize: 13,
    color: BRAND.inkSoft, textAlign: 'center', marginBottom: 12,
  },
  empty: {
    fontFamily: FONTS.body, fontSize: 15, color: BRAND.inkSoft,
    textAlign: 'center', marginTop: 40,
  },
  list: { gap: 10, paddingBottom: 20 },
  card: {
    backgroundColor: BRAND.creamCard, borderRadius: RADIUS.card,
    borderWidth: 1, borderColor: BRAND.line,
    paddingHorizontal: 12, paddingVertical: 10, ...SHADOWS.card,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  check: { paddingRight: 2 },
  checkMark: { fontSize: 22, color: BRAND.timeChipText },
  body: { flex: 1 },
  text: { fontFamily: FONTS.bodyBold, fontSize: 14, color: BRAND.warmInk },
  textDone: { color: BRAND.inkFaint, textDecorationLine: 'line-through' },
  time: { fontFamily: FONTS.body, fontSize: 12, color: BRAND.inkFaint, marginTop: 2 },
  more: { fontSize: 18, color: BRAND.inkFaint, paddingHorizontal: 4 },
  strip: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 8,
    marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: BRAND.line,
  },
  moveBtn: {
    backgroundColor: BRAND.timeChipBg, borderRadius: 999,
    paddingHorizontal: 12, paddingVertical: 6,
  },
  moveText: { fontFamily: FONTS.bodyHeavy, fontSize: 12, color: BRAND.timeChipText },
  plainBtn: {
    borderWidth: 1, borderColor: BRAND.line, borderRadius: 999,
    paddingHorizontal: 12, paddingVertical: 6,
  },
  plainText: { fontFamily: FONTS.bodyHeavy, fontSize: 12, color: BRAND.inkSoft },
  // BRAND.danger, not the raw pink: #EF476F measures 3.56:1 as text on a
  // cream card, below AA. As a FILL with white on it, it stays.
  dangerText: { fontFamily: FONTS.bodyHeavy, fontSize: 12, color: BRAND.danger },
});
