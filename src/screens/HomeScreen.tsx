/**
 * HomeScreen — the base screen: greeting, stats bar, priority-grouped task
 * cards, mic entry point, wake alerts and nearby-task checks.
 * Dependencies: TaskParser (voice add), NotificationService,
 * MorningRoutineService (wake plan), NearbyTaskReminderService,
 * PhoneContactsService, UserProfileStorage.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { BRAND, NOTE_PALETTE, FONTS, RADIUS, SHADOWS } from '../constants/theme';
import LumiWordmark from '../components/LumiWordmark';
import { TaskList } from '../components/TaskList';
import { useLumiContext } from '../hooks/useLumiContext';
import { extractTaskTags } from '../services/TaskParser';
import { getWakeAlertPlanNow, learnMorningRoutineFromTasks } from '../services/MorningRoutineService';
import { LocationCandidate, checkAndNotifyNearbyTasks, geocodeTaskLocation, getCurrentLocationDetails, openLocationInMaps, searchLocationCandidates, trackTaskTravelLearning } from '../services/NearbyTaskReminderService';
import { sendInstantNotification } from '../services/NotificationService';
import { pickPhoneContact } from '../services/PhoneContactsService';
import { markArrivals, replanNextTripFromPosition } from '../services/LiveRoute';
import { loadProfile, saveProfile } from '../services/UserProfileStorage';
import { isExpoGo } from '../utils/isExpoGo';
import { locationTextOf } from '../utils/dayPlanning';
import { RootStackParamList } from '../types/navigation';
import { Task } from '../types/models';

type DateTimePickerEvent = { type: 'set' | 'dismissed' | 'neutralButtonPressed' };
type NativeDateTimePickerProps = {
  value: Date;
  mode: 'time' | 'date' | 'datetime' | 'countdown';
  is24Hour?: boolean;
  display?: 'default' | 'spinner' | 'clock' | 'calendar';
  onChange: (event: DateTimePickerEvent, date?: Date) => void;
};

let NativeDateTimePicker: React.ComponentType<NativeDateTimePickerProps> | null = null;

try {
  NativeDateTimePicker = require('@react-native-community/datetimepicker').default as React.ComponentType<NativeDateTimePickerProps>;
} catch (error) {
  console.log('[DATE_PICKER] native datetime picker unavailable:', error);
}

// Group tiles use the sticky-note pastels so the grid matches the Tasks board.
const noteTint = (i: number) => NOTE_PALETTE[i % NOTE_PALETTE.length].tint;

const EMPTY_GROUPS: Array<{ name: string; icon: string; color: string }> = [
  { name: 'Work', icon: '💼', color: noteTint(0) },
  { name: 'Health', icon: '🧘', color: noteTint(1) },
  { name: 'Home', icon: '🏠', color: noteTint(2) },
  { name: 'Errands', icon: '🛒', color: noteTint(3) },
  { name: 'Calls', icon: '📞', color: noteTint(4) },
  { name: 'Learning', icon: '📚', color: noteTint(0) },
  { name: 'Interviews', icon: '🎯', color: noteTint(1) },
  { name: 'General', icon: '📋', color: noteTint(2) },
];

// ── subgroup helpers ──────────────────────────────────────────────────────────

type SubgroupSummary = {
  name: string;
  icon: string;
  color: string;
  total: number;
  done: number;
  tasks: Task[];
};

const SUBGROUP_ICONS: Array<[RegExp, string]> = [
  [/gym|fitness|workout/i, '🏋️'],
  [/yoga|pilates|meditat/i, '🧘'],
  [/doctor|medical|health|pharmacy/i, '🩺'],
  [/work|office|standup|deploy|sprint/i, '💼'],
  [/lumi|ai course|nebius|agent/i, '🤖'],
  [/course|learn|study|lecture/i, '📚'],
  [/home|clean|laundry|cook/i, '🏠'],
  [/errand|shop|grocery|buy|store/i, '🛒'],
  [/call|phone|ring/i, '📞'],
  [/social|friend|family|dinner|coffee/i, '👥'],
  [/interview|hiring|talent/i, '🎯'],
  [/travel|flight|train|commute/i, '✈️'],
];

const SUBGROUP_COLORS: Array<[RegExp, string]> = [
  [/gym|fitness|workout|yoga|pilates|health|meditat/i, noteTint(1)],
  [/work|office|standup|lumi|ai|nebius|agent|deploy/i, noteTint(0)],
  [/course|learn|study|lecture/i, noteTint(2)],
  [/home|clean|laundry|cook/i, noteTint(3)],
  [/errand|shop|grocery|buy|store/i, noteTint(4)],
  [/call|phone|social|friend|family|dinner/i, noteTint(0)],
  [/interview|hiring|talent/i, noteTint(1)],
  [/doctor|medical|pharmacy/i, noteTint(2)],
];

function iconFor(name: string): string {
  for (const [rgx, icon] of SUBGROUP_ICONS) {
    if (rgx.test(name)) { return icon; }
  }
  return '📋';
}

function colorFor(name: string): string {
  for (const [rgx, color] of SUBGROUP_COLORS) {
    if (rgx.test(name)) { return color; }
  }
  return noteTint(3);
}

function parseDueDateValue(value?: string): Date {
  if (!value) {
    return new Date();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function formatDueDateLabel(value?: string): string {
  if (!value) {
    return 'Choose a date and time';
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function mergeDateAndTime(dateValue: Date, timeValue: Date): Date {
  const next = new Date(dateValue);
  next.setHours(timeValue.getHours(), timeValue.getMinutes(), 0, 0);
  return next;
}

function buildSubgroups(tasks: Task[]): SubgroupSummary[] {
  const map = new Map<string, Task[]>();
  for (const t of tasks) {
    const key = (t.subgroup || t.category || 'General').trim();
    const bucket = map.get(key) ?? [];
    bucket.push(t);
    map.set(key, bucket);
  }
  return Array.from(map.entries())
    .map(([name, groupTasks]) => ({
      name,
      icon: iconFor(name),
      color: colorFor(name),
      total: groupTasks.length,
      done: groupTasks.filter((t) => t.status === 'complete').length,
      tasks: groupTasks,
    }))
    .sort((a, b) => b.total - a.total);
}

// ── animated badge ────────────────────────────────────────────────────────────

function BadgeDone({ done, total }: { done: number; total: number }) {
  const scale = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    Animated.sequence([
      Animated.timing(scale, { toValue: 1.25, duration: 100, useNativeDriver: true }),
      Animated.timing(scale, { toValue: 1, duration: 100, useNativeDriver: true }),
    ]).start();
  }, [done, scale]);
  if (done === 0) { return null; }
  return (
    <Animated.View style={[styles.badge, done === total && styles.badgeDone, { transform: [{ scale }] }]}>
      <Text style={styles.badgeText}>{done}</Text>
    </Animated.View>
  );
}

type Props = NativeStackScreenProps<RootStackParamList, 'Home'>;

export default function HomeScreen({ navigation }: Props) {
  const { tasksState, checkInState } = useLumiContext();
  const { tasks, todayTasks, backlog, progress, toggleTask, removeTask, updateTaskText, updateTaskDetails } = tasksState;
  const { pendingCheckIn } = checkInState;

  const [editTask, setEditTask] = useState<Task | null>(null);
  const [editText, setEditText] = useState('');
  const [editSubgroup, setEditSubgroup] = useState('');
  const [editDueDate, setEditDueDate] = useState('');
  const [editLocation, setEditLocation] = useState('');
  const [editLocationCoords, setEditLocationCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [editLocationCandidates, setEditLocationCandidates] = useState<LocationCandidate[]>([]);
  const [editContactName, setEditContactName] = useState('');
  const [editContactPhone, setEditContactPhone] = useState('');
  const [showEditSubgroup, setShowEditSubgroup] = useState(false);
  const [showEditDeadline, setShowEditDeadline] = useState(false);
  const [showEditLocation, setShowEditLocation] = useState(false);
  const [showEditContact, setShowEditContact] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);
  const [timePickerMode, setTimePickerMode] = useState<'date' | 'time'>('date');
  const [pendingDateValue, setPendingDateValue] = useState<Date>(new Date());
  const [activeSubgroup, setActiveSubgroup] = useState<SubgroupSummary | null>(null);

  const backlogCount = useMemo(
    () => backlog.reduce((sum, g) => sum + g.tasks.length, 0),
    [backlog],
  );

  const subgroups = useMemo(() => {
    const allTasks = [...todayTasks, ...backlog.flatMap((g) => g.tasks)];
    if (!allTasks.length) {
      return EMPTY_GROUPS.map((group) => ({ ...group, total: 0, done: 0, tasks: [] }));
    }
    return buildSubgroups(allTasks);
  }, [todayTasks, backlog]);

  const knownLocations = useMemo(() => {
    const allLocations = tasks
      // A routed task stores an OBJECT here, not a string: `.trim()` on it is a
      // TypeError that took the whole screen down.
      .map((task) => locationTextOf(task).trim())
      .filter((value): value is string => Boolean(value));
    return Array.from(new Set(allLocations)).slice(0, 8);
  }, [tasks]);

  // Morning check-in redirect
  useEffect(() => {
    if (pendingCheckIn === 'morning') {
      navigation.navigate('CheckIn', { type: 'morning', mandatory: true, flow: 'review' });
    }
  }, [navigation, pendingCheckIn]);

  // Nearby task reminders
  useEffect(() => {
    let alive = true;
    const runLocationLoop = async () => {
      const profile = await loadProfile();
      if (!alive) {
        return;
      }

      await checkAndNotifyNearbyTasks(todayTasks, async (taskId, ts) => {
        await updateTaskDetails(taskId, { lastNearbyReminderAt: ts });
      });

      if (profile) {
        await trackTaskTravelLearning(
          profile,
          todayTasks,
          async (taskId, patch) => updateTaskDetails(taskId, patch),
          async (nextProfile) => saveProfile(nextProfile),
        );

        // Presence FIRST: a task she is standing in has no journey left, and
        // stamping that is what stops the next leg being measured from home.
        const { arrived } = await markArrivals(todayTasks).catch(() => ({ arrived: [] }));
        const reached = new Set(arrived.map((t) => t.id));
        const live = reached.size
          ? todayTasks.map((t) => (reached.has(t.id) ? { ...t, verifiedArrival: true } : t))
          : todayTasks;

        // Then re-plan the next trip from where she ACTUALLY is. positionDrift
        // only fires this once she has moved past the threshold, so a
        // stationary phone does nothing; notify only when the leave time
        // really changed.
        await replanNextTripFromPosition(live, profile, { notify: true })
          .catch(() => {});
      }
    };

    runLocationLoop();
    const timer = setInterval(runLocationLoop, 2 * 60 * 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [todayTasks, updateTaskDetails]);

  // Morning planner + habit learning
  useEffect(() => {
    let alive = true;
    const runPlanner = async () => {
      const profile = await loadProfile();
      if (!profile || !alive) { return; }
      const learned = learnMorningRoutineFromTasks(profile, tasks);
      if (learned.lastUpdated !== profile.lastUpdated) { await saveProfile(learned); }
      const plan = getWakeAlertPlanNow(learned, todayTasks);
      if (!plan) { return; }
      await sendInstantNotification(plan.title, plan.body, { type: 'wake-up-planner', taskId: plan.taskId });
      await updateTaskDetails(plan.taskId, { lastWakeReminderAt: Date.now() });
    };
    runPlanner();
    const timer = setInterval(runPlanner, 2 * 60 * 1000);
    return () => { alive = false; clearInterval(timer); };
  }, [tasks, todayTasks, updateTaskDetails]);

  const onSaveEdit = useCallback(async () => {
    if (!editTask || !editText.trim()) { return; }
    const trimmedLocation = editLocation.trim();
    let locationPatch: Partial<Task> = {
      location: trimmedLocation || undefined,
      hasLocation: Boolean(trimmedLocation),
      locationLat: undefined,
      locationLng: undefined,
    };

    if (trimmedLocation) {
      const coords = editLocationCoords ?? await geocodeTaskLocation(trimmedLocation);
      locationPatch = {
        ...locationPatch,
        locationLat: coords?.lat,
        locationLng: coords?.lng,
      };
    }

    await updateTaskText(editTask.id, editText.trim());
    await updateTaskDetails(editTask.id, {
      subgroup: editSubgroup.trim() || undefined,
      dueDate: editDueDate.trim() || undefined,
      hasDeadline: Boolean(editDueDate.trim()),
      contactName: editContactName.trim() || undefined,
      contactPhone: editContactPhone.trim() || undefined,
      tags: extractTaskTags(editText.trim()),
      ...locationPatch,
    });
    setEditTask(null);
    setEditText('');
    setEditSubgroup('');
    setEditDueDate('');
    setEditLocation('');
    setEditLocationCoords(null);
    setEditLocationCandidates([]);
    setEditContactName('');
    setEditContactPhone('');
    setShowEditSubgroup(false);
    setShowEditDeadline(false);
    setShowEditLocation(false);
    setShowEditContact(false);
    setShowTimePicker(false);
  }, [editContactName, editContactPhone, editDueDate, editLocation, editLocationCoords, editSubgroup, editTask, editText, updateTaskDetails, updateTaskText]);

  const closeEditTask = useCallback(() => {
    setEditTask(null);
    setEditText('');
    setEditSubgroup('');
    setEditDueDate('');
    setEditLocation('');
    setEditLocationCoords(null);
    setEditLocationCandidates([]);
    setEditContactName('');
    setEditContactPhone('');
    setShowEditSubgroup(false);
    setShowEditDeadline(false);
    setShowEditLocation(false);
    setShowEditContact(false);
    setShowTimePicker(false);
    setTimePickerMode('date');
    setPendingDateValue(new Date());
  }, []);

  const handleDeleteEditTask = useCallback(async () => {
    if (!editTask) {
      return;
    }
    await removeTask(editTask.id);
    closeEditTask();
  }, [closeEditTask, editTask, removeTask]);

  // Update subgroup summary reactively when toggling tasks inside popup
  const handlePopupToggle = useCallback(async (task: Task) => {
    await toggleTask(task.id, task.status !== 'complete');
    setActiveSubgroup((prev) => {
      if (!prev) { return null; }
      const updated = prev.tasks.map((t) =>
        t.id === task.id
          ? { ...t, status: (t.status === 'complete' ? 'pending' : 'complete') as Task['status'], completedAt: t.status === 'complete' ? null : Date.now() }
          : t,
      );
      return { ...prev, tasks: updated, done: updated.filter((t) => t.status === 'complete').length };
    });
  }, [toggleTask]);

  const handlePopupDelete = useCallback(async (task: Task) => {
    await removeTask(task.id);
    setActiveSubgroup((prev) => {
      if (!prev) { return null; }
      const updated = prev.tasks.filter((t) => t.id !== task.id);
      return { ...prev, tasks: updated, total: updated.length, done: updated.filter((t) => t.status === 'complete').length };
    });
  }, [removeTask]);

  const handleProfilePress = useCallback(() => {
    navigation.navigate('ProfileEdit');
  }, [navigation]);

  const beginEditTask = useCallback((task: Task) => {
    setEditTask(task);
    setEditText(task.text);
    setEditSubgroup(task.subgroup ?? '');
    setEditDueDate(task.dueDate ?? '');
    setEditLocation(locationTextOf(task));   // never the object: it lands in a TextInput
    setEditLocationCoords(task.locationLat && task.locationLng ? { lat: task.locationLat, lng: task.locationLng } : null);
    setEditLocationCandidates([]);
    setEditContactName(task.contactName ?? '');
    setEditContactPhone(task.contactPhone ?? '');
    setShowEditSubgroup(Boolean(task.subgroup));
    setShowEditDeadline(Boolean(task.dueDate));
    setShowEditLocation(Boolean(locationTextOf(task)));
    setShowEditContact(Boolean(task.contactName || task.contactPhone));
    setShowTimePicker(false);
    setTimePickerMode('date');
    setPendingDateValue(parseDueDateValue(task.dueDate));
  }, []);

  const handlePickContact = useCallback(async () => {
    const picked = await pickPhoneContact();
    if (!picked) {
      return;
    }
    setShowEditContact(true);
    if (picked.name) {
      setEditContactName(picked.name);
    }
    if (picked.phone) {
      setEditContactPhone(picked.phone);
    }
  }, []);

  const handleTimeChange = useCallback((event: DateTimePickerEvent, selectedDate?: Date) => {
    if (Platform.OS === 'android' && event.type !== 'set') {
      setShowTimePicker(false);
      setTimePickerMode('date');
      return;
    }

    if (event.type !== 'set' || !selectedDate) {
      return;
    }

    setShowEditDeadline(true);
    if (timePickerMode === 'date') {
      const nextDate = new Date(selectedDate);
      setPendingDateValue(nextDate);
      if (Platform.OS === 'android') {
        setTimePickerMode('time');
        setShowTimePicker(true);
      } else {
        setTimePickerMode('time');
      }
      return;
    }

    const merged = mergeDateAndTime(pendingDateValue, selectedDate);
    setEditDueDate(merged.toISOString());
    setShowTimePicker(false);
    setTimePickerMode('date');
  }, [pendingDateValue, timePickerMode]);

  const openCalendarPicker = useCallback(() => {
    const seed = parseDueDateValue(editDueDate);
    setPendingDateValue(seed);
    setTimePickerMode('date');
    setShowTimePicker(true);
    setShowEditDeadline(true);
  }, [editDueDate]);

  const handleUseCurrentLocation = useCallback(async () => {
    const currentLocation = await getCurrentLocationDetails();
    if (!currentLocation) {
      Alert.alert('Location unavailable', 'Lumi could not read your current location right now.');
      return;
    }

    setShowEditLocation(true);
    setEditLocation(currentLocation.label);
    setEditLocationCoords({ lat: currentLocation.lat, lng: currentLocation.lng });
    setEditLocationCandidates([]);
  }, []);

  const handleSearchLocationCandidates = useCallback(async () => {
    const query = editLocation.trim();
    if (!query) {
      Alert.alert('Enter a place', 'Type the place name first so Lumi can search it on the map.');
      return;
    }

    const candidates = await searchLocationCandidates(query);
    if (!candidates.length) {
      Alert.alert('No places found', `Lumi could not find map results for "${query}".`);
      setEditLocationCandidates([]);
      return;
    }

    setEditLocationCandidates(candidates);
    await handleOpenMapCandidate(candidates[0]);
  }, [editLocation]);

  const handleOpenMap = useCallback(async () => {
    const label = editLocation.trim() || 'near me';
    console.log('[LOCATION] handleOpenMap pressed:', { label });
    const opened = await openLocationInMaps(label);
    if (!opened) {
      Alert.alert('Maps unavailable', 'No map application is available on this device.');
    }
  }, [editLocation]);

  const handleOpenMapCandidate = useCallback(async (candidate: LocationCandidate) => {
    console.log('[LOCATION] handleOpenMapCandidate pressed:', candidate);
    const opened = await openLocationInMaps(candidate.label, { lat: candidate.lat, lng: candidate.lng });
    if (!opened) {
      Alert.alert('Maps unavailable', 'No map application is available on this device.');
    }
  }, []);

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>

        {/* ── Header ── */}
        <View style={styles.headerRow}>
          <LumiWordmark size={34} />
          <View style={styles.headerRight}>
            <Pressable style={styles.headerBtn} onPress={handleProfilePress}>
              <Text style={styles.headerBtnText}>👤</Text>
            </Pressable>
            <Pressable style={styles.headerBtn} onPress={() => navigation.navigate('Settings')}>
              <Text style={styles.headerBtnText}>⚙️</Text>
            </Pressable>
          </View>
        </View>

        {/* ── Expo Go notice ── */}
        {isExpoGo && (
          <View style={styles.noticeBanner}>
            <Text style={styles.noticeText}>
              Running in Expo Go — notifications & microphone need a dev build.
            </Text>
          </View>
        )}

        {/* ── Pending check-in nudge (non-morning) ── */}
        {pendingCheckIn && pendingCheckIn !== 'morning' && (
          <Pressable
            style={styles.nudge}
            onPress={() => navigation.navigate('CheckIn', { type: pendingCheckIn, mandatory: false, flow: 'review' })}
          >
            <Text style={styles.nudgeText}>
              {pendingCheckIn === 'afternoon' ? '☀️ Afternoon check-in ready — tap to start' : '🌙 Evening check-in ready — tap to start'}
            </Text>
          </Pressable>
        )}

        {/* ── Two primary voice buttons ── */}
        <View style={styles.voiceRow}>
          <Pressable
            style={styles.primaryBtn}
            onPress={() => navigation.navigate('CheckIn', { type: 'morning', mandatory: false, flow: 'capture' })}
          >
            <Text style={styles.primaryBtnIcon}>🎙️</Text>
            <Text style={styles.primaryBtnLabel}>Add Tasks</Text>
            <Text style={styles.primaryBtnSub}>Tell Lumi what to do</Text>
          </Pressable>

          <Pressable
            style={[styles.primaryBtn, styles.primaryBtnAlt]}
            onPress={() => navigation.navigate('CheckIn', { type: pendingCheckIn ?? 'afternoon', mandatory: false, flow: 'review' })}
          >
            <Text style={styles.primaryBtnIcon}>✅</Text>
            <Text style={[styles.primaryBtnLabel, styles.primaryBtnLabelAlt]}>What's Done?</Text>
            <Text style={[styles.primaryBtnSub, styles.primaryBtnSubAlt]}>Tell Lumi what you finished</Text>
          </Pressable>
        </View>

        {/* ── Progress bar ── */}
        <View style={styles.progressRow}>
          <View style={styles.progressTrack}>
            <View
              style={[
                styles.progressFill,
                { width: progress.total ? `${Math.round((progress.complete / progress.total) * 100)}%` : '0%' },
              ]}
            />
          </View>
          <Text style={styles.progressLabel}>{progress.complete} / {progress.total} today</Text>
        </View>

        {/* ── Subgroup icon grid ── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Task Groups</Text>
          <View style={styles.iconGrid}>
            {subgroups.map((sg) => (
              <Pressable
                key={sg.name}
                style={[styles.groupIcon, { backgroundColor: sg.color }]}
                onPress={() => sg.total > 0 && setActiveSubgroup(sg)}
              >
                <BadgeDone done={sg.done} total={sg.total} />
                <Text style={styles.groupEmoji}>{sg.icon}</Text>
                <Text style={styles.groupName} numberOfLines={1}>{sg.name}</Text>
                <Text style={styles.groupCount}>{sg.done}/{sg.total}</Text>
              </Pressable>
            ))}
          </View>
        </View>

        {/* ── Backlog ── */}
        {backlogCount > 0 && (
          <View style={styles.backlogCard}>
            <Text style={styles.backlogTitle}>⏳ {backlogCount} backlog task{backlogCount !== 1 ? 's' : ''}</Text>
            {backlog.slice(0, 2).map((group) => (
              <View key={group.date} style={styles.backlogGroup}>
                <Text style={styles.backlogDate}>{group.date}</Text>
                {group.tasks.slice(0, 3).map((task) => (
                  <Text key={task.id} style={styles.backlogTask}>• {task.text}</Text>
                ))}
                {group.tasks.length > 3 && <Text style={styles.backlogMore}>+{group.tasks.length - 3} more</Text>}
              </View>
            ))}
          </View>
        )}

      </ScrollView>

      {/* ── Subgroup popup ── */}
      <Modal visible={Boolean(activeSubgroup)} transparent animationType="slide" onRequestClose={() => setActiveSubgroup(null)}>
        <Pressable style={styles.popupBackdrop} onPress={() => setActiveSubgroup(null)}>
          <Pressable style={styles.popupCard} onPress={(e) => e.stopPropagation()}>
            {activeSubgroup && (
              <>
                <View style={styles.popupHandle} />
                <View style={styles.popupHeader}>
                  <Text style={styles.popupIcon}>{activeSubgroup.icon}</Text>
                  <View style={styles.popupHeaderText}>
                    <Text style={styles.popupTitle}>{activeSubgroup.name}</Text>
                    <Text style={styles.popupCount}>{activeSubgroup.done} of {activeSubgroup.total} complete</Text>
                  </View>
                  <Pressable style={styles.popupClose} onPress={() => setActiveSubgroup(null)}>
                    <Text style={styles.popupCloseText}>✕</Text>
                  </Pressable>
                </View>
                <ScrollView style={styles.popupList} showsVerticalScrollIndicator={false}>
                  <TaskList
                    tasks={activeSubgroup.tasks}
                    onToggle={handlePopupToggle}
                    onDelete={handlePopupDelete}
                    onEdit={(task) => {
                      beginEditTask(task);
                      setActiveSubgroup(null);
                    }}
                  />
                </ScrollView>
                <Pressable
                  style={styles.popupAddBtn}
                  onPress={() => { setActiveSubgroup(null); navigation.navigate('CheckIn', { type: 'morning', mandatory: false, flow: 'capture' }); }}
                >
                  <Text style={styles.popupAddText}>🎙️ Add more tasks</Text>
                </Pressable>
              </>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* ── Edit task modal ── */}
      <Modal visible={Boolean(editTask)} transparent animationType="fade">
        <View style={styles.editBackdrop}>
          <View style={styles.editCard}>
            <Text style={styles.editTitle}>Edit task</Text>
            <Text style={styles.fieldLabel}>Task title</Text>
            <TextInput
              value={editText}
              onChangeText={setEditText}
              style={styles.editInput}
              placeholder="Task description"
              autoFocus
              multiline
            />
            <View style={styles.editChipsRow}>
              {!showEditSubgroup && <Pressable style={styles.editChipButton} onPress={() => setShowEditSubgroup(true)}><Text style={styles.editChipText}>Add subgroup</Text></Pressable>}
              {!showEditDeadline && <Pressable style={styles.editChipButton} onPress={() => setShowEditDeadline(true)}><Text style={styles.editChipText}>Add time</Text></Pressable>}
              {!showEditLocation && <Pressable style={styles.editChipButton} onPress={() => setShowEditLocation(true)}><Text style={styles.editChipText}>Add location</Text></Pressable>}
              {!showEditContact && <Pressable style={styles.editChipButton} onPress={() => setShowEditContact(true)}><Text style={styles.editChipText}>Add contact</Text></Pressable>}
            </View>

            {showEditSubgroup && (
              <View style={styles.detailBlock}>
                <Text style={styles.fieldLabel}>Group</Text>
                <TextInput
                  value={editSubgroup}
                  onChangeText={setEditSubgroup}
                  style={styles.editField}
                  placeholder="Nebius, Gym, Calls"
                />
              </View>
            )}

            {showEditDeadline && (
              <View style={styles.detailBlock}>
                <Text style={styles.fieldLabel}>Time</Text>
                <Pressable style={styles.editPickerField} onPress={openCalendarPicker}>
                  <Text style={[styles.editPickerText, !editDueDate && styles.editPlaceholderText]}>{formatDueDateLabel(editDueDate)}</Text>
                </Pressable>
                {editDueDate ? (
                  <Pressable style={styles.inlineAction} onPress={() => setEditDueDate('')}>
                    <Text style={styles.inlineActionText}>Clear time</Text>
                  </Pressable>
                ) : null}
                {showTimePicker && NativeDateTimePicker ? (
                  <NativeDateTimePicker
                    value={timePickerMode === 'date' ? pendingDateValue : parseDueDateValue(editDueDate || pendingDateValue.toISOString())}
                    mode={timePickerMode}
                    is24Hour={false}
                    display={Platform.OS === 'ios' ? 'spinner' : timePickerMode === 'date' ? 'calendar' : 'default'}
                    onChange={handleTimeChange}
                  />
                ) : null}
                {!NativeDateTimePicker ? (
                  <TextInput
                    value={editDueDate}
                    onChangeText={setEditDueDate}
                    style={styles.editField}
                    placeholder="Type a time like tomorrow 7pm"
                  />
                ) : null}
              </View>
            )}

            {showEditLocation && (
              <View style={styles.detailBlock}>
                <View style={styles.contactHeaderRow}>
                  <Text style={styles.fieldLabel}>Location</Text>
                  <View style={styles.inlineActionsRow}>
                    <Pressable style={styles.inlineAction} onPress={handleUseCurrentLocation}>
                      <Text style={styles.inlineActionText}>Use current</Text>
                    </Pressable>
                    <Pressable style={styles.inlineAction} onPress={handleSearchLocationCandidates}>
                      <Text style={styles.inlineActionText}>Search map</Text>
                    </Pressable>
                    <Pressable style={styles.inlineAction} onPress={handleOpenMap}>
                      <Text style={styles.inlineActionText}>Open map</Text>
                    </Pressable>
                  </View>
                </View>
                <TextInput
                  value={editLocation}
                  onChangeText={(value) => {
                    setEditLocation(value);
                    setEditLocationCoords(null);
                    setEditLocationCandidates([]);
                  }}
                  style={styles.editField}
                  placeholder="Space gym, Nebius office, pharmacy"
                />
                {!!editLocationCandidates.length && (
                  <View style={styles.locationCandidatesList}>
                    {editLocationCandidates.map((candidate) => (
                      <View key={`${candidate.label}-${candidate.lat}-${candidate.lng}`} style={styles.locationCandidateCard}>
                        <Pressable
                          style={styles.locationCandidateMain}
                          onPress={() => {
                            setEditLocation(candidate.label);
                            setEditLocationCoords({ lat: candidate.lat, lng: candidate.lng });
                          }}
                        >
                          <Text style={styles.locationCandidateTitle}>{candidate.label}</Text>
                        </Pressable>
                        <Pressable style={styles.locationCandidateAction} onPress={() => handleOpenMapCandidate(candidate)}>
                          <Text style={styles.locationCandidateActionText}>Map</Text>
                        </Pressable>
                      </View>
                    ))}
                  </View>
                )}
                {!!knownLocations.length && (
                  <View style={styles.knownPlacesRow}>
                    {knownLocations.map((location) => (
                      <Pressable key={location} style={styles.knownPlaceChip} onPress={() => {
                        setEditLocation(location);
                        setEditLocationCoords(null);
                      }}>
                        <Text style={styles.knownPlaceText}>{location}</Text>
                      </Pressable>
                    ))}
                  </View>
                )}
              </View>
            )}

            {showEditContact && (
              <View style={styles.detailBlock}>
                <View style={styles.contactHeaderRow}>
                  <Text style={styles.fieldLabel}>Contact</Text>
                  <Pressable style={styles.inlineAction} onPress={handlePickContact}>
                    <Text style={styles.inlineActionText}>Pick from phone</Text>
                  </Pressable>
                </View>
                <TextInput
                  value={editContactName}
                  onChangeText={setEditContactName}
                  style={styles.editField}
                  placeholder="Person name"
                />
                <Text style={[styles.fieldLabel, styles.fieldLabelSecondary]}>Phone number</Text>
                <TextInput
                  value={editContactPhone}
                  onChangeText={setEditContactPhone}
                  style={styles.editField}
                  placeholder="050... or international number"
                  keyboardType="phone-pad"
                />
              </View>
            )}
            <View style={styles.editActions}>
              <Pressable style={styles.editDelete} onPress={handleDeleteEditTask}>
                <Text style={styles.editDeleteText}>Delete</Text>
              </Pressable>
              <Pressable style={styles.editCancel} onPress={closeEditTask}>
                <Text style={styles.editCancelText}>Cancel</Text>
              </Pressable>
              <Pressable style={styles.editSave} onPress={onSaveEdit}>
                <Text style={styles.editSaveText}>Save</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

// ── styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: BRAND.cream },
  content: { padding: 16, paddingBottom: 48 },

  // header
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  headerRight: { flexDirection: 'row', gap: 8 },
  headerBtn: {
    backgroundColor: BRAND.creamCard, borderRadius: RADIUS.pill, paddingHorizontal: 13, paddingVertical: 7,
    borderWidth: 1, borderColor: BRAND.line,
  },
  headerBtnText: { color: BRAND.inkSoft, fontFamily: FONTS.bodySemi, fontSize: 16 },

  // notices
  noticeBanner: {
    backgroundColor: BRAND.honey, borderRadius: RADIUS.chip, padding: 10, marginBottom: 12,
    borderWidth: 1, borderColor: BRAND.line,
  },
  noticeText: { color: BRAND.warmInk, fontFamily: FONTS.body, fontSize: 13, lineHeight: 18 },
  nudge: {
    backgroundColor: BRAND.sunGold, borderRadius: RADIUS.chip, paddingVertical: 10, paddingHorizontal: 16,
    marginBottom: 12, alignItems: 'center',
    ...SHADOWS.card,
  },
  nudgeText: { color: BRAND.warmInk, fontFamily: FONTS.bodyBold, fontSize: 14 },

  // two voice buttons
  voiceRow: { flexDirection: 'row', gap: 12, marginBottom: 16 },
  primaryBtn: {
    flex: 1, backgroundColor: BRAND.sunGold, borderRadius: RADIUS.button, paddingVertical: 22, paddingHorizontal: 10,
    alignItems: 'center',
    ...SHADOWS.button,
  },
  primaryBtnAlt: { backgroundColor: BRAND.creamCard, borderWidth: 2, borderColor: BRAND.sunGold },
  primaryBtnIcon: { fontSize: 34, marginBottom: 6 },
  primaryBtnLabel: { fontSize: 15, fontFamily: FONTS.displaySemi, color: BRAND.warmInk, marginBottom: 2 },
  primaryBtnLabelAlt: { color: BRAND.warmInk },
  primaryBtnSub: { fontSize: 11, fontFamily: FONTS.body, color: BRAND.inkSoft, textAlign: 'center' },
  primaryBtnSubAlt: { color: BRAND.inkSoft },

  // progress
  progressRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 20 },
  progressTrack: { flex: 1, height: 10, borderRadius: RADIUS.pill, backgroundColor: BRAND.line, overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: BRAND.sunGold, borderRadius: RADIUS.pill },
  progressLabel: { fontSize: 12, color: BRAND.inkSoft, fontFamily: FONTS.bodySemi, minWidth: 80, textAlign: 'right' },

  // subgroup grid
  section: { marginBottom: 20 },
  sectionTitle: { fontSize: 15, fontFamily: FONTS.displaySemi, color: BRAND.warmInk, marginBottom: 12 },
  iconGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  groupIcon: {
    width: '22%', borderRadius: RADIUS.card, paddingVertical: 12, paddingHorizontal: 4,
    alignItems: 'center', justifyContent: 'center', position: 'relative',
    ...SHADOWS.card,
  },
  addGroupIcon: { backgroundColor: BRAND.cream, borderWidth: 1.5, borderColor: BRAND.line, borderStyle: 'dashed' },
  addGroupPlus: { fontSize: 22, color: BRAND.inkFaint, marginBottom: 4 },
  groupEmoji: { fontSize: 28, marginBottom: 4 },
  groupName: { fontSize: 10, fontFamily: FONTS.bodyBold, color: BRAND.warmInk, textAlign: 'center' },
  groupCount: { fontSize: 10, fontFamily: FONTS.body, color: BRAND.inkSoft, marginTop: 1 },
  badge: {
    position: 'absolute', top: 6, right: 6, backgroundColor: BRAND.sunGold,
    borderRadius: RADIUS.pill, minWidth: 18, height: 18, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4,
  },
  badgeDone: { backgroundColor: BRAND.success },
  badgeText: { fontSize: 10, fontFamily: FONTS.bodyHeavy, color: BRAND.white },

  // backlog
  backlogCard: {
    backgroundColor: BRAND.creamCard, borderRadius: RADIUS.card, padding: 14,
    borderWidth: 1, borderColor: BRAND.line, marginBottom: 10,
    ...SHADOWS.card,
  },
  backlogTitle: { fontSize: 14, fontFamily: FONTS.displaySemi, color: BRAND.warmInk, marginBottom: 8 },
  backlogGroup: { marginBottom: 6 },
  backlogDate: { fontSize: 12, fontFamily: FONTS.bodyBold, color: BRAND.inkSoft, marginBottom: 2 },
  backlogTask: { fontSize: 12, fontFamily: FONTS.body, color: BRAND.warmInk, marginBottom: 1 },
  backlogMore: { fontSize: 11, fontFamily: FONTS.body, color: BRAND.inkFaint, fontStyle: 'italic' },

  // subgroup popup
  popupBackdrop: { flex: 1, backgroundColor: 'rgba(87,67,38,0.35)', justifyContent: 'flex-end' },
  popupCard: {
    backgroundColor: BRAND.cream, borderTopLeftRadius: RADIUS.card + 8, borderTopRightRadius: RADIUS.card + 8,
    paddingHorizontal: 16, paddingBottom: 36, maxHeight: '82%',
  },
  popupHandle: {
    width: 44, height: 4, backgroundColor: BRAND.line, borderRadius: 2,
    alignSelf: 'center', marginTop: 12, marginBottom: 16,
  },
  popupHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 14 },
  popupIcon: { fontSize: 36 },
  popupHeaderText: { flex: 1 },
  popupTitle: { fontSize: 20, fontFamily: FONTS.display, color: BRAND.warmInk },
  popupCount: { fontSize: 13, fontFamily: FONTS.body, color: BRAND.inkSoft },
  popupClose: {
    width: 32, height: 32, borderRadius: 16, backgroundColor: BRAND.line,
    alignItems: 'center', justifyContent: 'center',
  },
  popupCloseText: { color: BRAND.inkSoft, fontFamily: FONTS.bodyBold, fontSize: 14 },
  popupList: { flexShrink: 1 },
  popupAddBtn: {
    marginTop: 14, backgroundColor: BRAND.sunGold, borderRadius: RADIUS.button, paddingVertical: 13, alignItems: 'center',
    ...SHADOWS.button,
  },
  popupAddText: { color: BRAND.warmInk, fontFamily: FONTS.bodyBold, fontSize: 15 },

  // edit modal
  editBackdrop: { flex: 1, backgroundColor: 'rgba(87,67,38,0.42)', justifyContent: 'center', padding: 24 },
  editCard: { backgroundColor: BRAND.cream, borderRadius: RADIUS.card, padding: 20, ...SHADOWS.card },
  editTitle: { fontSize: 18, fontFamily: FONTS.display, color: BRAND.warmInk, marginBottom: 12 },
  editInput: {
    borderWidth: 1, borderColor: BRAND.line, borderRadius: RADIUS.chip, padding: 12,
    fontSize: 15, fontFamily: FONTS.body, color: BRAND.warmInk, backgroundColor: BRAND.creamCard, minHeight: 60,
  },
  editField: {
    borderWidth: 1,
    borderColor: BRAND.line,
    borderRadius: RADIUS.chip,
    padding: 12,
    fontSize: 14,
    fontFamily: FONTS.body,
    color: BRAND.warmInk,
    backgroundColor: BRAND.creamCard,
    marginTop: 10,
  },
  detailBlock: {
    marginTop: 12,
  },
  fieldLabel: {
    color: BRAND.inkSoft,
    fontSize: 13,
    fontFamily: FONTS.bodyBold,
    marginBottom: 6,
  },
  fieldLabelSecondary: {
    marginTop: 10,
  },
  editPickerField: {
    borderWidth: 1,
    borderColor: BRAND.line,
    borderRadius: RADIUS.chip,
    paddingHorizontal: 12,
    paddingVertical: 14,
    backgroundColor: BRAND.creamCard,
  },
  editPickerText: {
    color: BRAND.warmInk,
    fontSize: 14,
    fontFamily: FONTS.body,
  },
  editPlaceholderText: {
    color: BRAND.inkFaint,
  },
  editChipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
  },
  editChipButton: {
    backgroundColor: BRAND.honey,
    borderRadius: RADIUS.pill,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: BRAND.line,
  },
  editChipText: {
    color: BRAND.warmInk,
    fontSize: 12,
    fontFamily: FONTS.bodyBold,
  },
  knownPlacesRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
  },
  knownPlaceChip: {
    backgroundColor: BRAND.timeChipBg,
    borderRadius: RADIUS.pill,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  knownPlaceText: {
    color: BRAND.timeChipText,
    fontSize: 12,
    fontFamily: FONTS.bodySemi,
  },
  locationCandidatesList: {
    marginTop: 10,
    gap: 8,
  },
  locationCandidateCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: BRAND.creamCard,
    borderRadius: RADIUS.chip,
    borderWidth: 1,
    borderColor: BRAND.line,
    overflow: 'hidden',
  },
  locationCandidateMain: {
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  locationCandidateTitle: {
    color: BRAND.warmInk,
    fontSize: 13,
    fontFamily: FONTS.bodySemi,
  },
  locationCandidateAction: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: BRAND.honey,
  },
  locationCandidateActionText: {
    color: BRAND.warmInk,
    fontSize: 12,
    fontFamily: FONTS.bodyBold,
  },
  contactHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  inlineActionsRow: {
    flexDirection: 'row',
    gap: 10,
  },
  inlineAction: {
    alignSelf: 'flex-start',
    paddingVertical: 4,
  },
  inlineActionText: {
    color: BRAND.timeChipText,
    fontSize: 12,
    fontFamily: FONTS.bodyBold,
  },
  editActions: { flexDirection: 'row', gap: 10, marginTop: 14 },
  editDelete: { flex: 1, paddingVertical: 12, borderRadius: RADIUS.chip, backgroundColor: BRAND.peach, alignItems: 'center' },
  editDeleteText: { color: BRAND.warmInk, fontFamily: FONTS.bodyBold },
  editCancel: { flex: 1, paddingVertical: 12, borderRadius: RADIUS.chip, backgroundColor: BRAND.line, alignItems: 'center' },
  editCancelText: { color: BRAND.inkSoft, fontFamily: FONTS.bodySemi },
  editSave: { flex: 1, paddingVertical: 12, borderRadius: RADIUS.chip, backgroundColor: BRAND.sunGold, alignItems: 'center' },
  editSaveText: { color: BRAND.warmInk, fontFamily: FONTS.bodyBold },
});
