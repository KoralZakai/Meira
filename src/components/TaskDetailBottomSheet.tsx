/** TaskDetailBottomSheet — bottom-sheet editor for a task (time, location, contact, subtasks). */
import React, { useEffect, useState } from 'react';
import {
  View,
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
import { Task, AppLanguage, TaskPriority, Subtask, TaskLocation, TransportType } from '../types';
import { BRAND, COLORS, PRIORITY_META, FONTS, RADIUS } from '../constants/theme';
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
  const [creating, setCreating] = useState(false);
  const [newCatName, setNewCatName] = useState('');
  const [cats, setCats] = useState<CategoryEntry[]>(() => allCategories());

  // Local editable field state (synced whenever a different task opens).
  const [titleText, setTitleText] = useState(task.text);
  const [notesText, setNotesText] = useState(task.progress ?? '');
  const [showDatePicker, setShowDatePicker] = useState(false);
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
    if (task.status === 'complete') commit({ status: 'pending', completedAt: undefined });
    setTimeField('from');
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
    commit({ date: toDateStr(selected) });
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

            <View style={styles.detailsSection}>
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
                {editable && <Text style={styles.editHint}>{editingCategory ? '▾' : '✏️'}</Text>}
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
                        <Text style={styles.subtaskRemove}>✕</Text>
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
  overlay: { flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.5)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: BRAND.creamCard,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
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
  taskTitle: { fontSize: 20, fontFamily: FONTS.bodyBold, color: BRAND.warmInk, marginBottom: 16 },
  titleInput: {
    fontSize: 18,
    fontFamily: FONTS.bodyBold,
    color: BRAND.warmInk,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: BRAND.line,
    borderRadius: RADIUS.chip,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: BRAND.cream,
  },
  detailsSection: { marginBottom: 16 },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: BRAND.line,
  },
  detailIcon: { fontSize: 18, marginRight: 12, width: 24 },
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
  subtaskRemove: { color: COLORS.danger, fontSize: 14, fontFamily: FONTS.bodyBold, paddingHorizontal: 4 },
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
