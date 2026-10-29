/**
 * place — "Where is "Space Gym"?" (15.10, Koral's pick: a popup with up to
 * three rows from the map, "✏️ Something else", "Later").
 *
 * THE FAULT THIS REMOVES
 *
 * A task whose place nobody could find kept its words and no coordinates:
 * the geocode in GoogleSync.ensureTravelChain returned null, logged one
 * `console.warn`, and the card stayed a card with no map pin, no route, no
 * leave-home time and no alarm — the silent state (CLAUDE.md), in the one
 * place the fix is a single tap. Meira knew she did not know, and said
 * nothing. Now she searches Places (never a model), puts what she found in
 * front of Koral, and writes the answer back where it lives.
 *
 * WHAT RUNS WHEN (rule 7 — name the trigger)
 *
 *   enqueuePlace    ensureTravelChain's "unplaced" branch, which runs when
 *                   Today is visible, when the app comes back to the front
 *                   (CalendarAutoSync, at the root) and from the background
 *                   task. Once per task and query, at most once a day.
 *   questionOf      QuestionService.refresh → maybeAsk (popup, with the
 *                   existing limits), askNow (You → Meira's questions), and
 *                   backgroundRun's one nudge a day when the app is closed.
 *   applyPlace      her tap in MeiraAskSheet.
 *
 * Every non-answer says why (rule 1): `PlaceAsk.outcome` tells "nothing found"
 * from "the search itself failed"; `unplacedFailure` turns what the map told
 * us into the reason the card's why-line already knows how to print, and a
 * failed search into nothing on the card but a warn with its reason.
 *
 * Pure but for what is INJECTED (PlaceStore, search, the task patch, the
 * re-plan, the server) — tests/run-place-question.ts drives every branch with
 * fakes and no network. The real wiring is placeDeps.ts.
 */
import {
  cityNamedIn, cityOf, namesACity, withoutAppendedStreet,
} from '../../utils/addressCompletion';
import { addrOf, locOf } from '../../utils/dayPlanning';
import { isOnlineOnlyPlace, isRemoteTask } from '../../utils/meetingLink';
import { hasRealCoords, locationIsPlaced } from '../../utils/placeCoords';
import type { RouteFailure } from '../../utils/routeFailure';
import type { Task } from '../../types/index';
import {
  failureOf, MeiraQuestion, PlaceAnswer, PlaceAnswerInput, PlaceCandidate, PlaceQuestionData, QuestionApply,
} from '../types';

export const KIND = 'place' as const;
export const MAX_CANDIDATES = 3;
/** The same name is not looked up again sooner than this (a sweep runs every few minutes). */
export const RETRY_SEARCH_MS = 24 * 60 * 60 * 1000;
/** …and a search that FAILED is tried again after this, not on every sweep. */
export const RETRY_FAILED_MS = 15 * 60 * 1000;
const MAX_ITEMS = 30;
const MAX_TRIED = 200;

export const keyOf = (taskId: string): string => `${KIND}:${taskId}`;

// ── what is worth asking ─────────────────────────────────────────────────────

/** "home", "online" and friends are not somewhere to look up (rule 8: a reader states what it will NOT accept). */
const NOT_A_PLACE_RE =
  /^\s*(?:(?:at|in)\s+)?(?:home|house|office|work|outside|anywhere|tbd|n\/a)\s*$|^\s*(?:ב)?(?:בית|בבית|משרד|במשרד|עבודה|בחוץ|לא ידוע)\s*$/i;

export type NotAskable = 'empty' | 'online' | 'not_a_place';

/** Can this text be looked up on a map at all? */
export function askableText(
  placeText: string,
  task: { meetingUrl?: string; category?: string; location?: unknown } = {},
): { ok: true } | { ok: false; why: NotAskable } {
  const text = String(placeText || '').trim();
  if (!text) return { ok: false, why: 'empty' };
  if (isOnlineOnlyPlace(text) || isRemoteTask({ ...task, location: task.location ?? text })) {
    return { ok: false, why: 'online' };
  }
  if (NOT_A_PLACE_RE.test(text)) return { ok: false, why: 'not_a_place' };
  return { ok: true };
}

/**
 * What to ask Places: her words, with a town.
 *
 * "Space Gym" alone finds one in every city. The town comes from where the
 * EVENT says it is (its title, "… - חיפה"), then from where she lives — never
 * the other way round, and never when the text already names one.
 */
