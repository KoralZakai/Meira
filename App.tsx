/**
 * App — root component: navigation container, theme, notification
 * initialization (initNotifications + tap subscription), deep-link handling
 * (lumi://personality), and session bootstrap.
 * Dependencies: NotificationService, screens/*, SupabaseAuthService session.
 */
// FIRST IMPORT, deliberately: it installs the release log gate as a side
// effect, and imports are hoisted, so this is the only position that actually
// runs before the rest of the graph. In a release build it silences the
// narration and redacts phone numbers, emails, tokens and GPS fixes out of
// whatever warn/error still carry.
import './src/bootstrapLogging';
import './src/utils/perf';  // APP_T0 — first, so "+app" timings start at bundle load

import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, AppState, View } from 'react-native';
import AsyncStorage from './src/services/EncryptedStorage';  // AES-256-GCM at rest (7.10)
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { Session } from '@supabase/supabase-js';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { SkyStatusBar } from './src/components/ui/SkyBackdrop';
import MainTabs from './src/navigation/MainTabs';
import SettingsMenu from './src/screens/SettingsMenu';
import AgentsScreen from './src/screens/AgentsScreen';
import HomeScreen from './src/screens/HomeScreen';
import CheckInScreen from './src/screens/CheckInScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import OnboardingScreen, { FIRST_MEETING_SNOOZE_KEY } from './src/screens/OnboardingScreen';
import ProfileEditScreen from './src/screens/ProfileEditScreen';
import GoalsScreen from './src/screens/GoalsScreen';
import StatsScreen from './src/screens/StatsScreen';
import AddTaskScreen from './src/screens/AddTaskScreen';
import TaskDetailScreen from './src/screens/TaskDetailScreen';
import CoachChatScreen from './src/screens/CoachChatScreen';
import { onShare, takeShared } from './modules/share-in';
import PersonalityHandoffScreen from './src/screens/PersonalityHandoffScreen';
import PersonalityQuizScreen from './src/screens/PersonalityQuizScreen';
import PlanTomorrow from './src/screens/PlanTomorrow';
import LeaveNowScreen from './src/screens/LeaveNowScreen';
import FocusNowScreen from './src/screens/FocusNowScreen';
import DayReviewScreen from './src/screens/DayReviewScreen';
import Analytics from './src/screens/Analytics';
import FindTimeScreen from './src/screens/FindTimeScreen';
import { RootStackParamList } from './src/types/navigation';
import { CheckInType } from './src/types/models';
import {
  initNotifications,
  removeDuplicateTaskNotifications,
  rescheduleDailyNotifications,
  rehydrateTaskAlerts,
  subscribeNotificationTap,
} from './src/services/NotificationService';
import { rehydrateReminders } from './src/services/ReminderService';
import { runStoreMigration } from './src/services/StoreMigration';
import { armDueAlarms, syncWakeAlarms } from './src/services/AlarmPlanner';
import { onTasksWritten } from './src/services/TaskStorage';
import {
  getSettings, saveSettings, saveSettingsChecked, getTasksForDate, getAllTasks, healTaskStore,
  invalidateTaskCache, pushLocalTasksToCloud, updateTaskFields,
} from './src/services/TaskStorage';
import { answerRunningLate } from './src/services/RunningLate';
import { getTodayString } from './src/utils/timeUtils';
import { loadProfile } from './src/services/UserProfileStorage';
import { Task } from './src/types';
import { registerPush } from './src/services/PushService';
import { startCalendarAutoSync } from './src/services/CalendarAutoSync';
import MeiraAskHost from './src/components/MeiraAskHost';
import FocusLectureHost from './src/components/FocusLectureHost';
import * as Questions from './src/services/QuestionService';
import { installRouteGateway } from './src/services/RouteGateway';
import {
  speakMorningBriefingNow,
  maybeSpeakWakeBriefing,
  maybeSpeakDailyMorningBriefing,
} from './src/services/MorningBriefingService';
import { LumiProvider } from './src/hooks/useLumiContext';
import { isSupabaseConfigured } from './src/services/supabaseClient';
import { getSession, onAuthChange } from './src/services/SupabaseAuthService';
import { warmServer } from './src/services/LumiServer';
import SignInScreen from './src/screens/SignInScreen';
import CrashCatcher from './src/components/CrashCatcher';
import { COLORS, BRAND } from './src/constants/theme';
// One family, five weights — see constants/theme FONTS for why Fredoka,
// Nunito and Fraunces all left at once. Three payloads became one.
import {
  useFonts,
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  Inter_800ExtraBold,
} from '@expo-google-fonts/inter';

