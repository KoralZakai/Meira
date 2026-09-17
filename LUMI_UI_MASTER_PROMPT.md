# LUMI — UI/UX COMPLETE MASTER PROMPT
# העבר לקלוד קוד ב-VS Code. הוא יקרא את הקוד הקיים ויעדכן רק מה שצריך.
# PASTE THIS ENTIRE FILE INTO CLAUDE CODE IN VS CODE

---

## BEFORE YOU WRITE ANY CODE — READ FIRST

1. List every file in this project
2. Read: package.json, app.json, src/navigation/ (if exists)
3. Read every file in: src/screens/, src/components/, src/services/
4. Identify what exists, what is broken, what is missing
5. Then proceed section by section below
6. DO NOT overwrite existing working code — upgrade it
7. DO NOT delete anything — only add/modify

---

## DESIGN DECISIONS (LOCKED IN)

### Navigation Structure
```
RootNavigator (Stack)
├─ MainTabs (Custom Bottom Tab Bar with Dock FAB)
│  ├─ MyDayStack
│  │  └─ TodaySchedule (home screen)
│  ├─ PlanTomorrowStack
│  │  └─ PlanTomorrow (planning screen)
│  ├─ AnalyticsStack
│  │  └─ Analytics
│  └─ WakeCalculatorStack
│     └─ WakeCalculator
│
├─ ModalStack (Non-blocking modals)
│  ├─ TaskDetailModal
│  ├─ VerificationModal
│  ├─ AddTaskSheet (bottom sheet)
│  ├─ EditTimeModal
│  └─ EveningCheckInModal (17:00-20:00)
│
├─ MenuStack (Hamburger overlay)
│  └─ SettingsMenu
│     ├─ ProfileSetup
│     └─ Integrations
```

### Tab Bar (Bottom Dock Style)
```
Icon Size: 48px
Label Font: 12px (below icon)
Active Color: #6C63FF (purple)
Inactive Color: #8A8A9A
FAB Position: Center-top of dock (sticky above)
FAB Icon Size: 56px (dynamic, rotates)
```

### Animations
- Subtle: card slides out, checkmark animates
- No confetti (quiet, professional)
- Completion: checkmark badge appears in corner

