/**
 * MyTasks — the tasks tab, grouped by subject as "sticky notes" (same warm
 * BRAND look as the Today screen). Tapping a task's checkbox plays a small
 * success moment: a bounce, a few particles, and a floating "+10".
 */
import React, { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  TextInput,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BRAND, FONTS, RADIUS, SHADOWS, getNoteStyle } from '../constants/theme';
import {
  addTask,
  deleteTasks,
  getAllTasks,
  getSettings,
  getTasksForDate,
  markTaskComplete,
  removePastRecurringInstances,
  saveSchedule,
  toDateKey,
  updateTaskFields,
} from '../services/TaskStorage';
import { getCategoryMeta, hydrateCustomCategories } from '../constants/categories';
import { buildTaskTree, childProgress, isLiveTask } from '../utils/taskRelations';
import {
  nextParentSuggestion, setParent, declineParent, autoFileConfident,
  type ParentSuggestion,
} from '../services/TaskHierarchy';
import { loadProfile } from '../services/UserProfileStorage';
import { normalizeProfile } from '../utils/profileShape';
import { buildDaySchedule } from '../utils/buildDaySchedule';
import { buildSchedule as buildScheduleOnServer } from '../services/LumiServer';
import { AppLanguage, Task } from '../types';
import TaskDetailBottomSheet, { formatDuration } from '../components/TaskDetailBottomSheet';
import { formatShortDate, getTomorrowString, subtractMinutes } from '../utils/timeUtils';
import { emitLumiMood } from '../services/LumiMood';
import { searchTasks, TASK_TOPICS } from '../utils/searchTasks';

type Filter = 'All' | 'Today' | 'Upcoming' | 'Done';
const FILTERS: Filter[] = ['Today', 'All', 'Upcoming', 'Done'];

interface MyTasksProps { navigation: any }

// What "Build schedule" adds on top of the existing tasks: a prep block for
// tomorrow's big event, the profile's gym routine, and the 22:00 plan-tomorrow
// check. Each is a REAL task (editable/resizable via the detail sheet) and is
// only created once (text-prefix dedupe against today's tasks).
const BIG_EVENT = /interview|exam|test|ראיון|מבחן|בחינה/i;

