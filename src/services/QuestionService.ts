/**
 * QuestionService — when Meira's questions pop up, and what happens to the answers.
 *
 * Owned by the root (App.tsx), never by one screen — a question nothing
 * triggers is not a feature (CLAUDE.md, silent-state rule 7). The four triggers:
 *
 *   1. Screen visible   Today, once it has loaded her routines (maybeAsk);
 *                       Profile, right after she saves a routine (justSaved);
 *                       a task whose place could not be found, the moment the
 *                       travel chain notices (askWhereIs → maybeAsk).
 *   2. App open         AppState 'active' → onAppActive: a new "open" for the
 *                       one-popup-per-open limit, the outbox retried, rules refreshed,
 *                       and checkTripOrigin ("where does tomorrow start?").
 *                       The calendar sweep at the root re-runs the travel chain,
 *                       which is what queues a "Where is X?" (kinds/place), and
 *                       then checkTripOrigin again (CalendarAutoSync).
 *   3. App closed       the calendar background task → backgroundRun: the outbox
 *                       retried, and at most one nudge a day for an open question
 *                       (refresh() detects every kind, tripOrigin included).
 *   4. She went looking the chip on a routine row, You → "Meira's questions" (askNow,
 *                       pending — which re-detects when its list is stale).
 *
 * WHEN a popup may show is decided by utils/questionQueue (pure, tested). The
 * popup itself is components/MeiraAskHost, listening here.
 *
 * An answer that could not reach the server is NOT lost and NOT reported as
 * saved: her phone copy is rewritten, the server part waits in the outbox
 * (OUTBOX_KEY) and the sheet says exactly that (rule 3).
 */
import { AppState } from 'react-native';
import AsyncStorage from './EncryptedStorage';  // AES-256-GCM at rest (7.10)
import { confirmRule as serverConfirmRule, QuestionAnswerInput, RuleProposal } from './LumiServer';
import { invalidateRoutines, loadRoutines } from './GapFillService';
import { refreshRules } from './RulesCache';
import { getAllTasks } from './TaskStorage';
import { sendImmediate } from './NotificationService';
import { applyAnswer, detectAll, detectPlaces, detectRoutineOrigin, detectTripOrigin, resend } from '../questions/registry';
import { enqueuePlace, PlaceAsk } from '../questions/kinds/place';
import { enqueueDeps } from '../questions/kinds/placeDeps';
import type { AnswerResult, MeiraQuestion, PlaceAnswerInput, QuestionAnswer } from '../questions/types';
import type { Routine } from '../utils/routines';
import {
  AskState, EMPTY_ASK_STATE, afterAnswer, afterShown, afterSnooze, mayInterrupt, minutesToNextDeparture, pickNext, unanswered,
} from '../utils/questionQueue';
import { getTodayString } from '../utils/timeUtils';

const STATE_KEY = 'lumi.meiraAsks.v1';
const OUTBOX_KEY = 'lumi.questionOutbox.v1';
const NUDGE_KEY = 'lumi.questionNudges.v1';
const MAX_TRIES = 10;
const MAX_NUDGES_PER_QUESTION = 2;

interface OutboxItem { input: QuestionAnswerInput | PlaceAnswerInput; tries: number; at: number }

/** The mark before a question's title: a routine 🔁, a place 📍, where tomorrow starts 🧭. */
const iconOf = (q: MeiraQuestion): string => (q.kind === 'place' ? '📍' : q.kind === 'tripOrigin' ? '🧭' : q.kind === 'routineOrigin' ? '🏠' : '🔁');

/** You → "Meira's questions" re-detects when what it holds is older than this. */
const PENDING_STALE_MS = 2 * 60 * 1000;

let questions: MeiraQuestion[] = [];
let lastRefreshAt = 0;
let shownThisOpen = false;
let sheetOpen = false;
const askListeners = new Set<(q: MeiraQuestion) => void>();
const changeListeners = new Set<() => void>();

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch (e) {
    console.warn('[Questions] unreadable', key, e);
    return fallback;
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn('[Questions] not written', key, e);
  }
}

const loadState = () => readJson<AskState>(STATE_KEY, EMPTY_ASK_STATE);
const loadOutbox = async (): Promise<OutboxItem[]> => (await readJson<{ items: OutboxItem[] }>(OUTBOX_KEY, { items: [] })).items;
const saveOutbox = (items: OutboxItem[]) => writeJson(OUTBOX_KEY, { items });

function hhmm(d = new Date()): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function changed(): void {
  changeListeners.forEach((fn) => {
    try { fn(); } catch (e) { console.warn('[Questions] listener failed', e); }
  });
}

/** The popup host listens here. Returns the unsubscribe. */
export function onAsk(fn: (q: MeiraQuestion) => void): () => void {
  askListeners.add(fn);
  return () => { askListeners.delete(fn); };
}