export function placeQuery(placeText: string, title?: string | null, homeAddress?: string | null): string {
  const base = withoutAppendedStreet(placeText).trim().replace(/^[\s\-–—,·:]+|[\s\-–—,·:]+$/g, '');
  if (!base || base.includes(',') || namesACity(base)) return base;
  const city = cityNamedIn(title) ?? cityOf(homeAddress);
  return city ? `${base}, ${city}` : base;
}

// ── what Places answered ─────────────────────────────────────────────────────

export interface PlaceHitLike { name?: unknown; address?: unknown; lat?: unknown; lng?: unknown }

const norm = (s: unknown): string => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/** At most three distinct places, each with a name, an address and a REAL coordinate. */
export function candidatesFrom(hits: PlaceHitLike[] | null | undefined): PlaceCandidate[] {
  const out: PlaceCandidate[] = [];
  const seen = new Set<string>();
  for (const h of Array.isArray(hits) ? hits : []) {
    const lat = Number(h?.lat);
    const lng = Number(h?.lng);
    const name = String(h?.name ?? '').trim();
    const address = String(h?.address ?? '').trim() || name;
    // 0,0 is "unknown", not a place (utils/placeCoords): a pin there is worse than none.
    if (!name || !address || !hasRealCoords(lat, lng)) continue;
    const id = `${lat.toFixed(4)},${lng.toFixed(4)}|${norm(name)}`;
    const spot = `${lat.toFixed(4)},${lng.toFixed(4)}`;
    if (seen.has(id) || seen.has(spot)) continue;
    seen.add(id);
    seen.add(spot);
    out.push({ name, address, lat, lng });
    if (out.length === MAX_CANDIDATES) break;
  }
  return out;
}

/** The popup's question: "📍 Where is "Space Gym"?" (the sheet draws the 📍). */
export function questionOf(p: PlaceQuestionData): MeiraQuestion {
  return {
    key: keyOf(p.taskId),
    kind: KIND,
    subject: p.taskId,
    title: p.placeText,
    ask: { en: `Where is "${p.placeText}"?`, he: `איפה "${p.placeText}"?` },
    context: { line: p.placeText, origin: [] },
    place: p,
  };
}

// ── the queue (what was found and is waiting for her) ────────────────────────

export interface PlaceQueueItem extends PlaceQuestionData { at: number }
export interface PlaceTried {
  query: string;
  at: number;
  /**
   * 'failed' is a back-off, not a verdict: the search itself broke (a refused
   * key, no connection) and says nothing about the place — it only keeps a
   * sweep every few minutes from hammering an endpoint that is refusing us.
   */
  outcome: 'no_hits' | 'asked' | 'failed';
  reason?: string;
}
export interface PlaceQueue {
  /** taskId → the question waiting for her. */
  items: Record<string, PlaceQueueItem>;
  /** taskId → what was last looked up, so a sweep does not search twice. */
  tried: Record<string, PlaceTried>;
}
export const EMPTY_QUEUE: PlaceQueue = { items: {}, tried: {} };

export interface PlaceStore {
  load(): Promise<PlaceQueue>;
  save(queue: PlaceQueue): Promise<void>;
}

const newest = <T extends { at: number }>(rec: Record<string, T>, max: number): Record<string, T> =>
  Object.fromEntries(Object.entries(rec).sort((a, b) => b[1].at - a[1].at).slice(0, max));

/**
 * Every write to the queue goes through here: one JS thread racing itself is
 * how the task list lost writes once already (TaskStorage.withTaskLock).
 */
let queueLock: Promise<unknown> = Promise.resolve();
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = queueLock.then(fn, fn);
  // Only the CHAIN forgets the failure, so one bad write cannot wedge the
  // queue; the caller of `run` still gets the rejection.
  queueLock = run.catch(() => {});
  return run;
}

/** Take one task's question out of the queue (answered, or no longer true). */
export function forgetPlace(store: PlaceStore, taskId: string): Promise<void> {
  return locked(async () => {
    const q = await store.load();
    if (!q.items[taskId]) return;
    const { [taskId]: _gone, ...items } = q.items;
    await store.save({ ...q, items });
  });
}

// ── asking ───────────────────────────────────────────────────────────────────

