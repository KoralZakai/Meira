/**
 * AddTaskScreen — "What do you want to add?"
 *
 * Koral, 17.10: the + opens with IDEAS under an empty box, and understands
 * while she types — no ✨ Parse button to remember.
 *
 *   empty input   "Suggested for you" (utils/addSuggestions): tomorrow's prep or
 *                 an early night, an errand on a journey already planned, a
 *                 free window, something still open. One tap each.
 *   typing        chips under the box on EVERY keystroke — time, day, person,
 *                 place, kind (utils/liveParse): local, free, no model. Each
 *                 chip is a fact she can tap to change or ✕ to remove, and ✕
 *                 removes the WORDS, so the chips and the saved task cannot
 *                 disagree.
 *   a pause       after 1.5 s, if the sentence says something Meira can add to
 *                 (a birthday, an interview): ONE server call, at most twice
 *                 per add (hooks/useAddUnderstand) — a greeting drafted, a gift
 *                 reminder, "prep brief + blocks". If it fails, one line says
 *                 so and everything else keeps working.
 *   Add           one tap, the same save path as ever (confirm-before-apply for
 *                 commands about an existing task, then the parser, then the
 *                 manual task) — but the day, the hour and the place she SEES
 *                 in the chips are the ones that are saved.
 *
 * Sending a greeting opens WhatsApp with her text for HER to send. Nothing in
 * this screen sends anything on its own.
 *
 * Dependencies: utils/liveParse, utils/addSuggestions, utils/addConclusions,
 * hooks/useAddSuggestions, hooks/useAddUnderstand, services/ContactService.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, Linking, ScrollView, StyleSheet, Text, TextInput, View, Pressable, KeyboardAvoidingView,
  Platform, ActivityIndicator, ToastAndroid,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import DateTimePicker from '@react-native-community/datetimepicker';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types/navigation';
import { useLumiContext } from '../hooks/useLumiContext';
import { useAppLanguage } from '../hooks/useAppLanguage';
import { useAddSuggestions } from '../hooks/useAddSuggestions';
import { useAddUnderstand } from '../hooks/useAddUnderstand';
import { BRAND, CATEGORY_META, FONTS, MIN_TOUCH, RADIUS } from '../constants/theme';
import { getSettings, getTasksForDate } from '../services/TaskStorage';
import { loadKnownPlaces } from '../services/KnownPlacesStore';
import { ContactService } from '../services/ContactService';
import { pickPhoneContact } from '../services/PhoneContactsService';
import { applyPlaceAction, applyScheduleAction } from '../services/AddSuggestionSources';
import type { PendingTaskAction } from '../hooks/useTasks';
import { untilAfterFromChange } from '../utils/timeRange';
import { liveParse, removeSpan, type LiveContact, type Span } from '../utils/liveParse';
import { describeDate, localKey } from '../utils/dateExpression';
import { reminderSlot, waLink, whatsappDigits, type Conclusion } from '../utils/addConclusions';
import { actionEnd, type Suggestion } from '../utils/addSuggestions';
import type { KnownPlaces } from '../utils/knownPlaces';
import LiveChips, { ltr, pinned, type Chip } from '../components/add/LiveChips';
import SuggestionList from '../components/add/SuggestionList';
import MeiraConclusions, { GreetingCard, conclusionKey } from '../components/add/MeiraConclusions';
import { readingRow } from '../components/today/readingRow';
import { checkBeforeSave } from '../services/ScheduleQueryService';
import { getTodayString } from '../utils/timeUtils';

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
function dayBanner(dateKey: string | undefined, he: boolean): string {
  const today = new Date();
  const key = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const target = dateKey || key(today);
  if (target === key(today)) return he ? 'היום' : 'Today';
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (target === key(tomorrow)) return he ? 'מחר' : 'Tomorrow';
  const [y, m, d] = target.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1)
    .toLocaleDateString(he ? 'he-IL' : 'en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

function timeToDate(hhmm?: string): Date {
  const d = new Date();
  if (hhmm && /^\d{1,2}:\d{2}$/.test(hhmm)) {
    const [h, m] = hhmm.split(':').map(Number);
    d.setHours(h, m, 0, 0);
  }
  return d;
}

function dateKeyToDate(key?: string): Date {
  const m = key?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date();
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

const say = (msg: string) => ToastAndroid?.show?.(msg, ToastAndroid.SHORT);

export default function AddTaskScreen({ navigation, route }: Props) {
  const { tasksState } = useLumiContext();
  const { language, he } = useAppLanguage();

  const initialTime = route.params?.initialTime;
  // Where the window the + was tapped in closes (the next event, or the leave
  // for it). The block defaults to END there, not an hour on — an hour from
  // 10:35 ran straight through an 11:00 call (Koral, 18.10).
  const initialUntil = route.params?.initialUntil;
  const defaultUntil = (from: string): string => {
    const hour = addMinutesToTime(from, 60);
    return initialUntil && initialUntil > from && initialUntil < hour ? initialUntil : hour;
  };
  // The day the caller was looking at. Absent = today.
  const initialDate = route.params?.initialDate;
  // A suggestion picked on Today's "+ Add something" arrives in the box, so she
  // sees what she is adding before she adds it.
  const [text, setText] = useState(route.params?.initialText ?? '');
  // The hour of the + tap is a DEFAULT: a time she types replaces it, and a
  // time she picks herself replaces both (timeTouched).
  const [fromTime, setFromTime] = useState<string | undefined>(initialTime);
  const [untilTime, setUntilTime] = useState<string | undefined>(
    initialTime ? defaultUntil(initialTime) : undefined,
  );
  const [picker, setPicker] = useState<'from' | 'until' | 'date' | null>(null);
  const timeTouched = useRef<boolean>(false);
  // undefined: the day follows the sentence. null: she removed it. string: she picked it.
  const [dateOverride, setDateOverride] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const [contacts, setContacts] = useState<LiveContact[]>([]);
  const [contactsReason, setContactsReason] = useState<string | undefined>();
  const [knownPlaces, setKnownPlaces] = useState<KnownPlaces | null>(null);
  const [personPick, setPersonPick] = useState<{ name: string; phone?: string } | null>(null);
  const [greeting, setGreeting] = useState<{ open: boolean; text: string; to: string } | null>(null);
  const [doneKeys, setDoneKeys] = useState<Set<string>>(new Set());
  const [tomorrow, setTomorrow] = useState<Array<{ text: string; time?: string; place?: string }>>([]);
  const inputRef = useRef<TextInput>(null);
  const now = useRef(new Date()).current;
  const todayKey = localKey(now);

  // ── what she has around her: contacts, usual places, tomorrow ───────────
  useEffect(() => {
    let alive = true;
    ContactService.listForMatching().then((r) => {
      if (!alive) return;
      setContacts(r.contacts);
      setContactsReason(r.reason);
      if (r.reason) console.warn('[AddTask] no contacts to match against:', r.reason);
    });
    loadKnownPlaces().then((p) => { if (alive) setKnownPlaces(p); })
      .catch((e) => console.warn('[AddTask] usual places unreadable', e));
    const t = new Date(now); t.setDate(t.getDate() + 1);
    getTasksForDate(localKey(t)).then((rows) => {
      if (!alive) return;
      setTomorrow(rows.filter((r) => r.status === 'pending').slice(0, 8).map((r) => ({
        text: r.text, time: r.fixedTime || r.scheduledTime,
        place: typeof r.location === 'string' ? r.location : r.location?.displayName || r.location?.address,
      })));
    }).catch((e) => console.warn('[AddTask] tomorrow unreadable — the server gets no context', e));
    return () => { alive = false; };
  }, [now]);

  // ── the live read of the sentence ───────────────────────────────────────
  const parse = useMemo(
    () => liveParse(text, { now, contacts, knownPlaces, language }),
    [text, contacts, knownPlaces, language, now],
  );

  // The hour in the words fills the pickers — until she sets one herself.
  useEffect(() => {
    if (timeTouched.current) return;
    if (parse.time) {
      setFromTime(parse.time);
      setUntilTime(parse.endTime ?? addMinutesToTime(parse.time, parse.durationMinutes || 60));
    } else if (initialTime) {
      setFromTime(initialTime);
      setUntilTime(defaultUntil(initialTime));
    } else {
      setFromTime(undefined);
      setUntilTime(undefined);
    }
  }, [parse.time, parse.endTime, parse.durationMinutes, initialTime, initialUntil]);

  const durationMinutes = fromTime && untilTime ? minutesBetween(fromTime, untilTime) : 30;
  // The day that will be saved: what she picked, else what the sentence says, else the day she was on.
  const effectiveDate: string | undefined =
    dateOverride !== undefined ? (dateOverride ?? initialDate) : (parse.date ?? initialDate);
  const dateShown = dateOverride !== undefined ? (dateOverride ?? undefined) : parse.date;
  const person = parse.person;
  const personPhone = personPick?.phone ?? person?.contact?.phone;
  const personHasPhone = Boolean(whatsappDigits(personPhone));

  const understand = useAddUnderstand({
    text,
    parse,
    he,
    effective: { time: fromTime, endTime: untilTime, date: effectiveDate ?? todayKey },
    personHasPhone,
    tomorrow,
  });
  const suggestions = useAddSuggestions(initialDate);

  // ── the chips ───────────────────────────────────────────────────────────
  const edit = (next: string) => setText(next);
  const selectWords = (sp?: Span) => {
    inputRef.current?.focus();
    if (sp) setTimeout(() => inputRef.current?.setSelection(sp.start, sp.end), 60);
  };

  const pickContact = async () => {
    const picked = await pickPhoneContact();
    ContactService.invalidate();
    if (!picked?.name) { say(he ? 'לא נבחר איש קשר' : 'No contact picked'); return; }
    setPersonPick({ name: picked.name, phone: picked.phone });
    ContactService.listForMatching().then((r) => { setContacts(r.contacts); setContactsReason(r.reason); });
    if (!picked.phone) say(he ? 'לאיש הקשר הזה אין מספר' : 'That contact has no number');
  };

  const chips: Chip[] = [];
  if (fromTime) {
    chips.push({
      key: 'time', icon: '🕐', tone: 'gold',
      label: ltr(untilTime ? `${fromTime}–${untilTime}` : fromTime),
      a11y: he ? `שעה ${fromTime}${untilTime ? ` עד ${untilTime}` : ''}` : `Time ${fromTime}${untilTime ? ` to ${untilTime}` : ''}`,
      a11yHint: he ? 'לחצי כדי לשנות' : 'Tap to change',
      onPress: () => setPicker('from'),
      onRemove: () => {
        timeTouched.current = true;
        setFromTime(undefined); setUntilTime(undefined);
        if (parse.spans.time) edit(removeSpan(text, parse.spans.time));
      },
      removeLabel: he ? 'להסיר את השעה' : 'Remove the time',
    });
  }
  if (dateShown) {
    chips.push({
      key: 'date', icon: '📅', tone: 'gold',
      label: describeDate(dateShown, now, he),
      a11yHint: he ? 'לחצי כדי לשנות' : 'Tap to change',
      onPress: () => setPicker('date'),
      onRemove: () => {
        if (dateOverride === undefined && parse.spans.date) edit(removeSpan(text, parse.spans.date));
        setDateOverride(null);
      },
      removeLabel: he ? 'להסיר את היום' : 'Remove the day',
    });
  }
  if (person) {
    const name = personPick?.name ?? person.label;
    const linked = Boolean(personPick || person.contact);
    chips.push({
      key: 'person', icon: '👤', tone: linked ? 'gold' : 'warn',
      label: linked ? name : `${name} · ${person.ambiguous ? (he ? 'מי מהם?' : 'which one?') : (he ? 'לחצי לחיבור' : 'tap to link')}`,
      a11yHint: he ? 'לחצי לבחירת איש קשר' : 'Tap to choose a contact',
      onPress: pickContact,
      onRemove: () => { setPersonPick(null); edit(removeSpan(text, person.span)); },
      removeLabel: he ? 'להסיר את האדם' : 'Remove the person',
    });
  }
  if (parse.place) {
    const typed = parse.place.source === 'typed';
    chips.push({
      key: 'place', icon: '📍', tone: 'gold',
      label: typed ? parse.place.text : `${parse.place.text} · ${he ? 'המקום הרגיל' : 'your usual'}`,
      a11yHint: typed ? (he ? 'לחצי כדי לערוך את המילים' : 'Tap to edit the words') : undefined,
      onPress: typed ? () => selectWords(parse.spans.place) : undefined,
      onRemove: typed && parse.spans.place ? () => edit(removeSpan(text, parse.spans.place!)) : undefined,
      removeLabel: he ? 'להסיר את המקום' : 'Remove the place',
    });
  }
  if (parse.categoryMatched) {
    const meta = CATEGORY_META[parse.category];
    chips.push({ key: 'cat', icon: parse.icon, tone: 'soft', label: he ? meta.labelHe : meta.labelEn });
  }

  // ── suggestions ─────────────────────────────────────────────────────────
  const onPickSuggestion = async (row: Suggestion) => {
    const a = row.action;
    if (a.kind === 'prefill') {
      // Put it in the box with its hour and day, so she sees what she is adding.
      timeTouched.current = true;
      setText(he ? (a.textHe ?? a.text) : a.text);
      if (a.time) {
        setFromTime(a.time);
        setUntilTime(addMinutesToTime(a.time, 45));
      }
      setDateOverride(a.date && a.date !== initialDate ? a.date : undefined);
      inputRef.current?.focus();
      return;
    }
    if (a.kind === 'open') { navigation.navigate('TaskDetail', { taskId: a.taskId } as any); return; }
    setBusyRow(row.id);
    try {
      if (a.kind === 'schedule') await applyScheduleAction(a);
      else await applyPlaceAction(a);
      await tasksState.refresh();
      const end = actionEnd(a);
      say(he
        ? `נקבע ל-${a.time}${end ? `–${end}` : ''}`
        : `Set for ${a.time}${end ? `–${end}` : ''}`);
      navigation.goBack();
    } catch (e) {
      console.warn('[AddTask] could not apply the suggestion', row.id, e);
      say(he ? 'לא הצלחתי לקבוע — נסי שוב' : "Couldn't set that — try again");
    } finally {
      setBusyRow(null);
    }
  };

  // ── Meira's conclusions ─────────────────────────────────────────────────
  const sendGreeting = async (draft: string) => {
    let number = personPhone;
    if (!whatsappDigits(number)) {
      const picked = await pickPhoneContact();
      ContactService.invalidate();
      if (!picked?.phone) {
        say(he ? 'אין מספר לשלוח אליו' : 'No number to send it to');
        return;
      }
      setPersonPick({ name: picked.name ?? person?.label ?? '', phone: picked.phone });
      number = picked.phone;
    }
    const url = waLink(number, draft);
    if (!url) { say(he ? 'המספר לא נראה תקין' : "That number doesn't look right"); return; }
    try {
      await Linking.openURL(url);
    } catch (e) {
      console.warn('[AddTask] could not open WhatsApp', e);
      say(he ? 'לא הצלחתי לפתוח וואטסאפ' : "Couldn't open WhatsApp");
    }
  };

  const onConclusion = async (c: Conclusion, key: string) => {
    const g = understand.greeting;
    switch (c.action.type) {
      case 'show_greeting':
        if (g) setGreeting({ open: true, text: he ? g.text_he : g.text_en, to: g.to });
        else say(he ? 'אין לי ברכה להראות' : 'There is no greeting to show');
        return;
      case 'open_whatsapp':
        if (g) await sendGreeting(greeting?.text ?? (he ? g.text_he : g.text_en));
        else say(he ? 'אין לי ברכה לשלוח' : 'There is no greeting to send');
        return;
      case 'add_reminder':
      case 'add_prep': {
        if (!c.action.when) return;
        const slot = reminderSlot(c.action.when, { date: effectiveDate ?? todayKey, time: fromTime }, new Date());
        if (!slot) { say(he ? 'הרגע הזה כבר עבר' : 'That moment has passed'); return; }
        try {
          await tasksState.addManualTask(he ? c.text_he : c.text_en, {
            fixedTime: slot.time, durationMinutes: c.action.type === 'add_prep' ? 45 : 5, date: slot.date,
          });
          setDoneKeys((s) => new Set(s).add(key));
          say(he ? `נוסף: ${slot.time}, ${describeDate(slot.date, new Date(), true)}` : `Added: ${slot.time}, ${describeDate(slot.date, new Date(), false)}`);
        } catch (e) {
          console.warn('[AddTask] could not add the reminder', e);
          say(he ? 'לא הצלחתי להוסיף את התזכורת' : "Couldn't add the reminder");
        }
        return;
      }
      default:
    }
  };

  // Confirm-before-apply for voice commands that touch an EXISTING task
  // ("done with the gym", "תזיז את החדר כושר ל-18:00"). Lumi speech stays short.
  const confirmAction = async (action: PendingTaskAction) => {
    const heNow = (await getSettings()).language === 'he';
    const verb =
      action.kind === 'complete'
        ? heNow ? 'לסמן כבוצע' : 'Mark done'
        : action.kind === 'delete'
          ? heNow ? 'למחוק' : 'Delete'
          : heNow ? 'לעדכן' : 'Update';
    const changes = Object.entries(action.patch)
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join(', ');
    return new Promise<boolean>((resolve) => {
      Alert.alert(
        `${verb}?`,
        `"${action.task.text}"${changes ? `\n${changes}` : ''}`,
        [
          { text: heNow ? 'ביטול' : 'Cancel', style: 'cancel', onPress: () => resolve(false) },
          { text: heNow ? 'כן' : 'Yes', onPress: () => resolve(true) },
        ],
      );
    });
  };

  const handleCreate = async () => {
    const trimmed = text.trim();
    if (!trimmed) {
      Alert.alert(he ? 'כתבי מה להוסיף' : 'Please enter a task description');
      return;
    }
    setBusy(true);
    // What the chips promised is what is saved: the day she sees, the place she
    // sees. (The + on today's timeline used to ignore "מחר ב-8" and write today.)
    const place = parse.place?.source === 'typed' ? parse.place.text : undefined;
    try {
      // Does it fit the day — travel from the meeting before, to the one after,
      // her margin? (Koral 28.10: warn it's impossible, then save anyway or find
      // a new time.) Checked BEFORE anything is saved; only with an hour.
      let atTime = fromTime;
      if (fromTime) {
        const check = await checkBeforeSave(
          { text: trimmed, date: effectiveDate ?? getTodayString(), fixedTime: fromTime, durationMinutes, place }, he ? 'he' : 'en');
        if (check.error) say(he ? 'לא הצלחתי לבדוק אם זה נכנס ביום' : "Couldn't check whether it fits the day");
        if (check.stop) {
          const choice = await new Promise<'save' | 'alt' | 'edit'>((resolve) => {
            Alert.alert(
              he ? '⚠️ זה לא נכנס' : "⚠️ This doesn't fit",
              check.text,
              [
                { text: he ? 'ביטול' : 'Cancel', style: 'cancel', onPress: () => resolve('edit') },
                { text: he ? 'לשמור בכל זאת' : 'Save anyway', onPress: () => resolve('save') },
                check.alt
                  ? { text: he ? `לקבוע ב-${check.alt}` : `Book ${check.alt}`, onPress: () => resolve('alt') }
                  : { text: he ? 'לבחור זמן אחר' : 'Pick another time', onPress: () => resolve('edit') },
              ],
              { cancelable: true, onDismiss: () => resolve('edit') },
            );
          });
          if (choice === 'edit') return;   // nothing saved; she changes the hour or day on this screen
          if (choice === 'alt') { atTime = check.alt; setFromTime(check.alt); }
        }
      }
      const extra = atTime
        ? { fixedTime: atTime, durationMinutes, date: effectiveDate, place }
        : undefined;

      // First: is this a command about an existing task rather than a new one?
      if (!fromTime && tasksState.processSpeechCommand) {
        const result = await tasksState.processSpeechCommand(trimmed);
        const heNow = (await getSettings()).language === 'he';
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
              heNow ? 'איזו משימה?' : 'Which task?',
              undefined,
              [
                ...result.candidates.map((t) => ({ text: t.text, onPress: () => resolve(t) })),
                { text: heNow ? 'ביטול' : 'Cancel', style: 'cancel' as const, onPress: () => resolve(null) },
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
          Alert.alert(heNow ? 'לא מצאתי משימה כזאת' : "Couldn't find that task");
          return;
        }
        if (result.type === 'duplicate') {
          // Lumi isn't sure — ask: same task (update with the new details) or
          // genuinely a new one?
          const sameTask = await new Promise<boolean | null>((resolve) => {
            Alert.alert(
              heNow ? 'אותה משימה?' : 'Same task?',
              heNow
                ? `יש לך כבר: "${result.action.task.text}". לעדכן אותה בפרטים החדשים?`
                : `You already have: "${result.action.task.text}". Update it with the new details?`,
              [
                { text: heNow ? 'ביטול' : 'Cancel', style: 'cancel', onPress: () => resolve(null) },
                { text: heNow ? 'משימה חדשה' : 'New task', onPress: () => resolve(false) },
                { text: heNow ? 'כן, עדכני' : 'Yes, update', onPress: () => resolve(true) },
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

      // Try LLM parsing first; fall back to manual if nothing comes back.
      //
      // `initialDate` goes in as the DEFAULT day. It used not to, so the +
      // pressed on tomorrow's timeline parsed a sentence with no date in it
      // and wrote the task onto today: created, saved, synced — and absent
      // from the day she was looking at. From the outside that is a button
      // that does nothing.
      //
      // A day she picked or removed on the chip is hers: the parser would read
      // the sentence again and overrule it, so that case is saved directly.
      let created: Array<{ date?: string }> = [];
      if (!fromTime && dateOverride === undefined && tasksState.addMorningTasksFromSpeech) {
        created = await tasksState.addMorningTasksFromSpeech(trimmed, initialDate) as Array<{ date?: string }>;
      }
      if ((!created || created.length === 0) && tasksState.addManualTask) {
        await tasksState.addManualTask(trimmed, { ...(extra ?? {}), date: effectiveDate, place });
        created = [{ date: effectiveDate }];
      }
      // Say where it landed — the day it ACTUALLY landed on, read back from
      // what was created, not the day this screen assumed. A sentence may
      // carry its own date ("ביום ראשון"), and a toast naming the wrong day is
      // worse than none: it ends the search before it starts.
      const landed = Array.from(new Set(created.map((t) => t?.date).filter(Boolean) as string[]));
      say(`${he ? 'נוסף ל' : 'Added to '}${(landed.length ? landed : [effectiveDate]).map((d) => dayBanner(d, he)).join(', ')}`);
      navigation.goBack();
    } catch (e) {
      console.warn('[AddTask] error:', e);
      if (tasksState.addManualTask) {
        await tasksState.addManualTask(trimmed, {
          ...(fromTime ? { fixedTime: fromTime, durationMinutes } : {}), date: effectiveDate, place,
        });
      }
      navigation.goBack();
    } finally {
      setBusy(false);
    }
  };

  const onPickerChange = (field: 'from' | 'until' | 'date') => (_: any, selected?: Date) => {
    setPicker(null);
    if (!selected) return;
    if (field === 'date') {
      setDateOverride(localKey(selected));
      return;
    }
    timeTouched.current = true;   // a deliberate pick; typing must not undo it
    const hhmm = `${pad(selected.getHours())}:${pad(selected.getMinutes())}`;
    if (field === 'from') {
      setFromTime(hhmm);
      // Until follows: same length as before, or an hour when there was none.
      setUntilTime(untilAfterFromChange(fromTime, untilTime, hhmm, 60));
    } else {
      setUntilTime(hhmm);
    }
  };

  const typing = text.trim().length > 0;

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        {/* Header */}
        <View style={styles.header}>
          <Pressable
            onPress={() => navigation.goBack()}
            style={styles.closeBtn}
            accessibilityRole="button"
            accessibilityLabel={he ? 'סגירה' : 'Close'}
          >
            <Text style={styles.closeText}>×</Text>
          </Pressable>
          <View style={styles.titleBox}>
            <Text style={styles.title} numberOfLines={1}>{pinned(he, he ? 'מה להוסיף?' : 'What do you want to add?')}</Text>
            <Text style={styles.dayLine} numberOfLines={1}>📅 {pinned(he, dayBanner(effectiveDate ?? initialDate, he))}</Text>
          </View>
          <View style={styles.closeBtn} />
        </View>

        <ScrollView
          style={styles.content}
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* The sentence */}
          <TextInput
            ref={inputRef}
            style={[styles.textInput, { textAlign: he ? 'right' : 'left' }]}
            placeholder={he ? 'למשל: יום הולדת לאבא ב-20:00, ראיון ביום ראשון ב-13:30' : "e.g. Dad's birthday at 20:00, interview Sunday 13:30"}
            value={text}
            onChangeText={setText}
            multiline
            autoFocus
            placeholderTextColor={BRAND.inkSoft}
            accessibilityLabel={he ? 'מה להוסיף' : 'What to add'}
          />

          {/* What I understood — on every keystroke */}
          <LiveChips chips={chips} he={he} />

          {/* What Meira worked out — after a pause */}
          <MeiraConclusions
            he={he}
            view={understand}
            doneKeys={doneKeys}
            onAct={onConclusion}
          />
          {greeting?.open ? (
            <GreetingCard
              he={he}
              to={greeting.to}
              text={greeting.text}
              onChange={(t) => setGreeting({ ...greeting, text: t })}
              onSend={() => sendGreeting(greeting.text)}
              onClose={() => setGreeting({ ...greeting, open: false })}
              hasPhone={personHasPhone}
            />
          ) : null}

          {/* An empty box offers ideas */}
          {!typing ? (
            <SuggestionList
              he={he}
              rows={suggestions.rows}
              loading={suggestions.loading}
              allFailed={suggestions.allFailed}
              onPick={onPickSuggestion}
              busyId={busyRow}
            />
          ) : null}

          {/* From / Until */}
          <View style={styles.section}>
            <Text style={styles.label}>{pinned(he, he ? 'שעה' : 'Time')}</Text>
            <View style={[styles.timeRow, { flexDirection: readingRow(he) }]}>
              <View style={styles.timeBlock}>
                <Text style={styles.timeLabel}>{he ? 'מ' : 'From'}</Text>
                <Pressable
                  style={styles.timeChip}
                  onPress={() => setPicker('from')}
                  accessibilityRole="button"
                  accessibilityLabel={he ? 'שעת התחלה' : 'Start time'}
                >
                  <Text style={styles.timeChipText}>{fromTime ?? '—'}</Text>
                </Pressable>
              </View>

              <Text style={styles.timeSep}>{he ? '←' : '→'}</Text>

              <View style={styles.timeBlock}>
                <Text style={styles.timeLabel}>{he ? 'עד' : 'Until'}</Text>
                <Pressable
                  style={[styles.timeChip, !fromTime && styles.timeChipDisabled]}
                  onPress={() => fromTime && setPicker('until')}
                  accessibilityRole="button"
                  accessibilityLabel={he ? 'שעת סיום' : 'End time'}
                >
                  <Text style={styles.timeChipText}>{untilTime ?? '—'}</Text>
                </Pressable>
              </View>

              {(fromTime || untilTime) && (
                <Pressable
                  style={styles.clearBtn}
                  onPress={() => {
                    timeTouched.current = true;
                    setFromTime(undefined); setUntilTime(undefined);
                    if (parse.spans.time) edit(removeSpan(text, parse.spans.time));
                  }}
                  accessibilityRole="button"
                >
                  <Text style={styles.clearText}>{he ? 'ניקוי' : 'Clear'}</Text>
                </Pressable>
              )}
            </View>

            {fromTime && untilTime && durationMinutes > 0 && (
              <Text style={styles.durationHint}>⏱ {durationMinutes} {he ? 'דק׳' : 'min'}</Text>
            )}
          </View>
        </ScrollView>

        {/* Pickers */}
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
        {picker === 'date' && (
          <DateTimePicker
            value={dateKeyToDate(effectiveDate)}
            mode="date"
            minimumDate={new Date(now.getFullYear(), now.getMonth(), now.getDate())}
            onChange={onPickerChange('date')}
          />
        )}

        {/* Actions */}
        <View style={[styles.actions, { flexDirection: readingRow(he) }]}>
          <Pressable
            onPress={() => navigation.goBack()}
            accessibilityRole="button"
            style={({ pressed }) => [styles.button, styles.cancelButton, pressed && { opacity: 0.7 }]}
          >
            <Text style={styles.cancelText}>{he ? 'ביטול' : 'Cancel'}</Text>
          </Pressable>
          <Pressable
            onPress={handleCreate}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={he ? 'הוספה' : 'Add'}
            style={({ pressed }) => [styles.button, styles.createButton, (pressed || busy) && { opacity: 0.7 }]}
          >
            {busy ? (
              <ActivityIndicator color={BRAND.onGold} />
            ) : (
              <Text style={styles.createText}>{he ? 'הוספה' : 'Add'}</Text>
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
  titleBox: { flex: 1, alignItems: 'center', gap: 2, paddingHorizontal: 8 },
  dayLine: { fontSize: 12, fontFamily: FONTS.bodyBold, color: BRAND.goldInk },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: BRAND.line,
  },
  title: { fontSize: 16, fontFamily: FONTS.bodyBold, color: BRAND.warmInk, textAlign: 'center' },
  closeBtn: { width: MIN_TOUCH, height: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' },
  closeText: { fontSize: 28, lineHeight: 30, color: BRAND.warmInk, fontFamily: FONTS.bodySemi },
  content: { flex: 1, paddingHorizontal: 16 },
  scroll: { paddingTop: 16, paddingBottom: 16, gap: 14 },
  section: { gap: 0 },
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
    fontSize: 16,
    fontFamily: FONTS.body,
    color: BRAND.warmInk,
    minHeight: 84,
    textAlignVertical: 'top',
    borderWidth: 1,
    borderColor: BRAND.line,
  },
  timeRow: { alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  timeBlock: { alignItems: 'center', gap: 4 },
  timeLabel: { fontSize: 11, fontFamily: FONTS.bodyBold, color: BRAND.inkSoft, textTransform: 'uppercase' },
  timeChip: {
    minHeight: MIN_TOUCH,
    minWidth: 80,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: BRAND.creamCard,
    borderRadius: RADIUS.chip,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: BRAND.line,
  },
  timeChipDisabled: { opacity: 0.4 },
  timeChipText: { fontSize: 16, fontFamily: FONTS.bodyBold, color: BRAND.warmInk, fontVariant: ['tabular-nums'] },
  timeSep: { fontSize: 18, color: BRAND.inkSoft, marginTop: 18 },
  durationHint: { fontSize: 12, color: BRAND.inkSoft, marginTop: 6 },
  clearBtn: { minHeight: MIN_TOUCH, justifyContent: 'center', marginTop: 18, paddingHorizontal: 8 },
  clearText: { fontSize: 13, color: BRAND.inkSoft, fontFamily: FONTS.bodySemi },
  actions: {
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: BRAND.line,
  },
  button: { flex: 1, minHeight: MIN_TOUCH + 4, borderRadius: RADIUS.chip, alignItems: 'center', justifyContent: 'center' },
  cancelButton: { backgroundColor: BRAND.creamCard, borderWidth: 1, borderColor: BRAND.line },
  cancelText: { fontSize: 15, fontFamily: FONTS.bodyBold, color: BRAND.warmInk },
  // Ink ON gold (BRAND.onGold): white on the gold is 1.7:1.
  createButton: { backgroundColor: BRAND.sunGold },
  createText: { fontSize: 15, fontFamily: FONTS.bodyBold, color: BRAND.onGold },
});
