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

import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, AppState, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { Session } from '@supabase/supabase-js';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import MainTabs from './src/navigation/MainTabs';
import SettingsMenu from './src/screens/SettingsMenu';
import AgentsScreen from './src/screens/AgentsScreen';
import HomeScreen from './src/screens/HomeScreen';
import CheckInScreen from './src/screens/CheckInScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import OnboardingScreen from './src/screens/OnboardingScreen';
import ProfileEditScreen from './src/screens/ProfileEditScreen';
import GoalsScreen from './src/screens/GoalsScreen';
import StatsScreen from './src/screens/StatsScreen';
import AddTaskScreen from './src/screens/AddTaskScreen';
import TaskDetailScreen from './src/screens/TaskDetailScreen';
import CoachChatScreen from './src/screens/CoachChatScreen';
import PersonalityHandoffScreen from './src/screens/PersonalityHandoffScreen';
import PersonalityQuizScreen from './src/screens/PersonalityQuizScreen';
import PlanTomorrow from './src/screens/PlanTomorrow';
import LeaveNowScreen from './src/screens/LeaveNowScreen';
import FocusNowScreen from './src/screens/FocusNowScreen';
import DayReviewScreen from './src/screens/DayReviewScreen';
import Analytics from './src/screens/Analytics';
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
import { armDueAlarms } from './src/services/AlarmPlanner';
import {
  getSettings, saveSettings, saveSettingsChecked, getTasksForDate, getAllTasks, saveAllTasks, healTaskStore,
} from './src/services/TaskStorage';
import { getTodayString } from './src/utils/timeUtils';
import { Task } from './src/types';
import { registerPush } from './src/services/PushService';
import {
  speakMorningBriefingNow,
  maybeSpeakWakeBriefing,
  maybeSpeakDailyMorningBriefing,
} from './src/services/MorningBriefingService';
import { LumiProvider } from './src/hooks/useLumiContext';
import { isSupabaseConfigured } from './src/services/supabaseClient';
import { getSession, onAuthChange } from './src/services/SupabaseAuthService';
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
}

function LumiAppShell() {
  // Focused route name — the floating Lumi hides where a bigger Lumi lives.
  const [routeName, setRouteName] = useState<string | undefined>(undefined);

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
        const touched = await rehydrateTaskAlerts(upcoming, settings.language);
        if (touched.length) {
          const byId = new Map(touched.map((t: Task) => [t.id, t]));
          const all = await getAllTasks();
          await saveAllTasks(all.map((t: Task) => byId.get(t.id) ?? t));
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
    };

    setup();

    // App-open moments: wake-alarm / first-of-the-morning briefing spoken
    // aloud (day, date, hour, today's tasks), evening plan-tomorrow nudge.
    runDailyMoments().catch(() => {});
    const appStateSub = AppState.addEventListener('change', (s) => {
      if (s !== 'active') return;
      runDailyMoments().catch(() => {});
      // …and sweep the alarms again. armDueAlarms only ever ran at COLD START,
      // so a phone that stays open all day never re-checked: an alarm planned
      // for tomorrow morning came into Android's 24 h reach hours later, with
      // nothing scheduled to notice. Coming back to the app is exactly when to
      // look. Idempotent — only 'planned' tasks are touched.
      armTomorrowAlarms().catch(() => {});
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
      (taskId: string, screen?: string) => {
        if (!mounted || !navRef.isReady()) return;
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
            MainTabs: { screens: { Today: 'schedule' } },
          },
        } as any,
      }}
      onStateChange={() => setRouteName(navRef.getCurrentRoute()?.name)}
      onReady={() => setRouteName(navRef.getCurrentRoute()?.name)}
    >
      <StatusBar style="dark" />
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
      </Stack.Navigator>
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
async function backfillCloudAfterSignIn(): Promise<void> {
  try {
    const settings = await getSettings();
    const res = await saveSettingsChecked(settings);
    console.warn(
      res.cloudSynced
        ? '[App] post-sign-in: settings reached the cloud'
        : `[App] post-sign-in: settings did NOT reach the cloud — ${res.reason}`,
    );
    const tasks = await getAllTasks();
    await saveAllTasks(tasks);
    console.warn(`[App] post-sign-in: pushed ${tasks.length} task(s)`);
  } catch (err: any) {
    console.warn('[App] post-sign-in backfill failed:', err?.message || err);
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
    const unsub = onAuthChange((s) => {
      if (mounted) setSession(s);
      // Signing in has to PUSH what is already on the phone. Until now the only
      // cloud write happened during bootstrap — i.e. BEFORE sign-in — so a user
      // who signed in mid-session stayed invisible to the cloud until some
      // unrelated edit happened to trigger a write. That is why /diag/sync kept
      // reporting 0 rows immediately after a sign-in that had plainly worked.
      if (s) backfillCloudAfterSignIn();
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
