/**
 * RunningLate — her answer to "you're late".
 *
 * 13.10, Koral: "if you see I haven't left — ask me: you're late, are you
 * still going? reschedule? cancel? keep options!" And then: "to an interview I
 * cannot be late! If it's nearly 13:00 and I'm still at home I haven't left —
 * why? Cancelled? Changed? To when? If it is not rescheduled to a new time,
 * keep it in the open tasks to do!"
 *
 * The question comes from LiveRoute's missed-departure re-plan — a
 * notification with buttons ('running-late' / 'cannot-be-late') and the banner
 * on Today. "Still going" needs nothing. This file is the rest:
 *
 *   cancel     → it is off: alerts stop, marked not going. Nothing left open.
 *   reschedule → her own task: tomorrow, same hour — or "no new time yet".
 *                A calendar meeting is not Meira's to move (the import would
 *                bring it back), so it says where it is moved.
 *   open       → "don't know yet": not going now, and an OPEN task to set the
 *                new time, so the thing is not lost.
 *
 * "New time" is three plain choices (21.10, Koral: the buttons after "you didn't make it" were
 * unclear): 🚶 go NOW — route from the real position, leaving now · 🔁 move it — to when · ⏳ set the
 * time later — it joins the open tasks to schedule.
 *
 * Triggered from App.tsx (notification action) and TodaySchedule (banner).
 */
import { Alert } from 'react-native';
import { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { Task } from '../types/index';
import { addTask, getAllTasks, getSettings, getTasksForDate, moveTasksToDate, updateTaskFields } from './TaskStorage';
import { cancelTaskNotifications } from './NotificationService';
import { getTodayString, getTomorrowString } from '../utils/timeUtils';
import { followUpOriginal, followUpTitle, isFromCalendar } from '../utils/liveRoutePlan';
import { getCurrentLocation } from './LocationService';
import { loadProfile } from './UserProfileStorage';

export { isFromCalendar };

/**
 * The screen listens here: an answer to "you're late" changed a task (a route from here, a new
 * date, a note kept open) — and the answers come from system dialogs that resolve AFTER the
 * function that opened them returned, so nobody awaits them. Without this the card kept showing the
 * old plan under a stored new one (21.10, 11:15: "leave 09:18" on screen, "11:37" in storage).
 */
const changeListeners = new Set<() => void>();
export function onLateAnswered(fn: () => void): () => void {
  changeListeners.add(fn);
  return () => { changeListeners.delete(fn); };
}
const lateChanged = (): void => {
  changeListeners.forEach((fn) => { try { fn(); } catch (e) { console.warn('[RunningLate] listener failed', e); } });
};
export type LateIntent = 'cancel' | 'reschedule' | 'open';

/** Not going now: the alerts stop and the day stops planning around it. */
export async function markNotGoing(task: Task): Promise<void> {
  await cancelTaskNotifications(task).catch((e) => console.warn('[RunningLate] alerts not cancelled', e));
  await updateTaskFields(task.id, { status: 'missed' } as Partial<Task>);
  // The way home after it goes too (28.10: "cancel the meeting → cancel heading home") — now,
  // not at the next sync. Lazy: ReturnHomeTasks pulls in the routine stores.
  const lang = await getSettings().then((st) => st.language).catch(() => 'he' as const);
  await import('./ReturnHomeTasks')
    .then((m) => m.ensureReturnHomeTasks(lang))
    .catch((e) => console.warn('[RunningLate] way home not updated', e));
  lateChanged();
}

/** Not going now, and the new time is still to be set — an open task says so. */
export async function keepOpen(task: Task, he: boolean): Promise<void> {
  await markNotGoing(task);
  // One note per task: pressing "later" again must not add a second (28.10).
  const already = (await getAllTasks().catch(() => [] as Task[])).some((t) => t.status === 'pending'
    && ((t as any).followUpOf === task.id || followUpOriginal(t.text) === task.text));
  if (already) { lateChanged(); return; }
  await addTask({
    text: followUpTitle(task.text, he),
    category: 'call',
    priority: 'must',
    isFixed: false,
    durationMinutes: 10,
    date: getTodayString(),
    status: 'pending',
    historicalDurations: [],
    // Which task it is about — so the bell can open THAT task (local; the title carries it too).
    followUpOf: task.id,
  } as Omit<Task, 'id' | 'createdAt' | 'completedAt'>);
  // Now the follow-up exists: the bell reloads (markNotGoing announced before it did — 28.10).
  lateChanged();
}

/** The task a "set a new time" follow-up is about: by id when kept, else the latest not-gone task of that name. */
export async function originalOf(followUp: Task): Promise<Task | null> {
  const all = await getAllTasks().catch(() => [] as Task[]);
  const byId = (followUp as any).followUpOf ? all.find((t) => t.id === (followUp as any).followUpOf) : undefined;
  if (byId) return byId;
  const name = followUpOriginal(followUp.text);
  if (!name) return null;
  return all.filter((t) => t.text === name && t.id !== followUp.id)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0] ?? null;
}

