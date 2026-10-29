/**
 * PlanTomorrow — tomorrow's full timeline: ⏰ wake alarm on top, a motivation
 * line for the big event, every task in clock order, and pre-computed travel
 * connectors BETWEEN places (leg chained from the previous task's location —
 * tap a connector to open the task's route map). Also: today's unfinished
 * tasks to carry over (tap moves them) and Gmail event suggestions dated
 * tomorrow (accept/dismiss). Calendar events import on open.
 * Dependencies: TaskStorage, GoogleSync, GoogleService (leg computation).
 * Registered in App.tsx; the 20:00 evening notification's "Plan tomorrow"
 * action routes here.
 * TODO(next): auto-silence (DND) during the interview window — needs the
 * native ACCESS_NOTIFICATION_POLICY permission, out of Expo-managed scope.
 */
import React, { useState, useCallback } from 'react';
import {
  View,
  ScrollView,
  StyleSheet,
  Text,
  SectionList,
  TouchableOpacity,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BRAND, FONTS, RADIUS } from '../constants/theme';
import { getTodayString, getTomorrowString } from '../utils/timeUtils';
import { getTasksForDate, getSettings, updateTaskFields } from '../services/TaskStorage';
import {
  planTomorrowFromGoogle, acceptGmailSuggestion, dismissGmailSuggestion,
  ensureTravelChain, analyzeWeek, WeekDayPlan,
} from '../services/GoogleSync';
import { GMAIL_ENABLED, gmailOffLine } from '../utils/gmailAccess';
import { checkTripOrigin } from '../services/QuestionService';
import { nextGap, describeGap } from '../utils/taskRequirements';
import { hydrateCustomCategories } from '../constants/categories';
import { Task, AppLanguage, GapSuggestion, TaskLocation, UserProfile } from '../types';
import { wakeChipFor, wakeInputs } from '../utils/alarmPlan';
import { loadProfile } from '../services/UserProfileStorage';
import { toChainProfile } from '../utils/buildTravelChain';
import DayTaskCard from '../components/DayTaskCard';

const BIG_EVENT_RE = /interview|exam|test|ראיון|מבחן|בחינה/i;

const locOf = (t?: Task): TaskLocation | undefined =>
  t && t.location && typeof t.location === 'object' ? (t.location as TaskLocation) : undefined;
interface PlanTomorrowProps {
  navigation: any;
}