export type PlaceAsk =
  /** Found places, and the question is waiting for her. */
  | { outcome: 'queued'; question: MeiraQuestion }
  /** Asked before (waiting, answered, or "Something else"): nothing new to say. */
  | { outcome: 'already' }
  /** Places answered and had nothing for this name. */
  | { outcome: 'no_hits'; query: string }
  /** The search itself failed — says nothing about whether the place exists. */
  | { outcome: 'search_failed'; reason: string }
  /** Not a place to look up (online, "home", empty). */
  | { outcome: 'skipped'; why: NotAskable };

export interface EnqueueDeps {
  store: PlaceStore;
  /** Places Text Search. MUST throw on a refusal — an empty list means only "found nothing". */
  search(query: string): Promise<PlaceHitLike[]>;
  /** Has she already answered (or put off for good) this question? */
  isAnswered(key: string): Promise<boolean>;
  now?: () => number;
}

export interface EnqueueArgs {
  task: {
    id: string; text: string; date: string; fixedTime?: string; scheduledTime?: string;
    meetingUrl?: string; category?: string; location?: unknown;
  };
  /** The place as the task has it (addrOf). */
  placeText: string;
  homeAddress?: string | null;
}

/**
 * A task's place could not be found: look it up on the map and queue the
 * question — once per task, and the same name no more than once a day.
 */
export async function enqueuePlace(deps: EnqueueDeps, args: EnqueueArgs): Promise<PlaceAsk> {
  const now = (deps.now ?? Date.now)();
  const { task } = args;
  const placeText = String(args.placeText || '').trim();
  const askable = askableText(placeText, task);
  if (!askable.ok) return { outcome: 'skipped', why: askable.why };
  const key = keyOf(task.id);
  if (await deps.isAnswered(key)) return { outcome: 'already' };
  const query = placeQuery(placeText, task.text, args.homeAddress);

  // Cheap checks first, under the lock: is it already waiting, or just looked up?
  const before = await locked(() => deps.store.load());
  if (before.items[task.id]) return { outcome: 'already' };
  const last = before.tried[task.id];
  if (last && last.query === query) {
    if (last.outcome === 'failed') {
      if (now - last.at < RETRY_FAILED_MS) return { outcome: 'search_failed', reason: last.reason ?? 'search failed' };
    } else if (now - last.at < RETRY_SEARCH_MS) {
      return last.outcome === 'no_hits' ? { outcome: 'no_hits', query } : { outcome: 'already' };
    }
  }

  let hits: PlaceHitLike[];
  try {
    hits = await deps.search(query);
  } catch (e) {
    // A refused key or a dropped connection is no verdict on the place: it is
    // remembered only as a short back-off, never as "tried and found nothing".
    // The reason travels in the outcome; the caller logs it, once (rule 2).
    const reason = e instanceof Error ? e.message : String(e);
    await locked(async () => {
      const q = await deps.store.load();
      if (q.items[task.id]) return;
      await deps.store.save({
        ...q, tried: newest({ ...q.tried, [task.id]: { query, at: now, outcome: 'failed' as const, reason } }, MAX_TRIED),
      });
    }).catch((err) => console.warn('[Questions] could not note a failed place search', err));
    return { outcome: 'search_failed', reason };
  }
  const candidates = candidatesFrom(hits);

  return locked(async () => {
    const q = await deps.store.load();
    if (q.items[task.id]) return { outcome: 'already' } as PlaceAsk;   // a concurrent sweep got there first
    if (!candidates.length) {
      console.warn('[Questions] Places found nothing for a task place — it stays unplaced:', task.id);
      await deps.store.save({
        ...q, tried: newest({ ...q.tried, [task.id]: { query, at: now, outcome: 'no_hits' as const } }, MAX_TRIED),
      });
      return { outcome: 'no_hits', query } as PlaceAsk;
    }
    const data: PlaceQueueItem = {
      taskId: task.id, date: task.date, taskText: task.text, time: task.fixedTime || task.scheduledTime,
      query, placeText, candidates, at: now,
    };
    await deps.store.save({
      items: newest({ ...q.items, [task.id]: data }, MAX_ITEMS),
      tried: newest({ ...q.tried, [task.id]: { query, at: now, outcome: 'asked' as const } }, MAX_TRIED),
    });
    return { outcome: 'queued', question: questionOf(data) } as PlaceAsk;
  });
}

