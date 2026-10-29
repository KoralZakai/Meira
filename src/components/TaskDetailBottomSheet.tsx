/** TaskDetailBottomSheet — bottom-sheet editor for a task (time, location, contact, subtasks). */
import React, { useEffect, useState } from 'react';
import {
  View,
  Switch,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  Dimensions,
  TextInput,
  ScrollView,
  ActivityIndicator,
  Alert,
  Platform,
  Linking,
} from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { allDayPatch, endPatch, isAllDay, lastDay, spanDays, startPatch } from '../utils/allDay';
import { Task, AppLanguage, TaskPriority, Subtask, TaskLocation, TransportType } from '../types';
import { BRAND, COLORS, PRIORITY_META, FONTS, RADIUS, surf, nink } from '../constants/theme';
import { getCategoryMeta, allCategories, createCustomCategory, CategoryEntry } from '../constants/categories';
import { searchLocationCandidates, openLocationInMaps } from '../services/NearbyTaskReminderService';
import { meetingProvider, extractMeetingUrl } from '../utils/meetingLink';
import { extractTaskTags } from '../services/TaskParser';
import { GoogleService } from '../services/GoogleService';
import { loadProfile } from '../services/UserProfileStorage';
import { moveTasksToDate } from '../services/TaskStorage';
import RouteMap from './RouteMap';
import { untilAfterFromChange, rangeMinutes } from '../utils/timeRange';
import OnYourWayCard from './OnYourWayCard';
import { TaskPrepSection } from './TaskPrepCard';
import { sourceLinkOf } from '../utils/sourceLink';
import EventDetailsSection from './EventDetailsSection';

import TaskSheetHero from './today/TaskSheetHero';
import { keepOpen, moveToChosenSlot } from '../services/RunningLate';
import LineIcon, { LineIconName } from './ui/LineIcon';
import { originText, shortPlace } from '../utils/tripPlaces';
import { contactPhoneOf } from '../utils/lateNotice';


const TRANSPORTS: Array<{ key: TransportType; icon: string; en: string; he: string }> = [
  { key: 'bus', icon: '🚌', en: 'Bus', he: 'אוטובוס' },
  { key: 'train', icon: '🚆', en: 'Train', he: 'רכבת' },
  { key: 'car', icon: '🚗', en: 'Car', he: 'רכב' },
  { key: 'walk', icon: '🚶', en: 'Walk', he: 'הליכה' },
  { key: 'bike', icon: '🚲', en: 'Bike', he: 'אופניים' },
];

interface TaskDetailBottomSheetProps {
  task: Task;
  visible: boolean;
  onClose: () => void;
  onComplete: () => void;
  language: AppLanguage;
  onUpdate?: (patch: Partial<Task>) => void | Promise<void>;
  onDelete?: () => void | Promise<void>;
}

const PRIORITIES: TaskPriority[] = ['must', 'have_to', 'need_to', 'nice_to_do'];
const pad = (n: number) => String(n).padStart(2, '0');

function shortDate(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? `${Number(iso.slice(8, 10))}.${Number(iso.slice(5, 7))}` : iso;
}

function deadlineToDate(value?: string): Date {
  if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  return new Date();
}