/** Rows and You listen here: questions appeared, were answered or put off. */
export function onQuestionsChanged(fn: () => void): () => void {
  changeListeners.add(fn);
  return () => { changeListeners.delete(fn); };
}

export function setSheetOpen(open: boolean): void {
  sheetOpen = open;
}

/** Re-detect from her routines (loaded here unless the caller already has them). */
export async function refresh(routines?: Routine[]): Promise<MeiraQuestion[]> {
  // Stamped first: a listener that asks `pending()` from inside `changed()`
  // below must not start a second refresh.
  lastRefreshAt = Date.now();
  const rs = routines ?? await loadRoutines().catch((e) => {
    console.warn('[Questions] routines not loaded', e);
    return [] as Routine[];
  });
  // The place questions first: a task with no place has no route, no leave
  // time and no alarm yet, which is worth more of her attention than a day-chip.
  const places = await detectPlaces(getTodayString()).catch((e) => {
    console.warn('[Questions] place questions not read', e);
    return [] as MeiraQuestion[];
  });
  // Where tomorrow starts (kinds/tripOrigin): derived each time from tomorrow's
  // tasks and her position, so it needs no queue and cannot go stale. Ahead of
  // everything — its moment is the evening before, and it is the one question
  // whose answer is a route she is about to rely on.
  const trip = await detectTripOrigin((await loadState()).answered).catch((e) => {
    console.warn('[Questions] trip-origin question not read', e);
    return [] as MeiraQuestion[];
  });
  // Home first, or straight to a routine that follows the day's last trip (kinds/routineOrigin):
  // derived like tripOrigin, so it needs no queue and rides the same triggers.
  const afterTrip = await detectRoutineOrigin().catch((e) => {
    console.warn('[Questions] routine-origin question not read', e);
    return [] as MeiraQuestion[];
  });
  questions = [...trip, ...afterTrip, ...places, ...detectAll(rs)];
  changed();
  return questions;
}

/**
 * Questions still waiting for her answer (put off ones included) — for the
 * chip and You. Re-detected when stale: "where tomorrow starts" depends on the
 * clock and on where she is, so a list built an hour ago may be missing it.
 */
export async function pending(): Promise<MeiraQuestion[]> {
  if (Date.now() - lastRefreshAt > PENDING_STALE_MS) {
    await refresh().catch((e) => console.warn('[Questions] refresh for the list failed', e));
  }
  return unanswered(questions, await loadState());
}

/**
 * Is there a question about where tomorrow starts? Detects now and, with the
 * app in front, shows it (subject to the usual limits). Called by the
 * calendar sweep at the root (CalendarAutoSync: launch, foreground, heartbeat,
 * the closed-app task) and when the app returns to the front — see
 * kinds/tripOrigin for the four triggers. Never throws: a failure is warned
 * about with its reason.
 */
export async function checkTripOrigin(reason = 'sweep'): Promise<boolean> {
  try {
    const open = (await refresh()).some((q) => q.kind === 'tripOrigin');
    if (open && AppState?.currentState === 'active') {
      await popUpIfGoodMoment();
    }
    return open;
  } catch (e) {
    console.warn(`[Questions] trip-origin check failed (${reason})`, e);
    return false;
  }
}

/** Pop one up if this is a good moment for it (utils/questionQueue decides). */
export async function maybeAsk(opts: { routines?: Routine[]; justSaved?: boolean } = {}): Promise<void> {
  await refresh(opts.routines);
  await popUpIfGoodMoment(opts);
}

/** The half of maybeAsk after detection: is this a good moment, and which one. */
async function popUpIfGoodMoment(opts: { justSaved?: boolean } = {}): Promise<void> {
  if (!askListeners.size) return;
  const state = await loadState();
  const today = getTodayString();
  const tasks = await getAllTasks().catch(() => []);
  const q = pickNext(questions, state, {
    now: Date.now(),
    today,
    minutesToDeparture: minutesToNextDeparture(tasks, today, hhmm()),
    shownThisOpen,
    sheetOpen,
    justSaved: opts.justSaved,
  });
  if (!q) return;
  shownThisOpen = true;
  await writeJson(STATE_KEY, afterShown(state, { now: Date.now(), today }));
  askListeners.forEach((fn) => fn(q));
}

/** She tapped the question herself: show it now, no limits. */
export async function askNow(key: string): Promise<boolean> {
  let q = questions.find((x) => x.key === key);
  if (!q) q = (await refresh()).find((x) => x.key === key);
  if (!q) return false;
  askListeners.forEach((fn) => fn(q!));
  return true;
}

/** "Not now": tomorrow, and after three of those never as a popup again. */
export async function snooze(q: MeiraQuestion): Promise<void> {
  await writeJson(STATE_KEY, afterSnooze(await loadState(), q.key, Date.now()));
  changed();
}

