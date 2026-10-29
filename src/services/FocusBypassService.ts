/**
 * FocusBypassService — notice that a learning session was bypassed, and say so.
 *
 * Koral, 17.10: "If the user defined a learning time but somehow BYPASSES the restriction, Meira
 * lectures her: 'You said you were studying!!' and gives her further opportunities to return to
 * her studies and block out distractions."
 *
 * The native side notices what it can while JS is not running (a permission switched off, the
 * service killed, a blocked app used anyway, the session ended early) and keeps it as an
 * "incident". This file turns incidents into lectures (utils/focusBypass) and keeps them until she
 * answers:
 *
 *   collectBypasses  reconcile with the native side, drain its incidents, store them as pending
 *   nextLecture      the one to show now (worst first), with a "move the rest" slot worked out
 *   answerLecture    what each offer does: resume / break / move / done
 *   focusTick        collect + schedule study sessions + (when the app is closed) notify
 *
 * TRIGGERS (rule 7): FocusLectureHost on mount and on every AppState 'active' (the app open or
 * brought back); CalendarAutoSync.runCalendarSync on every sync path including the closed-app
 * WorkManager job, which can only notify; FocusNowScreen right after "End early".
 *
 * Every bypass is also written to a local log (date, kind, minutes) for the weekly count — no
 * server call.
 */
import { AppState } from 'react-native';
import AsyncStorage from './EncryptedStorage';
import { FocusGuard } from '../../modules/focus-guard';
import { sendImmediate } from './NotificationService';
import {
  addTask, getAllTasks, getTasksForDate, moveTasksToDate, updateTaskFields,
} from './TaskStorage';
import { getReadiness, recoverFailedStarts, scheduleStudySessions, startLearning } from './FocusSessionService';
import {
  appendLog, breakPlan, eventsFromIncidents, lectureFor, logEntryFor, pickEvent, resumePlan,
  suggestMoveTarget, weeklyLine, weeklySummary, whenLabel,
  type BypassEvent, type BypassLogEntry, type Lecture, type Offer,
} from '../utils/focusBypass';
import { failureText, hhmmOf, localDateKey, sessionSig, type FailureText } from '../utils/focusSession';
import type { AppLanguage, Task } from '../types/index';

const PENDING_KEY = 'meira.focus.bypass.pending.v1';
const HANDLED_KEY = 'meira.focus.bypass.handled.v1';
const LOG_KEY = 'meira.focus.bypass.log.v1';
const NOTIFIED_KEY = 'meira.focus.bypass.notified.v1';
const KEEP_IDS = 200;

// A screen that is open when a bypass is collected (the 10-second wait just ended, the app came
// back to the front) should show the lecture at once, not at the next open.
let listeners: Array<() => void> = [];

/** Be told when collectBypasses finds anything waiting. Returns the unsubscribe. */
export function onBypassesWaiting(fn: () => void): () => void {
  listeners.push(fn);
  return () => { listeners = listeners.filter((l) => l !== fn); };
}

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch (e) {
    // Rule 2: say that it was unreadable. The fallback then stands for "empty", on purpose.
    console.warn('[FocusBypass] unreadable store', key, e);
    return fallback;
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn('[FocusBypass] could not write', key, e);
  }
}

// ── Collecting ─────────────────────────────────────────────────────────────

export interface CollectResult {
  pending: BypassEvent[];
  /** Why the native side could not be asked. undefined when it simply is not in this build. */
  error?: string;
  /** What reconcile found: a stopped session finished or resumed. */
  reconciled?: string;
}

/**
 * Ask the native side what happened while we were not looking, store it, and return everything
 * still waiting for an answer. Safe to call as often as you like.
 */
export async function collectBypasses(now = Date.now()): Promise<CollectResult> {
  if (!FocusGuard.isAvailable()) return { pending: [] };
  const result: CollectResult = { pending: [] };

  // A session that should be running and is not: finish it (measuring slips) or resume it.
  const rec = FocusGuard.reconcile();
  if (!rec.ok) {
    console.warn('[FocusBypass] reconcile failed:', rec.reason);
    result.error = rec.reason;
  } else {
    result.reconciled = rec.state;
    if (rec.error) {
      console.warn('[FocusBypass] a session could not be resumed:', rec.error);
      result.error = rec.error;
    }
  }

  const drained = FocusGuard.drainIncidents();
  if (!drained.ok) {
    console.warn('[FocusBypass] could not read incidents:', drained.reason);
    result.error = drained.reason;
  }
  const incoming = drained.ok ? eventsFromIncidents(drained.incidents) : [];

  const handled = new Set(await readJson<string[]>(HANDLED_KEY, []));
  const stored = await readJson<BypassEvent[]>(PENDING_KEY, []);
  const byId = new Map<string, BypassEvent>();
  for (const e of [...stored, ...incoming]) if (!handled.has(e.id) && !byId.has(e.id)) byId.set(e.id, e);

  // Newly seen events go into the weekly log, once each (appendLog dedupes by id).
  if (incoming.length) {
    let log = await readJson<BypassLogEntry[]>(LOG_KEY, []);
    for (const e of incoming) log = appendLog(log, logEntryFor(e));
    await writeJson(LOG_KEY, log);
  }

  result.pending = [...byId.values()];
  await writeJson(PENDING_KEY, result.pending);
  if (result.pending.length) {
    for (const l of listeners) { try { l(); } catch (e) { console.warn("[FocusBypass] listener failed", e); } }
  }
  return result;
}

