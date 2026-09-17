/**
 * AddTaskScreen — manual/voice task entry; parses the input into tasks.
 * Dependencies: TaskParser (speech/text -> ParsedTask[]).
 */
import React, { useRef, useState } from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  ToastAndroid,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import DateTimePicker from '@react-native-community/datetimepicker';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types/navigation';
import { useLumiContext } from '../hooks/useLumiContext';
import { BRAND, FONTS, RADIUS, tint } from '../constants/theme';
import { inferTaskDetails, parseSpeechToTasksWithExpansion, ParsedTask } from '../services/TaskParser';
import { parseTimeExpression } from '../utils/timeParser';
import { getSettings } from '../services/TaskStorage';
import type { PendingTaskAction } from '../hooks/useTasks';

type Props = NativeStackScreenProps<RootStackParamList, 'AddTask'>;

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Which day this task is going onto, said plainly.
 *
 * The + on a timeline showing tomorrow used to write today's date. That is
 * fixed — but a silent correct answer and a silent wrong one look identical
 * from here, and the person tapping + is the only one who knows which day she
 * meant. So the day is on screen before she types, not discovered afterwards
 * in the wrong list.
 */
function dayBanner(dateKey: string | undefined): string {
  const today = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const key = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const target = dateKey || key(today);
  if (target === key(today)) return 'Today';
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (target === key(tomorrow)) return 'Tomorrow';
  const [y, m, d] = target.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1)
    .toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}


function timeToDate(hhmm?: string): Date {
  const d = new Date();
  if (hhmm && /^\d{1,2}:\d{2}$/.test(hhmm)) {
    const [h, m] = hhmm.split(':').map(Number);
    d.setHours(h, m, 0, 0);
  }
  return d;
}

function minutesBetween(from: string, until: string): number {
  const [fh, fm] = from.split(':').map(Number);
  const [uh, um] = until.split(':').map(Number);
  return Math.max(0, (uh * 60 + um) - (fh * 60 + fm));
}

function addMinutesToTime(hhmm: string, mins: number): string {
  const [h, m] = hhmm.split(':').map(Number);
  const total = h * 60 + m + mins;
  return `${pad(Math.floor(total / 60) % 24)}:${pad(total % 60)}`;
}

