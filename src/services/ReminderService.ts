/**
 * ReminderService — reminders that are NOT tasks.
 *
 * "Remind me at 16:00" is not a to-do item, it is an alarm. Until now the app
 * had no way to express that: TaskIntent routed every "תזכיר לי" into task
 * creation, so asking for an alert at 16:00 produced a task called
 * "notify me at 16:00" and no alert at all. This module is the missing half.
 *
 * Three things live here:
 *   • standalone reminders — a time, a message, a notification
 *   • lead times on an existing task — "remind me 30 minutes before"
 *   • conversation focus — which task "…before" refers to, with a TTL
 *
 * The store is AsyncStorage; rehydrateReminders() re-arms everything at app
 * start, because scheduled notifications don't survive a reinstall.
 *
 * Dependencies: NotificationService (scheduling), TaskStorage (lead times).
 * Consumed by LumiCoachEngine's reminder branch and App bootstrap.
 */
import AsyncStorage from './EncryptedStorage';  // AES-256-GCM at rest (7.10)
import { Task } from '../types/index';
import { scheduleReminderAt, cancelScheduled } from './NotificationService';
import { getAllTasks, updateTaskFields } from './TaskStorage';
import { armTaskAlerts } from './NotificationService';

const REMINDERS_KEY = 'lumi.standaloneReminders.v1';
const FOCUS_KEY = 'lumi.taskFocus.v1';
/** How long "…30 minutes before" still refers to the task just discussed. */
const FOCUS_TTL_MS = 45 * 60 * 1000;

export interface StandaloneReminder {
  id: string;
  /** What to say. Empty means a bare "reminder" ping. */
  text: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  notificationId?: string;
  createdAt: number;
}

const newId = () => `rem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function readAll(): Promise<StandaloneReminder[]> {
  try {
    const raw = await AsyncStorage.getItem(REMINDERS_KEY);
    return raw ? (JSON.parse(raw) as StandaloneReminder[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(list: StandaloneReminder[]): Promise<void> {
  await AsyncStorage.setItem(REMINDERS_KEY, JSON.stringify(list)).catch(() => {});
}

/** Reminders still in the future, soonest first. */
export async function listReminders(): Promise<StandaloneReminder[]> {
  const now = Date.now();
  return (await readAll())
    .filter((r) => whenOf(r) > now)
    .sort((a, b) => whenOf(a) - whenOf(b));
}

function whenOf(r: { date: string; time: string }): number {
  const [y, mo, d] = (r.date || '').split('-').map(Number);
  const [h, mi] = (r.time || '').split(':').map(Number);
  if ([y, mo, d, h, mi].some((n) => !Number.isFinite(n))) return 0;
  return new Date(y, mo - 1, d + 0, h, mi, 0, 0).getTime();
}

/**
 * Schedule a one-off reminder. Returns null when the moment already passed —
 * the caller must NOT claim success in that case (the WhatsApp agent learned
 * this the hard way: never print ✓ without a real id).
 */
export async function setStandaloneReminder(input: {
  text: string;
  date: string;
  time: string;
}): Promise<StandaloneReminder | null> {
  const reminder: StandaloneReminder = {
    id: newId(),
    text: (input.text || '').trim(),
    date: input.date,
    time: input.time,
    createdAt: Date.now(),
  };
  if (whenOf(reminder) <= Date.now()) return null;

  const notificationId = await scheduleReminderAt(
    new Date(whenOf(reminder)),
    reminder.text,
    { reminderId: reminder.id },
  );
  if (!notificationId) return null;
  reminder.notificationId = notificationId;

  const all = await readAll();
  all.push(reminder);
  await writeAll(all);
  return reminder;
}

export async function cancelReminder(id: string): Promise<boolean> {
  const all = await readAll();
  const hit = all.find((r) => r.id === id);
  if (!hit) return false;
  if (hit.notificationId) await cancelScheduled(hit.notificationId);
  await writeAll(all.filter((r) => r.id !== id));
  return true;
}

/**
 * Re-arm every future reminder and drop the expired ones. Idempotent — the old
 * notification id is cancelled before the new one is scheduled.
 */
export async function rehydrateReminders(): Promise<number> {
  const now = Date.now();
  const all = await readAll();
  const alive = all.filter((r) => whenOf(r) > now);
  for (const r of alive) {
    if (r.notificationId) await cancelScheduled(r.notificationId);
    r.notificationId =
      (await scheduleReminderAt(new Date(whenOf(r)), r.text, { reminderId: r.id })) ?? undefined;
  }
  await writeAll(alive);
  return alive.length;
}

/**
 * "Remind me 30 minutes before" — attach lead times to an existing task and
 * re-arm its alerts so the change takes effect immediately.
 */
export async function setLeadTimeForTask(
  taskId: string,
  minutesBefore: number[],
): Promise<Task | null> {
  const tasks = await getAllTasks();
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return null;
  const clean = Array.from(new Set(minutesBefore.filter((n) => Number.isFinite(n) && n > 0)))
    .sort((a, b) => b - a);
  if (!clean.length) return null;
  await updateTaskFields(taskId, { remindMinutesBefore: clean });
  const updated = { ...task, remindMinutesBefore: clean };
  await armTaskAlerts(updated).catch(() => {});
  return updated;
}

// ── conversation focus ───────────────────────────────────────────────────────
// "Remind me 30 minutes before" has to know BEFORE WHAT. The server solved this
// with a 45-minute active-task TTL (server/session.py); the app had only an
// in-memory slot that died with the process. This is the app-side equivalent.

export async function setTaskFocus(taskId: string): Promise<void> {
  await AsyncStorage.setItem(FOCUS_KEY, JSON.stringify({ taskId, at: Date.now() })).catch(() => {});
}

/** The task under discussion, or null once the TTL lapses. */
export async function getTaskFocus(): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem(FOCUS_KEY);
    if (!raw) return null;
    const { taskId, at } = JSON.parse(raw) as { taskId: string; at: number };
    if (!taskId || Date.now() - at > FOCUS_TTL_MS) return null;
    return taskId;
  } catch {
    return null;
  }
}

/**
 * Which task a "…before" phrase means: the one just discussed, else the next
 * upcoming timed task. Null when there is genuinely nothing to attach to.
 */
export async function resolveFocusTask(): Promise<Task | null> {
  const tasks = await getAllTasks();
  const focusId = await getTaskFocus();
  if (focusId) {
    const hit = tasks.find((t) => t.id === focusId);
    if (hit) return hit;
  }
  const now = Date.now();
  const upcoming = tasks
    .filter((t) => t.status === 'pending' && t.fixedTime)
    .map((t) => ({ t, when: whenOf({ date: t.date, time: t.fixedTime! }) }))
    .filter((x) => x.when > now)
    .sort((a, b) => a.when - b.when);
  return upcoming[0]?.t ?? null;
}