const Stack = createNativeStackNavigator<RootStackParamList>();
const navRef = createNavigationContainerRef<RootStackParamList>();

// Evening nudge: once per day, from the evening check-in hour on, ask to plan
// tomorrow (routes to the PlanTomorrow screen).
const EVENING_ASK_KEY = 'lumi.eveningAskDate.v1';

async function maybeAskPlanTomorrow(): Promise<void> {
  try {
    const settings = await getSettings();
    if (new Date().getHours() < (settings.eveningTime?.hour ?? 20)) return;
    const today = new Date().toISOString().slice(0, 10);
    if ((await AsyncStorage.getItem(EVENING_ASK_KEY)) === today) return;
    await AsyncStorage.setItem(EVENING_ASK_KEY, today);
    const he = settings.language === 'he';
    Alert.alert(
      he ? '🌙 לתכנן את מחר?' : '🌙 Plan tomorrow?',
      he ? 'בואו נסדר את היום של מחר.' : "Let's line up tomorrow's day.",
      [
        { text: he ? 'לא עכשיו' : 'Not now', style: 'cancel' },
        { text: he ? 'כן!' : "Let's go", onPress: () => { if (navRef.isReady()) navRef.navigate('PlanTomorrow'); } },
      ],
    );
  } catch { /* best-effort */ }
}

// One entry point for the app-open voice/nudge moments (launch + foreground):
// wake-alarm speak wins; else the daily morning greeting; evenings ask to plan.
async function runDailyMoments(): Promise<void> {
  const spokeWake = await maybeSpeakWakeBriefing().catch(() => false);
  if (!spokeWake) await maybeSpeakDailyMorningBriefing().catch(() => {});
  await maybeAskPlanTomorrow();
  // THE DAY BEFORE is when tomorrow's alarm becomes settable: Android's
  // ACTION_SET_ALARM has no date, so it can only be armed once the ring time is
  // inside 24 h. Nothing used to come back and do that except a cold start, so
  // an interview planned two days out could reach its morning with the alarm
  // still sitting in 'planned'. Every app-open moment now sweeps — launch,
  // foreground, and the evening plan-tomorrow nudge, which is exactly the hour
  // tomorrow morning's alarm comes into reach.
  await armTomorrowAlarms().catch(() => {});
}

/** Arm every planned alarm for today and tomorrow whose hour is now reachable. */
async function armTomorrowAlarms(): Promise<void> {
  const today = getTodayString();
  const soon = new Date();
  soon.setDate(soon.getDate() + 2);
  const soonKey = `${soon.getFullYear()}-${String(soon.getMonth() + 1).padStart(2, '0')}-${String(soon.getDate()).padStart(2, '0')}`;
  const upcoming = (await getAllTasks()).filter((t) => t.date >= today && t.date <= soonKey);
  await armDueAlarms(upcoming);
  // …and the morning's owner, which a task saved elsewhere (WhatsApp, the
  // server, another device) reached with no state at all — no write on this
  // phone, so the save hook never saw it (rule 7: app open is a trigger).
  await syncWakeAlarms().catch((e) => console.warn('[App] wake alarm sweep failed', e));
}

// Routes are asked for through the SERVER, whose Maps key is unrestricted.
// The key inside the APK is restricted to meira.secretary + SHA-1, which Google
// enforces through headers only the Maps SDK sends — so every Directions call
// made directly from the phone was REQUEST_DENIED (107 of them in one day).
// At module scope on purpose: a headless background sync never mounts a
// component, and a hook would install this too late for it.
installRouteGateway();