async function markHandled(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const handled = await readJson<string[]>(HANDLED_KEY, []);
  await writeJson(HANDLED_KEY, [...new Set([...handled, ...ids])].slice(-KEEP_IDS));
  const pending = await readJson<BypassEvent[]>(PENDING_KEY, []);
  await writeJson(PENDING_KEY, pending.filter((e) => !ids.includes(e.id)));
}

/** She has seen it (or answered): every waiting event of that session is done with. */
export async function dismissLecture(event: BypassEvent): Promise<void> {
  const pending = await readJson<BypassEvent[]>(PENDING_KEY, []);
  const same = pending.filter((e) => e.session.id === event.session.id && e.session.startedAtMs === event.session.startedAtMs);
  await markHandled([event.id, ...same.map((e) => e.id)]);
}

// ── Showing ────────────────────────────────────────────────────────────────

export interface ShownLecture { lecture: Lecture; event: BypassEvent }

/** The lecture to show now, or null. Events that have nothing to say are retired as they are met. */
export async function nextLecture(lang: AppLanguage, now = Date.now()): Promise<ShownLecture | null> {
  let pending = await readJson<BypassEvent[]>(PENDING_KEY, []);
  let todays: Task[] | null = null;
  for (let guard = 0; guard < 8 && pending.length; guard += 1) {
    const ev = pickEvent(pending);
    if (!ev) return null;
    // Work out where the rest could go only when an offer will use it.
    if (todays === null) todays = await getTasksForDate(localDateKey(now)).catch((e) => {
      console.warn('[FocusBypass] could not read today for the move offer', e);
      return [] as Task[];
    });
    const minutes = Math.max(10, Math.min(45, Math.ceil((ev.session.endsAtMs - now) / 60_000)));
    const moveTo = suggestMoveTarget(todays, now, minutes, { ignoreTaskId: ev.session.taskId });
    const lecture = lectureFor(ev, now, lang, { moveTo });
    if (lecture) return { lecture, event: ev };
    await markHandled([ev.id]); // stale, or nothing worth saying (a couple of minutes left)
    pending = pending.filter((e) => e.id !== ev.id);
  }
  return null;
}

/** "This week: 3 times out of learning", or '' for none. */
export async function weeklyCountLine(lang: AppLanguage, now = Date.now()): Promise<string> {
  const log = await readJson<BypassLogEntry[]>(LOG_KEY, []);
  return weeklyLine(weeklySummary(log, now), lang);
}

// ── Answering ──────────────────────────────────────────────────────────────

export type AnswerOutcome =
  | { ok: true; line: string }
  | { ok: false; failure: FailureText; fix: 'usage' | 'overlay' | 'none' };

const bad = (reason: string, lang: AppLanguage): AnswerOutcome => {
  const failure = failureText(reason, lang);
  return { ok: false, failure, fix: failure.fix };
};

/** What the offer does. A failure is returned with its fix — and the lecture stays up. */
export async function answerLecture(
  shown: ShownLecture, offer: Offer, lang: AppLanguage, now = Date.now(),
): Promise<AnswerOutcome> {
  const he = lang === 'he';
  const { event, lecture } = shown;
  const session = event.session;

  if (offer.kind === 'done') {
    await dismissLecture(event);
    return { ok: true, line: he ? 'בסדר. נתראה בפעם הבאה.' : 'OK. See you next time.' };
  }

  if (offer.kind === 'resume') {
    const plan = resumePlan(event, offer, now);
    const r = await startLearning({
      endsAtMs: plan.endsAtMs, title: session.title, taskId: session.taskId, lang,
      packages: session.blocked, now,
    });
    if (!r.ok) return { ok: false, failure: r.failure, fix: r.fix };
    await dismissLecture(event);
    return { ok: true, line: he ? `חוסמת שוב · עוד ${plan.minutes} דק׳` : `Blocking again · ${plan.minutes} min` };
  }

  if (offer.kind === 'break') {
    const readiness = getReadiness();
    if (!readiness.native) return bad('native_unavailable', lang);
    if (!readiness.usageAccess) return bad('no_usage_access', lang);
    if (!readiness.overlay) return bad('no_overlay', lang);
    const plan = breakPlan(offer, now);
    const title = session.title;
    const r = FocusGuard.scheduleSession({
      id: `resume-${session.id}-${Math.floor(now / 1000)}`,
      startAtMs: plan.startAtMs, endsAtMs: plan.endsAtMs, blocked: session.blocked, title,
      lang, taskId: session.taskId,
      startTitle: he ? '📚 ההפסקה נגמרה' : '📚 Break is over',
      startBody: he ? `חוזרים ללמוד · עד ${hhmmOf(plan.endsAtMs)}` : `Back to learning · until ${hhmmOf(plan.endsAtMs)}`,
      sig: sessionSig({ startAtMs: plan.startAtMs, endsAtMs: plan.endsAtMs, blocked: session.blocked, title, lang }),
    });
    if (!r.ok) return bad(r.reason, lang);
    await dismissLecture(event);
    return { ok: true, line: he ? `הפסקה עד ${hhmmOf(plan.startAtMs)}, ואז אני חוסמת שוב.` : `Break until ${hhmmOf(plan.startAtMs)}, then I block again.` };
  }

  // move
  const target = lecture.moveTo;
  if (!target) return bad('bad_window', lang);
  try {
    await moveTheRest(event, offer.minutes, target.date, target.start, lang, now);
  } catch (e) {
    console.warn('[FocusBypass] could not move the rest of the session', e);
    return { ok: false, failure: { title: he ? 'לא הצלחתי להעביר' : "Couldn't move it", body: String((e as Error)?.message ?? e).slice(0, 100), fix: 'none' }, fix: 'none' };
  }
  await dismissLecture(event);
  const when = whenLabel(target, now, lang);
  return { ok: true, line: he ? `הועבר ל${when}.` : `Moved to ${when}.` };
}