async function synthesizeDayExtras(todayTasks: Task[], profile: any, he: boolean): Promise<number> {
  const today = toDateKey();
  const has = (re: RegExp) => todayTasks.some((t) => re.test(t.text));
  let added = 0;

  // 1. Tomorrow's interview/exam → a long prep block TODAY (must, 5h).
  const tomorrowTasks = await getTasksForDate(getTomorrowString());
  const big = tomorrowTasks.find((t) => t.status !== 'complete' && BIG_EVENT.test(t.text));
  if (big && !has(/prepare for|learn for|להתכונן ל|ללמוד ל/i)) {
    await addTask({
      text: he ? `ללמוד ולהתכונן ל: ${big.text}` : `Learn & prepare for: ${big.text}`,
      category: 'course',
      priority: 'must',
      isFixed: false,
      durationMinutes: 300, // ponytail: flat 5h prep block; scale by event type if it ever matters
      date: today,
      status: 'pending',
      source: 'suggested',
      historicalDurations: [],
    } as unknown as Omit<Task, 'id' | 'createdAt' | 'completedAt'>);
    added += 1;
  }

  // 2. Gym, if the profile's routine/hobbies mention it and today doesn't have it.
  const routineText = `${profile?.hobbies ?? ''} ${profile?.routinesNotes ?? ''}`;
  if (/gym|workout|אימון|כושר/i.test(routineText) && !has(/gym|אימון|כושר/i)) {
    await addTask({
      text: he ? 'אימון בחדר כושר 💪' : 'Gym workout 💪',
      category: 'gym',
      priority: 'have_to',
      isFixed: false,
      durationMinutes: 60,
      date: today,
      status: 'pending',
      source: 'suggested',
      historicalDurations: [],
    } as unknown as Omit<Task, 'id' | 'createdAt' | 'completedAt'>);
    added += 1;
  }

  // 3. Evening "check tomorrow's schedule" hour — before sleep time.
  if (!has(/tomorrow'?s schedule|לוח.?זמנים של מחר|לתכנן את מחר/i)) {
    const sleep = typeof profile?.sleepTime === 'string' && /^\d{1,2}:\d{2}$/.test(profile.sleepTime)
      ? profile.sleepTime
      : '23:00';
    await addTask({
      text: he ? "🌙 לבדוק ולתכנן את הלו״ז של מחר" : "🌙 Check & plan tomorrow's schedule",
      category: 'general',
      priority: 'have_to',
      isFixed: true,
      fixedTime: subtractMinutes(sleep, 60),
      durationMinutes: 60,
      date: today,
      status: 'pending',
      source: 'suggested',
      historicalDurations: [],
    } as unknown as Omit<Task, 'id' | 'createdAt' | 'completedAt'>);
    added += 1;
  }
  return added;
}

// Group a flat task list into subject sections, sorted for a stable order.
// A task's subgroup (project/theme, e.g. "Lumi app" for many bug-fix tasks)
// wins over its category, so related tasks share one sticky note under the
// project title; the note's icon/color come from the first task's category.
function groupBySubject(tasks: Task[]) {
  const map = new Map<string, Task[]>();
  for (const task of tasks) {
    const key = (task.subgroup || '').trim() || task.category || 'general';
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(task);
  }
  return Array.from(map.entries())
    .map(([key, list]) => {
      const bySubgroup = Boolean((list[0].subgroup || '').trim());
      const meta = getCategoryMeta(bySubgroup ? list[0].category || 'general' : key);
      return { key, meta, title: bySubgroup ? key : null, tasks: list };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

function logicalTaskKey(task: Task): string {
  return task.text.trim().toLowerCase().replace(/\s+/g, ' ');
}

function collapseRepeatedTasks(tasks: Task[]): Task[] {
  const groups = new Map<string, Task[]>();
  for (const task of tasks) {
    const key = logicalTaskKey(task);
    const group = groups.get(key) ?? [];
    group.push(task);
    groups.set(key, group);
  }

  return Array.from(groups.values()).map((group) => {
    if (group.length === 1) return group[0];
    const repeatDays = Array.from(new Set([
      ...group.flatMap((task) => task.repeatDays ?? []),
      ...group.map((task) => {
        const [year, month, day] = task.date.split('-').map(Number);
        return new Date(year, month - 1, day).getDay();
      }),
    ])).sort((a, b) => a - b);
    return {
      ...group.slice().sort((a, b) => a.date.localeCompare(b.date))[0],
      repeatDays,
    };
  });
}

export default function MyTasks({ navigation }: MyTasksProps) {
  const insets = useSafeAreaInsets();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('Today');
  const [query, setQuery] = useState('');
  const [topicId, setTopicId] = useState<string | null>(null);
  // "Should this go under that project?" — offered, never applied silently.
  const [nesting, setNesting] = useState<{ child: Task; suggestion: ParentSuggestion } | null>(null);
  const [language, setLanguage] = useState<AppLanguage>('en');
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [building, setBuilding] = useState(false);
  // Multi-select + expired-cleanup
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [expiredIds, setExpiredIds] = useState<string[]>([]);

  useFocusEffect(useCallback(() => {
    void load();
  }, []));

  const load = async () => {
    try {
      setLoading(true);
      await removePastRecurringInstances();
      const [all, settings] = await Promise.all([getAllTasks(), getSettings(), hydrateCustomCategories()]);
      setLanguage(settings.language);
      setTasks(all);
      const todayKey = toDateKey();
      setExpiredIds(all.filter((t) => t.date < todayKey && isLiveTask(t)).map((t) => t.id));
      // File the obvious ones without asking, then offer AT MOST ONE question
      // about the rest. Answering used to immediately raise the next pair,
      // which looked exactly like the answer had been ignored.
      if (!nestingAnsweredRef.current) {
        autoFileConfident(all)
          .then(async (filed) => {
            if (filed.length) {
              const names = filed.map((f) => `«${f.child.text}» → «${f.parent.text}»`).join('\n');
              Alert.alert(
                language === 'he' ? 'סודר תחת פרויקט' : 'Filed under a project',
                `${names}\n\n${language === 'he'
                  ? 'אפשר לגרור החוצה מתוך המשימה.'
                  : 'You can move it back out from the task itself.'}`,
              );
              await load();
              return;
            }
            const next = await nextParentSuggestion(await getAllTasks());
            setNesting(next);
          })
          .catch(() => setNesting(null));
      }
    } finally {
      setLoading(false);
    }
  };

  const today = toDateKey();
  const todayPending = tasks.filter((task) => task.date === today && isLiveTask(task));

  const byFilter = (() => {
    if (filter === 'Today') return todayPending;
    // Sorted by date, then by time within the day. Unsorted, "Upcoming" showed
    // next month above tomorrow, which makes the list unreadable.
    if (filter === 'Upcoming') {
      return tasks
        .filter((task) => task.date > today && isLiveTask(task))
        .sort((a, b) => (
          a.date !== b.date
            ? a.date.localeCompare(b.date)
            : (a.fixedTime || a.scheduledTime || '23:59')
              .localeCompare(b.fixedTime || b.scheduledTime || '23:59')
        ));
    }
    if (filter === 'Done') return tasks.filter((task) => task.status === 'complete');
    return collapseRepeatedTasks(tasks.filter(isLiveTask));
  })();

  // Search sits ON TOP of the active filter, so "Upcoming + sport" needs no
  // second mental model. With a hundred-plus tasks the list was an archive
  // with no way in.
  const filtered = searchTasks(byFilter, query, topicId);

  // One question per visit to this screen. Chaining them turned a helpful
  // prompt into a quiz, and made an accepted answer look like it had failed
  // because a near-identical card appeared in its place.
  const nestingAnsweredRef = React.useRef(false);

  const acceptNesting = async () => {
    if (!nesting) return;
    nestingAnsweredRef.current = true;
    await setParent(nesting.child.id, nesting.suggestion.parent.id);
    setNesting(null);
    await load();
  };

  const rejectNesting = async () => {
    if (!nesting) return;
    nestingAnsweredRef.current = true;
    await declineParent(nesting.child.id);
    setNesting(null);
    await load();
  };

  const handleComplete = async (task: Task) => {
    const completing = task.status !== 'complete';
    await markTaskComplete(task.id, completing);
    if (completing) emitLumiMood('celebrate'); // floating Lumi cheers
    await load();
  };

  const persistSchedule = async (scheduled: Task[]) => {
    for (const task of scheduled) {
      if (task.scheduledTime) {
        await updateTaskFields(task.id, { scheduledTime: task.scheduledTime });
      }
    }
    await saveSchedule({
      date: today,
      tasks: scheduled,
      wakeUpTime: scheduled[0]?.scheduledTime ?? '08:00',
      generatedAt: Date.now(),
      lumiSummary: `${scheduled.length} tasks scheduled`,
      lumiSummaryHe: `${scheduled.length} משימות שובצו`,
    });
  };

  const nowHHMM = () => {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  // Add prep-for-tomorrow / gym / plan-tomorrow blocks, reload, and return
  // today's fresh pending list ready to be laid on the timeline.
  const prepareBuildPool = async (profile: any): Promise<Task[]> => {
    await synthesizeDayExtras(todayPending, profile, language === 'he');
    const all = await getAllTasks();
    return all.filter((task) => task.date === today && isLiveTask(task));
  };

  const buildSchedule = async () => {
    if (!todayPending.length) return;
    setBuilding(true);
    try {
      const profile = normalizeProfile(await loadProfile());
      const wake = profile?.defaultWakeTime || '08:00';
      const pool = await prepareBuildPool(profile);
      // From NOW (not midnight/wake), important tasks only; the rest stay in
      // the list unscheduled.
      const scheduled = buildDaySchedule(pool, wake, { now: nowHHMM(), importantOnly: true });
      await persistSchedule(scheduled.filter((t) => t.scheduledTime));
      await load();
      // Was 'Schedule' — the Timeline tab, now folded into Today.
      navigation.navigate('MainTabs', { screen: 'Today' } as any);
    } finally {
      setBuilding(false);
    }
  };

  // Build the day on the SERVER — the same algorithm, run where the one brain
  // lives. This used to run the on-device ReAct agent over a transcript of the
  // day: a 235B model asked to redo a sort the phone had already done
  // correctly, whose answer was then clamped by the local build anyway. The
  // local build is now the offline fallback rather than the thing being
  // second-guessed, so the day has one shape whatever the network is doing.
  const refineOnServer = async () => {
    if (!todayPending.length) return;
    setBuilding(true);
    try {
      // Was `const profile: any = await loadProfile()` — the cast hid that four
      // profile fields rendered as "undefined", so the planner planned blind.
      const profile = normalizeProfile(await loadProfile());
      const wake = profile?.defaultWakeTime || '08:00';
      const pool = await prepareBuildPool(profile);
      const local = buildDaySchedule(pool, wake, { now: nowHHMM(), importantOnly: true });

      const built = await buildScheduleOnServer(today, pool, {
        wakeTime: wake,
        importantOnly: true,
        language,
      });
      let scheduled = local;
      if (built) {
        const byId = new Map(built.tasks.map((task: any) => [task.id, task.scheduledTime]));
        // A returned slot may only move a task forward of now — never back into
        // the past, whoever computed it.
        scheduled = local.map((task) => {
          const slot = byId.get(task.id);
          return slot && slot >= nowHHMM() ? { ...task, scheduledTime: slot } : task;
        });
      } else {
        Alert.alert('Used quick schedule', 'Lumi was unreachable, so I built it on the phone.');
      }
      await persistSchedule(scheduled.filter((t) => t.scheduledTime));
      await load();
      // Was 'Schedule' — the Timeline tab, now folded into Today.
      navigation.navigate('MainTabs', { screen: 'Today' } as any);
    } finally {
      setBuilding(false);
    }
  };

  const enterSelect = (id: string) => { setSelectMode(true); setSelectedIds(new Set([id])); };
  const toggleSelect = (id: string) => setSelectedIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) { next.delete(id); } else { next.add(id); }
    return next;
  });
  const exitSelect = () => { setSelectMode(false); setSelectedIds(new Set()); };
  const deleteSelected = async () => {
    if (!selectedIds.size) return;
    await deleteTasks([...selectedIds]);
    exitSelect();
    await load();
  };
  const clearExpired = async () => {
    if (!expiredIds.length) return;
    Alert.alert(
      language === 'he' ? 'לנקות משימות ישנות?' : 'Clear old tasks?',
      language === 'he'
        ? `${expiredIds.length} משימות שעבר תאריכן יימחקו.`
        : `${expiredIds.length} task(s) past their date will be deleted.`,
      [
        { text: language === 'he' ? 'ביטול' : 'Cancel', style: 'cancel' },
        {
          text: language === 'he' ? 'נקה' : 'Clear', style: 'destructive',
          onPress: async () => { await deleteTasks(expiredIds); await load(); },
        },
      ],
    );
  };

  const subjectGroups = groupBySubject(filtered);

  return (
    <View style={styles.root}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={[styles.scroll, { paddingTop: insets.top + 12 }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <View>
            <Text style={styles.greeting}>☑️ Task board</Text>
            <Text style={styles.userName}>Your tasks</Text>
          </View>
          <TouchableOpacity style={styles.addBtn} onPress={() => navigation.navigate('AddTask')} activeOpacity={0.85}>
            <Text style={styles.addBtnText}>＋</Text>
          </TouchableOpacity>
        </View>

        {/* Search — free text and topic, both optional */}
        <View style={styles.searchRow}>
          <Text style={styles.searchIcon}>🔍</Text>
          <TextInput
            style={styles.searchInput}
            value={query}
            onChangeText={setQuery}
            placeholder="Search tasks, places, people…"
            placeholderTextColor={BRAND.inkSoft}
            returnKeyType="search"
          />
          {query.length > 0 && (
            <TouchableOpacity onPress={() => setQuery('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={styles.searchClear}>✕</Text>
            </TouchableOpacity>
          )}
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filtersBar} contentContainerStyle={styles.filtersContent}>
          {TASK_TOPICS.map((tp) => (
            <TouchableOpacity
              key={tp.id}
              style={[styles.chip, topicId === tp.id && styles.chipActive]}
              onPress={() => setTopicId((v) => (v === tp.id ? null : tp.id))}
            >
              <Text style={[styles.chipText, topicId === tp.id && styles.chipTextActive]}>
                {tp.icon} {tp.labelEn}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {(query.length > 0 || topicId) && (
          <View style={styles.searchSummary}>
            <Text style={styles.searchSummaryText}>
              {filtered.length} result{filtered.length === 1 ? '' : 's'}
              {topicId ? ` · ${TASK_TOPICS.find((x) => x.id === topicId)?.labelEn}` : ''}
              {query ? ` · "${query}"` : ''}
            </Text>
            <TouchableOpacity onPress={() => { setQuery(''); setTopicId(null); }}>
              <Text style={styles.searchSummaryClear}>Clear all</Text>
            </TouchableOpacity>
          </View>
        )}

        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filtersBar} contentContainerStyle={styles.filtersContent}>
          {FILTERS.map((item) => (
            <TouchableOpacity key={item} style={[styles.chip, filter === item && styles.chipActive]} onPress={() => setFilter(item)}>
              <Text style={[styles.chipText, filter === item && styles.chipTextActive]}>{item}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {(filter === 'Today' || filter === 'All') && todayPending.length > 0 && (
          <View style={styles.actionBar}>
            <TouchableOpacity style={styles.buildBtn} onPress={buildSchedule} disabled={building} activeOpacity={0.85}>
              {building ? <ActivityIndicator color={BRAND.white} /> : <Text style={styles.buildBtnText}>Build schedule for today</Text>}
            </TouchableOpacity>
            <TouchableOpacity style={styles.aiBtn} onPress={refineOnServer} disabled={building} activeOpacity={0.85}>
              <Text style={styles.aiBtnText}>✨ AI</Text>
            </TouchableOpacity>
          </View>
        )}

        {!selectMode && nesting && (
          <View style={styles.nestCard}>
            <Text style={styles.nestText}>
              {language === 'he' ? 'לשים את ' : 'File '}
              <Text style={styles.nestStrong}>«{nesting.child.text}»</Text>
              {language === 'he' ? ' תחת ' : ' under '}
              <Text style={styles.nestStrong}>«{nesting.suggestion.parent.text}»</Text>?
            </Text>
            {/* Say WHY. "Because you were just filing things there" is a very
                different claim from "because the words match", and the user
                should be able to tell them apart before agreeing. */}
            <Text style={styles.nestWhy}>
              {nesting.suggestion.reason === 'wording'
                ? (language === 'he' ? 'לפי הניסוח' : 'based on the wording')
                : (language === 'he' ? 'כי הוספת לשם עכשיו' : "because you've been adding there")}
            </Text>
            <View style={styles.nestActions}>
              <TouchableOpacity style={styles.nestYes} onPress={acceptNesting} activeOpacity={0.85}>
                <Text style={styles.nestYesText}>{language === 'he' ? 'כן' : 'Yes'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.nestNo} onPress={rejectNesting} activeOpacity={0.85}>
                <Text style={styles.nestNoText}>{language === 'he' ? 'לא, להשאיר' : 'No, keep it out'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {!selectMode && expiredIds.length > 0 && (
          <View style={styles.expiredBanner}>
            <Text style={styles.expiredText}>
              🧹 {expiredIds.length} {language === 'he' ? 'משימות שעבר תאריכן' : 'old task(s) past their date'}
            </Text>
            <TouchableOpacity style={styles.expiredBtn} onPress={clearExpired} activeOpacity={0.85}>
              <Text style={styles.expiredBtnText}>{language === 'he' ? 'נקה' : 'Clear'}</Text>
            </TouchableOpacity>
          </View>
        )}

        {loading ? (
          <ActivityIndicator color={BRAND.sunGold} size="large" style={{ marginTop: 32 }} />
        ) : subjectGroups.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>☑️</Text>
            <Text style={styles.emptyText}>All clear here. Nice work.</Text>
          </View>
        ) : (
          <View style={styles.groupsWrap}>
            {subjectGroups.map((group, index) => {
              const note = getNoteStyle(index);
              const doneCount = group.tasks.filter((t) => t.status === 'complete').length;
              return (
                <View
                  key={group.key}
                  style={[
                    styles.noteCard,
                    { backgroundColor: note.tint, borderColor: note.border, transform: [{ rotate: note.rotate }] },
                  ]}
                >
                  <View style={[styles.noteTape, { backgroundColor: note.tape, transform: [{ rotate: note.tapeRotate }] }]} />
                  <View style={styles.noteHeader}>
                    <Text style={styles.noteIcon}>{group.meta.icon}</Text>
                    <Text style={styles.noteName}>{group.title ?? group.meta.labelEn}</Text>
                    <Text style={styles.noteCount}>{doneCount > 0 ? `${doneCount}/${group.tasks.length}` : `${group.tasks.length}`}</Text>
                  </View>
                  <View style={styles.noteBody}>
                    {buildTaskTree(group.tasks).map(({ task, children }) => {
                      const prog = childProgress(children);
                      return (
                        <View key={task.id}>
                          <TaskRow
                            task={task}
                            selectMode={selectMode}
                            selected={selectedIds.has(task.id)}
                            onPress={() => (selectMode ? toggleSelect(task.id) : setSelectedTask(task))}
                            onLongPress={() => enterSelect(task.id)}
                            onToggle={() => handleComplete(task)}
                          />
                          {/* Children of a project, indented one step. Deliberately
                              always visible rather than collapsed: a task hidden
                              behind a disclosure is a task that gets forgotten. */}
                          {children.length > 0 && (
                            <View style={styles.childWrap}>
                              {prog.total > 1 && (
                                <Text style={styles.childProgress}>
                                  {prog.done}/{prog.total} {language === 'he' ? 'הושלמו' : 'done'}
                                </Text>
                              )}
                              {children.map((child) => (
                                <TaskRow
                                  key={child.id}
                                  task={child}
                                  selectMode={selectMode}
                                  selected={selectedIds.has(child.id)}
                                  onPress={() => (selectMode ? toggleSelect(child.id) : setSelectedTask(child))}
                                  onLongPress={() => enterSelect(child.id)}
                                  onToggle={() => handleComplete(child)}
                                />
                              ))}
                            </View>
                          )}
                        </View>
                      );
                    })}
                  </View>
                </View>
              );
            })}
          </View>
        )}

        <View style={{ height: 120 }} />
      </ScrollView>

      {selectMode && (
        <View style={[styles.selectBar, { paddingBottom: insets.bottom + 12 }]}>
          <TouchableOpacity onPress={exitSelect} activeOpacity={0.8}>
            <Text style={styles.selectCancel}>{language === 'he' ? 'ביטול' : 'Cancel'}</Text>
          </TouchableOpacity>
          <Text style={styles.selectCount}>
            {selectedIds.size} {language === 'he' ? 'נבחרו' : 'selected'}
          </Text>
          <TouchableOpacity
            style={[styles.selectDelete, !selectedIds.size && styles.selectDeleteOff]}
            onPress={deleteSelected}
            disabled={!selectedIds.size}
            activeOpacity={0.85}
          >
            <Text style={styles.selectDeleteText}>🗑 {language === 'he' ? 'מחק' : 'Delete'}</Text>
          </TouchableOpacity>
        </View>
      )}

      {selectedTask && (
        <TaskDetailBottomSheet
          task={selectedTask}
          visible={Boolean(selectedTask)}
          onClose={() => setSelectedTask(null)}
          onComplete={() => { void handleComplete(selectedTask); setSelectedTask(null); }}
          onUpdate={async (patch) => {
            setSelectedTask((current) => (current ? { ...current, ...patch } : current));
            const targets = tasks.filter((task) =>
              task.status !== 'complete' && logicalTaskKey(task) === logicalTaskKey(selectedTask),
            );
            await Promise.all(targets.map((task) => updateTaskFields(task.id, patch)));
            await load();
          }}
          onDelete={async () => {
            const ids = tasks
              .filter((task) => task.status !== 'complete' && logicalTaskKey(task) === logicalTaskKey(selectedTask))
              .map((task) => task.id);
            setSelectedTask(null);
            await deleteTasks(ids.length ? ids : [selectedTask.id]);
            await load();
          }}
          language={language}
        />
      )}
    </View>
  );
}

// One task row inside a sticky note. Owns its own success-moment animation
// so groups/re-renders elsewhere don't interrupt it.
function TaskRow({ task, onPress, onToggle, onLongPress, selectMode = false, selected = false }: {
  task: Task; onPress: () => void; onToggle: () => void; onLongPress?: () => void;
  selectMode?: boolean; selected?: boolean;
}) {
  const isDone = task.status === 'complete';
  const hour = task.scheduledTime || task.fixedTime || '';
  // Date + hour on every row ("Tomorrow · 10:00").
  const time = [formatShortDate(task.date), hour].filter(Boolean).join(' · ');
  const scale = useRef(new Animated.Value(1)).current;
  const pop = useRef(new Animated.Value(0)).current;
  const [bursting, setBursting] = useState(false);

  const handleToggle = () => {
    const willBeDone = !isDone;
    onToggle();
    if (willBeDone) {
      setBursting(true);
      scale.setValue(1);
      Animated.sequence([
        Animated.timing(scale, { toValue: 1.35, duration: 120, useNativeDriver: true }),
        Animated.spring(scale, { toValue: 1, friction: 4, useNativeDriver: true }),
      ]).start();
      pop.setValue(0);
      Animated.timing(pop, { toValue: 1, duration: 650, useNativeDriver: true }).start(() => setBursting(false));
    }
  };

  return (
    <TouchableOpacity style={rowStyles.row} onPress={onPress} onLongPress={onLongPress} delayLongPress={350} activeOpacity={0.85}>
      <View style={rowStyles.checkWrap}>
        {selectMode ? (
          <View style={[rowStyles.selectDot, selected && rowStyles.selectDotOn]}>
            {selected && <Text style={rowStyles.checkmark}>✓</Text>}
          </View>
        ) : (
          <TouchableOpacity onPress={handleToggle} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Animated.View style={[rowStyles.checkbox, isDone && rowStyles.checkboxDone, { transform: [{ scale }] }]}>
              {isDone && <Text style={rowStyles.checkmark}>✓</Text>}
            </Animated.View>
          </TouchableOpacity>
        )}
        {bursting && (
          <Animated.Text
            pointerEvents="none"
            style={[
              rowStyles.pointBadge,
              {
                opacity: pop.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0, 1, 0] }),
                transform: [{ translateY: pop.interpolate({ inputRange: [0, 1], outputRange: [0, -24] }) }],
              },
            ]}
          >
            +10 ✨
          </Animated.Text>
        )}
      </View>

      <View style={rowStyles.body}>
        <Text style={[rowStyles.title, isDone && rowStyles.titleDone]} numberOfLines={2}>
          {task.text}
        </Text>
        {task.durationMinutes > 0 && <Text style={rowStyles.sub}>{formatDuration(task.durationMinutes)}</Text>}
      </View>

      {time ? (
        <View style={rowStyles.timeChip}>
          <Text style={rowStyles.timeChipText}>{time}</Text>
        </View>
      ) : null}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BRAND.cream },
  scroll: { paddingHorizontal: 16 },

  // Expired-task cleanup banner
  expiredBanner: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: '#FDEFD9', borderColor: '#F1E0B8', borderWidth: 1,
    borderRadius: 14, paddingVertical: 10, paddingHorizontal: 14, marginBottom: 12,
  },
  expiredText: { flex: 1, fontSize: 13, fontFamily: FONTS.bodySemi, color: BRAND.warmInk },
  expiredBtn: { backgroundColor: BRAND.sunGold, borderRadius: 12, paddingVertical: 6, paddingHorizontal: 16 },
  expiredBtnText: { fontSize: 13, fontFamily: FONTS.bodyBold, color: BRAND.warmInk },

  // Multi-select delete bar
  selectBar: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: BRAND.creamCard, borderTopColor: BRAND.line, borderTopWidth: 1,
    paddingHorizontal: 20, paddingTop: 12,
  },
  selectCancel: { fontSize: 15, fontFamily: FONTS.bodySemi, color: BRAND.inkSoft },
  selectCount: { fontSize: 15, fontFamily: FONTS.bodyBold, color: BRAND.warmInk },
  selectDelete: { backgroundColor: '#EF476F', borderRadius: 14, paddingVertical: 10, paddingHorizontal: 22 },
  selectDeleteOff: { opacity: 0.4 },
  selectDeleteText: { fontSize: 15, fontFamily: FONTS.bodyBold, color: BRAND.white },

  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  greeting: { fontSize: 14, fontFamily: FONTS.body, color: BRAND.inkSoft },
  userName: { fontSize: 24, fontFamily: FONTS.display, color: BRAND.warmInk },
  addBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: BRAND.sunGold,
    alignItems: 'center',
    justifyContent: 'center',
    ...SHADOWS.button,
  },
  addBtnText: { fontSize: 22, color: BRAND.white, fontFamily: FONTS.bodyHeavy, marginTop: -2 },

  // One indent step, with a rail so the relationship is visible without
  // reading the titles.
  nestCard: {
    backgroundColor: BRAND.creamCard, borderRadius: RADIUS.card,
    borderWidth: 1, borderColor: BRAND.line,
    padding: 14, marginBottom: 12, gap: 4,
  },
  nestText: { fontFamily: FONTS.body, fontSize: 14, color: BRAND.warmInk },
  nestStrong: { fontFamily: FONTS.bodyHeavy, color: BRAND.warmInk },
  nestWhy: { fontFamily: FONTS.body, fontSize: 12, color: BRAND.inkFaint },
  nestActions: { flexDirection: 'row', gap: 10, marginTop: 8 },
  nestYes: {
    backgroundColor: BRAND.sunGold, borderRadius: 12,
    paddingVertical: 8, paddingHorizontal: 22,
  },
  nestYesText: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: '#4A3512' },
  nestNo: { paddingVertical: 8, paddingHorizontal: 10 },
  nestNoText: { fontFamily: FONTS.bodyBold, fontSize: 13, color: BRAND.inkFaint },
  childWrap: {
    marginLeft: 14, paddingLeft: 10,
    borderLeftWidth: 2, borderLeftColor: BRAND.line,
  },
  childProgress: {
    fontFamily: FONTS.bodyHeavy, fontSize: 10,
    color: BRAND.inkFaint, marginBottom: 2, marginTop: 2,
  },
  filtersBar: { flexGrow: 0, marginBottom: 10 },
  searchRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: BRAND.creamCard, borderRadius: RADIUS.chip,
    borderWidth: 1, borderColor: BRAND.line,
    paddingHorizontal: 12, paddingVertical: 8, marginBottom: 10,
  },
  searchIcon: { fontSize: 14 },
  searchInput: {
    flex: 1, fontSize: 14, fontFamily: FONTS.body, color: BRAND.warmInk, paddingVertical: 0,
  },
  searchClear: { fontSize: 15, color: BRAND.inkSoft, paddingHorizontal: 2 },
  searchSummary: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 8, paddingHorizontal: 2,
  },
  searchSummaryText: { fontSize: 12.5, fontFamily: FONTS.bodySemi, color: BRAND.inkSoft },
  searchSummaryClear: { fontSize: 12.5, fontFamily: FONTS.bodyBold, color: BRAND.sunGold },
  filtersContent: { gap: 8 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: BRAND.creamCard,
    borderWidth: 1,
    borderColor: BRAND.line,
  },
  chipActive: { backgroundColor: BRAND.warmInk, borderColor: BRAND.warmInk },
  chipText: { fontSize: 13, fontFamily: FONTS.bodyBold, color: BRAND.inkSoft },
  chipTextActive: { color: BRAND.white },

  actionBar: { flexDirection: 'row', gap: 8, marginBottom: 16 },
  buildBtn: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: BRAND.sunGold,
    ...SHADOWS.button,
  },
  buildBtnText: { fontSize: 15, fontFamily: FONTS.bodyHeavy, color: BRAND.white },
  aiBtn: {
    paddingHorizontal: 16,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: BRAND.creamCard,
    borderWidth: 1,
    borderColor: BRAND.line,
  },
  aiBtnText: { fontSize: 14, fontFamily: FONTS.bodyHeavy, color: BRAND.sunGold },

  // Sticky-note subject groups
  groupsWrap: { gap: 18, marginTop: 4 },
  noteCard: {
    position: 'relative',
    borderWidth: 1,
    borderRadius: RADIUS.card,
    padding: 15,
    paddingTop: 16,
    ...SHADOWS.card,
  },
  noteTape: {
    position: 'absolute',
    left: 26,
    top: -9,
    width: 54,
    height: 18,
    borderRadius: 3,
    opacity: 0.85,
  },
  noteHeader: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  noteIcon: { fontSize: 16 },
  noteName: { flex: 1, fontSize: 17, fontFamily: FONTS.display, color: BRAND.warmInk },
  noteCount: {
    fontSize: 12,
    fontFamily: FONTS.bodyBold,
    color: BRAND.inkSoft,
    backgroundColor: BRAND.creamCard,
    paddingHorizontal: 9,
    paddingVertical: 2,
    borderRadius: 999,
  },
  noteBody: { gap: 8, marginTop: 11 },

  empty: { alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 28 },
  emptyIcon: { fontSize: 40 },
  emptyText: { fontSize: 14, fontFamily: FONTS.bodySemi, color: BRAND.inkSoft },
});

const rowStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    backgroundColor: BRAND.creamCard,
    borderWidth: 1,
    borderColor: BRAND.line,
    borderRadius: 14,
    padding: 12,
  },
  checkWrap: { position: 'relative' },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: '#E6D9BC',
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxDone: { backgroundColor: BRAND.sunGold, borderColor: BRAND.sunGold },
  checkmark: { fontSize: 13, color: BRAND.white, fontFamily: FONTS.bodyHeavy },
  selectDot: {
    width: 22, height: 22, borderRadius: 11, borderWidth: 2,
    borderColor: '#EF476F', backgroundColor: '#fff',
    alignItems: 'center', justifyContent: 'center',
  },
  selectDotOn: { backgroundColor: '#EF476F', borderColor: '#EF476F' },
  pointBadge: {
    position: 'absolute',
    left: 26,
    top: -6,
    fontSize: 12,
    fontFamily: FONTS.bodyHeavy,
    color: BRAND.amber,
  },
  body: { flex: 1, minWidth: 0 },
  title: { fontSize: 14, fontFamily: FONTS.bodyBold, color: BRAND.warmInk },
  titleDone: { color: BRAND.inkFaint, textDecorationLine: 'line-through' },
  sub: { fontSize: 11.5, fontFamily: FONTS.body, color: BRAND.inkFaint, marginTop: 3 },
  timeChip: {
    borderRadius: 10,
    paddingHorizontal: 9,
    paddingVertical: 5,
    backgroundColor: BRAND.timeChipBg,
  },
  timeChipText: { fontSize: 12, fontFamily: FONTS.bodyHeavy, color: BRAND.timeChipText },
});