function LumiAppShell() {
  // Focused route name — the floating Lumi hides where a bigger Lumi lives.
  const [routeName, setRouteName] = useState<string | undefined>(undefined);

  // Any save — chat, mic, (+), a calendar import — re-checks the morning alarm
  // and sets it in Clock now (AlarmPlanner.syncWakeAlarms). Debounced: one save
  // is several writes, and a calendar import is dozens.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = onTasksWritten(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        syncWakeAlarms().catch((e) => console.warn('[App] wake alarm after a save failed', e));
      }, 1500);
    });
    return () => { off(); if (timer) clearTimeout(timer); };
  }, []);

  useEffect(() => {
    let mounted = true;

    const setup = async () => {
      await initNotifications();
      await removeDuplicateTaskNotifications();
      // Heal the stored task list once, here, under the lock — this is the
      // write getAllTasks used to do on every read.
      await healTaskStore().catch(() => {});
      // One-time repair of damage done while the write race and the
      // duplicate-alert bug were live. No-ops after the first run.
      const migration = await runStoreMigration().catch(() => null);
      if (migration?.ran && (migration.duplicatesMerged || migration.staleArchived
        || migration.orphanAlertsCancelled)) {
        // Say what happened. Tasks quietly disappearing is exactly the thing
        // that makes someone stop trusting the list.
        const he = (await getSettings()).language === 'he';
        Alert.alert(
          he ? '🧹 ניקיתי את הרשימה' : '🧹 Cleaned up your list',
          [
            migration.duplicatesMerged
              ? (he ? `${migration.duplicatesMerged} כפילויות אוחדו` : `${migration.duplicatesMerged} duplicates merged`)
              : '',
            migration.staleArchived
              ? (he ? `${migration.staleArchived} משימות ישנות לארכיון` : `${migration.staleArchived} old tasks archived`)
              : '',
            migration.orphanAlertsCancelled
              ? (he ? `${migration.orphanAlertsCancelled} התראות יתומות בוטלו` : `${migration.orphanAlertsCancelled} orphaned alerts cancelled`)
              : '',
            '',
            he ? `נשארו ${migration.tasksAfter} משימות. שום דבר לא נמחק.`
               : `${migration.tasksAfter} tasks left. Nothing was deleted.`,
          ].filter(Boolean).join('\n'),
        );
      }
      const settings = await getSettings();
      // Make sure the cloud app_settings row EXISTS. saveSettings only ran when
      // the user happened to edit their profile, so the row was never created —
      // and the WhatsApp server resolves a phone to an account by looking up
      // app_settings."whatsAppPhone". No row meant every WhatsApp task queued
      // into pending_mirror.json forever. Idempotent upsert, cheap.
      // saveSettingsChecked RETURNS its failure rather than throwing, so the
      // old `.catch()` here could never fire — the upsert could fail on every
      // launch and say nothing at all. Report the reason.
      saveSettingsChecked(settings)
        .then((r) => {
          if (!r.cloudSynced) console.warn('[App] settings mirror did NOT reach the cloud:', r.reason);
          else console.warn('[App] settings mirror ok');
        })
        .catch((e) => console.warn('[App] settings mirror threw:', e?.message || e));
      await rescheduleDailyNotifications(settings);
      // Scheduled alerts don't survive a reinstall, an OS upgrade, or a
      // force-stop — re-arm the next week's worth so a task saved days ago
      // still rings. Idempotent, and best-effort: never block startup.
      try {
        const horizon = new Date();
        horizon.setDate(horizon.getDate() + 7);
        const today = getTodayString();
        const upcoming = (await getAllTasks()).filter(
          (t) => t.date >= today && t.date <= horizon.toISOString().slice(0, 10),
        );
        // PERSIST what rehydrate returns. Its own docstring says the caller
        // must ("ids are useless if they only ever live in memory") and this
        // call discarded them — so the next launch could not cancel what this
        // one scheduled and simply scheduled a second copy. After N launches
        // every alert fired N times. One write, not N.
        //
        // Only the ONE field rehydrate produces, merged into the LOCAL row.
        // This used to be `saveAllTasks(getAllTasks()…)` — a cloud-merged read
        // written back over local storage on every launch that re-armed
        // anything, plus a full cloud sync. That is the shape that brought
        // unticked tasks back (TodaySchedule fixed its copy the same way).
        const touched = await rehydrateTaskAlerts(upcoming, settings.language);
        for (const t of touched) {
          await updateTaskFields(t.id, { notificationIds: t.notificationIds })
            .catch((e) => console.warn('[App] could not save re-armed alert ids', t.id, e));
        }
        await rehydrateReminders();
        // Alarms planned for a far-future task can only be SET once they are
        // within Android's 24 h reach. This is the sweep that does it — without
        // it an interview booked twelve days out would never ring.
        await armDueAlarms(upcoming);
      } catch (e) {
        console.log('[App] alert rehydrate skipped:', e);
      }
      // If the user linked their WhatsApp number, keep the push token fresh on the server.
      if (settings.whatsAppPhone) {
        registerPush(settings.whatsAppPhone).catch(() => {});
      }

      // Google Calendar, from here on, keeps itself up to date.
      //
      // It used to be pulled by ONE thing: TodaySchedule coming into focus,
      // once per half hour. An event booked while the app was shut therefore
      // reached Lumi whenever she next happened to open that one tab — and
      // since the route, the leave time and the wake alarm are all built from
      // the import, none of them existed until then either. Owned by the root
      // now, not by a screen: which tab she is on must not decide whether her
      // calendar is read. Foreground on every return, plus a background job
      // while the app is closed.
      startCalendarAutoSync(settings.language);
      // Meira's questions: an answer that could not reach the server is sent
      // now, and her rules are fetched (QuestionService, trigger 2).
      Questions.onAppActive().catch((e) => console.warn('[App] questions start failed', e));
    };

    setup();

    // "Share → Meira" (27.10): a Clalit SMS shared from the SMS app opens the
    // chat, which reads it on the phone. Triggers: the share that launched the
    // app (cold start), coming back to the app, and a share while it is open.
    // The same text twice within a minute is one share (a launch intent can be
    // read again on resume).
    let lastShare = { text: '', at: 0 };
    const openShared = (text: string) => {
      if (text === lastShare.text && Date.now() - lastShare.at < 60_000) return;
      lastShare = { text, at: Date.now() };
      const go = (tries: number) => {
        if (navRef.isReady()) navRef.navigate('CoachChat', { shared: { id: String(Date.now()), text } });
        else if (tries > 0) setTimeout(() => go(tries - 1), 300);
        else console.warn('[App] a shared message arrived before navigation was ready');
      };
      go(20);
    };
    const pullShare = () => {
      const r = takeShared();
      if (r.ok && r.text) openShared(r.text);
    };
    pullShare();
    const offShare = onShare(openShared);

    // App-open moments: wake-alarm / first-of-the-morning briefing spoken
    // aloud (day, date, hour, today's tasks), evening plan-tomorrow nudge.
    runDailyMoments().catch(() => {});
    // Wake the sleeping server now, while she looks at the day — not on her
    // first mic turn (LumiServer.warmServer). Fire-and-forget.
    warmServer('launch');
    const appStateSub = AppState.addEventListener('change', (s) => {
      if (s !== 'active') return;
      warmServer('foreground');
      pullShare();
      runDailyMoments().catch(() => {});
      // …and sweep the alarms again. armDueAlarms only ever ran at COLD START,
      // so a phone that stays open all day never re-checked: an alarm planned
      // for tomorrow morning came into Android's 24 h reach hours later, with
      // nothing scheduled to notice. Coming back to the app is exactly when to
      // look. Idempotent — only 'planned' tasks are touched.
      armTomorrowAlarms().catch(() => {});
      // A new "open" for the one-question-per-open limit; the outbox; her rules.
      Questions.onAppActive().catch((e) => console.warn('[App] questions resume failed', e));
    });

    const sub = subscribeNotificationTap(
      (checkInType?: CheckInType) => {
        if (!mounted || !checkInType || !navRef.isReady()) {
          return;
        }

        // Afternoon/evening ask "what did you get done?" — that is a list to
        // tick, not a conversation to have. CheckInScreen's review flow makes
        // you describe your day in words and then matches the words back to
        // tasks; DayReview just shows the tasks. Morning stays on CheckIn,
        // which is genuinely about planning.
        if (checkInType === 'afternoon' || checkInType === 'evening') {
          navRef.navigate('DayReview');
          return;
        }

        navRef.navigate('CheckIn', {
          type: checkInType,
          mandatory: checkInType === 'morning',
        });

        // Wake-up call: read the motivational greeting + today's tasks aloud.
        if (checkInType === 'morning') {
          speakMorningBriefingNow().catch(() => {});
        }
      },
      // Evening notification's "Plan tomorrow" action.
      () => {
        if (mounted && navRef.isReady()) navRef.navigate('PlanTomorrow');
      },
      // Task-scoped notifications carry the screen they want (alertPlan
      // ALERT_SCREEN): leave-time alerts open the LeaveNow focus screen with
      // the countdown + route, everything else opens the task detail.
      (taskId: string, screen?: string, intent?: 'cancel' | 'reschedule' | 'open') => {
        if (!mounted || !navRef.isReady()) return;
        // "You're late — reschedule? cancel?" (13.10): answered on the spot.
        if (intent) {
          getSettings()
            .then((st) => answerRunningLate(taskId, intent, st.language === 'he'))
            .catch((e) => console.warn('[App] running-late answer failed', e));
          return;
        }
        if (screen === 'FindTime') {
          navRef.navigate('FindTime', taskId ? { groupId: taskId } : undefined);
          return;
        }
        if (screen === 'LeaveNow') {
          getTasksForDate(getTodayString())
            .then((ts: Task[]) => {
              const task = ts.find((t) => t.id === taskId);
              // Fall back to the detail screen when the task is gone/rolled over.
              if (task) navRef.navigate('LeaveNow', { task });
              else navRef.navigate('TaskDetail', { taskId });
            })
            .catch(() => navRef.navigate('TaskDetail', { taskId }));
          return;
        }
        navRef.navigate('TaskDetail', { taskId });
      },
    );

    return () => {
      mounted = false;
      sub.remove();
      appStateSub.remove();
      offShare();
    };
  }, []);

  return (
    <NavigationContainer
      ref={navRef}
      linking={{
        prefixes: ['lumi://'],
        // Only PersonalityHandoff was reachable by link, which meant the
        // schedule could be opened exactly one way: by BUILDING one. That is
        // fine as a user action and useless as a way to look at the screen —
        // inspecting it changed the day it was showing.
        //
        // lumi://schedule still resolves; it lands on the Today TAB, which IS
        // the timeline now that the separate Schedule screen was folded in.
        config: {
          screens: {
            PersonalityHandoff: 'personality',
            Onboarding: 'meet',
            MainTabs: { screens: { Today: 'schedule' } },
          },
        } as any,
      }}
      onStateChange={() => setRouteName(navRef.getCurrentRoute()?.name)}
      onReady={() => {
        setRouteName(navRef.getCurrentRoute()?.name);
        openFirstMeetingIfNeeded().catch((e) => console.warn('[App] first meeting check failed', e));
      }}
    >
      <SkyStatusBar />
      <Stack.Navigator initialRouteName="MainTabs">
        <Stack.Screen name="MainTabs" component={MainTabs} options={{ headerShown: false }} />
        <Stack.Screen name="SettingsMenu" component={SettingsMenu} options={{ headerShown: false, presentation: 'modal' }} />
        <Stack.Screen name="Agents" component={AgentsScreen} options={{ headerShown: false }} />
        <Stack.Screen name="Onboarding" component={OnboardingScreen} options={{ headerShown: false }} />
        <Stack.Screen name="ProfileEdit" component={ProfileEditScreen} options={{ headerShown: false }} />
        <Stack.Screen name="Home" component={HomeScreen} options={{ headerShown: false }} />
        <Stack.Screen name="Goals" component={GoalsScreen} options={{ headerShown: false }} />
        <Stack.Screen name="Stats" component={StatsScreen} options={{ headerShown: false }} />
        <Stack.Screen name="AddTask" component={AddTaskScreen} options={{ headerShown: false }} />
        <Stack.Screen name="TaskDetail" component={TaskDetailScreen} options={{ headerShown: false }} />
        <Stack.Screen
          name="CheckIn"
          component={CheckInScreen}
          options={({ route }) => ({
            headerShown: !route.params?.mandatory,
            gestureEnabled: !route.params?.mandatory,
            headerBackVisible: !route.params?.mandatory,
            title: 'Lumi Check-in',
          })}
        />
        <Stack.Screen name="Settings" component={SettingsScreen} options={{ headerShown: false }} />
        <Stack.Screen name="CoachChat" component={CoachChatScreen} options={{ headerShown: false, presentation: 'modal' }} />
        <Stack.Screen name="PersonalityHandoff" component={PersonalityHandoffScreen} options={{ headerShown: false }} />
        <Stack.Screen name="PersonalityQuiz" component={PersonalityQuizScreen} options={{ headerShown: false, presentation: 'modal' }} />
        <Stack.Screen name="PlanTomorrow" component={PlanTomorrow} options={{ headerShown: false, presentation: 'modal' }} />
        {/* Opened by the leave-home notification — one task, countdown, route. */}
        <Stack.Screen name="LeaveNow" component={LeaveNowScreen} options={{ headerShown: false, presentation: 'fullScreenModal' }} />
        <Stack.Screen name="FocusNow" component={FocusNowScreen} options={{ headerShown: false, presentation: 'fullScreenModal' }} />
        <Stack.Screen name="DayReview" component={DayReviewScreen} options={{ headerShown: false, presentation: 'modal' }} />
        <Stack.Screen name="Analytics" component={Analytics} options={{ headerShown: false, presentation: 'modal' }} />
        <Stack.Screen name="FindTime" component={FindTimeScreen} options={{ headerShown: false }} />
      </Stack.Navigator>
      {/* Meira's questions — over whichever screen she is on (QuestionService decides when). */}
      <MeiraAskHost />
      {/* Learning sessions (17.10): the lecture when a block was bypassed, and the root trigger that
          reconciles the blocker and schedules study sessions on every return to the app. */}
      <FocusLectureHost />
      {/* Floating Lumi companion — every screen except where a bigger Lumi lives. */}
    </NavigationContainer>
  );
}