/**
 * Put the rest of the studying on the schedule at `date start`: the session's own task is moved
 * and shortened to what is left; with no task (a session started by hand, or a task she since
 * ticked) a new study task is added. Either way the next calendar sync schedules its alarm.
 */
async function moveTheRest(
  event: BypassEvent, minutes: number, date: string, start: string, lang: AppLanguage, now: number,
): Promise<void> {
  const he = lang === 'he';
  const taskId = event.session.taskId;
  const all = await getAllTasks();
  const own = taskId ? all.find((t) => t.id === taskId) : undefined;
  if (own && own.status !== 'complete') {
    if (own.date !== date) await moveTasksToDate([own.id], date);
    await updateTaskFields(own.id, {
      scheduledTime: start,
      ...(own.fixedTime ? { fixedTime: start } : {}),
      durationMinutes: minutes,
      pickedAt: Date.now(),
      status: 'pending',
    });
  } else {
    const title = event.session.title || (he ? 'למידה' : 'Learning');
    await addTask({
      text: he ? `לימוד (המשך): ${title}` : `Study (rest): ${title}`,
      category: 'course',
      priority: 'need_to',
      isFixed: true,
      fixedTime: start,
      durationMinutes: minutes,
      date,
      status: 'pending',
      historicalDurations: [],
    } as unknown as Omit<Task, 'id' | 'createdAt' | 'completedAt'>);
  }
  await scheduleStudySessions(await getAllTasks(), lang, now).catch((e) =>
    console.warn('[FocusBypass] could not schedule the moved session', e));
}

// ── The tick ───────────────────────────────────────────────────────────────

/**
 * One pass of everything the focus feature needs from time to time: reconcile + collect
 * bypasses, put the study-task alarms in step, and — when the app is closed — notify about what
 * only JS can know (the service was killed). Called from the root host and from every calendar
 * sync path.
 */
export async function focusTick(lang: AppLanguage, reason: string, now = Date.now()): Promise<CollectResult> {
  if (!FocusGuard.isAvailable()) return { pending: [] };
  let result: CollectResult = { pending: [] };
  try {
    result = await collectBypasses(now);
  } catch (e) {
    console.warn('[FocusBypass] collect failed', reason, e);
  }
  const open = AppState.currentState === 'active';
  // BEFORE scheduling: scheduling retires entries whose task is no longer planned, and a start that
  // Android refused in the background is exactly such an entry — recover it while it still exists.
  if (open) {
    // Open: the one moment Android lets a session that was refused in the background start after all.
    await recoverFailedStarts(lang, now)
      .catch((e) => console.warn('[FocusBypass] recovery failed', reason, e));
  }
  try {
    const report = await scheduleStudySessions(await getAllTasks(), lang, now);
    if (report.state === 'failed') console.warn('[FocusBypass] scheduling had errors', reason, JSON.stringify(report.errors));
  } catch (e) {
    console.warn('[FocusBypass] schedule failed', reason, e);
  }
  if (!open) await notifyWhileClosed(result.pending, lang, now);
  return result;
}

/**
 * The native side posts its own notification for a revoked permission, a slip and a failed block.
 * Only "the service was killed" is invisible to it — so that one is said from here, once.
 */
async function notifyWhileClosed(pending: BypassEvent[], lang: AppLanguage, now: number): Promise<void> {
  const killed = pending.filter((e) => e.kind === 'service_killed');
  if (!killed.length) return;
  const sent = new Set(await readJson<string[]>(NOTIFIED_KEY, []));
  for (const ev of killed) {
    if (sent.has(ev.id)) continue;
    const l = lectureFor(ev, now, lang);
    if (!l) continue;
    await sendImmediate(l.title, l.body, { type: 'focus_bypass', eventId: ev.id })
      .catch((e) => console.warn('[FocusBypass] notification failed', e));
    sent.add(ev.id);
  }
  await writeJson(NOTIFIED_KEY, [...sent].slice(-KEEP_IDS));
}
