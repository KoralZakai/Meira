/**
 * HistoryService — her opt-in history, phone side (Feature 2, 20.10).
 *
 * Nothing is collected unless she said yes (Menu → Privacy). With the yes:
 *  - every write of the task list is diffed (TaskStorage.onTaskListChanged)
 *    into events — a move, a tick, a miss, an arrival — queued locally;
 *  - a running focus session is logged as study minutes on every tick;
 *  - the queue is sent by `historyTick`, from CalendarAutoSync on every sync
 *    path (launch, foreground, heartbeat, pull-to-refresh, the closed-app job).
 *
 * The listener is registered when this module is imported, and CalendarAutoSync
 * imports it — so the closed-app job collects too, not only the open app (rule 7).
 */
import AsyncStorage from './EncryptedStorage';
import { onTaskListChanged } from './TaskStorage';
import { historyConsent, historyEvents, historyWeek } from './LumiServer';
import { sendImmediate } from './NotificationService';
import { getRunning } from './FocusSessionService';
import { diffEvents, studyEvent, type HistoryEvent } from '../utils/historyEvents';
import {
  dueMoment, streakKey, streakPush, sundaySummary, wednesdayNudge, weekOf, type CoachSent,
} from '../utils/historyCoach';
import type { AppLanguage } from '../types/index';

const OPT_KEY = 'lumi.history.optIn.v1';
const QUEUE_KEY = 'lumi.history.queue.v1';
const MAX_QUEUE = 500;

let optedIn: boolean | null = null;

async function isOptedIn(): Promise<boolean> {
  if (optedIn === null) {
    optedIn = (await AsyncStorage.getItem(OPT_KEY).catch(() => null)) === '1';
  }
  return optedIn;
}

async function readQueue(): Promise<HistoryEvent[]> {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    return raw ? (JSON.parse(raw) as HistoryEvent[]) : [];
  } catch (e) {
    console.warn('[History] queue unreadable', e);
    return [];
  }
}

async function writeQueue(q: HistoryEvent[]): Promise<void> {
  // Keep the newest; one dedupKey once.
  const seen = new Set<string>();
  const out: HistoryEvent[] = [];
  for (const e of q.slice().reverse()) {
    if (seen.has(e.dedupKey)) continue;
    seen.add(e.dedupKey);
    out.push(e);
  }
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(out.reverse().slice(-MAX_QUEUE)));
}

export async function enqueue(events: HistoryEvent[]): Promise<void> {
  if (!events.length || !(await isOptedIn())) return;
  await writeQueue([...(await readQueue()), ...events]);
}

// Listening only while she is opted in — otherwise every save would pay for a
// diff nobody keeps. Decided at import (open app AND the closed-app job, both
// import this through CalendarAutoSync) and again whenever she flips the switch.
let stopListening: (() => void) | null = null;
function listen(on: boolean) {
  if (on && !stopListening) {
    stopListening = onTaskListChanged((before, after) => {
      const events = diffEvents(before, after);
      if (events.length) enqueue(events).catch((e) => console.warn('[History] enqueue failed', e));
    });
  } else if (!on && stopListening) {
    stopListening();
    stopListening = null;
  }
}
isOptedIn().then(listen).catch((e) => console.warn('[History] opt-in unreadable', e));

export async function historyOptedIn(): Promise<boolean> {
  return isOptedIn();
}

/** Her answer from the Privacy switch. Returns the reason when the server refused. */
export async function setHistoryOptIn(on: boolean): Promise<{ ok: boolean; reason?: string; backfilled?: number }> {
  const r = await historyConsent(on);
  if (!r.ok) return { ok: false, reason: r.reason };
  if (on && !r.data.optedIn) return { ok: false, reason: r.data.reason || 'refused' };
  optedIn = on;
  listen(on);
  await AsyncStorage.setItem(OPT_KEY, on ? '1' : '0');
  if (!on) await AsyncStorage.removeItem(QUEUE_KEY).catch(() => {});
  return { ok: true, backfilled: r.data.backfilled, ...(r.data.reason ? { reason: r.data.reason } : {}) };
}