/**
 * Push what is already on this phone up to the cloud, right after signing in.
 *
 * Every cloud write is gated on a user id, so everything created while signed
 * out lives only in AsyncStorage. Signing in does not retroactively upload it,
 * and the one bootstrap upsert runs at launch — before any sign-in. The result
 * was a phone that had signed in successfully and still showed 0 rows in
 * app_settings and 0 in tasks, which in turn left the WhatsApp number
 * unresolvable and its tasks queued in pending_mirror.
 *
 * Settings first: the server resolves a phone through app_settings."whatsAppPhone",
 * so that row is what unblocks the WhatsApp backlog.
 */
/**
 * Meira's first meeting opens by itself (8.10, Koral: "when the user sets up
 * Meira for the first time, Meira says hi and asks…"). It existed only behind
 * Profile → "start over" — a capability with no trigger (rule 7). Opens once
 * the app is signed in and the navigator is ready, unless she finished it,
 * already has a home and a morning saved (a returning user), or said ⏭ later
 * today.
 */
async function openFirstMeetingIfNeeded(): Promise<void> {
  const p = await loadProfile().catch(() => null);
  if (p?.onboardingComplete || (p?.homeAddress && p?.totalMorningRoutineMinutes)) return;
  const snoozed = await AsyncStorage.getItem(FIRST_MEETING_SNOOZE_KEY).catch(() => null);
  if (snoozed === getTodayString()) return;
  if (navRef.isReady() && navRef.getCurrentRoute()?.name !== 'Onboarding') navRef.navigate('Onboarding');
}