function formatDeadline(value: string, isHe: boolean): string {
  return deadlineToDate(value).toLocaleDateString(isHe ? 'he-IL' : 'en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

// Build a Date from a task's YYYY-MM-DD date + HH:MM time, for the date+time picker.
function taskDateTime(dateStr?: string, time?: string): Date {
  const d = dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? deadlineToDate(dateStr) : new Date();
  if (time && /^\d{1,2}:\d{2}$/.test(time)) {
    const [h, m] = time.split(':').map(Number);
    d.setHours(h, m, 0, 0);
  }
  return d;
}

const toDateStr = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const timeToDate = (hhmm?: string): Date => {
  const d = new Date();
  if (hhmm && /^\d{1,2}:\d{2}$/.test(hhmm)) {
    const [h, m] = hhmm.split(':').map(Number);
    d.setHours(h, m, 0, 0);
  }
  return d;
};
// Minutes from a start HH:MM to an end HH:MM, wrapping past midnight.
const minutesBetween = (from: string, to: string): number => {
  const [fh, fm] = from.split(':').map(Number);
  const [th, tm] = to.split(':').map(Number);
  let diff = (th * 60 + tm) - (fh * 60 + fm);
  if (diff < 0) diff += 1440;
  return diff;
};
const addMinutesToTime = (hhmm: string, mins: number): string => {
  const [h, m] = hhmm.split(':').map(Number);
  const t = (((h * 60 + m + mins) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
};

// Human duration, in hours where it helps: 30→"30m", 90→"1h 30m", 480→"8h".
export const formatDuration = (mins?: number): string => {
  if (!mins || mins <= 0) return '—';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
};

const makeSubtaskId = () => `st_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

export default function TaskDetailBottomSheet({
  task,
  visible,
  onClose,
  onComplete,
  language,
  onUpdate,
  onDelete,
}: TaskDetailBottomSheetProps) {
  const isHe = language === 'he';
  const editable = !!onUpdate;

  const confirmDelete = () => {
    Alert.alert(
      isHe ? 'למחוק משימה?' : 'Delete task?',
      isHe ? 'הפעולה אינה ניתנת לביטול.' : 'This cannot be undone.',
      [
        { text: isHe ? 'ביטול' : 'Cancel', style: 'cancel' },
        { text: isHe ? 'מחק' : 'Delete', style: 'destructive', onPress: () => onDelete?.() },
      ],
    );
  };

  const [editingCategory, setEditingCategory] = useState(false);
  // The Google account the source event/email was read from, so its link opens
  // the exact item rather than the day.
  const [sourceEmail, setSourceEmail] = useState<string | undefined>();
  useEffect(() => {
    let alive = true;
    GoogleService.listGoogleAccounts()
      .then((a) => { if (alive) setSourceEmail(a.length === 1 && a[0].email ? a[0].email : undefined); })
      .catch((e) => console.warn('[TaskDetail] google accounts', String(e?.message || e)));
    return () => { alive = false; };
  }, []);
  const [creating, setCreating] = useState(false);
  const [newCatName, setNewCatName] = useState('');
  const [cats, setCats] = useState<CategoryEntry[]>(() => allCategories());

  // Local editable field state (synced whenever a different task opens).
  const [titleText, setTitleText] = useState(task.text);
  const [notesText, setNotesText] = useState(task.progress ?? '');
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showEndPicker, setShowEndPicker] = useState(false);
  const [timeField, setTimeField] = useState<'from' | 'to' | null>(null);
  const [editingEmail, setEditingEmail] = useState(false);
  const [emailDraft, setEmailDraft] = useState('');
  const [editingMeeting, setEditingMeeting] = useState(false);
  const [meetingDraft, setMeetingDraft] = useState('');
  const [showDeadlinePicker, setShowDeadlinePicker] = useState(false);
  const [newSubtask, setNewSubtask] = useState('');

  const [locQuery, setLocQuery] = useState('');
  const [locCandidates, setLocCandidates] = useState<{ label: string; lat: number; lng: number }[]>([]);
  const [locSearching, setLocSearching] = useState(false);
  const [transportBusy, setTransportBusy] = useState(false);

  useEffect(() => {
    setTitleText(task.text);
    setNotesText(task.progress ?? '');
    setEditingCategory(false);
    setCreating(false);
    setNewCatName('');
    setLocQuery('');
    setLocCandidates([]);
    setNewSubtask('');
    setShowDeadlinePicker(false);
  }, [task.id]);

  const categoryMeta = getCategoryMeta(task.category);
  const priorityMeta = PRIORITY_META[task.priority ?? 'need_to'] || PRIORITY_META.need_to;
  const timeLabel = task.fixedTime || task.scheduledTime;
  const locationLabel =
    typeof task.location === 'string'
      ? task.location
      : task.location?.displayName || task.location?.address || '';

  const commit = (patch: Partial<Task>) => onUpdate?.(patch);

  // Per-task transport override: save the choice, then recompute the route +
  // leaveHomeBy for the new mode (needs a located task with an arrival time).
  const objLocation = typeof task.location === 'object' && task.location ? (task.location as TaskLocation) : null;

  /**
   * Reschedule = pick a new clock time. A completed task is reopened first,
   * otherwise the new time would sit on something already ticked off and the
   * alarm would never fire.
   */
  const rescheduleNow = () => {
    // Koral 28.10: reschedule = a new date and hour NOW, or "later" — then it waits
    // in the 🔔 ("צריך לקבוע מועד") so she remembers to set it.
    Alert.alert(isHe ? `${task.text} — מתי?` : `${task.text} — when?`, undefined, [
      { text: isHe ? 'ביטול' : 'Cancel', style: 'cancel' },
      {
        text: isHe ? '⏳ אחר כך — להזכיר לי' : '⏳ Later — remind me',
        onPress: () => {
          keepOpen(task, isHe)
            .then(() => { Alert.alert(isHe ? 'נכנס להתראות 🔔 — אזכיר לך לקבוע מועד ✓' : "In your 🔔 — I'll remind you to set a date ✓"); onClose(); })
            .catch((e) => Alert.alert(isHe ? 'לא נשמר' : 'Not saved', String(e)));
        },
      },
      {
        text: isHe ? '📅 תאריך ושעה עכשיו' : '📅 Date and hour now',
        onPress: () => {
          if (task.status === 'complete') commit({ status: 'pending', completedAt: undefined });
          moveToChosenSlot(task, isHe).then((ok) => { if (ok) onClose(); })
            .catch((e) => Alert.alert(isHe ? 'לא נשמר' : 'Not saved', String(e)));
        },
      },
    ]);
  };

  /**
   * Same task, tomorrow. moveTasksToDate owns this: it drops the route
   * computed for the old day, clears the slot Lumi assigned, wipes the stale
   * notification ids and re-arms the alerts for the new date. Rebuilding any
   * of that here would get one of them wrong.
   */
  const moveToTomorrow = async () => {
    const from = deadlineToDate(task.date);
    from.setDate(from.getDate() + 1);
    await moveTasksToDate(
      [task.id],
      `${from.getFullYear()}-${pad(from.getMonth() + 1)}-${pad(from.getDate())}`,
    ).catch(() => {});
    onClose();
  };

  const changeTransport = async (mode: TransportType) => {
    if (!objLocation) return;
    commit({ location: { ...objLocation, transportType: mode } });
    const arrival = task.fixedTime || task.scheduledTime;
    if (!arrival) return;
    setTransportBusy(true);
    try {
      const profile = await loadProfile();
      if (!profile) return;
      // Bridge models/UserProfile (homeLatLng object) to the routing shape
      // GoogleService expects (homeLat/homeLng flats) — same pattern as
      // LumiCoachEngine's gProfile.
      const gProfile = {
        ...profile,
        homeLat: profile.homeLatLng?.lat,
        homeLng: profile.homeLatLng?.lng,
      } as any;
      const plan = await GoogleService.getPlanForMode(
        mode,
        objLocation.address || objLocation.displayName || locationLabel,
        arrival,
        gProfile,
        task.date,
      );
      if (plan) {
        commit({
          location: {
            ...objLocation,
            transportType: mode,
            transitPlan: plan,
            leaveHomeBy: plan.leaveHomeAt,
            travelMinutes: plan.totalDurationMinutes,
          },
        });
      }
    } finally {
      setTransportBusy(false);
    }
  };

  // Flush any not-yet-committed text edits (title/notes may not have blurred), then close.
  const saveAndClose = () => {
    const t = titleText.trim();
    if (t && t !== task.text) commit({ text: t, tags: extractTaskTags(t) });
    if (notesText !== (task.progress ?? '')) commit({ progress: notesText });
    onClose();
  };

  const selectCategory = async (key: string) => {
    setEditingCategory(false);
    setCreating(false);
    setNewCatName('');
    await commit({ category: key as Task['category'] });
  };

  const handleCreateCategory = async () => {
    if (!newCatName.trim()) return;
    const key = await createCustomCategory(newCatName);
    setCats(allCategories());
    await selectCategory(key);
  };

  // Start/end of the time range. Start is fixedTime; end is endTime, or derived
  // from start + duration when only a start was ever set.
  const fromTime = task.fixedTime || task.scheduledTime || '';
  const toTime = task.endTime || (fromTime ? addMinutesToTime(fromTime, task.durationMinutes || 30) : '');

  const onDateChange = (event: any, selected?: Date) => {
    setShowDatePicker(false);
    if (event?.type === 'dismissed' || !selected) return;
    commit(startPatch(task, toDateStr(selected)));
  };

  // The last day of an all-day range (utils/allDay). Before the first = one day.
  const onEndDateChange = (event: any, selected?: Date) => {
    setShowEndPicker(false);
    if (event?.type === 'dismissed' || !selected) return;
    commit(endPatch(task, toDateStr(selected)));
  };

  // From/To time pickers → set fixedTime + endTime, and derive durationMinutes.
  const onRangeChange = (event: any, selected?: Date) => {
    const field = timeField;
    setTimeField(null);
    if (Platform.OS === 'android' && event?.type !== 'set') return;
    if (!selected || !field) return;
    const hhmm = `${pad(selected.getHours())}:${pad(selected.getMinutes())}`;
    if (field === 'from') {
      // Moving the start moves the whole block (utils/timeRange). It kept the
      // old end, so 14:00–15:00 moved to 16:00 became 16:00–15:00.
      const end = untilAfterFromChange(fromTime || undefined, toTime || undefined, hhmm, task.durationMinutes || 60);
      commit({ fixedTime: hhmm, scheduledTime: hhmm, isFixed: true, endTime: end, durationMinutes: rangeMinutes(hhmm, end) });
    } else {
      const start = fromTime || hhmm;
      commit({
        endTime: hhmm,
        durationMinutes: minutesBetween(start, hhmm),
        ...(fromTime ? {} : { fixedTime: hhmm, scheduledTime: hhmm, isFixed: true }),
      });
    }
  };

  // Repeat: pick which weekdays this task recurs on (0=Sun … 6=Sat).
  const weekdayLabels = isHe ? ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'] : ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const repeatDays = task.repeatDays ?? [];
  const toggleRepeatDay = (d: number) => {
    const next = repeatDays.includes(d)
      ? repeatDays.filter((x) => x !== d)
      : [...repeatDays, d].sort((a, b) => a - b);
    commit({ repeatDays: next });
  };

  const onDeadlineChange = (event: any, selected?: Date) => {
    setShowDeadlinePicker(false);
    if (event?.type === 'dismissed' || !selected) return;
    commit({ deadline: `${selected.getFullYear()}-${pad(selected.getMonth() + 1)}-${pad(selected.getDate())}` });
  };

  // ── Subtasks ──────────────────────────────────────────────
  const subtasks: Subtask[] = task.subtasks ?? [];

  const addSubtask = () => {
    const t = newSubtask.trim();
    if (!t) return;
    const next: Subtask[] = [
      ...subtasks,
      { id: makeSubtaskId(), text: t, status: 'pending', durationMinutes: 0, order: subtasks.length },
    ];
    setNewSubtask('');
    commit({ subtasks: next });
  };

  const toggleSubtask = (id: string) => {
    const next = subtasks.map((s) =>
      s.id === id ? { ...s, status: s.status === 'complete' ? 'pending' : 'complete' } as Subtask : s,
    );
    commit({ subtasks: next });
  };

  const removeSubtask = (id: string) => {
    const next = subtasks
      .filter((s) => s.id !== id)
      .map((s, i) => ({ ...s, order: i }));
    commit({ subtasks: next });
  };

  const runLocationSearch = async () => {
    if (!locQuery.trim()) return;
    setLocSearching(true);
    setLocCandidates([]);
    try {
      setLocCandidates(await searchLocationCandidates(locQuery.trim()));
    } catch (e) {
      console.log('[TaskEdit] location search error:', e);
    } finally {
      setLocSearching(false);
    }
  };

  const pickLocation = async (c: { label: string; lat: number; lng: number }) => {
    setLocCandidates([]);
    setLocQuery('');
    await commit({
      location: { address: c.label, displayName: c.label, lat: c.lat, lng: c.lng, confirmed: true },
      hasLocation: true,
      locationLat: c.lat,
      locationLng: c.lng,
    });
    // Open the map so the user can verify the exact place.
    openLocationInMaps(c.label, { lat: c.lat, lng: c.lng });
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.handleBar} />

          {/* Canvas v4 "עריכת משימה": ✕ · the title · save. Every field below saves as she
              changes it; "שמירה" also keeps a title still being typed, then closes. */}
          <View style={[styles.editHead, { flexDirection: isHe ? 'row-reverse' : 'row' }]}>
            <TouchableOpacity style={styles.editX} onPress={onClose} accessibilityRole="button" accessibilityLabel={isHe ? 'סגירה' : 'Close'}>
              <Text style={styles.editXText}>×</Text>
            </TouchableOpacity>
            <Text style={styles.editTitle} numberOfLines={1}>{isHe ? 'עריכת משימה' : 'Edit task'}</Text>
            <TouchableOpacity style={styles.editSave} accessibilityRole="button"
              onPress={() => {
                const t = titleText.trim();
                if (editable && t && t !== task.text) commit({ text: t, tags: extractTaskTags(t) });
                onClose();
              }}>
              <Text style={styles.editSaveText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>{isHe ? 'שמירה' : 'Save'}</Text>
            </TouchableOpacity>
          </View>

          <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            {/* Title — editable */}
            {editable ? (
              <TextInput
                style={styles.titleInput}
                value={titleText}
                onChangeText={setTitleText}
                onBlur={() => {
                  const t = titleText.trim();
                  if (t && t !== task.text) commit({ text: t, tags: extractTaskTags(t) });
                }}
                multiline
                placeholder={isHe ? 'תיאור המשימה' : 'Task description'}
                placeholderTextColor={BRAND.inkSoft}
              />
            ) : (
              <Text style={styles.taskTitle}>{task.text}</Text>
            )}

            {/* Canvas v4: when (±5) · from → to · how · the leave reminder · who. */}
            {editable ? (() => {
              const dir = isHe ? 'row-reverse' : 'row';
              const rtl = isHe ? styles.rtlText : null;
              const shift = (d: number) => {
                if (!fromTime) { setTimeField('from'); return; }
                const nf = addMinutesToTime(fromTime, d);
                const nt = toTime ? addMinutesToTime(toTime, d) : undefined;
                commit({ fixedTime: nf, scheduledTime: nf, isFixed: true, ...(nt ? { endTime: nt } : {}) });
              };
              const place = objLocation ? shortPlace(objLocation.displayName || objLocation.address) : '';
              const from = originText((objLocation as any)?.transitPlan?.originLabel, isHe);
              const leave = objLocation?.leaveHomeBy;
              const phone = contactPhoneOf(task);
              const who = (task as any).contact?.name || task.contactName || '';
              const MODES: Array<[TransportType, LineIconName, string]> = [
                ['walk', 'walk', isHe ? 'הליכה' : 'Walk'], ['bike', 'bike', isHe ? 'אופניים' : 'Bike'],
                ['bus', 'bus', isHe ? 'אוטובוס' : 'Bus'], ['train', 'train', isHe ? 'רכבת' : 'Train'], ['car', 'car', isHe ? 'רכב' : 'Car'],
              ];
              return (
                <View style={styles.core}>
                  <View style={styles.coreCard}>
                    <View style={[styles.coreRow, { flexDirection: dir }]}>
                      <View style={[styles.coreIcon, { backgroundColor: surf('#E5F0FF') }]}><LineIcon name="calendar" size={18} color="#2F6FD6" /></View>
                      <TouchableOpacity style={{ flex: 1, minWidth: 0 }} onPress={() => setShowDatePicker(true)} accessibilityRole="button">
                        <Text style={[styles.coreLabel, rtl]}>{isHe ? 'מתי' : 'When'}</Text>
                        <Text style={[styles.coreValue, rtl]} numberOfLines={1}>{formatDeadline(task.date, isHe)}</Text>
                      </TouchableOpacity>
                    </View>
                    {/* 29.10: a whole day, or from date to date — no hours (utils/allDay). */}
                    <View style={[styles.coreRow, { flexDirection: dir, marginTop: 4 }]}>
                      <Text style={[styles.coreValue, rtl, { flex: 1, minWidth: 0 }]} numberOfLines={1}>{isHe ? 'כל היום' : 'All day'}</Text>
                      <Switch
                        value={isAllDay(task)}
                        onValueChange={(on) => commit(allDayPatch(on, task))}
                        trackColor={{ false: BRAND.line, true: BRAND.sunGold }}
                        thumbColor={BRAND.white}
                        accessibilityLabel={isHe ? 'כל היום' : 'All day'}
                      />
                    </View>
                    {isAllDay(task) ? (
                      <View style={[styles.stepRow, { flexDirection: dir }]}>
                        <TouchableOpacity style={[styles.timeBtn, styles.dateBtn]} onPress={() => setShowDatePicker(true)} accessibilityRole="button"
                          accessibilityLabel={isHe ? 'מתאריך' : 'From date'}>
                          <Text style={styles.timeText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>{shortDate(task.date)}</Text>
                        </TouchableOpacity>
                        <Text style={styles.stepArrow}>{isHe ? '←' : '→'}</Text>
                        <TouchableOpacity style={[styles.timeBtn, styles.dateBtn]} onPress={() => setShowEndPicker(true)} accessibilityRole="button"
                          accessibilityLabel={isHe ? 'עד תאריך' : 'To date'}>
                          <Text style={styles.timeText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>
                            {task.endDate ? shortDate(lastDay(task)) : (isHe ? 'עד…' : 'Until…')}
                          </Text>
                        </TouchableOpacity>
                        {spanDays(task) > 1 ? (
                          <Text style={[styles.coreLabel, { flexShrink: 1 }]} numberOfLines={1}>
                            {isHe ? `${spanDays(task)} ימים` : `${spanDays(task)} days`}
                          </Text>
                        ) : null}
                      </View>
                    ) : (
                    <View style={[styles.stepRow, { flexDirection: dir }]}>
                      <TouchableOpacity style={styles.stepBtn} onPress={() => shift(-5)} accessibilityRole="button" accessibilityLabel={isHe ? '5 דקות מוקדם יותר' : '5 minutes earlier'}>
                        <Text style={styles.stepText} numberOfLines={1}>−5</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={styles.timeBtn} onPress={() => setTimeField('from')} accessibilityRole="button">
                        <Text style={styles.timeText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>{fromTime || (isHe ? 'שעה' : 'Time')}</Text>
                      </TouchableOpacity>
                      <Text style={styles.stepArrow}>{isHe ? '←' : '→'}</Text>
                      <TouchableOpacity style={styles.timeBtn} onPress={() => setTimeField('to')} accessibilityRole="button">
                        <Text style={styles.timeText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>{toTime || (isHe ? 'עד' : 'Until')}</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={styles.stepBtn} onPress={() => shift(5)} accessibilityRole="button" accessibilityLabel={isHe ? '5 דקות מאוחר יותר' : '5 minutes later'}>
                        <Text style={styles.stepText} numberOfLines={1}>+5</Text>
                      </TouchableOpacity>
                    </View>
                    )}
                  </View>

                  {place ? (
                    <View style={styles.coreCard}>
                      <View style={[styles.coreRow, { flexDirection: dir }]}>
                        <View style={[styles.coreIcon, { backgroundColor: surf('#FFF1C7') }]}><LineIcon name="home" size={18} color="#B87F00" /></View>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={[styles.coreLabel, rtl]}>{isHe ? 'מאיפה' : 'From'}</Text>
                          <Text style={[styles.coreValue, rtl]} numberOfLines={1}>{from}</Text>
                        </View>
                      </View>
                      <View style={[styles.thread, isHe ? { marginRight: 18 } : { marginLeft: 18 }]} />
                      <View style={[styles.coreRow, { flexDirection: dir }]}>
                        <View style={[styles.coreIcon, { backgroundColor: surf('#F1E7FF') }]}><LineIcon name="pin" size={18} color="#7A3FC4" /></View>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={[styles.coreLabel, rtl]}>{isHe ? 'לאן' : 'To'}</Text>
                          <Text style={[styles.coreValue, rtl]} numberOfLines={2}>{place}</Text>
                        </View>
                      </View>
                      <Text style={[styles.coreLabel, rtl, { marginTop: 8 }]}>{isHe ? 'איך' : 'How'}</Text>
                      <View style={[styles.modeRow, { flexDirection: dir }]}>
                        {MODES.map(([key, icon, label]) => {
                          const on = objLocation?.transportType === key;
                          return (
                            <TouchableOpacity key={key} style={[styles.modeBtn, on && styles.modeBtnOn]} disabled={transportBusy}
                              onPress={() => { changeTransport(key).catch((e) => console.warn('[Sheet] transport not changed', e)); }}
                              accessibilityRole="button" accessibilityState={{ selected: on }} accessibilityLabel={label}>
                              <LineIcon name={icon} size={18} color={on ? BRAND.white : BRAND.inkSoft} />
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                      {transportBusy ? <ActivityIndicator color={BRAND.sunGold} size="small" /> : null}
                    </View>
                  ) : null}

                  {leave ? (
                    <View style={[styles.coreCard, styles.coreRow, { flexDirection: dir }]}>
                      <View style={[styles.coreIcon, { backgroundColor: surf('#FFE3EA') }]}><LineIcon name="bell" size={18} color="#D6335A" /></View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={[styles.coreLabel, rtl]}>{isHe ? 'תזכורת יציאה' : 'Leave reminder'}</Text>
                        <Text style={[styles.coreValue, rtl]} numberOfLines={1}>{isHe ? `בשעת היציאה · ${leave}` : `At leave time · ${leave}`}</Text>
                      </View>
                    </View>
                  ) : null}

                  <View style={[styles.coreCard, styles.coreRow, { flexDirection: dir }, !(who || phone) && styles.coreMissing]}>
                    <View style={[styles.coreIcon, { backgroundColor: 'rgba(20,27,46,0.05)' }]}><LineIcon name="user" size={18} color={BRAND.inkSoft} /></View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={[styles.coreLabel, rtl]}>{isHe ? 'איש קשר' : 'Contact'}</Text>
                      <Text style={[styles.coreValue, rtl, !(who || phone) && { color: BRAND.inkSoft }]} numberOfLines={1}>
                        {who || phone || (isHe ? '+ אפשר להוסיף למטה — כדי לעדכן אם תאחרי' : '+ Add one below — so I can tell them if you are late')}
                      </Text>
                    </View>
                    {phone ? (
                      <TouchableOpacity style={styles.coreCall} accessibilityRole="button" accessibilityLabel={isHe ? 'להתקשר' : 'Call'}
                        onPress={() => Linking.openURL(`tel:${phone.replace(/[^\d+]/g, '')}`).catch((e) => console.warn('[Sheet] call failed', e))}>
                        <LineIcon name="phone" size={18} color={BRAND.goldInk} />
                      </TouchableOpacity>
                    ) : null}
                  </View>

                  <Text style={[styles.coreNote, rtl]}>{isHe ? '✨ שינוי שעה או מקום — אחשב מחדש את ההלוך והחזור' : '✨ Change the hour or place — I will re-plan the way there and back'}</Text>
                  <Text style={[styles.moreCap, rtl]}>{isHe ? 'עוד פרטים' : 'More details'}</Text>
                </View>
              );
            })() : null}

            <View style={styles.detailsSection}>
              {/* Where this came from — the email or calendar event behind it,
                  derived from ids the task already has (utils/sourceLink). */}
              {(() => {
                // A Google event gets the full section below (link, guests, text,
                // join link, files); this row is for the email / Outlook origins.
                const googleEventId = String(task.id).startsWith('gcal-') && task.calendarEventId && !String(task.calendarEventId).includes(':')
                  ? String(task.calendarEventId) : '';
                if (googleEventId) return <EventDetailsSection eventId={googleEventId} he={isHe} />;
                const link = sourceLinkOf(task, sourceEmail);
                if (!link) return null;
                return (
                  <View style={styles.detailRow}>
                    <Text style={styles.detailIcon}>{link.kind === 'gmail' ? '📧' : '📅'}</Text>
                    <TouchableOpacity
                      style={{ flex: 1 }}
                      onPress={() => Linking.openURL(link.url).catch((e) => console.warn('[TaskDetail] open source', String(e?.message || e)))}
                    >
                      <Text style={[styles.detailLabel, styles.linkLabel]} numberOfLines={1}>
                        {isHe ? link.labelHe : link.labelEn}
                      </Text>
                    </TouchableOpacity>
                  </View>
                );
              })()}
              {/* Join link — a video call had nowhere to live, so it used to be
                  typed into `location` and then planned as a journey. */}
              {/* Editable, not just readable. A Zoom link that arrives by
                  WhatsApp rather than on an invite had nowhere to go: the row
                  only rendered once `meetingUrl` was already set, so the one
                  case where she needs to type it was the case with no field. */}
              {task.meetingUrl && !editingMeeting ? (
                <View style={styles.detailRow}>
                  <Text style={styles.detailIcon}>💻</Text>
                  <TouchableOpacity
                    style={{ flex: 1 }}
                    onPress={() => Linking.openURL(task.meetingUrl!).catch(() => {})}
                  >
                    <Text style={[styles.detailLabel, styles.linkLabel]} numberOfLines={1}>
                      {isHe
                        ? `הצטרפי ל-${meetingProvider(task.meetingUrl) || 'שיחה'}`
                        : `Join ${meetingProvider(task.meetingUrl) || 'call'}`}
                    </Text>
                  </TouchableOpacity>
                  {editable && (
                    <TouchableOpacity onPress={() => { setMeetingDraft(task.meetingUrl || ''); setEditingMeeting(true); }}>
                      <Text style={styles.editHint}>✏️</Text>
                    </TouchableOpacity>
                  )}
                </View>
              ) : null}

              {editable && (!task.meetingUrl || editingMeeting) ? (
                <View style={styles.detailRow}>
                  <Text style={styles.detailIcon}>💻</Text>
                  <TextInput
                    style={[styles.detailLabel, styles.inlineInput]}
                    value={meetingDraft}
                    onChangeText={setMeetingDraft}
                    placeholder={isHe ? 'קישור לזום / מיט' : 'Zoom / Meet link'}
                    placeholderTextColor={BRAND.inkFaint}
                    autoCapitalize="none"
                    keyboardType="url"
                    onBlur={() => {
                      const url = extractMeetingUrl(meetingDraft) || meetingDraft.trim();
                      commit({ meetingUrl: url || undefined } as Partial<Task>);
                      setEditingMeeting(false);
                    }}
                  />
                </View>
              ) : null}

              {/* Who it is with. Names and emails came in on the invite and
                  were thrown away — the phone/name fields existed, email did not. */}
              {(editable || task.contactName || task.contactEmail || (task.attendees?.length ?? 0) > 0) && (
                <View style={styles.detailRow}>
                  <Text style={styles.detailIcon}>👤</Text>
                  <View style={{ flex: 1 }}>
                    {task.contactName ? (
                      <Text style={styles.detailLabel}>{task.contactName}</Text>
                    ) : null}
                    {(task.contactEmail || task.attendees?.[0]) && !editingEmail ? (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <TouchableOpacity
                          style={{ flex: 1 }}
                          onPress={() => {
                            const to = task.contactEmail || task.attendees?.[0];
                            if (to) Linking.openURL(`mailto:${to}`).catch(() => {});
                          }}
                        >
                          <Text style={[styles.detailLabel, styles.linkLabel]} numberOfLines={1}>
                            {task.contactEmail || task.attendees?.[0]}
                          </Text>
                        </TouchableOpacity>
                        {editable && (
                          <TouchableOpacity onPress={() => { setEmailDraft(task.contactEmail || ''); setEditingEmail(true); }}>
                            <Text style={styles.editHint}>✏️</Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    ) : null}
                    {editable && (!(task.contactEmail || task.attendees?.[0]) || editingEmail) ? (
                      <TextInput
                        style={[styles.detailLabel, styles.inlineInput]}
                        value={emailDraft}
                        onChangeText={setEmailDraft}
                        placeholder={isHe ? 'אימייל' : 'Email address'}
                        placeholderTextColor={BRAND.inkFaint}
                        autoCapitalize="none"
                        keyboardType="email-address"
                        onBlur={() => {
                          commit({ contactEmail: emailDraft.trim() || undefined } as Partial<Task>);
                          setEditingEmail(false);
                        }}
                      />
                    ) : null}
                    {(task.attendees?.length ?? 0) > 1 ? (
                      <Text style={styles.editHint}>
                        {isHe ? `ועוד ${task.attendees!.length - 1}` : `+${task.attendees!.length - 1} more`}
                      </Text>
                    ) : null}
                  </View>
                </View>
              )}

              {/* Category */}
              <TouchableOpacity
                style={styles.detailRow}
                activeOpacity={editable ? 0.6 : 1}
                onPress={() => editable && setEditingCategory((v) => !v)}
              >
                <Text style={styles.detailIcon}>{categoryMeta.icon}</Text>
                <Text style={styles.detailLabel}>{isHe ? categoryMeta.labelHe : categoryMeta.labelEn}</Text>
                <View style={[styles.colorBox, { backgroundColor: categoryMeta.color }]} />
                {editable && <Text style={styles.editHint}>{editingCategory ? '▼' : '✏️'}</Text>}
              </TouchableOpacity>

              {editingCategory && editable && (
                <View style={styles.editPanel}>
                  <View style={styles.chipsWrap}>
                    {cats.map((c) => {
                      const selected = task.category === c.key;
                      return (
                        <TouchableOpacity
                          key={c.key}
                          onPress={() => selectCategory(c.key)}
                          style={[styles.chip, selected && { borderColor: c.color, backgroundColor: c.color + '22' }]}
                          activeOpacity={0.7}
                        >
                          <Text style={styles.chipIcon}>{c.icon}</Text>
                          <Text style={styles.chipLabel}>{isHe ? c.labelHe : c.labelEn}</Text>
                        </TouchableOpacity>
                      );
                    })}
                    {!creating && (
                      <TouchableOpacity onPress={() => setCreating(true)} style={[styles.chip, styles.chipNew]} activeOpacity={0.7}>
                        <Text style={styles.chipIcon}>➕</Text>
                        <Text style={[styles.chipLabel, { color: BRAND.sunGold }]}>{isHe ? 'חדש' : 'New'}</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                  {creating && (
                    <View style={styles.newRow}>
                      <TextInput
                        value={newCatName}
                        onChangeText={setNewCatName}
                        placeholder={isHe ? 'שם קטגוריה חדשה' : 'New category name'}
                        placeholderTextColor={BRAND.inkSoft}
                        autoFocus
                        style={styles.newInput}
                        onSubmitEditing={handleCreateCategory}
                        returnKeyType="done"
                      />
                      <TouchableOpacity onPress={handleCreateCategory} style={styles.addBtn} activeOpacity={0.8}>
                        <Text style={styles.addBtnText}>{isHe ? 'הוסף' : 'Add'}</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                </View>
              )}

              {/* Priority */}
              <View style={styles.detailRow}>
                <Text style={styles.detailIcon}>🏁</Text>
                {editable ? (
                  <View style={styles.priorityRow}>
                    {PRIORITIES.map((p) => {
                      const meta = PRIORITY_META[p];
                      const selected = (task.priority ?? 'need_to') === p;
                      return (
                        <TouchableOpacity
                          key={p}
                          onPress={() => commit({ priority: p })}
                          style={[styles.priorityChip, { borderColor: meta.color }, selected && { backgroundColor: meta.color }]}
                          activeOpacity={0.7}
                        >
                          <Text style={[styles.priorityChipText, { color: selected ? 'white' : meta.color }]}>
                            {isHe ? meta.labelHe : meta.labelEn}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                ) : (
                  <Text style={styles.detailLabel}>{isHe ? priorityMeta.labelHe : priorityMeta.labelEn}</Text>
                )}
              </View>

              {/* Date */}
              <View style={styles.detailRow}>
                <Text style={styles.detailIcon}>🗓️</Text>
                <Text style={styles.detailLabel}>{isHe ? 'תאריך' : 'Date'}</Text>
                {editable ? (
                  <TouchableOpacity onPress={() => setShowDatePicker(true)} style={styles.valueBtn}>
                    <Text style={styles.valueBtnText}>{formatDeadline(task.date, isHe)}</Text>
                  </TouchableOpacity>
                ) : (
                  <Text style={styles.detailValue}>{formatDeadline(task.date, isHe)}</Text>
                )}
              </View>

              {/* Deadline */}
              <View style={styles.detailRow}>
                <Text style={styles.detailIcon}>📅</Text>
                <Text style={styles.detailLabel}>{isHe ? 'תאריך יעד' : 'Deadline'}</Text>
                {editable ? (
                  <View style={styles.deadlineControls}>
                    <TouchableOpacity onPress={() => setShowDeadlinePicker(true)} style={styles.valueBtn}>
                      <Text style={styles.valueBtnText}>
                        {task.deadline ? formatDeadline(task.deadline, isHe) : isHe ? 'בחר' : 'Set'}
                      </Text>
                    </TouchableOpacity>
                    {task.deadline ? (
                      <TouchableOpacity onPress={() => commit({ deadline: undefined })}>
                        <Text style={styles.clearText}>{isHe ? 'נקה' : 'Clear'}</Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>
                ) : (
                  <Text style={styles.detailValue}>
                    {task.deadline ? formatDeadline(task.deadline, isHe) : '—'}
                  </Text>
                )}
              </View>

              {/* Time — from → to (derives duration) */}
              <View style={styles.detailRow}>
                <Text style={styles.detailIcon}>⏱️</Text>
                <Text style={styles.detailLabel}>{isHe ? 'שעה' : 'Time'}</Text>
                {editable ? (
                  <View style={styles.rangeRow}>
                    <TouchableOpacity onPress={() => setTimeField('from')} style={styles.valueBtn}>
                      <Text style={styles.valueBtnText}>{fromTime || (isHe ? 'משעה' : 'From')}</Text>
                    </TouchableOpacity>
                    <Text style={styles.rangeArrow}>→</Text>
                    <TouchableOpacity onPress={() => setTimeField('to')} style={styles.valueBtn}>
                      <Text style={styles.valueBtnText}>{toTime || (isHe ? 'עד' : 'To')}</Text>
                    </TouchableOpacity>
                    {fromTime ? <Text style={styles.rangeDur}>({formatDuration(task.durationMinutes)})</Text> : null}
                  </View>
                ) : (
                  <Text style={styles.detailValue}>
                    {fromTime ? `${fromTime}–${toTime} · ${formatDuration(task.durationMinutes)}` : formatDuration(task.durationMinutes)}
                  </Text>
                )}
              </View>

              {/* Repeat — pick weekdays */}
              <View style={styles.detailRow}>
                <Text style={styles.detailIcon}>🔁</Text>
                <Text style={styles.detailLabel}>{isHe ? 'חזרה' : 'Repeat'}</Text>
                <View style={styles.weekdayRow}>
                  {weekdayLabels.map((lbl, i) => {
                    const on = repeatDays.includes(i);
                    return (
                      <TouchableOpacity
                        key={i}
                        disabled={!editable}
                        onPress={() => toggleRepeatDay(i)}
                        style={[styles.weekdayChip, on && styles.weekdayChipOn]}
                        activeOpacity={0.7}
                      >
                        <Text style={[styles.weekdayText, on && styles.weekdayTextOn]}>{lbl}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>

              {/* Location */}
              <View style={styles.locationBlock}>
                <View style={styles.detailRow}>
                  <Text style={styles.detailIcon}>📍</Text>
                  <Text style={styles.detailLabel}>{isHe ? 'מיקום' : 'Location'}</Text>
                  <Text style={styles.detailValue} numberOfLines={1}>
                    {locationLabel || '—'}
                  </Text>
                </View>

                {editable && (
                  <>
                    {locationLabel && typeof task.location === 'object' && task.location && (
                      <TouchableOpacity
                        style={styles.mapsLink}
                        onPress={() =>
                          openLocationInMaps(locationLabel, {
                            lat: (task.location as any).lat,
                            lng: (task.location as any).lng,
                          })
                        }
                      >
                        <Text style={styles.mapsLinkText}>🗺️ {isHe ? 'אמת במפה' : 'Verify on map'}</Text>
                      </TouchableOpacity>
                    )}

                    <View style={styles.searchRow}>
                      <TextInput
                        style={[styles.newInput, styles.flex]}
                        value={locQuery}
                        onChangeText={setLocQuery}
                        placeholder={isHe ? 'חפש מקום (למשל רמת גן)' : 'Search a place (e.g. Ramat Gan)'}
                        placeholderTextColor={BRAND.inkSoft}
                        onSubmitEditing={runLocationSearch}
                        returnKeyType="search"
                      />
                      <TouchableOpacity style={styles.addBtn} onPress={runLocationSearch} disabled={locSearching}>
                        {locSearching ? <ActivityIndicator color="white" size="small" /> : <Text style={styles.addBtnText}>🔍</Text>}
                      </TouchableOpacity>
                    </View>

                    {locCandidates.length > 0 && (
                      <View style={styles.candidates}>
                        {locCandidates.map((c, i) => (
                          <TouchableOpacity key={`${c.lat},${c.lng},${i}`} style={styles.candidate} onPress={() => pickLocation(c)}>
                            <Text style={styles.candidateIcon}>📍</Text>
                            <Text style={styles.candidateLabel} numberOfLines={1}>
                              {c.label}
                            </Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    )}
                  </>
                )}
              </View>

              {/* What Meira prepared for this task (songs, what to bring…). */}
              {task.status === 'pending' && <TaskPrepSection task={task} he={isHe} />}

              {/* An errand with no place: places on her planned routes, open
                  when she passes (Koral, 29.9 — "fix my coffee machine"). */}
              {editable && !locationLabel && task.status === 'pending' && (
                <OnYourWayCard task={task} he={isHe} onPlan={commit} />
              )}

              {/* Transport + route — located tasks only */}
              {objLocation?.lat != null && (
                <View style={styles.locationBlock}>
                  <View style={styles.detailRow}>
                    <Text style={styles.detailIcon}>🧭</Text>
                    <Text style={styles.detailLabel}>{isHe ? 'תחבורה' : 'Transport'}</Text>
                    <View style={styles.priorityRow}>
                      {TRANSPORTS.map((t) => {
                        const selected = objLocation.transportType === t.key;
                        return (
                          <TouchableOpacity
                            key={t.key}
                            disabled={!editable || transportBusy}
                            onPress={() => changeTransport(t.key)}
                            style={[styles.transportChip, selected && styles.transportChipOn]}
                            activeOpacity={0.7}
                          >
                            <Text style={styles.transportChipText}>
                              {t.icon} {isHe ? t.he : t.en}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </View>
                  {transportBusy && <ActivityIndicator color={BRAND.sunGold} size="small" />}
                  {objLocation.transitPlan && (
                    <RouteMap
                      plan={objLocation.transitPlan}
                      destLat={objLocation.lat}
                      destLng={objLocation.lng}
                      destLabel={locationLabel}
                    />
                  )}
                </View>
              )}

              {/* Subtasks */}
              <View style={styles.subtaskBlock}>
                <Text style={styles.detailLabel}>
                  ✅ {isHe ? 'תתי-משימות' : 'Subtasks'}
                  {subtasks.length ? `  (${subtasks.filter((s) => s.status === 'complete').length}/${subtasks.length})` : ''}
                </Text>

                {subtasks.map((s) => (
                  <View key={s.id} style={styles.subtaskRow}>
                    <TouchableOpacity
                      onPress={() => editable && toggleSubtask(s.id)}
                      style={[styles.subtaskCheck, s.status === 'complete' && styles.subtaskCheckDone]}
                      activeOpacity={0.7}
                    >
                      <Text style={styles.subtaskCheckText}>{s.status === 'complete' ? '✓' : ''}</Text>
                    </TouchableOpacity>
                    <Text
                      style={[
                        styles.subtaskText,
                        s.status === 'complete' && { textDecorationLine: 'line-through', color: BRAND.inkSoft },
                      ]}
                    >
                      {s.text}
                    </Text>
                    {editable && (
                      <TouchableOpacity onPress={() => removeSubtask(s.id)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                        <Text style={styles.subtaskRemove}>×</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                ))}

                {editable && (
                  <View style={styles.subtaskAddRow}>
                    <TextInput
                      style={[styles.newInput, styles.flex]}
                      value={newSubtask}
                      onChangeText={setNewSubtask}
                      placeholder={isHe ? 'הוסף תת-משימה…' : 'Add a step…'}
                      placeholderTextColor={BRAND.inkSoft}
                      onSubmitEditing={addSubtask}
                      returnKeyType="done"
                    />
                    <TouchableOpacity onPress={addSubtask} style={styles.addBtn} activeOpacity={0.8}>
                      <Text style={styles.addBtnText}>{isHe ? 'הוסף' : 'Add'}</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>

              {/* Notes / details */}
              <View style={styles.notesBlock}>
                <Text style={styles.detailLabel}>📝 {isHe ? 'פרטים' : 'Details'}</Text>
                {editable ? (
                  <TextInput
                    style={styles.notesInput}
                    value={notesText}
                    onChangeText={setNotesText}
                    onBlur={() => {
                      if (notesText !== (task.progress ?? '')) commit({ progress: notesText });
                    }}
                    placeholder={isHe ? 'הוסף הערות או פרטים…' : 'Add notes or details…'}
                    placeholderTextColor={BRAND.inkSoft}
                    multiline
                  />
                ) : (
                  <Text style={styles.detailValue}>{task.progress || '—'}</Text>
                )}
              </View>
            </View>
          </ScrollView>

          <View style={styles.actions}>
            {/* A finished task is not a dead end. Plenty of things get ticked
                off and then need doing again — or were ticked off too early.
                Offer the way back before the buttons, so it is the first
                thing she sees on a task she has just completed. */}
            {task.status === 'complete' && (
              <View style={styles.doneAgainBox}>
                <Text style={styles.doneAgainText}>
                  {isHe ? 'המשימה בוצעה. לתזמן אותה שוב?' : 'Done. Schedule it again?'}
                </Text>
                <View style={styles.actionRow}>
                  <TouchableOpacity
                    style={[styles.button, styles.rescheduleButton, styles.flex]}
                    onPress={rescheduleNow}
                  >
                    <Text style={styles.rescheduleButtonText}>🕘 {isHe ? 'תזמון מחדש' : 'Reschedule'}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.button, styles.tomorrowButton, styles.flex]}
                    onPress={moveToTomorrow}
                  >
                    <Text style={styles.tomorrowButtonText}>➡️ {isHe ? 'למחר' : 'To tomorrow'}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            <TouchableOpacity
              style={[styles.button, task.status === 'complete' ? styles.undoButton : styles.completeButton]}
              onPress={onComplete}
            >
              <Text style={task.status === 'complete' ? styles.undoButtonText : styles.completeButtonText}>
                {task.status === 'complete'
                  ? (isHe ? '↩︎ בטל בוצע' : '↩︎ Undo done')
                  : (isHe ? '✓ בוצע' : '✓ Done')}
              </Text>
            </TouchableOpacity>

            {task.status !== 'complete' && (
              <View style={styles.actionRow}>
                <TouchableOpacity
                  style={[styles.button, styles.rescheduleButton, styles.flex]}
                  onPress={rescheduleNow}
                >
                  <Text style={styles.rescheduleButtonText}>🕘 {isHe ? 'תזמון מחדש' : 'Reschedule'}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.button, styles.tomorrowButton, styles.flex]}
                  onPress={moveToTomorrow}
                >
                  <Text style={styles.tomorrowButtonText}>➡️ {isHe ? 'למחר' : 'To tomorrow'}</Text>
                </TouchableOpacity>
              </View>
            )}

            <View style={styles.actionRow}>
              {onDelete && (
                <TouchableOpacity style={[styles.button, styles.deleteButton, styles.flex]} onPress={confirmDelete}>
                  <Text style={styles.deleteButtonText}>🗑 {isHe ? 'מחיקה' : 'Delete'}</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity style={[styles.button, styles.closeButton, styles.flex]} onPress={editable ? saveAndClose : onClose}>
                <Text style={styles.closeButtonText}>{editable ? (isHe ? 'שמור' : 'Save') : (isHe ? 'סגור' : 'Close')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </View>

      {showDatePicker && (
        <DateTimePicker value={deadlineToDate(task.date)} mode="date" onChange={onDateChange} />
      )}
      {showEndPicker && (
        <DateTimePicker value={deadlineToDate(task.endDate || task.date)} minimumDate={deadlineToDate(task.date)}
          mode="date" onChange={onEndDateChange} />
      )}
      {timeField && (
        <DateTimePicker
          value={timeToDate(timeField === 'from' ? fromTime : toTime)}
          mode="time"
          is24Hour
          onChange={onRangeChange}
        />
      )}
      {showDeadlinePicker && (
        <DateTimePicker value={deadlineToDate(task.deadline)} mode="date" onChange={onDeadlineChange} />
      )}
    </Modal>
  );
}

const { height } = Dimensions.get('window');

const styles = StyleSheet.create({
  editHead: { alignItems: 'center', gap: 10, paddingBottom: 10 },
  editX: { width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(20,27,46,0.06)', alignItems: 'center', justifyContent: 'center' },
  editXText: { fontSize: 22, fontFamily: FONTS.bodyHeavy, color: BRAND.warmInk },
  editTitle: { flex: 1, minWidth: 0, textAlign: 'center', fontFamily: FONTS.bodyHeavy, fontSize: 18, color: BRAND.warmInk },
  editSave: { minWidth: 80, minHeight: 44, paddingHorizontal: 16, borderRadius: 22, backgroundColor: BRAND.sunGold, alignItems: 'center', justifyContent: 'center' },
  editSaveText: { fontFamily: FONTS.bodyHeavy, fontSize: 15, color: BRAND.onGold },
  rtlText: { textAlign: 'right', writingDirection: 'rtl' },
  core: { gap: 8, marginBottom: 12 },
  coreCard: { padding: 10, borderRadius: 16, backgroundColor: surf('#FFFFFF'), borderWidth: 1, borderColor: BRAND.line },
  coreMissing: { borderStyle: 'dashed', backgroundColor: surf('rgba(255,255,255,0.6)') },
  coreRow: { alignItems: 'center', gap: 10, minHeight: 44 },
  coreIcon: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  coreLabel: { fontFamily: FONTS.bodyBold, fontSize: 11.5, color: BRAND.inkSoft },
  coreValue: { fontFamily: FONTS.bodyHeavy, fontSize: 15, color: BRAND.warmInk },
  stepRow: { alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 10 },
  stepBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(20,27,46,0.07)', alignItems: 'center', justifyContent: 'center' },
  stepText: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.warmInk },
  dateBtn: { minWidth: 88 },
  timeBtn: { minWidth: 72, minHeight: 44, paddingHorizontal: 10, borderRadius: 14, backgroundColor: surf('#FFFFFF'), borderWidth: 1, borderColor: BRAND.line, alignItems: 'center', justifyContent: 'center' },
  timeText: { fontFamily: FONTS.bodyHeavy, fontSize: 18, color: BRAND.warmInk, fontVariant: ['tabular-nums'] },
  stepArrow: { fontSize: 16, color: BRAND.inkSoft },
  thread: { width: 2, height: 10, backgroundColor: 'rgba(90,79,224,0.35)' },
  modeRow: { gap: 6, marginTop: 4, flexWrap: 'wrap' },
  modeBtn: { width: 48, height: 42, borderRadius: 14, backgroundColor: 'rgba(20,27,46,0.06)', alignItems: 'center', justifyContent: 'center' },
  modeBtnOn: { backgroundColor: '#5A4FE0' },
  coreCall: { width: 44, height: 44, borderRadius: 22, backgroundColor: BRAND.goldSoft, alignItems: 'center', justifyContent: 'center' },
  coreNote: { fontFamily: FONTS.bodySemi, fontSize: 12, color: nink('#3B3570') },
  moreCap: { fontFamily: FONTS.bodyHeavy, fontSize: 12, color: BRAND.goldInk, marginTop: 6 },
  overlay: { flex: 1, backgroundColor: 'rgba(20, 27, 46, 0.45)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: surf('#F7F5FF'),
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    maxHeight: height * 0.85,
    paddingHorizontal: 16,
    paddingBottom: 24,
  },
  handleBar: {
    width: 40,
    height: 4,
    backgroundColor: BRAND.line,
    borderRadius: 2,
    alignSelf: 'center',
    marginTop: 8,
    marginBottom: 12,
  },
  taskTitle: { fontSize: 20, fontFamily: FONTS.bodyHeavy, color: BRAND.warmInk, marginBottom: 12 },
  titleInput: {
    fontSize: 18,
    fontFamily: FONTS.bodyBold,
    color: BRAND.warmInk,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: BRAND.line,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: surf('#FFFFFF'),
  },
  // v3: each detail is its own soft white card with the icon in a pastel circle.
  detailsSection: { marginBottom: 16, gap: 6 },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 10,
    minHeight: 52,
    borderRadius: 16,
    backgroundColor: surf('#FFFFFF'),
  },
  detailIcon: {
    fontSize: 16, marginRight: 10, width: 34, height: 34, borderRadius: 17, overflow: 'hidden',
    textAlign: 'center', textAlignVertical: 'center', lineHeight: 34, backgroundColor: surf('#EEF0FF'),
  },
  detailLabel: { fontSize: 14, fontFamily: FONTS.bodySemi, color: BRAND.inkSoft, flex: 1 },
  detailValue: { fontSize: 14, fontFamily: FONTS.bodySemi, color: BRAND.warmInk, maxWidth: 180 },
  colorBox: { width: 20, height: 20, borderRadius: RADIUS.chip },
  editHint: { fontSize: 14, marginLeft: 10, color: BRAND.sunGold },
  linkLabel: { color: BRAND.sunGold, textDecorationLine: 'underline' },
  valueBtn: { backgroundColor: BRAND.cream, borderRadius: RADIUS.chip, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: BRAND.line },
  valueBtnText: { fontSize: 14, fontFamily: FONTS.bodyBold, color: BRAND.sunGold },
  rangeRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rangeArrow: { fontSize: 14, color: BRAND.inkSoft, fontFamily: FONTS.bodyBold },
  rangeDur: { fontSize: 12, color: BRAND.inkSoft, fontFamily: FONTS.bodySemi },
  weekdayRow: { flexDirection: 'row', gap: 4, flex: 1, justifyContent: 'flex-end' },
  weekdayChip: {
    width: 28, height: 28, borderRadius: RADIUS.chip,
    borderWidth: 1.5, borderColor: BRAND.line,
    alignItems: 'center', justifyContent: 'center',
  },
  weekdayChipOn: { backgroundColor: BRAND.sunGold, borderColor: BRAND.sunGold },
  weekdayText: { fontSize: 12, fontFamily: FONTS.bodyBold, color: BRAND.inkSoft },
  weekdayTextOn: { color: 'white' },
  miniInput: {
    minWidth: 64,
    textAlign: 'center',
    borderWidth: 1,
    borderColor: BRAND.line,
    borderRadius: RADIUS.chip,
    paddingVertical: 6,
    paddingHorizontal: 8,
    fontSize: 14,
    color: BRAND.warmInk,
    backgroundColor: BRAND.cream,
  },
  editPanel: { paddingVertical: 12 },
  chipsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: RADIUS.card,
    borderWidth: 1.5,
    borderColor: BRAND.line,
    backgroundColor: BRAND.cream,
  },
  chipNew: { borderColor: BRAND.sunGold, borderStyle: 'dashed' },
  chipIcon: { fontSize: 15, marginRight: 5 },
  chipLabel: { fontSize: 13, fontFamily: FONTS.bodySemi, color: BRAND.warmInk },
  newRow: { flexDirection: 'row', alignItems: 'center', marginTop: 12, gap: 8 },
  newInput: {
    borderWidth: 1,
    borderColor: BRAND.line,
    borderRadius: RADIUS.chip,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
    color: BRAND.warmInk,
    backgroundColor: BRAND.cream,
  },
  flex: { flex: 1 },
  addBtn: {
    backgroundColor: BRAND.sunGold,
    borderRadius: RADIUS.chip,
    paddingHorizontal: 14,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addBtnText: { color: 'white', fontFamily: FONTS.bodyBold, fontSize: 13 },
  priorityRow: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end' },
  priorityChip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: RADIUS.chip, borderWidth: 1.5 },
  priorityChipText: { fontSize: 11, fontFamily: FONTS.bodyBold },
  transportChip: {
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: RADIUS.chip,
    borderWidth: 1.5, borderColor: BRAND.line, backgroundColor: BRAND.creamCard,
  },
  transportChipOn: { borderColor: BRAND.sunGold, backgroundColor: BRAND.honey },
  transportChipText: { fontSize: 11, fontFamily: FONTS.bodyBold, color: BRAND.warmInk },
  locationBlock: { paddingVertical: 4 },
  mapsLink: { paddingVertical: 8 },
  mapsLinkText: { color: BRAND.sunGold, fontFamily: FONTS.bodySemi, fontSize: 13 },
  searchRow: { flexDirection: 'row', gap: 8, alignItems: 'center', marginTop: 8 },
  candidates: {
    marginTop: 6,
    borderWidth: 1,
    borderColor: BRAND.line,
    borderRadius: RADIUS.chip,
    overflow: 'hidden',
    backgroundColor: BRAND.cream,
  },
  candidate: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: BRAND.line,
  },
  candidateIcon: { fontSize: 14, marginRight: 8 },
  candidateLabel: { fontSize: 13, flex: 1, color: BRAND.warmInk },
  deadlineControls: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  clearText: { color: BRAND.inkSoft, fontSize: 13, fontFamily: FONTS.bodySemi },
  subtaskBlock: { paddingTop: 14 },
  subtaskRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 7, gap: 10 },
  subtaskCheck: {
    width: 22,
    height: 22,
    borderRadius: RADIUS.chip,
    borderWidth: 2,
    borderColor: BRAND.line,
    justifyContent: 'center',
    alignItems: 'center',
  },
  subtaskCheckDone: { backgroundColor: BRAND.success, borderColor: BRAND.success },
  subtaskCheckText: { color: 'white', fontFamily: FONTS.bodyBold, fontSize: 12 },
  subtaskText: { flex: 1, fontSize: 14, color: BRAND.warmInk },
  subtaskRemove: { color: COLORS.danger, fontSize: 22, lineHeight: 24, fontFamily: FONTS.bodyBold, paddingHorizontal: 4 },
  subtaskAddRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  notesBlock: { paddingTop: 14 },
  notesInput: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: BRAND.line,
    borderRadius: RADIUS.chip,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: BRAND.warmInk,
    backgroundColor: BRAND.cream,
    minHeight: 60,
    textAlignVertical: 'top',
  },
  actions: { gap: 10, marginTop: 8 },
  actionRow: { flexDirection: 'row', gap: 10 },
  button: { paddingVertical: 12, borderRadius: RADIUS.chip, alignItems: 'center' },
  completeButton: { backgroundColor: BRAND.success },
  completeButtonText: { color: 'white', fontFamily: FONTS.bodySemi, fontSize: 14 },
  undoButton: { backgroundColor: BRAND.creamCard, borderWidth: 1.5, borderColor: BRAND.success },
  undoButtonText: { color: BRAND.success, fontFamily: FONTS.bodyBold, fontSize: 14 },
  deleteButton: { backgroundColor: COLORS.danger + '22', borderWidth: 1, borderColor: COLORS.danger },
  deleteButtonText: { color: COLORS.danger, fontFamily: FONTS.bodyBold, fontSize: 14 },
  rescheduleButton: { backgroundColor: BRAND.creamCard, borderWidth: 1.5, borderColor: BRAND.sunGold },
  rescheduleButtonText: { color: BRAND.warmInk, fontFamily: FONTS.bodySemi, fontSize: 14 },
  tomorrowButton: { backgroundColor: BRAND.creamCard, borderWidth: 1.5, borderColor: BRAND.line },
  tomorrowButtonText: { color: BRAND.warmInk, fontFamily: FONTS.bodySemi, fontSize: 14 },
  doneAgainBox: {
    backgroundColor: BRAND.creamCard, borderRadius: RADIUS.chip, padding: 10, gap: 8,
    borderWidth: 1, borderColor: BRAND.line,
  },
  doneAgainText: { fontFamily: FONTS.bodySemi, fontSize: 13, color: BRAND.inkSoft, textAlign: 'center' },
  inlineInput: { paddingVertical: 2, color: BRAND.warmInk },
  closeButton: { backgroundColor: BRAND.line },
  closeButtonText: { color: BRAND.warmInk, fontFamily: FONTS.bodySemi, fontSize: 14 },
});