export interface HistoryTick {
  sent: number;
  streaks: Array<{ taskId: string; text?: string; moves: number }>;
  error?: string;
}

/** Log a running focus session and send the queue. */
export async function flushHistory(
  running?: { id: string; title: string; startedAtMs: number; endsAtMs: number; taskId: string | null } | null,
): Promise<HistoryTick> {
  if (!(await isOptedIn())) return { sent: 0, streaks: [] };
  if (running) {
    const ev = studyEvent(running);
    if (ev) await enqueue([ev]);
  }
  const queue = await readQueue();
  if (!queue.length) return { sent: 0, streaks: [] };
  const batch = queue.slice(0, 200);
  const r = await historyEvents(batch);
  if (!r.ok) return { sent: 0, streaks: [], error: r.reason };
  if (!r.data.ok) {
    if (r.data.reason === 'not_opted_in') {
      // The server says no (turned off elsewhere): stop collecting here too.
      optedIn = false;
      listen(false);
      await AsyncStorage.setItem(OPT_KEY, '0');
      await AsyncStorage.removeItem(QUEUE_KEY).catch(() => {});
    }
    return { sent: 0, streaks: [], error: r.data.reason };
  }
  const sentKeys = new Set(batch.map((e) => e.dedupKey));
  const rest = (await readQueue()).filter((e) => !sentKeys.has(e.dedupKey));
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(rest));
  return { sent: batch.length, streaks: r.data.streaks ?? [] };
}


// ── The coach: Sunday summary, Wednesday nudge, the 3rd move ────────────────


const SENT_KEY = 'lumi.history.coachSent.v1';

async function readSent(): Promise<CoachSent> {
  try {
    const raw = await AsyncStorage.getItem(SENT_KEY);
    return raw ? (JSON.parse(raw) as CoachSent) : {};
  } catch {
    console.warn('[History] coach state unreadable — starting fresh');
    return {};
  }
}

export interface CoachTick extends HistoryTick {
  pushed: string[];
}

/**
 * One tick: log a running study session, send the queue, then say whatever is
 * due. Called by CalendarAutoSync on every sync path. Never throws.
 */
export async function historyTick(language: AppLanguage, now = new Date()): Promise<CoachTick> {
  if (!(await isOptedIn())) return { sent: 0, streaks: [], pushed: [] };
  const he = language === 'he';
  const running = getRunning(now.getTime()).running?.session ?? null;
  const flushed = await flushHistory(running);
  const sent = await readSent();
  const pushed: string[] = [];

  const said = new Set(sent.streaks ?? []);
  for (const s of flushed.streaks) {
    if (said.has(streakKey(s))) continue;
    const { title, body } = streakPush(s, he);
    await sendImmediate(title, body, { taskId: s.taskId, kind: 'history-streak' });
    said.add(streakKey(s));
    pushed.push('streak');
  }
  sent.streaks = [...said].slice(-100);

  const moment = dueMoment(now, sent);
  if (moment) {
    const r = await historyWeek(moment === 'sunday' ? 'last week' : 'this week');
    if (!r.ok) {
      console.warn('[History] week report unavailable:', r.reason);
    } else {
      const msg = moment === 'sunday' ? sundaySummary(r.data, he) : wednesdayNudge(r.data, he);
      if (msg) {
        await sendImmediate(msg.title, msg.body, { kind: `history-${moment}` });
        pushed.push(moment);
      }
      // Decided for this week either way: a Wednesday that was on track stays quiet.
      if (r.data.ok) sent[moment] = weekOf(now);
      else console.warn('[History] week report refused:', r.data.reason);
    }
  }
  await AsyncStorage.setItem(SENT_KEY, JSON.stringify(sent)).catch(() => {});
  return { ...flushed, pushed };
}