/**
 * The reason the card's why-line should carry for a task that stays unplaced.
 *
 * `not_found` already prints "📍 Google cannot place this address — Fix the
 * address" (utils/routeFailure): that is what the map just told us, or what
 * Koral was just asked about, so it is true.
 *
 * undefined = claim nothing:
 *   - a failed SEARCH says nothing about the place. It is not "not found" (a
 *     lie about the address) and it is not worth a 📡 on every card of a day
 *     lived offline; the caller LOGS the reason (a warn survives a release
 *     build) and the next sweep asks again, because a failed search is never
 *     recorded as tried.
 *   - an online meeting is not an unplaced place.
 */
export function unplacedFailure(ask: PlaceAsk, now = Date.now()): RouteFailure | undefined {
  switch (ask.outcome) {
    case 'queued':
      return { kind: 'not_found', status: 'NO_PLACE', detail: 'asked her which of the places found', at: now };
    case 'already':
      return { kind: 'not_found', status: 'NO_PLACE', detail: 'asked before; the task still has no place', at: now };
    case 'no_hits':
      return { kind: 'not_found', status: 'NO_PLACE', detail: 'the map found nothing under that name', at: now };
    default:
      return undefined;
  }
}

// ── which of the questions are still true ────────────────────────────────────

interface TaskLike {
  id: string; date?: string; status?: string; location?: unknown; meetingUrl?: string; category?: string;
}

/**
 * The queued questions that are still about something, and the ids to drop.
 *
 * A question outlives its cause easily: the task was deleted or done, its day
 * has passed, she placed it by hand, or she rewrote the place text — in which
 * case the candidates answer a question nobody is asking any more.
 */
export function placeQuestionsFrom(
  queue: PlaceQueue, tasks: TaskLike[], today: string,
): { questions: MeiraQuestion[]; drop: string[] } {
  const questions: MeiraQuestion[] = [];
  const drop: string[] = [];
  for (const item of Object.values(queue.items)) {
    const task = tasks.find((t) => t.id === item.taskId);
    const live = task
      && task.status !== 'complete' && task.status !== 'moved'
      && !(task.date && task.date < today)
      && !locationIsPlaced(locOf(task as unknown as Task))
      && norm(addrOf(task as unknown as Task)) === norm(item.placeText);
    if (live) questions.push(questionOf(item));
    else drop.push(item.taskId);
  }
  return { questions: questions.sort((a, b) => a.key.localeCompare(b.key)), drop };
}

// ── answering ────────────────────────────────────────────────────────────────

/** The location a task gets once she has picked a row. */
export function locationFromCandidate(base: unknown, c: PlaceCandidate): Record<string, unknown> {
  const was = base && typeof base === 'object' ? (base as Record<string, unknown>) : {};
  return {
    ...was,
    address: c.address,
    displayName: c.name,
    lat: c.lat,
    lng: c.lng,
    confirmed: true,
    // The destination just changed under whatever this task knew about getting
    // there; the forced re-plan fills these in again. Her choice of vehicle stays.
    transitPlan: undefined,
    leaveHomeBy: undefined,
    wakeUpBy: undefined,
    travelMinutes: undefined,
    routeFailure: undefined,
    noRouteForMode: undefined,
    missedBusHandled: undefined,
  };
}

export interface ApplyDeps {
  findTask(taskId: string): Promise<{ id: string; text: string; date: string } | null>;
  /** Rewrite ONE task's location from its current one, under the task lock. */
  patchLocation(taskId: string, build: (base: unknown) => Record<string, unknown>): Promise<void>;
  /** Remember this activity happens at this address (KnownPlacesStore.learnPlace). */
  learn(activity: string, address: string, coords: { lat: number; lng: number }): Promise<void>;
  /** ensureTravelChain(date, lang, { forceTaskId }). Started, not awaited. */
  replan(date: string, taskId: string): Promise<unknown>;
  forget(taskId: string): Promise<void>;
  /** The record for the server (questions_store). */
  send(input: PlaceAnswerInput): Promise<{ ok: boolean; reason?: string }>;
}

const SAVED_EDIT = {
  en: 'OK — you can change the place on the task.',
  he: 'בסדר — אפשר לשנות את המקום במשימה.',
};