// Which account this phone last pushed its tasks for. The backfill is for the
// moment someone SIGNS IN — not for every launch: Supabase reports a restored
// session as SIGNED_IN too (auth-js _recoverAndRefresh), and INITIAL_SESSION /
// TOKEN_REFRESHED arrive on every start and every hour. It used to run on all
// of them, so every launch downloaded and re-uploaded every task (245 rows,
// 19.10). Cleared on sign-out, so signing back in pushes again.
const BACKFILLED_FOR_KEY = 'lumi.cloudBackfilledFor.v1';

async function backfillOnSignIn(userId: string): Promise<void> {
  const done = await AsyncStorage.getItem(BACKFILLED_FOR_KEY).catch(() => null);
  if (done === userId) return;   // this phone already pushed for this account
  if (await backfillCloudAfterSignIn()) {
    await AsyncStorage.setItem(BACKFILLED_FOR_KEY, userId)
      .catch((e) => console.warn('[App] could not record the sign-in backfill', e));
  }
}

/** True when the settings reached the cloud and the tasks were pushed. */
async function backfillCloudAfterSignIn(): Promise<boolean> {
  try {
    const settings = await getSettings();
    const res = await saveSettingsChecked(settings);
    console.warn(
      res.cloudSynced
        ? '[App] post-sign-in: settings reached the cloud'
        : `[App] post-sign-in: settings did NOT reach the cloud — ${res.reason}`,
    );
    // What only this phone has — never the cloud's copy written back over it.
    const { pushed, local } = await pushLocalTasksToCloud();
    console.warn(`[App] post-sign-in: pushed ${pushed} of ${local} task(s) the cloud lacked`);
    return res.cloudSynced;
  } catch (err: any) {
    console.warn('[App] post-sign-in backfill failed:', err?.message || err);
    return false;
  }
}