/** Apply her answer where it lives; what could not reach the server waits in the outbox. */
export async function answer(q: MeiraQuestion, a: QuestionAnswer): Promise<AnswerResult> {
  const { result, retry } = await applyAnswer(q, a);
  if (retry) {
    const items = await loadOutbox();
    await saveOutbox([...items.filter((i) => !(i.input.kind === retry.kind && i.input.subject === retry.subject)),
      { input: retry, tries: 0, at: Date.now() }]);
  }
  // Answered = it will not be asked again. Not when nothing landed anywhere
  // and nothing waits to be sent: then the question must stay.
  if (result.ok || result.savedLocally || result.queued
    || result.reason === 'line_changed' || result.reason === 'task_gone') {
    await writeJson(STATE_KEY, afterAnswer(await loadState(), q.key, Date.now()));
  }
  invalidateRoutines();
  changed();
  return result;
}

/**
 * A task's place could not be found: look it up on the map and, when Places
 * knows candidates, queue "Where is X?" (kinds/place). Called from
 * GoogleSync.ensureTravelChain's "unplaced" branch.
 *
 * Returns what happened — NEVER nothing: the caller turns it into the reason
 * the card's why-line carries (kinds/place.unplacedFailure). The popup shows at
 * once only when the app is in front (a sheet nobody can see would spend the
 * day's allowance for nothing); otherwise the question waits for the next
 * open, for You → Meira's questions, and for backgroundRun's nudge.
 */
export async function askWhereIs(a: {
  task: {
    id: string; text: string; date: string; fixedTime?: string; scheduledTime?: string;
    meetingUrl?: string; category?: string; location?: unknown;
  };
  placeText: string;
  homeAddress?: string | null;
}): Promise<PlaceAsk> {
  const ask = await enqueuePlace(
    enqueueDeps(async (key) => Boolean((await loadState()).answered[key])),
    { task: a.task, placeText: a.placeText, homeAddress: a.homeAddress },
  );
  if (ask.outcome === 'queued') {
    changed();
    if (AppState?.currentState === 'active') {
      maybeAsk().catch((e) => console.warn('[Questions] place question check failed', e));
    }
  }
  return ask;
}

/** Her yes / no to a rule Meira proposed. */
export async function confirmRule(p: RuleProposal, yes: boolean): Promise<{ ok: boolean; reason?: string }> {
  const r = await serverConfirmRule(p.id, yes);
  if (!r.ok) return { ok: false, reason: r.reason };
  if (yes) {
    await refreshRules();
    invalidateRoutines();
  }
  return { ok: true };
}

/** Send what waited. -> how many are still waiting. */
export async function retryOutbox(): Promise<number> {
  const items = await loadOutbox();
  if (!items.length) return 0;
  const keep: OutboxItem[] = [];
  for (const item of items) {
    const outcome = await resend(item.input).catch(() => 'retry' as const);
    if (outcome === 'retry' && item.tries + 1 < MAX_TRIES) keep.push({ ...item, tries: item.tries + 1 });
    if (outcome === 'drop') console.warn('[Questions] an outbox item was dropped');
  }
  await saveOutbox(keep);
  if (keep.length !== items.length) invalidateRoutines();
  return keep.length;
}

export async function outboxCount(): Promise<number> {
  return (await loadOutbox()).length;
}

/** AppState 'active' (and cold start): a new open, the outbox, her rules. */
export async function onAppActive(): Promise<void> {
  shownThisOpen = false;
  await retryOutbox().catch((e) => console.warn('[Questions] outbox retry failed', e));
  await refreshRules().catch((e) => console.warn('[Questions] rules refresh failed', e));
  // Back in front is the moment to notice that tomorrow's route starts from a
  // home she is not at (trigger 2 of kinds/tripOrigin).
  await checkTripOrigin('app-active');
}

/**
 * The app is closed (calendar background task): retry the outbox, and nudge
 * — at most once a day, at most twice per question — about a question that
 * is still open. Tapping the notification opens the app, where the popup is.
 */
export async function backgroundRun(): Promise<void> {
  await retryOutbox().catch((e) => console.warn('[Questions] background outbox failed', e));
  try {
    // A question she put off ("Later") is not nudged about either: the notification
    // is a popup in another coat, and "Later" meant later.
    const state = await loadState();
    const open = (await refresh()).filter((x) => mayInterrupt(x, state, Date.now()));
    if (!open.length) return;
    const today = getTodayString();
    const nudges = await readJson<{ day: string; perKey: Record<string, number> }>(NUDGE_KEY, { day: '', perKey: {} });
    if (nudges.day === today) return;
    const q = open.find((x) => (nudges.perKey[x.key] ?? 0) < MAX_NUDGES_PER_QUESTION);
    if (!q) return;
    await sendImmediate(`${iconOf(q)} ${q.title}`, `${q.ask.he} · ${q.ask.en}`, { screen: 'Today', question: q.key });
    await writeJson(NUDGE_KEY, { day: today, perKey: { ...nudges.perKey, [q.key]: (nudges.perKey[q.key] ?? 0) + 1 } });
  } catch (e) {
    console.warn('[Questions] background nudge failed', e);
  }
}