/**
 * 📅 From the bell: give the follow-up its new date and hour — the original
 * task moves there and is planned again; the follow-up is done. false = she
 * backed out or the original is gone (said).
 */
export async function setNewDate(followUp: Task, he: boolean): Promise<boolean> {
  const original = await originalOf(followUp);
  if (!original) {
    Alert.alert(he ? 'לא מצאתי את המשימה המקורית' : "I couldn't find the original task",
      he ? 'אפשר להוסיף אותה מחדש עם המועד החדש.' : 'You can add it again with the new time.');
    return false;
  }
  const initial = new Date(); initial.setDate(initial.getDate() + 1);
  const at = await pickDateAndHour(initial);
  if (!at) return false;
  const hhmm = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
  await updateTaskFields(original.id, { fixedTime: hhmm, scheduledTime: hhmm, isFixed: true, status: 'pending' } as Partial<Task>);
  const n = await moveTasksToDate([original.id], ymd(at));
  if (!n) {
    Alert.alert(he ? 'לא נשמר' : 'Not saved', he ? 'המשימה לא נמצאה' : 'The task was not found');
    return false;
  }
  await updateTaskFields(followUp.id, { status: 'complete', completedAt: Date.now() } as Partial<Task>);
  lateChanged();
  Alert.alert(he ? `נקבע ל-${ymd(at)} ב-${hhmm} ✓` : `Set for ${ymd(at)} at ${hhmm} ✓`, original.text);
  return true;
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** A date, then an hour — the two system dialogs, one after the other. null = she backed out. */
export function pickDateAndHour(initial: Date): Promise<Date | null> {
  return new Promise((resolve) => {
    DateTimePickerAndroid.open({
      value: initial, mode: 'date', minimumDate: new Date(),
      onChange: (e, day) => {
        if (e.type !== 'set' || !day) return resolve(null);
        DateTimePickerAndroid.open({
          value: day, mode: 'time', is24Hour: true,
          onChange: (e2, time) => {
            if (e2.type !== 'set' || !time) return resolve(null);
            const out = new Date(day);
            out.setHours(time.getHours(), time.getMinutes(), 0, 0);
            resolve(out);
          },
        });
      },
    });
  });
}

/** 📅 Another date AND hour (21.10, Koral: "reschedule for another time, date and hour"). */
export async function moveToChosenSlot(task: Task, he: boolean): Promise<boolean> {
  const initial = new Date(); initial.setDate(initial.getDate() + 1);
  const at = await pickDateAndHour(initial);
  if (!at) return false;
  const hhmm = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
  await cancelTaskNotifications(task).catch((e) => console.warn('[RunningLate] alerts not cancelled', e));
  // The hour first, then the day: moveTasksToDate re-arms the alerts from what is stored.
  await updateTaskFields(task.id, { fixedTime: hhmm, scheduledTime: hhmm, isFixed: true } as Partial<Task>);
  const n = await moveTasksToDate([task.id], ymd(at));
  lateChanged();
  Alert.alert(n ? (he ? `הועבר ל-${ymd(at)} ב-${hhmm} ✓` : `Moved to ${ymd(at)} at ${hhmm} ✓`)
    : (he ? 'לא נשמר' : 'Not saved'), n ? '' : (he ? 'המשימה לא נמצאה' : 'The task was not found'));
  return n > 0;
}

/** 🚶 "Calculate from now, from where I am": the real fix, a depart-now route, said plainly — or why not. */
export async function goNowFromHere(task: Task, he: boolean): Promise<void> {
  const pos = await getCurrentLocation().catch(() => null);
  if (!pos) {
    Alert.alert(he ? 'אין לי את המיקום שלך' : "I can't see where you are",
      he ? 'אשרי מיקום לאפליקציה (או הפעילי GPS) ונסי שוב — בלי זה אחשב מהבית, וזה לא נכון.'
        : 'Allow location for the app (or turn GPS on) and try again — without it I would route from home, which is wrong.');
    return;
  }
  const profile = await loadProfile().catch(() => null);
  const { replanFromNextDeparture } = await import('./LiveRoute');   // lazy: LiveRoute is heavy and imports half the app
  const r = await replanFromNextDeparture(task, profile, { from: pos, language: he ? 'he' : 'en' });
  if (!r.replanned) {
    Alert.alert(he ? 'לא הצלחתי לחשב מסלול' : "I couldn't work out a route",
      he ? `סיבה: ${r.reason}. נסי שוב בעוד רגע, או בחרי "לדחות".` : `Reason: ${r.reason}. Try again in a moment, or pick "Move it".`);
    return;
  }
  lateChanged();
  Alert.alert(he ? '🚶 מחושב מהמקום שבו את, יוצאת עכשיו' : '🚶 Worked out from where you are, leaving now', r.message ?? '');
}

export async function answerRunningLate(taskId: string, intent: LateIntent, he: boolean, fromChoice = false): Promise<void> {
  const task = (await getTasksForDate(getTodayString()).catch(() => [] as Task[])).find((t) => t.id === taskId);
  if (!task) {
    Alert.alert(he ? 'לא מצאתי את המשימה' : "I couldn't find that task", he ? 'ייתכן שכבר עודכנה.' : 'It may have changed already.');
    return;
  }
  const calendar = isFromCalendar(task.id);
  const done = (title: string, body = '') => Alert.alert(title, body);
  const failed = (e: unknown) => Alert.alert(he ? 'לא נשמר' : 'Not saved', String(e));
  const back = { text: he ? 'חזרה' : 'Back', style: 'cancel' as const };
  const open = {
    text: he ? '⏳ עוד אין מועד — לזכור לי' : '⏳ No new time yet — remind me',
    onPress: () => {
      keepOpen(task, he)
        .then(() => done(he ? 'נכנס להתראות 🔔 — אזכיר לך לקבוע מועד ✓' : 'In your 🔔 — I\'ll remind you to set a date ✓', followUpTitle(task.text, he)))
        .catch(failed);
    },
  };

  if (intent === 'open') {
    keepOpen(task, he)
      .then(() => done(he ? 'נכנס להתראות 🔔 — אזכיר לך לקבוע מועד ✓' : 'In your 🔔 — I\'ll remind you to set a date ✓', followUpTitle(task.text, he)))
      .catch(failed);
    return;
  }

  if (intent === 'cancel') {
    Alert.alert(he ? `${task.text} בוטל?` : `${task.text} is off?`, calendar
      ? (he ? 'אבטל את התזכורות. זה מהיומן שלך — אם הוא נשאר שם, כדאי להודיע להם.' : "I'll stop the alerts. It's from your calendar — if it's still there, worth telling them.")
      : (he ? 'אבטל את התזכורות ואסמן שלא הלכת.' : "I'll stop the alerts and mark it as not done."), [
      back,
      {
        text: he ? 'כן, בוטל' : 'Yes, it is off',
        style: 'destructive',
        onPress: () => { markNotGoing(task).then(() => done(he ? 'סימנתי ✓' : 'Done ✓')).catch(failed); },
      },
      open,
    ]);
    return;
  }

  // 'reschedule' is the front door of "New time": three plain choices, then the rest.
  if (intent === 'reschedule' && !fromChoice) {
    Alert.alert(he ? `${task.text} — מה עושים?` : `${task.text} — what now?`,
      he ? 'אפשר עדיין להגיע, לדחות, או לתזמן אחר כך.' : 'You can still go, move it, or set the time later.', [
        { text: he ? '🚶 לחשב מעכשיו, מהמקום שבו אני' : '🚶 Route me now, from where I am',
          onPress: () => { goNowFromHere(task, he).catch(failed); } },
        { text: he ? '🔁 לדחות — למתי?' : '🔁 Move it — to when?',
          onPress: () => { answerRunningLate(taskId, 'reschedule', he, true).catch(failed); } },
        { text: he ? '⏳ לתזמן אחר כך' : '⏳ Set the time later',
          onPress: () => {
            keepOpen(task, he)
              .then(() => done(he ? 'נכנס להתראות 🔔 — אזכיר לך לקבוע מועד ✓' : 'In your 🔔 — I\'ll remind you to set a date ✓', followUpTitle(task.text, he)))
              .catch(failed);
          } },
      ], { cancelable: true });
    return;
  }

  if (calendar) {
    Alert.alert(he ? 'הוזז — למתי?' : 'Moved — to when?', he
      ? 'זו פגישה מהיומן: המועד החדש ייכנס כשישתנה ביומן, ואני אסנכרן אותו. עד אז אשמור משימה פתוחה לתאם מועד.'
      : "It's a calendar meeting: the new time arrives when the calendar changes, and I'll sync it. Until then I'll keep an open task to set it.",
    [back, open]);
    return;
  }
  Alert.alert(he ? `${task.text} — למתי?` : `${task.text} — to when?`, '', [
    { text: he ? '📅 תאריך ושעה אחרים' : '📅 Another date and hour',
      onPress: () => { moveToChosenSlot(task, he).catch(failed); } },
    {
      text: he ? 'מחר באותה שעה' : 'Tomorrow, same time',
      onPress: () => {
        cancelTaskNotifications(task).catch(() => {});
        moveTasksToDate([task.id], getTomorrowString())
          .then((n) => { lateChanged(); return n; })
          .then((n) => (n ? done(he ? 'הועבר למחר ✓' : 'Moved to tomorrow ✓') : failed(he ? 'המשימה לא נמצאה' : 'not found')))
          .catch(failed);
      },
    },
    open,
  ], { cancelable: true });
}