### Dark Mode
- System follow (respects user's phone settings)
- Use theme colors from constants/theme.ts

### Task Interaction
- Tap task → Bottom sheet with options
- Swipe → Future expansion (not yet)
- Long-press → Future expansion (not yet)

---

## SECTION 0 — NAVIGATION SETUP

### src/navigation/RootNavigator.tsx — CREATE or OVERWRITE:

```typescript
import React, { useEffect, useState } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Appearance } from 'react-native';

// Screens
import TodaySchedule from '../screens/TodaySchedule';
import PlanTomorrow from '../screens/PlanTomorrow';
import Analytics from '../screens/Analytics';
import WakeCalculator from '../screens/WakeCalculator';
import SettingsMenu from '../screens/SettingsMenu';

// Components
import CustomTabBar from '../components/CustomTabBar';

// Types
import { RootStackParamList, MyDayStackParamList, PlanTomorrowStackParamList, AnalyticsStackParamList, WakeCalculatorStackParamList } from '../types/navigation';

const RootStack = createNativeStackNavigator<RootStackParamList>();
const MyDayStack = createNativeStackNavigator<MyDayStackParamList>();
const PlanTomorrowStack = createNativeStackNavigator<PlanTomorrowStackParamList>();
const AnalyticsStack = createNativeStackNavigator<AnalyticsStackParamList>();
const WakeCalculatorStack = createNativeStackNavigator<WakeCalculatorStackParamList>();
const Tab = createBottomTabNavigator();

// ─── INDIVIDUAL STACKS ───

function MyDayStackScreen() {
  return (
    <MyDayStack.Navigator
      screenOptions={{
        headerShown: false,
        animationEnabled: true,
        cardStyle: { backgroundColor: '#FFFDF5' }, // light mode
      }}
    >
      <MyDayStack.Screen name="TodaySchedule" component={TodaySchedule} />
    </MyDayStack.Navigator>
  );
}

function PlanTomorrowStackScreen() {
  return (
    <PlanTomorrowStack.Navigator
      screenOptions={{
        headerShown: false,
        animationEnabled: true,
        cardStyle: { backgroundColor: '#FFFDF5' },
      }}
    >
      <PlanTomorrowStack.Screen name="PlanTomorrowScreen" component={PlanTomorrow} />
    </PlanTomorrowStack.Navigator>
  );
}

function AnalyticsStackScreen() {
  return (
    <AnalyticsStack.Navigator
      screenOptions={{
        headerShown: false,
        animationEnabled: true,
        cardStyle: { backgroundColor: '#FFFDF5' },
      }}
    >
      <AnalyticsStack.Screen name="AnalyticsScreen" component={Analytics} />
    </AnalyticsStack.Navigator>
  );
}

function WakeCalculatorStackScreen() {
  return (
    <WakeCalculatorStack.Navigator
      screenOptions={{
        headerShown: false,
        animationEnabled: true,
        cardStyle: { backgroundColor: '#FFFDF5' },
      }}
    >
      <WakeCalculatorStack.Screen name="WakeCalculatorScreen" component={WakeCalculator} />
    </WakeCalculatorStack.Navigator>
  );
}

// ─── MAIN TABS (with custom dock) ───

function MainTabs() {
  return (
    <Tab.Navigator
      tabBar={(props) => <CustomTabBar {...props} />}
      screenOptions={{
        headerShown: false,
        tabBarHideOnKeyboard: false,
      }}
    >
      <Tab.Screen
        name="MyDay"
        component={MyDayStackScreen}
        options={{
          tabBarLabel: 'My Day',
          tabBarIcon: '🏠',
        }}
      />
      <Tab.Screen
        name="PlanTomorrow"
        component={PlanTomorrowStackScreen}
        options={{
          tabBarLabel: 'Plan Tomorrow',
          tabBarIcon: '📋',
        }}
      />
      <Tab.Screen
        name="Analytics"
        component={AnalyticsStackScreen}
        options={{
          tabBarLabel: 'Analytics',
          tabBarIcon: '📊',
        }}
      />
      <Tab.Screen
        name="WakeCalculator"
        component={WakeCalculatorStackScreen}
        options={{
          tabBarLabel: 'Wake',
          tabBarIcon: '⏰',
        }}
      />
    </Tab.Navigator>
  );
}

// ─── ROOT NAVIGATOR ───

export default function RootNavigator() {
  const [colorScheme, setColorScheme] = useState(Appearance.getColorScheme());

  useEffect(() => {
    const subscription = Appearance.addChangeListener(({ colorScheme }) => {
      setColorScheme(colorScheme);
    });
    return () => subscription.remove();
  }, []);

  return (
    <NavigationContainer>
      <RootStack.Navigator
        screenOptions={{
          headerShown: false,
          cardStyle: {
            backgroundColor: colorScheme === 'dark' ? '#1A1A2E' : '#FFFDF5',
          },
        }}
      >
        <RootStack.Screen
          name="MainTabs"
          component={MainTabs}
          options={{ animationEnabled: false }}
        />
        <RootStack.Group
          screenOptions={{
            presentation: 'modal',
            animationEnabled: true,
          }}
        >
          {/* Modals will be added here in future sections */}
        </RootStack.Group>
        <RootStack.Group
          screenOptions={{
            presentation: 'fullScreenModal',
            animationEnabled: true,
          }}
        >
          {/* Full screen modals (Settings menu) */}
          <RootStack.Screen
            name="SettingsMenu"
            component={SettingsMenu}
          />
        </RootStack.Group>
      </RootStack.Navigator>
    </NavigationContainer>
  );
}
```

### src/types/navigation.ts — CREATE:

```typescript
import { RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';

// Root Stack
export type RootStackParamList = {
  MainTabs: undefined;
  SettingsMenu: undefined;
  TaskDetailModal: { taskId: string };
  VerificationModal: { taskId: string };
  AddTaskSheet: { date: string };
  EditTimeModal: { taskId: string };
  EveningCheckInModal: undefined;
};

// My Day Stack
export type MyDayStackParamList = {
  TodaySchedule: undefined;
};

// Plan Tomorrow Stack
export type PlanTomorrowStackParamList = {
  PlanTomorrowScreen: undefined;
};

// Analytics Stack
export type AnalyticsStackParamList = {
  AnalyticsScreen: undefined;
};

// Wake Calculator Stack
export type WakeCalculatorStackParamList = {
  WakeCalculatorScreen: undefined;
};

// Navigation prop types
export type RootStackNavigation = NativeStackNavigationProp<RootStackParamList>;
export type MyDayNavigation = NativeStackNavigationProp<MyDayStackParamList>;
export type PlanTomorrowNavigation = NativeStackNavigationProp<PlanTomorrowStackParamList>;
export type AnalyticsNavigation = NativeStackNavigationProp<AnalyticsStackParamList>;
export type WakeCalculatorNavigation = NativeStackNavigationProp<WakeCalculatorStackParamList>;

// Route prop types
export type RootStackRoute<T extends keyof RootStackParamList> = RouteProp<RootStackParamList, T>;
```

---

## SECTION 1 — CUSTOM COMPONENTS

### src/components/CustomTabBar.tsx — CREATE:

```typescript
import React, { useRef, useEffect } from 'react';
import {
  View,
  TouchableOpacity,
  StyleSheet,
  Text,
  Animated,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS } from '../constants/theme';

interface TabBarProps {
  state: any;
  descriptors: any;
  navigation: any;
}

export default function CustomTabBar({ state, descriptors, navigation }: TabBarProps) {
  const insets = useSafeAreaInsets();
  const fabRotate = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(fabRotate, {
          toValue: 1,
          duration: 3000,
          useNativeDriver: true,
        }),
        Animated.timing(fabRotate, {
          toValue: 0,
          duration: 0,
          useNativeDriver: true,
        }),
      ])
    ).start();
  }, []);

  const fabRotateInterpolation = fabRotate.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  return (
    <View style={[styles.container, { paddingBottom: insets.bottom }]}>
      <View style={styles.tabBar}>
        {state.routes.map((route: any, index: number) => {
          const { options } = descriptors[route.key];
          const isFocused = state.index === index;

          const onPress = () => {
            const event = navigation.emit({
              type: 'tabPress',
              target: route.key,
              preventDefault: false,
            });

            if (!isFocused && !event.defaultPrevented) {
              navigation.navigate(route.name);
            }
          };

          return (
            <TouchableOpacity
              key={route.key}
              onPress={onPress}
              style={[
                styles.tab,
                {
                  opacity: isFocused ? 1 : 0.6,
                },
              ]}
              activeOpacity={0.7}
            >
              <Text
                style={[
                  styles.icon,
                  {
                    color: isFocused ? COLORS.purple : COLORS.lightTextSecondary,
                    fontSize: 32,
                  },
                ]}
              >
                {options.tabBarIcon}
              </Text>
              <Text
                style={[
                  styles.label,
                  {
                    color: isFocused ? COLORS.purple : COLORS.lightTextSecondary,
                    fontWeight: isFocused ? '600' : '400',
                  },
                ]}
              >
                {options.tabBarLabel}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Floating Action Button (Dock Style) */}
      <Animated.View
        style={[
          styles.fab,
          {
            transform: [{ rotate: fabRotateInterpolation }],
          },
        ]}
      >
        <TouchableOpacity
          style={styles.fabButton}
          onPress={() => {
            // Open Add Task Sheet
            // This will be connected to context/navigation
          }}
          activeOpacity={0.8}
        >
          <Text style={styles.fabIcon}>➕</Text>
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: COLORS.lightBg,
    borderTopWidth: 1,
    borderTopColor: COLORS.lightBorder,
  },
  tabBar: {
    flexDirection: 'row',
    height: 80,
    justifyContent: 'space-around',
    alignItems: 'flex-start',
    paddingTop: 8,
  },
  tab: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 8,
  },
  icon: {
    marginBottom: 4,
  },
  label: {
    fontSize: 11,
    textAlign: 'center',
  },
  fab: {
    position: 'absolute',
    bottom: 65,
    alignSelf: 'center',
    width: 56,
    height: 56,
  },
  fabButton: {
    width: '100%',
    height: '100%',
    borderRadius: 28,
    backgroundColor: COLORS.purple,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: COLORS.purple,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
  },
  fabIcon: {
    fontSize: 24,
  },
});
```

### src/components/TaskCard.tsx — CREATE:

```typescript
import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Animated,
  Dimensions,
} from 'react-native';
import { Task, TaskStatus } from '../types';
import { COLORS, CATEGORY_META, PRIORITY_META } from '../constants/theme';
import { formatDuration } from '../utils/timeUtils';

interface TaskCardProps {
  task: Task;
  onTap: (task: Task) => void;
  onComplete?: (task: Task) => void;
  showVerificationBadge?: boolean;
  language: 'en' | 'he';
}

export default function TaskCard({
  task,
  onTap,
  onComplete,
  showVerificationBadge = false,
  language,
}: TaskCardProps) {
  const [scaleAnim] = useState(new Animated.Value(1));
  const categoryMeta = CATEGORY_META[task.category] || CATEGORY_META.general;
  const priorityMeta = PRIORITY_META[task.priority] || PRIORITY_META.need_to;

  const isCompleted = task.status === 'complete';
  const isMissed = task.status === 'missed';

  const handleComplete = () => {
    Animated.sequence([
      Animated.timing(scaleAnim, {
        toValue: 0.95,
        duration: 100,
        useNativeDriver: true,
      }),
      Animated.timing(scaleAnim, {
        toValue: 1,
        duration: 100,
        useNativeDriver: true,
      }),
    ]).start(() => {
      onComplete?.(task);
    });
  };

  return (
    <Animated.View style={{ transform: [{ scale: scaleAnim }] }}>
      <TouchableOpacity
        onPress={() => onTap(task)}
        activeOpacity={0.8}
        style={[
          styles.card,
          {
            backgroundColor: isCompleted ? COLORS.lightBorder : COLORS.lightCard,
            opacity: isCompleted ? 0.6 : 1,
            borderLeftColor: categoryMeta.color,
          },
        ]}
      >
        {/* Header: Category + Priority */}
        <View style={styles.header}>
          <View style={styles.categoryBadge}>
            <Text style={styles.categoryIcon}>{categoryMeta.icon}</Text>
            <Text
              style={[
                styles.categoryLabel,
                { color: categoryMeta.color },
              ]}
            >
              {language === 'he' ? categoryMeta.labelHe : categoryMeta.labelEn}
            </Text>
          </View>

          {/* Verification Badge (Top Right) */}
          {isCompleted && showVerificationBadge && (
            <View style={styles.verificationBadge}>
              <Text style={styles.verificationIcon}>✓</Text>
            </View>
          )}

          {isMissed && (
            <View style={[styles.verificationBadge, { backgroundColor: COLORS.danger }]}>
              <Text style={styles.verificationIcon}>✕</Text>
            </View>
          )}
        </View>

        {/* Task Title */}
        <Text
          style={[
            styles.taskTitle,
            {
              textDecorationLine: isCompleted ? 'line-through' : 'none',
              color: isCompleted ? COLORS.lightTextSecondary : COLORS.lightText,
            },
          ]}
          numberOfLines={2}
        >
          {task.text}
        </Text>

        {/* Details Row: Time + Duration + Location */}
        <View style={styles.detailsRow}>
          {task.fixedTime && (
            <View style={styles.detail}>
              <Text style={styles.detailLabel}>🕐</Text>
              <Text style={styles.detailValue}>{task.fixedTime}</Text>
            </View>
          )}

          {task.location && (
            <View style={styles.detail}>
              <Text style={styles.detailLabel}>📍</Text>
              <Text style={styles.detailValue} numberOfLines={1}>
                {task.location.displayName || task.location.address}
              </Text>
            </View>
          )}

          <View style={styles.detail}>
            <Text style={styles.detailLabel}>⏱️</Text>
            <Text style={styles.detailValue}>
              {formatDuration(task.durationMinutes, language)}
            </Text>
          </View>
        </View>

        {/* Priority Badge */}
        <View style={styles.footer}>
          <View
            style={[
              styles.priorityBadge,
              { backgroundColor: priorityMeta.color },
            ]}
          >
            <Text style={styles.priorityText}>
              {language === 'he' ? priorityMeta.labelHe : priorityMeta.labelEn}
            </Text>
          </View>

          {/* Complete Button (if not already complete) */}
          {!isCompleted && (
            <TouchableOpacity
              onPress={handleComplete}
              style={styles.completeButton}
              activeOpacity={0.7}
            >
              <Text style={styles.completeButtonText}>Mark Done</Text>
            </TouchableOpacity>
          )}
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 12,
    padding: 14,
    marginHorizontal: 16,
    marginVertical: 8,
    borderLeftWidth: 4,
    backgroundColor: COLORS.lightCard,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 2,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  categoryBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: COLORS.lightBg,
  },
  categoryIcon: {
    fontSize: 16,
    marginRight: 4,
  },
  categoryLabel: {
    fontSize: 12,
    fontWeight: '600',
  },
  verificationBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: COLORS.success,
    justifyContent: 'center',
    alignItems: 'center',
  },
  verificationIcon: {
    color: 'white',
    fontWeight: 'bold',
    fontSize: 14,
  },
  taskTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.lightText,
    marginBottom: 10,
  },
  detailsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 10,
  },
  detail: {
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 12,
    marginBottom: 4,
  },
  detailLabel: {
    fontSize: 12,
    marginRight: 4,
  },
  detailValue: {
    fontSize: 12,
    color: COLORS.lightTextSecondary,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  priorityBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  priorityText: {
    fontSize: 11,
    color: 'white',
    fontWeight: '600',
  },
  completeButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: COLORS.purple,
  },
  completeButtonText: {
    fontSize: 11,
    color: 'white',
    fontWeight: '600',
  },
});
```

### src/components/WakeAlertBanner.tsx — CREATE:

```typescript
import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Animated,
  TouchableOpacity,
  Dimensions,
} from 'react-native';
import { COLORS } from '../constants/theme';

interface WakeAlertBannerProps {
  wakeTime: string;
  leaveTime: string;
  language: 'en' | 'he';
  onDismiss?: () => void;
}

export default function WakeAlertBanner({
  wakeTime,
  leaveTime,
  language,
  onDismiss,
}: WakeAlertBannerProps) {
  const [slideAnim] = useState(new Animated.Value(-100));

  useEffect(() => {
    Animated.spring(slideAnim, {
      toValue: 0,
      useNativeDriver: true,
      tension: 80,
      friction: 10,
    }).start();
  }, []);

  return (
    <Animated.View
      style={[
        styles.container,
        {
          transform: [{ translateY: slideAnim }],
        },
      ]}
    >
      <View style={styles.banner}>
        <View style={styles.content}>
          <View style={styles.alertItem}>
            <Text style={styles.emoji}>⏰</Text>
            <View>
              <Text style={styles.label}>
                {language === 'he' ? 'קום בבוקר:' : 'Wake up at:'}
              </Text>
              <Text style={styles.time}>{wakeTime}</Text>
            </View>
          </View>

          <View style={styles.divider} />

          <View style={styles.alertItem}>
            <Text style={styles.emoji}>🚪</Text>
            <View>
              <Text style={styles.label}>
                {language === 'he' ? 'צא מהבית:' : 'Leave home at:'}
              </Text>
              <Text style={styles.time}>{leaveTime}</Text>
            </View>
          </View>
        </View>

        <TouchableOpacity onPress={onDismiss} style={styles.closeButton}>
          <Text style={styles.closeIcon}>✕</Text>
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  banner: {
    flexDirection: 'row',
    backgroundColor: COLORS.purple,
    borderRadius: 12,
    padding: 14,
    justifyContent: 'space-between',
    alignItems: 'center',
    shadowColor: COLORS.purple,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 5,
  },
  content: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  alertItem: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  emoji: {
    fontSize: 24,
    marginRight: 10,
  },
  label: {
    fontSize: 11,
    color: 'rgba(255, 255, 255, 0.8)',
    fontWeight: '500',
  },
  time: {
    fontSize: 16,
    color: 'white',
    fontWeight: '700',
  },
  divider: {
    width: 1,
    height: 40,
    backgroundColor: 'rgba(255, 255, 255, 0.3)',
    marginHorizontal: 12,
  },
  closeButton: {
    padding: 8,
  },
  closeIcon: {
    fontSize: 18,
    color: 'white',
    fontWeight: 'bold',
  },
});
```

---

## SECTION 2 — MY DAY SCREEN (Today's Schedule)

### src/screens/TodaySchedule.tsx — CREATE or OVERWRITE:

```typescript
import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  ScrollView,
  StyleSheet,
  Text,
  FlatList,
  ActivityIndicator,
  Appearance,
  Modal,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { COLORS, CATEGORY_META } from '../constants/theme';
import { getTodayString } from '../utils/timeUtils';
import { TaskStorage } from '../services/TaskStorage';
import { Task, DailySchedule, AppLanguage } from '../types';
import WakeAlertBanner from '../components/WakeAlertBanner';
import TaskCard from '../components/TaskCard';
import TaskDetailBottomSheet from '../components/TaskDetailBottomSheet';

interface TodayScheduleProps {
  navigation: any;
}

export default function TodaySchedule({ navigation }: TodayScheduleProps) {
  const colorScheme = Appearance.getColorScheme();
  const isDark = colorScheme === 'dark';

  const [todaySchedule, setTodaySchedule] = useState<DailySchedule | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [showTaskDetail, setShowTaskDetail] = useState(false);
  const [language, setLanguage] = useState<AppLanguage>('en');

  // Load today's schedule
  useFocusEffect(
    useCallback(() => {
      loadTodaySchedule();
    }, [])
  );

  const loadTodaySchedule = async () => {
    try {
      setLoading(true);
      const today = getTodayString();
      const schedule = await TaskStorage.loadSchedule(today);
      const tasksData = await TaskStorage.loadTasks(today);

      // Sort tasks by time
      const sorted = tasksData.sort((a, b) => {
        const aTime = a.location?.leaveHomeBy || a.fixedTime || a.scheduledTime || '23:59';
        const bTime = b.location?.leaveHomeBy || b.fixedTime || b.scheduledTime || '23:59';
        return aTime.localeCompare(bTime);
      });

      setTodaySchedule(schedule);
      setTasks(sorted);
    } catch (error) {
      console.log('[TodaySchedule] Error loading:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleTaskTap = (task: Task) => {
    setSelectedTask(task);
    setShowTaskDetail(true);
  };

  const handleTaskComplete = async (task: Task) => {
    // This will trigger verification modal
    // Implementation in next section
    console.log('[TodaySchedule] Mark as complete:', task.id);
  };

  const handleTaskDetailClose = () => {
    setShowTaskDetail(false);
    setSelectedTask(null);
  };

  const bgColor = isDark ? COLORS.darkBg : COLORS.lightBg;
  const textColor = isDark ? COLORS.darkText : COLORS.lightText;

  return (
    <View style={[styles.container, { backgroundColor: bgColor }]}>
      <ScrollView
        style={styles.scrollView}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={styles.header}>
          <Text style={[styles.headerTitle, { color: textColor }]}>
            {language === 'he' ? 'היום שלי' : 'My Day'}
          </Text>
          <Text style={[styles.headerSubtitle, { color: isDark ? COLORS.darkTextSecondary : COLORS.lightTextSecondary }]}>
            {new Date().toLocaleDateString(language === 'he' ? 'he-IL' : 'en-US', {
              weekday: 'long',
              month: 'short',
              day: 'numeric',
            })}
          </Text>
        </View>

        {/* Wake Alerts (if applicable) */}
        {todaySchedule?.tasks.some((t) => t.location?.wakeUpBy) && (
          <WakeAlertBanner
            wakeTime={todaySchedule?.tasks.find((t) => t.location?.wakeUpBy)?.location?.wakeUpBy || '08:00'}
            leaveTime={todaySchedule?.tasks.find((t) => t.location?.leaveHomeBy)?.location?.leaveHomeBy || '08:30'}
            language={language}
          />
        )}

        {/* Tasks Loading State */}
        {loading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={COLORS.purple} />
          </View>
        ) : tasks.length === 0 ? (
          <View style={styles.emptyContainer}>
            <Text style={[styles.emptyText, { color: textColor }]}>
              {language === 'he' ? 'אין משימות היום. טוב ליום פנוי!' : 'No tasks today. Enjoy your free day!'}
            </Text>
          </View>
        ) : (
          <FlatList
            scrollEnabled={false}
            data={tasks}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <TaskCard
                task={item}
                onTap={handleTaskTap}
                onComplete={handleTaskComplete}
                showVerificationBadge={item.status === 'complete'}
                language={language}
              />
            )}
          />
        )}

        {/* Completion Summary */}
        {tasks.length > 0 && (
          <View style={styles.summary}>
            <Text style={[styles.summaryText, { color: textColor }]}>
              {`${tasks.filter((t) => t.status === 'complete').length}/${tasks.length} ${language === 'he' ? 'משימות הושלמו' : 'tasks completed'}`}
            </Text>
          </View>
        )}
      </ScrollView>

      {/* Task Detail Bottom Sheet */}
      {selectedTask && (
        <TaskDetailBottomSheet
          task={selectedTask}
          visible={showTaskDetail}
          onClose={handleTaskDetailClose}
          onComplete={() => {
            handleTaskComplete(selectedTask);
            handleTaskDetailClose();
          }}
          language={language}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 16,
    paddingVertical: 20,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 4,
  },
  headerSubtitle: {
    fontSize: 14,
    fontWeight: '500',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    minHeight: 300,
  },
  emptyContainer: {
    marginTop: 60,
    paddingHorizontal: 20,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 16,
    fontWeight: '500',
    textAlign: 'center',
  },
  summary: {
    padding: 16,
    alignItems: 'center',
  },
  summaryText: {
    fontSize: 14,
    fontWeight: '600',
  },
});
```

### src/components/TaskDetailBottomSheet.tsx — CREATE:

```typescript
import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  Dimensions,
  Animated,
} from 'react-native';
import { Task, AppLanguage } from '../types';
import { COLORS, CATEGORY_META, PRIORITY_META } from '../constants/theme';

interface TaskDetailBottomSheetProps {
  task: Task;
  visible: boolean;
  onClose: () => void;
  onComplete: () => void;
  language: AppLanguage;
}

export default function TaskDetailBottomSheet({
  task,
  visible,
  onClose,
  onComplete,
  language,
}: TaskDetailBottomSheetProps) {
  const categoryMeta = CATEGORY_META[task.category];
  const priorityMeta = PRIORITY_META[task.priority];

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          {/* Handle Bar */}
          <View style={styles.handleBar} />

          {/* Task Title */}
          <Text style={styles.taskTitle}>{task.text}</Text>

          {/* Details */}
          <View style={styles.detailsSection}>
            <DetailRow
              icon={categoryMeta.icon}
              label={language === 'he' ? categoryMeta.labelHe : categoryMeta.labelEn}
              value={categoryMeta.color}
              isColor
            />
            <DetailRow
              icon={priorityMeta.color === COLORS.danger ? '🔴' : '🟠'}
              label={language === 'he' ? priorityMeta.labelHe : priorityMeta.labelEn}
            />
            {task.fixedTime && (
              <DetailRow icon="🕐" label="Time" value={task.fixedTime} />
            )}
            {task.location && (
              <DetailRow
                icon="📍"
                label="Location"
                value={task.location.displayName || task.location.address}
              />
            )}
            <DetailRow icon="⏱️" label="Duration" value={`${task.durationMinutes} min`} />
          </View>

          {/* Action Buttons */}
          <View style={styles.actions}>
            <TouchableOpacity
              style={[styles.button, styles.completeButton]}
              onPress={onComplete}
            >
              <Text style={styles.completeButtonText}>
                {language === 'he' ? 'סימן כהושלם' : 'Mark Complete'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.button, styles.editButton]}
              onPress={() => {
                // Edit time flow
                onClose();
              }}
            >
              <Text style={styles.editButtonText}>
                {language === 'he' ? 'ערוך זמן' : 'Edit Time'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.button, styles.closeButton]}
              onPress={onClose}
            >
              <Text style={styles.closeButtonText}>
                {language === 'he' ? 'סגור' : 'Close'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

interface DetailRowProps {
  icon: string;
  label: string;
  value?: string;
  isColor?: boolean;
}

function DetailRow({ icon, label, value, isColor }: DetailRowProps) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailIcon}>{icon}</Text>
      <Text style={styles.detailLabel}>{label}</Text>
      {value && !isColor && <Text style={styles.detailValue}>{value}</Text>}
      {isColor && (
        <View
          style={[
            styles.colorBox,
            { backgroundColor: value },
          ]}
        />
      )}
    </View>
  );
}

const { height } = Dimensions.get('window');

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: COLORS.lightCard,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: height * 0.7,
    paddingHorizontal: 16,
    paddingBottom: 24,
  },
  handleBar: {
    width: 40,
    height: 4,
    backgroundColor: COLORS.lightBorder,
    borderRadius: 2,
    alignSelf: 'center',
    marginTop: 8,
    marginBottom: 16,
  },
  taskTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: COLORS.lightText,
    marginBottom: 20,
  },
  detailsSection: {
    marginBottom: 20,
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.lightBorder,
  },
  detailIcon: {
    fontSize: 18,
    marginRight: 12,
    width: 24,
  },
  detailLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: COLORS.lightTextSecondary,
    flex: 1,
  },
  detailValue: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.lightText,
  },
  colorBox: {
    width: 20,
    height: 20,
    borderRadius: 10,
  },
  actions: {
    gap: 12,
  },
  button: {
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  completeButton: {
    backgroundColor: COLORS.success,
  },
  completeButtonText: {
    color: 'white',
    fontWeight: '600',
    fontSize: 14,
  },
  editButton: {
    backgroundColor: COLORS.purple,
  },
  editButtonText: {
    color: 'white',
    fontWeight: '600',
    fontSize: 14,
  },
  closeButton: {
    backgroundColor: COLORS.lightBorder,
  },
  closeButtonText: {
    color: COLORS.lightText,
    fontWeight: '600',
    fontSize: 14,
  },
});
```

---

## SECTION 3 — PLAN TOMORROW SCREEN

### src/screens/PlanTomorrow.tsx — CREATE:

```typescript
import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  ScrollView,
  StyleSheet,
  Text,
  FlatList,
  TouchableOpacity,
  Appearance,
  SectionList,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { COLORS } from '../constants/theme';
import { getTodayString, getTomorrowString } from '../utils/timeUtils';
import { TaskStorage } from '../services/TaskStorage';
import { Task, AppLanguage } from '../types';
import TaskCard from '../components/TaskCard';

interface PlanTomorrowProps {
  navigation: any;
}

export default function PlanTomorrow({ navigation }: PlanTomorrowProps) {
  const colorScheme = Appearance.getColorScheme();
  const isDark = colorScheme === 'dark';
  const bgColor = isDark ? COLORS.darkBg : COLORS.lightBg;
  const textColor = isDark ? COLORS.darkText : COLORS.lightText;

  const [tomorrowTasks, setTomorrowTasks] = useState<Task[]>([]);
  const [unfinishedTasks, setUnfinishedTasks] = useState<Task[]>([]);
  const [suggestedTasks, setSuggestedTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [language, setLanguage] = useState<AppLanguage>('en');

  useFocusEffect(
    useCallback(() => {
      loadPlanTomorrow();
    }, [])
  );

  const loadPlanTomorrow = async () => {
    try {
      setLoading(true);
      const tomorrow = getTomorrowString();
      const today = getTodayString();

      // Load tomorrow's already scheduled tasks
      const tomorrowData = await TaskStorage.loadTasks(tomorrow);

      // Load unfinished tasks from today
      const todayData = await TaskStorage.loadTasks(today);
      const unfinished = todayData.filter(
        (t) => t.status === 'pending' || t.status === 'partial'
      );

      // Generate smart suggestions
      const suggestions = generateSuggestions(unfinished);

      setTomorrowTasks(tomorrowData);
      setUnfinishedTasks(unfinished);
      setSuggestedTasks(suggestions);
    } catch (error) {
      console.log('[PlanTomorrow] Error loading:', error);
    } finally {
      setLoading(false);
    }
  };

  const generateSuggestions = (unfinished: Task[]): Task[] => {
    // Smart suggestion logic
    // 1. Unfinished from today (not completed)
    // 2. Goals approaching deadline
    // 3. Calendar events
    // 4. Location-based (if user is in specific area)

    return unfinished.slice(0, 5); // Placeholder
  };

  const handleAddTask = (task: Task) => {
    // Add to tomorrow's plan
    console.log('[PlanTomorrow] Add task to tomorrow:', task.id);
  };

  const sections = [
    {
      title: language === 'he' ? '🔒 כבר בתוכנית' : '🔒 Already Scheduled',
      data: tomorrowTasks,
      locked: true,
    },
    {
      title: language === 'he' ? '💡 לומי מציעה' : '💡 Lumi Suggests',
      data: suggestedTasks,
      locked: false,
    },
  ];

  return (
    <View style={[styles.container, { backgroundColor: bgColor }]}>
      <ScrollView
        style={styles.scrollView}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={styles.header}>
          <Text style={[styles.headerTitle, { color: textColor }]}>
            {language === 'he' ? 'תוכנן מחר' : 'Plan Tomorrow'}
          </Text>
          <Text style={[styles.headerSubtitle, { color: isDark ? COLORS.darkTextSecondary : COLORS.lightTextSecondary }]}>
            {getTomorrowString()}
          </Text>
        </View>

        {/* Wake Time Section (Optional) */}
        <View style={styles.wakeTimeSection}>
          <Text style={[styles.wakeTimeLabel, { color: textColor }]}>
            {language === 'he' ? '⏰ מה השעה להקום מחר?' : '⏰ Wake time tomorrow?'}
          </Text>
          <TouchableOpacity style={styles.wakeTimeButton}>
            <Text style={styles.wakeTimeValue}>08:00</Text>
            <Text style={styles.wakeTimeHint}>
              {language === 'he' ? 'כמו היום' : 'Same as today'}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Tasks Sections */}
        <SectionList
          scrollEnabled={false}
          sections={sections}
          keyExtractor={(item, index) => item.id + index}
          renderItem={({ item, section }) => (
            <TaskCard
              task={item}
              onTap={() => console.log(item)}
              showVerificationBadge={false}
              language={language}
            />
          )}
          renderSectionHeader={({ section: { title } }) => (
            <Text style={[styles.sectionTitle, { color: textColor }]}>
              {title}
            </Text>
          )}
        />

        {/* Add More Tasks Button */}
        <TouchableOpacity style={styles.addMoreButton}>
          <Text style={styles.addMoreButtonText}>
            {language === 'he' ? '➕ הוסף משימות נוספות' : '➕ Add More Tasks'}
          </Text>
        </TouchableOpacity>

        {/* Action Buttons */}
        <View style={styles.actionButtons}>
          <TouchableOpacity style={[styles.actionButton, styles.saveButton]}>
            <Text style={styles.saveButtonText}>
              {language === 'he' ? '✓ שמור תוכנית' : '✓ Save Plan'}
            </Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 16,
    paddingVertical: 20,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 4,
  },
  headerSubtitle: {
    fontSize: 14,
    fontWeight: '500',
  },
  wakeTimeSection: {
    marginHorizontal: 16,
    marginBottom: 20,
    paddingVertical: 16,
    borderRadius: 12,
    backgroundColor: COLORS.purpleLight,
    paddingHorizontal: 14,
  },
  wakeTimeLabel: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 8,
  },
  wakeTimeButton: {
    paddingVertical: 10,
  },
  wakeTimeValue: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.lightText,
  },
  wakeTimeHint: {
    fontSize: 12,
    color: COLORS.lightTextSecondary,
    marginTop: 2,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    marginLeft: 16,
    marginTop: 16,
    marginBottom: 8,
  },
  addMoreButton: {
    marginHorizontal: 16,
    marginVertical: 16,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: COLORS.purple,
    alignItems: 'center',
  },
  addMoreButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.purple,
  },
  actionButtons: {
    paddingHorizontal: 16,
    paddingVertical: 20,
  },
  actionButton: {
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
  },
  saveButton: {
    backgroundColor: COLORS.success,
  },
  saveButtonText: {
    color: 'white',
    fontWeight: '600',
    fontSize: 16,
  },
});
```

---

## SECTION 4 — WAKE CALCULATOR SCREEN

### src/screens/WakeCalculator.tsx — CREATE:

```typescript
import React, { useState } from 'react';
import {
  View,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Appearance,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { COLORS } from '../constants/theme';
import { calculateWakeTime } from '../utils/timeUtils';

interface WakeCalculatorProps {
  navigation: any;
}

export default function WakeCalculator({ navigation }: WakeCalculatorProps) {
  const colorScheme = Appearance.getColorScheme();
  const isDark = colorScheme === 'dark';
  const bgColor = isDark ? COLORS.darkBg : COLORS.lightBg;
  const textColor = isDark ? COLORS.darkText : COLORS.lightText;

  const [location, setLocation] = useState('');
  const [arrivalTime, setArrivalTime] = useState('10:00');
  const [travelMinutes, setTravelMinutes] = useState('45');
  const [routineMinutes, setRoutineMinutes] = useState('45');
  const [wakeTime, setWakeTime] = useState('');
  const [leaveTime, setLeaveTime] = useState('');
  const [loading, setLoading] = useState(false);

  const handleCalculate = async () => {
    try {
      setLoading(true);
      const result = calculateWakeTime(
        arrivalTime,
        parseInt(travelMinutes),
        parseInt(routineMinutes),
        15
      );
      setWakeTime(result.wakeBy);
      setLeaveTime(result.leaveHomeBy);
    } catch (error) {
      console.log('[WakeCalculator] Error:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: bgColor }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView style={styles.scrollView} showsVerticalScrollIndicator={false}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={[styles.headerTitle, { color: textColor }]}>
            ⏰ Wake Calculator
          </Text>
          <Text style={[styles.headerSubtitle, { color: isDark ? COLORS.darkTextSecondary : COLORS.lightTextSecondary }]}>
            Calculate when to wake up and leave home
          </Text>
        </View>

        {/* Inputs */}
        <View style={styles.form}>
          {/* Location Input */}
          <View style={styles.formGroup}>
            <Text style={[styles.label, { color: textColor }]}>📍 Where are you going?</Text>
            <TextInput
              style={[styles.input, { color: textColor, borderColor: COLORS.lightBorder }]}
              placeholder="Binyamina, Jerusalem, etc."
              placeholderTextColor={isDark ? COLORS.darkTextSecondary : COLORS.lightTextSecondary}
              value={location}
              onChangeText={setLocation}
            />
          </View>

          {/* Arrival Time */}
          <View style={styles.formGroup}>
            <Text style={[styles.label, { color: textColor }]}>🕐 Arrival time</Text>
            <TextInput
              style={[styles.input, { color: textColor, borderColor: COLORS.lightBorder }]}
              placeholder="10:00"
              placeholderTextColor={isDark ? COLORS.darkTextSecondary : COLORS.lightTextSecondary}
              value={arrivalTime}
              onChangeText={setArrivalTime}
            />
          </View>

          {/* Travel Time */}
          <View style={styles.formGroup}>
            <Text style={[styles.label, { color: textColor }]}>🚌 Travel time (minutes)</Text>
            <TextInput
              style={[styles.input, { color: textColor, borderColor: COLORS.lightBorder }]}
              placeholder="45"
              placeholderTextColor={isDark ? COLORS.darkTextSecondary : COLORS.lightTextSecondary}
              value={travelMinutes}
              onChangeText={setTravelMinutes}
              keyboardType="number-pad"
            />
          </View>

          {/* Morning Routine */}
          <View style={styles.formGroup}>
            <Text style={[styles.label, { color: textColor }]}>🛁 Morning routine (minutes)</Text>
            <TextInput
              style={[styles.input, { color: textColor, borderColor: COLORS.lightBorder }]}
              placeholder="45"
              placeholderTextColor={isDark ? COLORS.darkTextSecondary : COLORS.lightTextSecondary}
              value={routineMinutes}
              onChangeText={setRoutineMinutes}
              keyboardType="number-pad"
            />
          </View>

          {/* Calculate Button */}
          <TouchableOpacity
            style={[styles.calculateButton, loading && styles.buttonDisabled]}
            onPress={handleCalculate}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color="white" />
            ) : (
              <Text style={styles.calculateButtonText}>Calculate ✓</Text>
            )}
          </TouchableOpacity>
        </View>

        {/* Results */}
        {wakeTime && leaveTime && (
          <View style={styles.results}>
            <Text style={[styles.resultsTitle, { color: textColor }]}>
              Your wake-up schedule:
            </Text>

            <View style={styles.resultCard}>
              <Text style={styles.resultEmoji}>⏰</Text>
              <View>
                <Text style={[styles.resultLabel, { color: isDark ? COLORS.darkTextSecondary : COLORS.lightTextSecondary }]}>
                  Wake up at
                </Text>
                <Text style={[styles.resultTime, { color: COLORS.purple }]}>
                  {wakeTime}
                </Text>
              </View>
            </View>

            <View style={styles.resultCard}>
              <Text style={styles.resultEmoji}>🚪</Text>
              <View>
                <Text style={[styles.resultLabel, { color: isDark ? COLORS.darkTextSecondary : COLORS.lightTextSecondary }]}>
                  Leave home at
                </Text>
                <Text style={[styles.resultTime, { color: COLORS.purple }]}>
                  {leaveTime}
                </Text>
              </View>
            </View>

            {/* Save Button */}
            <TouchableOpacity style={styles.saveButton}>
              <Text style={styles.saveButtonText}>Save as alert ✓</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 16,
    paddingVertical: 20,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 4,
  },
  headerSubtitle: {
    fontSize: 14,
    fontWeight: '500',
  },
  form: {
    paddingHorizontal: 16,
    gap: 16,
  },
  formGroup: {
    marginBottom: 8,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  calculateButton: {
    backgroundColor: COLORS.purple,
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 8,
  },
  calculateButtonText: {
    color: 'white',
    fontWeight: '600',
    fontSize: 16,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  results: {
    marginHorizontal: 16,
    marginTop: 24,
    marginBottom: 32,
  },
  resultsTitle: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 16,
  },
  resultCard: {
    flexDirection: 'row',
    backgroundColor: COLORS.purpleLight,
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    alignItems: 'center',
  },
  resultEmoji: {
    fontSize: 32,
    marginRight: 16,
  },
  resultLabel: {
    fontSize: 12,
    fontWeight: '500',
    marginBottom: 4,
  },
  resultTime: {
    fontSize: 20,
    fontWeight: '700',
  },
  saveButton: {
    backgroundColor: COLORS.success,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 12,
  },
  saveButtonText: {
    color: 'white',
    fontWeight: '600',
    fontSize: 14,
  },
});
```

---

## SECTION 5 — ANALYTICS SCREEN (Basic)

### src/screens/Analytics.tsx — CREATE:

```typescript
import React, { useState, useEffect } from 'react';
import {
  View,
  ScrollView,
  StyleSheet,
  Text,
  Appearance,
  TouchableOpacity,
} from 'react-native';
import { COLORS, CATEGORY_META } from '../constants/theme';
import { TaskStorage } from '../services/TaskStorage';

interface AnalyticsProps {
  navigation: any;
}

export default function Analytics({ navigation }: AnalyticsProps) {
  const colorScheme = Appearance.getColorScheme();
  const isDark = colorScheme === 'dark';
  const bgColor = isDark ? COLORS.darkBg : COLORS.lightBg;
  const textColor = isDark ? COLORS.darkText : COLORS.lightText;

  const [selectedPeriod, setSelectedPeriod] = useState<'week' | 'month'>('week');
  const [stats, setStats] = useState<any>(null);

  useEffect(() => {
    loadAnalytics();
  }, [selectedPeriod]);

  const loadAnalytics = async () => {
    try {
      const userStats = await TaskStorage.loadStats();
      setStats(userStats);
    } catch (error) {
      console.log('[Analytics] Error:', error);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: bgColor }]}>
      <ScrollView style={styles.scrollView} showsVerticalScrollIndicator={false}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={[styles.headerTitle, { color: textColor }]}>
            📊 Your Analytics
          </Text>
        </View>

        {/* Period Selector */}
        <View style={styles.periodSelector}>
          {(['week', 'month'] as const).map((period) => (
            <TouchableOpacity
              key={period}
              style={[
                styles.periodButton,
                selectedPeriod === period && styles.periodButtonActive,
              ]}
              onPress={() => setSelectedPeriod(period)}
            >
              <Text
                style={[
                  styles.periodButtonText,
                  selectedPeriod === period && styles.periodButtonTextActive,
                ]}
              >
                {period === 'week' ? 'This Week' : 'This Month'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Stats Overview */}
        {stats && (
          <>
            <View style={styles.statsGrid}>
              <StatCard
                icon="✓"
                label="Completed"
                value={`${stats.totalTasksCompleted || 0}`}
              />
              <StatCard
                icon="🎯"
                label="On Time"
                value={`${stats.totalTasksOnTime || 0}`}
              />
              <StatCard
                icon="📈"
                label="Accuracy"
                value={`${Math.round((stats.totalTasksOnTime / Math.max(stats.totalTasksCompleted, 1)) * 100) || 0}%`}
              />
            </View>

            {/* Category Breakdown */}
            <View style={styles.section}>
              <Text style={[styles.sectionTitle, { color: textColor }]}>
                Time by Category
              </Text>
              {Object.entries(stats.categoryDurationAverages || {}).map(
                ([category, hours]: [string, any]) => (
                  <CategoryRow
                    key={category}
                    category={category as any}
                    hours={Math.round(hours / 60)}
                  />
                )
              )}
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

function StatCard({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <View style={styles.statCard}>
      <Text style={styles.statEmoji}>{icon}</Text>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

function CategoryRow({ category, hours }: { category: string; hours: number }) {
  const meta = CATEGORY_META[category as any];
  const percentage = Math.min((hours / 40) * 100, 100);

  return (
    <View style={styles.categoryRow}>
      <Text style={styles.categoryIcon}>{meta?.icon || '📌'}</Text>
      <View style={styles.categoryInfo}>
        <Text style={styles.categoryName}>{meta?.labelEn || category}</Text>
        <View style={styles.progressBar}>
          <View
            style={[
              styles.progressFill,
              {
                width: `${percentage}%`,
                backgroundColor: meta?.color || COLORS.lightTextSecondary,
              },
            ]}
          />
        </View>
      </View>
      <Text style={styles.categoryHours}>{hours}h</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 16,
    paddingVertical: 20,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: '700',
  },
  periodSelector: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    gap: 12,
    marginBottom: 20,
  },
  periodButton: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.lightBorder,
    alignItems: 'center',
  },
  periodButtonActive: {
    backgroundColor: COLORS.purple,
    borderColor: COLORS.purple,
  },
  periodButtonText: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.lightTextSecondary,
  },
  periodButtonTextActive: {
    color: 'white',
  },
  statsGrid: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    gap: 12,
    marginBottom: 24,
  },
  statCard: {
    flex: 1,
    backgroundColor: COLORS.lightCard,
    borderRadius: 12,
    padding: 14,
    alignItems: 'center',
  },
  statEmoji: {
    fontSize: 28,
    marginBottom: 8,
  },
  statLabel: {
    fontSize: 12,
    fontWeight: '500',
    color: COLORS.lightTextSecondary,
    marginBottom: 4,
  },
  statValue: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.purple,
  },
  section: {
    paddingHorizontal: 16,
    marginBottom: 32,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 12,
  },
  categoryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.lightBorder,
  },
  categoryIcon: {
    fontSize: 18,
    marginRight: 10,
    width: 24,
  },
  categoryInfo: {
    flex: 1,
  },
  categoryName: {
    fontSize: 14,
    fontWeight: '500',
    color: COLORS.lightText,
    marginBottom: 6,
  },
  progressBar: {
    height: 6,
    backgroundColor: COLORS.lightBorder,
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 3,
  },
  categoryHours: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.purple,
    marginLeft: 8,
  },
});
```

---

## SECTION 6 — SETTINGS MENU

### src/screens/SettingsMenu.tsx — CREATE:

```typescript
import React, { useState } from 'react';
import {
  View,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  Appearance,
  Switch,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS } from '../constants/theme';
import { UserProfile } from '../types';
import { TaskStorage } from '../services/TaskStorage';

interface SettingsMenuProps {
  navigation: any;
}

export default function SettingsMenu({ navigation }: SettingsMenuProps) {
  const insets = useSafeAreaInsets();
  const colorScheme = Appearance.getColorScheme();
  const isDark = colorScheme === 'dark';
  const bgColor = isDark ? COLORS.darkBg : COLORS.lightBg;
  const textColor = isDark ? COLORS.darkText : COLORS.lightText;

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);

  React.useEffect(() => {
    loadProfile();
  }, []);

  const loadProfile = async () => {
    const p = await TaskStorage.loadProfile();
    setProfile(p);
  };

  return (
    <View style={[styles.container, { backgroundColor: bgColor, paddingTop: insets.top }]}>
      {/* Header with Close Button */}
      <View style={styles.headerWithClose}>
        <Text style={[styles.headerTitle, { color: textColor }]}>⚙️ Settings</Text>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={styles.closeButton}>✕</Text>
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.scrollView} showsVerticalScrollIndicator={false}>
        {/* Profile Section */}
        <SettingSection title="Profile">
          <SettingItem label="Name" value={profile?.name || 'Not set'} />
          <SettingItem label="Home Address" value={profile?.homeAddress || 'Not set'} />
          <SettingItem label="Transport" value={profile?.transportType || 'Not set'} />
        </SettingSection>

        {/* Notifications Section */}
        <SettingSection title="Notifications">
          <SettingToggle
            label="Wake-up Alarms"
            value={notificationsEnabled}
            onChange={setNotificationsEnabled}
          />
          <SettingToggle label="Deadline Reminders" value={true} onChange={() => {}} />
          <SettingToggle label="Achievement Badges" value={true} onChange={() => {}} />
        </SettingSection>

        {/* Integrations Section */}
        <SettingSection title="Integrations">
          <SettingButton label="Google Calendar" icon="📅" onPress={() => {}} />
          <SettingButton label="Gmail" icon="📧" onPress={() => {}} />
          <SettingButton label="Contacts" icon="👥" onPress={() => {}} />
        </SettingSection>

        {/* About Section */}
        <SettingSection title="About">
          <SettingItem label="Version" value="1.0.0" />
          <SettingButton label="Privacy Policy" onPress={() => {}} />
          <SettingButton label="Terms of Service" onPress={() => {}} />
        </SettingSection>
      </ScrollView>
    </View>
  );
}

function SettingSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function SettingItem({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.settingItem}>
      <Text style={styles.settingLabel}>{label}</Text>
      <Text style={styles.settingValue}>{value}</Text>
    </View>
  );
}

function SettingToggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <View style={styles.settingToggle}>
      <Text style={styles.settingLabel}>{label}</Text>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ false: COLORS.lightBorder, true: COLORS.purpleLight }}
        thumbColor={value ? COLORS.purple : COLORS.lightTextSecondary}
      />
    </View>
  );
}

function SettingButton({
  label,
  icon,
  onPress,
}: {
  label: string;
  icon?: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity style={styles.settingButton} onPress={onPress} activeOpacity={0.7}>
      <Text style={styles.settingLabel}>
        {icon && `${icon} `}
        {label}
      </Text>
      <Text style={styles.settingArrow}>›</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  headerWithClose: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: '700',
  },
  closeButton: {
    fontSize: 20,
    fontWeight: 'bold',
    color: COLORS.lightTextSecondary,
  },
  scrollView: {
    flex: 1,
  },
  section: {
    paddingHorizontal: 16,
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.purple,
    textTransform: 'uppercase',
    marginBottom: 12,
  },
  settingItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.lightBorder,
  },
  settingLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: COLORS.lightText,
  },
  settingValue: {
    fontSize: 14,
    color: COLORS.lightTextSecondary,
  },
  settingToggle: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.lightBorder,
  },
  settingButton: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.lightBorder,
  },
  settingArrow: {
    fontSize: 20,
    color: COLORS.lightTextSecondary,
  },
});
```

---

## SECTION 7 — RUN & VERIFY

After all sections complete:

1. Run: `npx expo start --clear`
2. Confirm app launches without crashing
3. Test navigation (tap tabs, verify they switch)
4. Test TaskCard component rendering
5. List every file created/modified
6. Run: `npx expo install --fix`

---

## NEXT PHASES (NOT YET)

Phase 2: Verification modals + GPS
Phase 3: Drag-and-drop task builder (Plan Tomorrow)
Phase 4: Evening check-in flow (17:00-20:00)
Phase 5: Learning service integration