/** Her answer → the task, the learned place, the new route, the record. */
export async function applyPlace(q: MeiraQuestion, a: PlaceAnswer, deps: ApplyDeps): Promise<QuestionApply> {
  const place = q.place;
  if (q.kind !== KIND || !place) return { result: { ok: false, savedLocally: false, reason: 'local' } };

  // "Something else": nothing is saved and none is claimed. The question is
  // answered (never asked again for this task) and the card keeps saying that
  // Google cannot place the address, with the fix one tap away.
  if (a.choice === 'edit') {
    await deps.forget(place.taskId).catch((e) => console.warn('[Questions] place question not cleared', e));
    const input: PlaceAnswerInput = {
      kind: KIND, subject: place.taskId, line: place.placeText,
      answer: { choice: 'edit', query: place.query }, rewrite_told: false,
    };
    const sent = await deps.send(input).catch((e) => ({ ok: false, reason: String(e?.message ?? e) }));
    const retry = sent.ok ? undefined : retryable(sent.reason, input);
    if (!sent.ok) console.warn('[Questions] place answer not recorded with Meira:', sent.reason);
    return { result: { ok: true, savedLocally: false, skipped: 'edit', queued: Boolean(retry), effect: SAVED_EDIT }, retry };
  }

  const cand = place.candidates[a.index];
  if (!cand) return { result: { ok: false, savedLocally: false, reason: 'local' } };

  const task = await deps.findTask(place.taskId).catch((e) => {
    console.warn('[Questions] could not read the task for a place answer', e);
    return undefined;
  });
  if (task === undefined) return { result: { ok: false, savedLocally: false, reason: 'local' } };
  // updateTask on a missing id writes nothing and says nothing: "saved" would be a lie.
  if (task === null) {
    await deps.forget(place.taskId).catch((e) => console.warn('[Questions] place question not cleared', e));
    return { result: { ok: false, savedLocally: false, reason: 'task_gone' } };
  }

  try {
    await deps.patchLocation(place.taskId, (base) => locationFromCandidate(base, cand));
  } catch (e) {
    console.warn('[Questions] place not saved on the task', e);
    return { result: { ok: false, savedLocally: false, reason: 'local' } };
  }
  await deps.forget(place.taskId).catch((e) => console.warn('[Questions] place question not cleared', e));
  await deps.learn(task.text, cand.address, { lat: cand.lat, lng: cand.lng })
    .catch((e) => console.warn('[Questions] place not learned', e));
  // The way there, planned again for THIS task. Started, not awaited: a route
  // takes seconds and the sheet must not hang on it — and when it fails the
  // chain writes the reason on the card itself.
  void Promise.resolve(deps.replan(task.date || place.date, place.taskId))
    .catch((e) => console.warn('[Questions] route not re-planned after a place answer', e));

  const input: PlaceAnswerInput = {
    kind: KIND, subject: place.taskId, line: task.text || place.placeText,
    answer: { choice: 'pick', query: place.query, name: cand.name, address: cand.address, lat: cand.lat, lng: cand.lng },
    rewrite_told: false,
  };
  const sent = await deps.send(input).catch((e) => ({ ok: false, reason: String(e?.message ?? e) }));
  if (!sent.ok) {
    const reason = failureOf(sent.reason ?? '');
    const retry = retryable(sent.reason, input);
    console.warn('[Questions] place answer not saved with Meira:', sent.reason);
    return { result: { ok: false, savedLocally: true, queued: Boolean(retry), reason }, retry };
  }
  return {
    result: {
      ok: true,
      savedLocally: true,
      effect: {
        en: `Saved: "${place.placeText}" is at ${cand.address}. Planning the way there.`,
        he: `נשמר: "${place.placeText}" — ${cand.address}. מתכננת את הדרך.`,
      },
    },
  };
}

/** Bad sign-in or no such route yet: retrying will not help until she acts or we deploy. */
function retryable(reason: string | undefined, input: PlaceAnswerInput): PlaceAnswerInput | undefined {
  const why = failureOf(reason ?? '');
  return why === 'offline' || why === 'server' ? input : undefined;
}

/** For the background retry: the answer already applied on the phone, sent again. */
export async function resendPlace(
  input: PlaceAnswerInput, send: ApplyDeps['send'],
): Promise<'done' | 'retry' | 'drop'> {
  const sent = await send(input).catch((e) => ({ ok: false, reason: String(e?.message ?? e) }));
  if (sent.ok) return 'done';
  return retryable(sent.reason, input) ? 'retry' : 'drop';
}
