/**
 * timeUtils — HH:MM arithmetic, date keys, wake-time math
 * (calculateWakeTime), and priority+time task sorting used app-wide.
 * Dependencies: none (pure). Consumed by LLMService, GoogleService,
 * NotificationService, schedule screens.
 */
/**
 * The LOCAL calendar date, YYYY-MM-DD.
 *
 * This used to be `new Date().toISOString().split('T')[0]`, which is the UTC
 * date. Israel is UTC+2/+3, so between midnight and 03:00 local it returned
 * YESTERDAY — the whole app (today's task list, the date stamped on a new task,
 * the alert window) silently shifted by a day for anyone using Lumi late at
 * night. Every date key in the app flows through here.
 */
const localDateKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const getTodayString = (): string => localDateKey(new Date());

export const getTomorrowString = (): string => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return localDateKey(tomorrow);
};

export const timeToMinutes = (hhmm: string): number => {
  // Guard the type as well as the format. Callers feed this straight from
  // stored JSON (task.location.wakeUpBy, profile.defaultWakeTime), so a
  // non-string is reachable — and throwing here takes the whole alarm
  // scheduler down with it. NaN flows into the Number.isFinite checks that
  // every caller already has.
  if (typeof hhmm !== 'string') return NaN;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/**
 * Minutes-since-midnight → HH:MM, wrapping into a real clock day.
 *
 * Negative input used to produce garbage like "-2:-45": a 00:40 flight needing
 * 105 minutes of runway wants 22:55 the night before, and every consumer
 * (notification triggers, alert bodies, the leave-now screen) got an
 * unparseable string instead. Wrapping is correct for both directions; callers
 * that care WHICH day it landed on track that separately (see alertPlan's
 * dayOffset).
 */
export const minutesToTime = (minutes: number): string => {
  const wrapped = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

export const subtractMinutes = (hhmm: string, mins: number): string =>
  minutesToTime(timeToMinutes(hhmm) - mins);

export const addMinutes = (hhmm: string, mins: number): string =>
  minutesToTime(timeToMinutes(hhmm) + mins);

export const calculateWakeTime = (
  fixedTime: string,
  travelMinutes: number,
  routineMinutes: number,
  bufferMinutes: number = 15
): { wakeBy: string; leaveHomeBy: string } => {
  const leaveHomeBy = subtractMinutes(fixedTime, travelMinutes + bufferMinutes);
  const wakeBy = subtractMinutes(leaveHomeBy, routineMinutes);
  return { wakeBy, leaveHomeBy };
};

export const calculateLatestStartTime = (
  deadlineDate: string,
  deadlineTime: string,
  estimatedMinutes: number,
  bufferMinutes: number = 30
): { date: string; time: string } => {
  const totalBack = estimatedMinutes + bufferMinutes;
  const deadlineTotal = timeToMinutes(deadlineTime);
  if (deadlineTotal >= totalBack) {
    return { date: deadlineDate, time: minutesToTime(deadlineTotal - totalBack) };
  }
  // Goes to previous day
  const prevDate = new Date(deadlineDate);
  prevDate.setDate(prevDate.getDate() - 1);
  return {
    date: prevDate.toISOString().split('T')[0],
    time: minutesToTime(24 * 60 - (totalBack - deadlineTotal)),
  };
};

export const getDaysUntilDeadline = (deadlineDate: string): number => {
  const today = new Date(getTodayString());
  const deadline = new Date(deadlineDate);
  return Math.ceil((deadline.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
};

export const formatDuration = (minutes: number, lang: 'en' | 'he' = 'en'): string => {
  if (minutes < 60) return lang === 'he' ? `${minutes} דק'` : `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (m === 0) return lang === 'he' ? `${h} שעות` : `${h}h`;
  return lang === 'he' ? `${h}ש' ${m}ד'` : `${h}h ${m}m`;
};

export const getSortKey = (task: {
  location?: { leaveHomeBy?: string };
  fixedTime?: string;
  scheduledTime?: string;
}): string => {
  return task.location?.leaveHomeBy || task.fixedTime || task.scheduledTime || '23:59';
};

export const sortTasksByPriorityAndTime = (tasks: any[]): any[] => {
  const priorityOrder: Record<string, number> = {
    must: 0, have_to: 1, need_to: 2, nice_to_do: 3,
  };
  return [...tasks].sort((a, b) => {
    const pa = priorityOrder[a.priority] ?? 4;
    const pb = priorityOrder[b.priority] ?? 4;
    if (pa !== pb) return pa - pb;
    return getSortKey(a).localeCompare(getSortKey(b));
  });
};

export const getCurrentPeriod = (): 'morning' | 'afternoon' | 'evening' | null => {
  const hour = new Date().getHours();
  if (hour >= 6 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 23) return 'evening';
  return null;
};

/** "2026-07-20" → "Mon 20/7" (EN) / "ב׳ 20/7" (HE). Today/tomorrow get words. */
export const formatShortDate = (dateStr: string, lang: 'en' | 'he' = 'en'): string => {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return '';
  if (dateStr === getTodayString()) return lang === 'he' ? 'היום' : 'Today';
  if (dateStr === getTomorrowString()) return lang === 'he' ? 'מחר' : 'Tomorrow';
  const d = new Date(`${dateStr}T00:00:00`);
  const daysEn = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const daysHe = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
  const day = (lang === 'he' ? daysHe : daysEn)[d.getDay()];
  return `${day} ${d.getDate()}/${d.getMonth() + 1}`;
};

export const formatTime = (hhmm: string): string => {
  const [h, m] = hhmm.split(':').map(Number);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

export const getWeekKey = (date?: string): string => {
  const d = new Date(date ? `${date}T00:00:00Z` : undefined);
  const week = Math.ceil((d.getDate() - d.getDay()) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
};

export const isExpoGo = (): boolean => {
  try {
    const Constants = require('expo-constants').default;
    return (
      Constants.appOwnership === 'expo' ||
      Constants.executionEnvironment === 'storeClient'
    );
  } catch { return false; }
};