// Auth gate: decides between the sign-in screen and the main app.
// - session === undefined  -> still checking (splash)
// - no session & not offline & Supabase configured -> SignInScreen
// - otherwise -> main app (cloud mode if signed in, local cache if offline)
function AuthGate() {
  const [session, setSession] = useState<Session | null | undefined>(
    isSupabaseConfigured ? undefined : null,
  );
  const [offline, setOffline] = useState(!isSupabaseConfigured);

  useEffect(() => {
    if (!isSupabaseConfigured) {
      return;
    }
    let mounted = true;
    getSession().then((s) => {
      if (mounted) setSession(s);
    });
    const unsub = onAuthChange((s, event) => {
      if (mounted) setSession(s);
      // Another account (or none): the shared task read must not outlive it.
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') invalidateTaskCache();
      if (event === 'SIGNED_OUT') {
        AsyncStorage.removeItem(BACKFILLED_FOR_KEY)
          .catch((e) => console.warn('[App] could not clear the sign-in backfill mark', e));
      }
      // Signing in has to PUSH what is already on the phone. Until now the only
      // cloud write happened during bootstrap — i.e. BEFORE sign-in — so a user
      // who signed in mid-session stayed invisible to the cloud until some
      // unrelated edit happened to trigger a write. That is why /diag/sync kept
      // reporting 0 rows immediately after a sign-in that had plainly worked.
      if (s && event === 'SIGNED_IN' && s.user?.id) {
        backfillOnSignIn(s.user.id).catch((e) => console.warn('[App] sign-in backfill failed', e));
      }
    });
    return () => {
      mounted = false;
      unsub();
    };
  }, []);

  if (session === undefined) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.lightBg }}>
        <ActivityIndicator color={COLORS.purple} size="large" />
      </View>
    );
  }

  if (!session && !offline) {
    return <SignInScreen onContinueOffline={() => setOffline(true)} />;
  }

  return <LumiAppShell />;
}

export default function App() {
  const [fontsLoaded] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    Inter_800ExtraBold,
  });

  if (!fontsLoaded) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: BRAND.cream }}>
        <ActivityIndicator color={BRAND.sunGold} size="large" />
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        {/* Outermost, so a render error in ANY screen shows what broke and
            offers a way back instead of taking the whole app down silently. */}
        <CrashCatcher>
          <LumiProvider>
            <AuthGate />
          </LumiProvider>
        </CrashCatcher>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