export default function AddTaskScreen({ navigation, route }: Props) {
  const { tasksState } = useLumiContext();

  const initialTime = route.params?.initialTime;
  // The day the caller was looking at. Absent = today.
  const initialDate = route.params?.initialDate;
  const [text, setText] = useState('');
  const [fromTime, setFromTime] = useState<string | undefined>(initialTime);
  const [untilTime, setUntilTime] = useState<string | undefined>(
    initialTime ? addMinutesToTime(initialTime, 60) : undefined
  );
  const [picker, setPicker] = useState<'from' | 'until' | null>(null);
  // True once SHE chooses a time; after that the text never moves the pickers.
  const timeTouched = useRef<boolean>(Boolean(initialTime));
  const [parsed, setParsed] = useState<ReturnType<typeof inferTaskDetails> | null>(null);
  const [llmResult, setLlmResult] = useState<ParsedTask[] | null>(null);
  const [parsing, setParsing] = useState(false);
  const [busy, setBusy] = useState(false);

  // Show parse preview when user stops typing
  const onChangeText = (val: string) => {
    setText(val);
    if (val.trim().length > 3) {
      setParsed(inferTaskDetails(val));
      // Fill From/Until from the sentence itself, so a typed "ב 8 בערב" is
      // VISIBLE as 20:00 before saving instead of being silently overridden by
      // whatever the picker was pre-set to. Only while she has not set a time
      // herself — an explicit pick is never overwritten by parsing.
      if (!timeTouched.current) {
        const te = parseTimeExpression(val);
        if (te.fixedTime) {
          setFromTime(te.fixedTime);
          setUntilTime(
            te.endTime ?? addMinutesToTime(te.fixedTime, te.durationMinutes ?? inferTaskDetails(val).durationMinutes ?? 60),
          );
        }
      }
    } else {
      setParsed(null);
    }
  };

  const durationMinutes = fromTime && untilTime ? minutesBetween(fromTime, untilTime) : 30;

  const handleLumiParse = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setParsing(true);
    setLlmResult(null);
    try {
      const result = await parseSpeechToTasksWithExpansion(trimmed);
      setLlmResult(result);
      // Auto-fill From/Until if LLM extracted a time
      if (result.length > 0 && result[0].fixedTime && !fromTime) {
        setFromTime(result[0].fixedTime);
        if (result[0].endTime) setUntilTime(result[0].endTime);
        else if (result[0].durationMinutes)
          setUntilTime(addMinutesToTime(result[0].fixedTime, result[0].durationMinutes));
      }
    } catch (e) {
      console.log('[AddTask] LLM parse error:', e);
    } finally {
      setParsing(false);
    }
  };

  // Confirm-before-apply for voice commands that touch an EXISTING task
  // ("done with the gym", "תזיז את החדר כושר ל-18:00"). Lumi speech stays short.
  const confirmAction = async (action: PendingTaskAction) => {
    const he = (await getSettings()).language === 'he';
    const verb =
      action.kind === 'complete'
        ? he ? 'לסמן כבוצע' : 'Mark done'
        : action.kind === 'delete'
          ? he ? 'למחוק' : 'Delete'
          : he ? 'לעדכן' : 'Update';
    const changes = Object.entries(action.patch)
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join(', ');
    return new Promise<boolean>((resolve) => {
      Alert.alert(
        `${verb}?`,
        `"${action.task.text}"${changes ? `\n${changes}` : ''}`,
        [
          { text: he ? 'ביטול' : 'Cancel', style: 'cancel', onPress: () => resolve(false) },
          { text: he ? 'כן' : 'Yes', onPress: () => resolve(true) },
        ],
      );
    });
  };

  const handleCreate = async () => {
    const trimmed = text.trim();
    if (!trimmed) {
      Alert.alert('Please enter a task description');
      return;
    }
    setBusy(true);
    try {
      const extra = fromTime
        ? { fixedTime: fromTime, durationMinutes }
        : undefined;

      // First: is this a command about an existing task rather than a new one?
      if (!fromTime && tasksState.processSpeechCommand) {
        const result = await tasksState.processSpeechCommand(trimmed);
        const he = (await getSettings()).language === 'he';
        if (result.type === 'confirm') {
          if (await confirmAction(result.action)) {
            await tasksState.applyTaskAction(result.action);
          }
          navigation.goBack();
          return;
        }
        if (result.type === 'ambiguous') {
          const chosen = await new Promise<(typeof result.candidates)[number] | null>((resolve) => {
            Alert.alert(
              he ? 'איזו משימה?' : 'Which task?',
              undefined,
              [
                ...result.candidates.map((t) => ({ text: t.text, onPress: () => resolve(t) })),
                { text: he ? 'ביטול' : 'Cancel', style: 'cancel' as const, onPress: () => resolve(null) },
              ],
            );
          });
          if (chosen) {
            await tasksState.applyTaskAction({ kind: result.kind, task: chosen, patch: result.patch });
          }
          navigation.goBack();
          return;
        }
        if (result.type === 'not_found') {
          Alert.alert(he ? 'לא מצאתי משימה כזאת' : "Couldn't find that task");
          return;
        }
        if (result.type === 'duplicate') {
          // Lumi isn't sure — ask: same task (update with the new details) or
          // genuinely a new one?
          const sameTask = await new Promise<boolean | null>((resolve) => {
            Alert.alert(
              he ? 'אותה משימה?' : 'Same task?',
              he
                ? `יש לך כבר: "${result.action.task.text}". לעדכן אותה בפרטים החדשים?`
                : `You already have: "${result.action.task.text}". Update it with the new details?`,
              [
                { text: he ? 'ביטול' : 'Cancel', style: 'cancel', onPress: () => resolve(null) },
                { text: he ? 'משימה חדשה' : 'New task', onPress: () => resolve(false) },
                { text: he ? 'כן, עדכני' : 'Yes, update', onPress: () => resolve(true) },
              ],
            );
          });
          if (sameTask === null) return;
          if (sameTask) {
            await tasksState.applyTaskAction(result.action);
            navigation.goBack();
            return;
          }
          // falls through to the normal create path below
        }
      }

      // Try LLM parsing first; fall back to manual if nothing comes back
      let created: unknown[] = [];
      if (!fromTime && tasksState.addMorningTasksFromSpeech) {
        created = await tasksState.addMorningTasksFromSpeech(trimmed);
      }
      if ((!created || created.length === 0) && tasksState.addManualTask) {
        await tasksState.addManualTask(trimmed, { ...(extra ?? {}), date: initialDate });
      }
      // Say where it landed. Adding to the wrong day is silent until she goes
      // looking for the task and cannot find it — by which point the mistake
      // is hers to hunt rather than ours to state.
      ToastAndroid?.show?.(`Added to ${dayBanner(initialDate)}`, ToastAndroid.SHORT);
      navigation.goBack();
    } catch (e) {
      console.log('[AddTask] error:', e);
      if (tasksState.addManualTask) {
        await tasksState.addManualTask(trimmed, {
          ...(fromTime ? { fixedTime: fromTime, durationMinutes } : {}), date: initialDate,
        });
      }
      navigation.goBack();
    } finally {
      setBusy(false);
    }
  };

  const onPickerChange = (field: 'from' | 'until') => (_: any, selected?: Date) => {
    setPicker(null);
    if (!selected) return;
    timeTouched.current = true;   // a deliberate pick; typing must not undo it
    const hhmm = `${pad(selected.getHours())}:${pad(selected.getMinutes())}`;
    if (field === 'from') {
      setFromTime(hhmm);
      // Auto-advance until by same duration gap if it existed
      if (untilTime && fromTime) {
        const gap = minutesBetween(fromTime, untilTime);
        setUntilTime(addMinutesToTime(hhmm, gap));
      }
    } else {
      setUntilTime(hhmm);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        {/* Header */}
        <View style={styles.header}>
          <Pressable onPress={() => navigation.goBack()} style={styles.closeBtn}>
            <Text style={styles.closeText}>✕</Text>
          </Pressable>
          <View style={styles.titleBox}>
            <Text style={styles.title}>New Task</Text>
            <Text style={styles.dayLine}>📅 {dayBanner(initialDate)}</Text>
          </View>
          <View style={styles.closeBtn} />
        </View>

        <ScrollView
          style={styles.content}
          contentContainerStyle={{ paddingBottom: 16 }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Task text */}
          <View style={styles.section}>
            <Text style={styles.label}>What do you need to do?</Text>
            <TextInput
              style={styles.textInput}
              placeholder="e.g. Gym at Space, meeting with Dan, doctor at 10..."
              value={text}
              onChangeText={onChangeText}
              multiline
              autoFocus
              placeholderTextColor={BRAND.inkSoft}
            />
          </View>

          {/* Parse preview */}
          {/* Quick keyword preview */}
          {parsed && !llmResult && (
            <View style={styles.parsePreview}>
              <Text style={styles.parseTitle}>Quick read:</Text>
              <Text style={styles.parseRow}>{parsed.icon}  {parsed.category}  ·  {parsed.priority}  ·  ~{parsed.durationMinutes} min</Text>
            </View>
          )}

          {/* Lumi Parse button */}
          {text.trim().length > 3 && !llmResult && (
            <Pressable
              style={[styles.lumiParseBtn, parsing && { opacity: 0.6 }]}
              onPress={handleLumiParse}
              disabled={parsing}
            >
              {parsing
                ? <ActivityIndicator size="small" color={BRAND.sunGold} />
                : <Text style={styles.lumiBtnText}>✨ Parse with Lumi</Text>}
            </Pressable>
          )}

          {/* Full LLM result */}
          {llmResult && llmResult.length > 0 && (
            <View style={styles.llmPreview}>
              <Text style={styles.parseTitle}>Lumi understands ✅</Text>
              {llmResult.map((t, i) => (
                <View key={i} style={styles.llmTask}>
                  <Text style={styles.llmTaskTitle}>
                    {t.category === 'gym' ? '💪' : t.category === 'interview' ? '🎯' : t.category === 'doctor' ? '⚕️' : '📌'}
                    {'  '}{t.text}
                  </Text>
                  <Text style={styles.parseRow}>{t.category}  ·  {t.priority}</Text>
                  {t.fixedTime && <Text style={styles.parseRow}>🕐 {t.fixedTime}{t.endTime ? ` → ${t.endTime}` : ''}</Text>}
                  {t.location && <Text style={styles.parseRow}>📍 {t.location}</Text>}
                  {t.contactName && <Text style={styles.parseRow}>👤 {t.contactName}</Text>}
                  {t.fixedTime && <Text style={[styles.parseRow, { color: BRAND.sunGold }]}>
                    🔔 Reminders: wake-up · leave home · 1hr · 15min
                  </Text>}
                </View>
              ))}
              <Pressable onPress={() => setLlmResult(null)} style={{ marginTop: 6 }}>
                <Text style={[styles.clearText, { textAlign: 'right' }]}>Re-parse</Text>
              </Pressable>
            </View>
          )}

          {/* From / Until */}
          <View style={styles.section}>
            <Text style={styles.label}>Time</Text>
            <View style={styles.timeRow}>
              <View style={styles.timeBlock}>
                <Text style={styles.timeLabel}>From</Text>
                <Pressable style={styles.timeChip} onPress={() => setPicker('from')}>
                  <Text style={styles.timeChipText}>{fromTime ?? '—'}</Text>
                </Pressable>
              </View>

              <Text style={styles.timeSep}>→</Text>

              <View style={styles.timeBlock}>
                <Text style={styles.timeLabel}>Until</Text>
                <Pressable
                  style={[styles.timeChip, !fromTime && styles.timeChipDisabled]}
                  onPress={() => fromTime && setPicker('until')}
                >
                  <Text style={styles.timeChipText}>{untilTime ?? '—'}</Text>
                </Pressable>
              </View>

              {(fromTime || untilTime) && (
                <Pressable
                  style={styles.clearBtn}
                  onPress={() => { setFromTime(undefined); setUntilTime(undefined); }}
                >
                  <Text style={styles.clearText}>Clear</Text>
                </Pressable>
              )}
            </View>

            {fromTime && untilTime && durationMinutes > 0 && (
              <Text style={styles.durationHint}>⏱ {durationMinutes} min</Text>
            )}
          </View>
        </ScrollView>

        {/* Time pickers */}
        {picker === 'from' && (
          <DateTimePicker
            value={timeToDate(fromTime)}
            mode="time"
            is24Hour
            onChange={onPickerChange('from')}
          />
        )}
        {picker === 'until' && (
          <DateTimePicker
            value={timeToDate(untilTime ?? (fromTime ? addMinutesToTime(fromTime, 60) : undefined))}
            mode="time"
            is24Hour
            onChange={onPickerChange('until')}
          />
        )}

        {/* Actions */}
        <View style={styles.actions}>
          <Pressable
            onPress={() => navigation.goBack()}
            style={({ pressed }) => [styles.button, styles.cancelButton, pressed && { opacity: 0.7 }]}
          >
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
          <Pressable
            onPress={handleCreate}
            disabled={busy}
            style={({ pressed }) => [styles.button, styles.createButton, (pressed || busy) && { opacity: 0.7 }]}
          >
            {busy ? (
              <ActivityIndicator color={BRAND.white} />
            ) : (
              <Text style={styles.createText}>Add Task</Text>
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BRAND.cream },
  flex: { flex: 1 },
  titleBox: { alignItems: 'center', gap: 2 },
  dayLine: { fontSize: 12, fontWeight: '700', color: '#8B6721' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: BRAND.line,
  },
  title: { fontSize: 16, fontFamily: FONTS.bodyBold, color: BRAND.warmInk, flex: 1, textAlign: 'center' },
  closeBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  closeText: { fontSize: 20, color: BRAND.warmInk, fontFamily: FONTS.bodySemi },
  content: { flex: 1, paddingHorizontal: 16, paddingTop: 16 },
  section: { marginBottom: 20 },
  label: {
    fontSize: 12,
    fontFamily: FONTS.bodyBold,
    color: BRAND.inkSoft,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  textInput: {
    backgroundColor: BRAND.creamCard,
    borderRadius: RADIUS.chip,
    padding: 14,
    fontSize: 15,
    color: BRAND.warmInk,
    minHeight: 80,
    textAlignVertical: 'top',
    borderWidth: 1,
    borderColor: BRAND.line,
  },
  parsePreview: {
    backgroundColor: BRAND.honey,
    borderRadius: RADIUS.chip,
    padding: 12,
    marginBottom: 16,
    borderLeftWidth: 3,
    borderLeftColor: BRAND.sunGold,
  },
  parseTitle: { fontSize: 11, fontFamily: FONTS.bodyBold, color: BRAND.sunGold, marginBottom: 4, textTransform: 'uppercase' },
  parseRow: { fontSize: 13, color: BRAND.warmInk, marginTop: 2 },
  timeRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  timeBlock: { alignItems: 'center', gap: 4 },
  timeLabel: { fontSize: 11, fontFamily: FONTS.bodyBold, color: BRAND.inkSoft, textTransform: 'uppercase' },
  timeChip: {
    backgroundColor: BRAND.creamCard,
    borderRadius: RADIUS.chip,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: BRAND.line,
  },
  timeChipDisabled: { opacity: 0.4 },
  timeChipText: { fontSize: 16, fontFamily: FONTS.bodyBold, color: BRAND.warmInk },
  timeSep: { fontSize: 16, color: BRAND.inkSoft, marginTop: 18 },
  durationHint: { fontSize: 12, color: BRAND.inkSoft, marginTop: 6 },
  clearBtn: { marginTop: 18, paddingHorizontal: 8 },
  clearText: { fontSize: 13, color: BRAND.inkSoft, fontFamily: FONTS.bodySemi },
  lumiParseBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: BRAND.honey,
    borderRadius: RADIUS.chip,
    paddingVertical: 10,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: BRAND.sunGold,
    minHeight: 40,
  },
  lumiBtnText: { fontSize: 14, fontFamily: FONTS.bodyBold, color: BRAND.sunGold },
  llmPreview: {
    backgroundColor: tint(BRAND.success),
    borderRadius: RADIUS.chip,
    padding: 12,
    marginBottom: 16,
    borderLeftWidth: 3,
    borderLeftColor: BRAND.success,
  },
  llmTask: { marginTop: 6 },
  llmTaskTitle: { fontSize: 14, fontFamily: FONTS.bodyBold, color: BRAND.warmInk, marginBottom: 2 },
  actions: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderTopWidth: 1,
    borderTopColor: BRAND.line,
  },
  button: { flex: 1, paddingVertical: 14, borderRadius: RADIUS.chip, alignItems: 'center' },
  cancelButton: { backgroundColor: BRAND.creamCard, borderWidth: 1, borderColor: BRAND.line },
  cancelText: { fontSize: 15, fontFamily: FONTS.bodyBold, color: BRAND.warmInk },
  createButton: { backgroundColor: BRAND.sunGold },
  createText: { fontSize: 15, fontFamily: FONTS.bodyBold, color: BRAND.white },
});