export default function PlanTomorrow({ navigation }: PlanTomorrowProps) {
  const insets = useSafeAreaInsets();
  const bgColor = BRAND.cream;
  const textColor = BRAND.warmInk;
  const subColor = BRAND.inkSoft;

  const [tomorrowTasks, setTomorrowTasks] = useState<Task[]>([]);
  const [suggestedTasks, setSuggestedTasks] = useState<Task[]>([]);
  const [gmailSuggestions, setGmailSuggestions] = useState<GapSuggestion[]>([]);
  const [week, setWeek] = useState<WeekDayPlan[]>([]);
  const [language, setLanguage] = useState<AppLanguage>('en');
  const [profile, setProfile] = useState<UserProfile | null>(null);

  useFocusEffect(
    useCallback(() => {
      loadPlanTomorrow();
    }, []),
  );

  const loadPlanTomorrow = async () => {
    try {
      const tomorrow = getTomorrowString();
      const today = getTodayString();
      const settings = await getSettings();
      setLanguage(settings.language);
      // The morning routine is what turns "06:30 call, no travel" into a wake
      // time. Without it this screen can only show a wake row for tasks that
      // already have a computed route.
      loadProfile().then((pr) => setProfile(toChainProfile(pr))).catch(() => {});
      // Import tomorrow's calendar events + gmail suggestions FIRST so the
      // scheduled list below already includes them. Best-effort.
      try {
        const { suggestions } = await planTomorrowFromGoogle(settings.language);
        setGmailSuggestions(suggestions);
      } catch (e) {
        console.log('[PlanTomorrow] google pull failed:', e);
      }
      let [tomorrowData, todayData] = await Promise.all([
        getTasksForDate(tomorrow),
        getTasksForDate(today),
        hydrateCustomCategories(),
      ]);
      // Pre-compute the travel legs between tomorrow's places (chained from
      // the previous appointment) so the timeline shows buses/routes ready.
      if (await ensureTravelChain(tomorrow, settings.language)) {
        tomorrowData = await getTasksForDate(tomorrow);
      }
      // She is looking at tomorrow's route, planned from HOME: if the phone says
      // she is elsewhere, this is the moment to ask where she will leave from
      // (kinds/tripOrigin). Never throws; a failure is warned about there.
      checkTripOrigin('plan-tomorrow').catch(() => {});
      tomorrowData = [...tomorrowData].sort((a, b) =>
        ((a.fixedTime || a.scheduledTime || '99') < (b.fixedTime || b.scheduledTime || '99') ? -1 : 1));
      setTomorrowTasks(tomorrowData);
      // Suggestions: today's unfinished tasks (candidates to carry over).
      const unfinished = todayData.filter((t) => t.status === 'pending' || t.status === 'partial');
      setSuggestedTasks(unfinished.slice(0, 5));
      // Week ahead: load counts + clashes for the next 7 days (local, no LLM).
      analyzeWeek(settings.language).then(setWeek).catch(() => {});
    } catch (error) {
      console.log('[PlanTomorrow] Error loading:', error);
    }
  };

  // Carry an unfinished task over to tomorrow.
  const moveToTomorrow = async (task: Task) => {
    await updateTaskFields(task.id, { date: getTomorrowString(), movedFromDate: task.date, status: 'pending' });
    await loadPlanTomorrow();
  };

  const acceptSuggestion = async (s: GapSuggestion) => {
    await acceptGmailSuggestion(s, language);
    await loadPlanTomorrow();
  };

  const dismissSuggestion = async (s: GapSuggestion) => {
    await dismissGmailSuggestion(s.id);
    setGmailSuggestions((prev) => prev.filter((x) => x.id !== s.id));
  };

  const he = language === 'he';
  // ⏰ tomorrow's wake time — the EARLIEST any task demands, asked of the
  // domain (utils/alarmPlan) so this screen, the cards and the phone alarm all
  // answer alike.
  //
  // This used to look only for a task whose LOCATION carried a wakeUpBy or a
  // leaveHomeBy, then subtract a hardcoded 45. Two failures, both of them the
  // reported one: a tomorrow with no travel at all (a 06:30 call) showed no
  // wake row whatsoever, and a routed one was woken by a placeholder routine
  // rather than her real one — so the banner and the alarm disagreed by
  // however far her routine differs from 45 minutes.
  const wakeInp = wakeInputs(profile);
  const wakeAt = tomorrowTasks
    .filter((t) => t.status !== 'complete')
    .map((t) => wakeChipFor(t, wakeInp)?.at)
    .filter((v): v is string => Boolean(v))
    .sort()[0];
  const bigEvent = tomorrowTasks.find((t) => BIG_EVENT_RE.test(t.text) && t.status !== 'complete');

  const sections = [
    {
      title: language === 'he' ? '🔒 כבר בתוכנית' : '🔒 Already Scheduled',
      data: tomorrowTasks,
    },
    {
      title: language === 'he' ? '💡 לומי מציעה' : '💡 Lumi Suggests',
      data: suggestedTasks,
    },
  ];

  /** Compact travel connector rendered between a task and the one before it. */
  const TravelConnector = ({ task }: { task: Task }) => {
    const tp = locOf(task)?.transitPlan;
    if (!tp) return null;
    const leg = tp.legs?.find((l) => l.type !== 'walk');
    const icon = leg?.type === 'train' ? '🚆' : leg?.type === 'subway' ? '🚇' : leg?.type === 'car' ? '🚗' : leg?.type === 'bike' ? '🚲' : '🚌';
    return (
      <TouchableOpacity
        style={styles.travelRow}
        activeOpacity={0.8}
        onPress={() => navigation.navigate('TaskDetail', { taskId: task.id })}
      >
        <Text style={[styles.travelText, { color: subColor }]}>
          {icon} {he ? 'יציאה' : 'Leave'} {tp.leaveHomeAt}
          {leg?.lineNumber ? ` · ${leg.lineNumber}` : ''} · {tp.totalDurationMinutes}
          {he ? " דק'" : 'm'} · {he ? 'מפה ←' : 'map →'}
        </Text>
      </TouchableOpacity>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: bgColor, paddingTop: insets.top }]}>
      <ScrollView style={styles.scrollView} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <Text style={[styles.headerTitle, { color: textColor }]}>
            {language === 'he' ? 'תכנון מחר' : 'Plan Tomorrow'}
          </Text>
          <Text style={[styles.headerSubtitle, { color: subColor }]}>{getTomorrowString()}</Text>
        </View>

        {/* ⏰ the morning starts here */}
        {wakeAt && (
          <View style={styles.wakeRow}>
            <Text style={styles.wakeText}>⏰ {he ? 'להתעורר עד' : 'Wake up by'} {wakeAt}</Text>
          </View>
        )}
        {/* Motivation for the big event */}
        {bigEvent && (
          <Text style={[styles.motivation, { color: textColor }]}>
            {he
              ? `יום גדול מחר — ${bigEvent.text} 💪 את/ה מוכן/ה לזה! 🚀`
              : `Big day tomorrow — ${bigEvent.text} 💪 You've got this! 🚀`}
          </Text>
        )}

        <SectionList
          scrollEnabled={false}
          sections={sections}
          keyExtractor={(item, index) => item.id + index}
          renderItem={({ item, section }) => (
            <View>
              {/* Travel leg INTO this task (chained from the previous place). */}
              {!section.title.includes('💡') && <TravelConnector task={item} />}
              <DayTaskCard
                task={item}
                onTap={() => {
                  // Suggested (unfinished-today) → carry to tomorrow; scheduled → detail.
                  if (section.title.includes('💡')) moveToTomorrow(item);
                  else navigation.navigate('TaskDetail', { taskId: item.id });
                }}
                // Tap is context-dependent here (a suggestion moves, a
                // scheduled task opens); holding always means "let me edit it".
                onHold={() => navigation.navigate('TaskDetail', { taskId: item.id })}
                showVerificationBadge={false}
                language={language}
                // What it still needs before it can be done. This screen
                // exists to get her ready for tomorrow, and "ready" was the
                // one thing it could not say: an interview with a route and
                // one without drew the same card. Suggestions are exempt —
                // they are not on the day yet, so nothing is owed for them.
                gapLabel={section.title.includes('💡')
                  ? undefined
                  : (() => {
                    const gap = nextGap(item, {
                      today: getTodayString(),
                      // The prep blocks live on the days BEFORE the
                      // interview, so tomorrow's list alone cannot tell
                      // whether study exists. Both lists together can.
                      existing: [...tomorrowTasks, ...suggestedTasks],
                    });
                    return gap ? describeGap(gap, language) : undefined;
                  })()}
              />
            </View>
          )}
          renderSectionHeader={({ section: { title, data } }) =>
            data.length > 0 ? (
              <Text style={[styles.sectionTitle, { color: textColor }]}>{title}</Text>
            ) : null
          }
          renderSectionFooter={({ section: { data, title } }) =>
            data.length === 0 ? (
              <Text style={[styles.emptyHint, { color: subColor }]}>
                {title}
                {'  —  '}
                {language === 'he' ? 'ריק' : 'nothing yet'}
              </Text>
            ) : null
          }
        />

        {!GMAIL_ENABLED ? (
          <Text style={[styles.suggestionReason, { color: subColor }]}>{gmailOffLine(language === 'he')}</Text>
        ) : null}
        {gmailSuggestions.length > 0 && (
          <View>
            <Text style={[styles.sectionTitle, { color: textColor }]}>
              {language === 'he' ? '📧 מהמייל שלך' : '📧 From your email'}
            </Text>
            {gmailSuggestions.map((s) => (
              <View key={s.id} style={styles.suggestionRow}>
                <View style={styles.suggestionInfo}>
                  <Text style={[styles.suggestionTitle, { color: textColor }]} numberOfLines={1}>
                    {s.taskToAdd.fixedTime ? `${s.taskToAdd.fixedTime} · ` : ''}{s.taskToAdd.text}
                  </Text>
                  <Text style={[styles.suggestionReason, { color: subColor }]} numberOfLines={1}>
                    {language === 'he' ? s.reasonHe : s.reason}
                  </Text>
                </View>
                <TouchableOpacity style={styles.suggestionBtn} onPress={() => acceptSuggestion(s)}>
                  <Text style={styles.suggestionBtnText}>✓</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.suggestionBtn, styles.suggestionBtnDim]} onPress={() => dismissSuggestion(s)}>
                  <Text style={styles.suggestionBtnText}>✕</Text>
                </TouchableOpacity>
              </View>
            ))}
          </View>
        )}

        {/* 📅 Week ahead — 7 days of load + clashes, straight from the calendar. */}
        {week.length > 0 && (
          <View>
            <Text style={[styles.sectionTitle, { color: textColor }]}>
              {he ? '📅 השבוע הקרוב' : '📅 Week ahead'}
            </Text>
            {week.map((d) => (
              <View key={d.date} style={styles.weekRow}>
                <Text style={[styles.weekDay, { color: textColor }]}>
                  {new Date(`${d.date}T12:00:00`).toLocaleDateString(he ? 'he-IL' : 'en-US', {
                    weekday: 'short', day: 'numeric', month: 'short',
                  })}
                </Text>
                <Text style={[styles.weekMeta, { color: subColor }]} numberOfLines={2}>
                  {d.taskCount
                    ? `${d.taskCount} ${he ? 'משימות' : 'tasks'}${d.leaveHomeBy ? ` · 🚪 ${d.leaveHomeBy}` : d.firstTaskTime ? ` · ${d.firstTaskTime}` : ''}`
                    : he ? 'פנוי' : 'free'}
                  {d.warnings.length ? `\n${d.warnings[0]}` : ''}
                </Text>
              </View>
            ))}
          </View>
        )}

        <TouchableOpacity
          style={styles.addMoreButton}
          onPress={() => navigation.getParent?.()?.navigate('AddTask') ?? navigation.navigate('AddTask')}
        >
          <Text style={styles.addMoreButtonText}>
            {language === 'he' ? '➕ הוסף משימות נוספות' : '➕ Add More Tasks'}
          </Text>
        </TouchableOpacity>

        <View style={{ height: 100 }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scrollView: { flex: 1 },
  header: { paddingHorizontal: 16, paddingVertical: 20 },
  headerTitle: { fontSize: 28, fontFamily: FONTS.bodyBold, marginBottom: 4 },
  headerSubtitle: { fontSize: 14, fontFamily: FONTS.bodySemi },
  sectionTitle: { fontSize: 16, fontFamily: FONTS.bodyBold, marginLeft: 16, marginTop: 16, marginBottom: 8 },
  emptyHint: { fontSize: 13, marginLeft: 16, marginTop: 12 },
  addMoreButton: {
    marginHorizontal: 16,
    marginVertical: 16,
    paddingVertical: 12,
    borderRadius: RADIUS.chip,
    borderWidth: 2,
    borderColor: BRAND.sunGold,
    alignItems: 'center',
  },
  addMoreButtonText: { fontSize: 14, fontFamily: FONTS.bodySemi, color: BRAND.sunGold },
  suggestionRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: 16, marginBottom: 8, padding: 10,
    backgroundColor: BRAND.creamCard, borderRadius: RADIUS.chip,
    borderWidth: 1, borderColor: BRAND.line,
  },
  suggestionInfo: { flex: 1 },
  suggestionTitle: { fontSize: 14, fontFamily: FONTS.bodySemi },
  suggestionReason: { fontSize: 12, fontFamily: FONTS.body },
  suggestionBtn: {
    width: 32, height: 32, borderRadius: RADIUS.chip,
    backgroundColor: BRAND.sunGold, alignItems: 'center', justifyContent: 'center',
  },
  suggestionBtnDim: { backgroundColor: BRAND.line },
  suggestionBtnText: { fontSize: 14, color: 'white', fontFamily: FONTS.bodyBold },
  wakeRow: {
    marginHorizontal: 16, marginBottom: 8, paddingVertical: 10, paddingHorizontal: 14,
    backgroundColor: BRAND.honey, borderRadius: RADIUS.chip, borderWidth: 1, borderColor: BRAND.sunGold,
  },
  wakeText: { fontSize: 15, fontFamily: FONTS.bodyBold, color: BRAND.warmInk },
  motivation: { fontSize: 13, fontFamily: FONTS.bodySemi, marginHorizontal: 16, marginBottom: 8 },
  weekRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    marginHorizontal: 16, marginBottom: 6, paddingVertical: 8, paddingHorizontal: 10,
    backgroundColor: BRAND.creamCard, borderRadius: RADIUS.chip,
    borderWidth: 1, borderColor: BRAND.line,
  },
  weekDay: { width: 92, fontSize: 13, fontFamily: FONTS.bodySemi },
  weekMeta: { flex: 1, fontSize: 12, fontFamily: FONTS.body },
  travelRow: { marginLeft: 68, marginBottom: 2 },
  travelText: { fontSize: 12, fontFamily: FONTS.bodySemi },
});
