/**
 * tripOrigin — "Tomorrow at 10:34 you leave for the interview. Where will you
 * leave from?" (17.10, Koral: she was near Nahariya, home is Tel Aviv, and
 * tomorrow's route had been worked out from home.)
 *
 * THE FAULT THIS REMOVES
 *
 * A day that has not begun is planned from home (utils/tripStart). That is
 * the right guess until the phone says she is somewhere else, at which point
 * the leave time, the route and the wake alarm are all built on a start Meira
 * has reason to doubt — and said nothing. Now she asks, once per day:
 *
 *   📍 From here (<where she is>)   → the day's start is saved (DayStartStore),
 *                                      the first trip is re-planned from it
 *   🏠 From home                    → nothing changes; answered
 *   Later                           → QuestionService's snooze (tomorrow)
 *
 * WHAT RUNS WHEN (rule 7 — name the trigger)
 *
 *   detectTripOrigin  QuestionService.refresh. That is: Today coming into
 *                     view (maybeAsk), the app returning to the front
 *                     (onAppActive) and every foreground calendar sweep
 *                     (CalendarAutoSync, at the root, incl. its 10-min
 *                     heartbeat), the closed-app task (backgroundRun → one
 *                     nudge notification a day), and You → "Meira's
 *                     questions" (pending). It is DERIVED each time from
 *                     tomorrow's tasks and her position, never queued, so it
 *                     cannot outlive its cause: she drove home, the task was
 *                     deleted, the plan moved — the question just is not there.
 *   applyTripOrigin   her tap in MeiraAskSheet.
 *
 * Every non-answer says why (rule 1): `decideTripOrigin` returns a reason, and
 * the reasons that mean "I could not tell" (no fix, no home, tasks unreadable)
 * are logged with console.warn, throttled.
 *
 * Pure but for what is INJECTED (clock, position, profile, tasks, the stored
 * start, the re-plan) — tests/run-tomorrow-start.ts drives every branch with
 * fakes and no network. The real wiring is tripOriginDeps.ts.
 */
import type { Task } from '../../types/index';
import {
  COULD_NOT_TELL, decideTripOrigin, hhmmOf, NoAsk, tomorrowOf, tripOriginKey, TRIP_ORIGIN_KIND, TripOriginDecision,
} from '../../utils/tomorrowStart';
import { DayStart, hePrefix } from '../../utils/tripStart';
import type {
  MeiraQuestion, QuestionApply, TripOriginAnswer, TripOriginQuestionData,
} from '../types';

export const KIND = TRIP_ORIGIN_KIND;
export const keyOf = tripOriginKey;

// ── the words ────────────────────────────────────────────────────────────────

/** "where you are now" — when the geocoder had no name for the spot. */
export const HERE_FALLBACK = { en: 'where you are now', he: 'המקום שבו את עכשיו' } as const;

/** The place as the buttons and the confirmation name it. */
export function hereLabelText(d: Pick<TripOriginQuestionData, 'hereLabel'>, he: boolean): string {
  const label = String(d.hereLabel ?? '').trim();
  return label || (he ? HERE_FALLBACK.he : HERE_FALLBACK.en);
}

/**
 * "Tomorrow at 10:34 you leave for X. Where will you leave from?" — with the
 * hour she LEAVES at when the plan has one; with only the appointment's hour,
 * it says "you have X" instead (a leave time nobody computed is not invented).
 */
export function askText(d: TripOriginQuestionData): { en: string; he: string } {
  const title = d.taskTitle;
  if (d.leaveAt) {
    return {
      en: `Tomorrow at ${d.leaveAt} you leave for ${title}. Where will you leave from?`,
      he: `מחר ב-${d.leaveAt} יוצאים ${hePrefix('ל', title)}. מאיפה תצאי?`,
    };
  }
  const at = d.time ? ` at ${d.time}` : '';
  const atHe = d.time ? ` ב-${d.time}` : '';
  return {
    en: `Tomorrow${at} you have ${title}. Where will you leave from?`,
    he: `מחר${atHe} יש לך ${title}. מאיפה תצאי?`,
  };
}

/** Every string the sheet draws for this kind, both languages (tests/run-tomorrow-start.ts). */
export function sheetText(d: TripOriginQuestionData): {
  ask: { en: string; he: string };
  here: { en: string; he: string };
  home: { en: string; he: string };
  later: { en: string; he: string };
} {
  return {
    ask: askText(d),
    here: { en: `📍 From here (${hereLabelText(d, false)})`, he: `📍 מכאן (${hereLabelText(d, true)})` },
    home: { en: '🏠 From home', he: '🏠 מהבית' },
    later: { en: 'Later', he: 'אחר כך' },
  };
}

/** The popup's question. Keyed by DATE: one question a day, whichever trip it is about. */
export function questionOf(d: TripOriginQuestionData): MeiraQuestion {
  return {
    key: keyOf(d.date),
    kind: KIND,
    subject: d.date,
    title: d.taskTitle,
    ask: askText(d),
    context: { line: d.taskTitle, origin: [] },
    tripOrigin: d,
  };
}

// ── detecting ────────────────────────────────────────────────────────────────

export interface DetectDeps {
  now?: () => Date;
  /** Her last known position; null when unknown or refused. */
  here(): Promise<{ lat: number; lng: number } | null>;
  /** Home, as the profile has it. null = no profile at all. */
  home(): Promise<{ coords: { lat?: number; lng?: number } | null; address?: string } | null>;
  tasksFor(date: string): Promise<Task[]>;
  /** What she already said about that date. A throw means "could not read". */
  dayStart(date: string): Promise<DayStart | null>;
  /** The place in words (the Today header's own label). null = no name. */
  labelOf(point: { lat: number; lng: number }): Promise<string | null>;
}

const lastWarn = new Map<string, number>();
const WARN_EVERY_MS = 10 * 60 * 1000;

/** A `could not tell` reason, warned about — but not on every 10-minute sweep. */
function warnOnce(reason: string, detail: string | undefined, now: number): void {
  const last = lastWarn.get(reason) ?? 0;
  if (now - last < WARN_EVERY_MS) return;
  lastWarn.set(reason, now);
  console.warn(`[Questions] tripOrigin: could not tell whether to ask — ${reason}${detail ? ` (${detail})` : ''}`);
}

export interface DetectResult {
  /** At most one: the question for tomorrow. */
  questions: MeiraQuestion[];
  decision: TripOriginDecision;
}

/**
 * Should Meira ask about tomorrow's start right now? `answered` is
 * AskState.answered (key → when).
 */
export async function detectTripOrigin(
  deps: DetectDeps, answered: Record<string, unknown>,
): Promise<DetectResult> {
  const clock = (deps.now ?? (() => new Date()))();
  const tomorrow = tomorrowOf(clock);
  const stop = (reason: NoAsk, detail?: string): DetectResult => {
    if (COULD_NOT_TELL.has(reason)) warnOnce(reason, detail, clock.getTime());
    return { questions: [], decision: { ask: false, reason, ...(detail ? { detail } : {}) } };
  };

  // Cheapest first: an answered day needs no reads at all.
  if (answered[keyOf(tomorrow)]) return stop('answered');

  let tasks: Task[];
  try {
    tasks = await deps.tasksFor(tomorrow);
  } catch (e) {
    return stop('tasks_unreadable', e instanceof Error ? e.message : String(e));
  }

  let dayStart: DayStart | null = null;
  try {
    dayStart = await deps.dayStart(tomorrow);
  } catch (e) {
    // Unreadable is not "she said nothing": asking again could undo her answer,
    // so the question waits until the store can be read.
    return stop('start_unreadable', e instanceof Error ? e.message : String(e));
  }

  const [here, home] = await Promise.all([
    deps.here().catch((e) => { console.warn('[Questions] tripOrigin: position unreadable', e); return null; }),
    deps.home().catch((e) => { console.warn('[Questions] tripOrigin: profile unreadable', e); return null; }),
  ]);

  const decision = decideTripOrigin({
    tomorrow, nowHHMM: hhmmOf(clock), here, home: home?.coords, homeAddress: home?.address, tasks, answered, dayStart,
  });
  if (!decision.ask) return stop(decision.reason, decision.detail);

  // Only now the network: her position in words. No name is not a reason to
  // stay silent — the sheet says "where you are now" — but it is said.
  const label = await deps.labelOf(decision.data.here).catch((e) => {
    console.warn('[Questions] tripOrigin: reverse geocode failed', e);
    return null;
  });
  if (!label) console.warn('[Questions] tripOrigin: no place name for her position; the question says "where you are now"');
  const data: TripOriginQuestionData = { ...decision.data, hereLabel: String(label ?? '').trim() };
  return { questions: [questionOf(data)], decision: { ask: true, data } };
}

// ── answering ────────────────────────────────────────────────────────────────

export interface ApplyDeps {
  findTask(taskId: string): Promise<{ id: string; text: string; date: string } | null>;
  saveStart(date: string, start: DayStart): Promise<void>;
  readStart(date: string): Promise<DayStart | null>;
  /** true = there was a start for that date and it is gone. */
  clearStart(date: string): Promise<boolean>;
  /** ensureTravelChain(date, lang, { forceTaskId, reladder: true }). Started, not awaited. */
  replan(date: string, taskId: string): Promise<unknown>;
  now?: () => number;
}

const local = (): QuestionApply => ({ result: { ok: false, savedLocally: false, reason: 'local' } });

/** Her answer → the day's start, the new route. Nothing is claimed that did not land (rule 3). */
export async function applyTripOrigin(q: MeiraQuestion, a: TripOriginAnswer, deps: ApplyDeps): Promise<QuestionApply> {
  const d = q.tripOrigin;
  if (q.kind !== KIND || !d) return local();

  if (a.choice === 'home') {
    // The plan is already from home; if an earlier answer said otherwise, undo it.
    let had: boolean;
    try {
      had = await deps.clearStart(d.date);
    } catch (e) {
      console.warn('[Questions] tripOrigin: could not clear the day start', e);
      return local();
    }
    if (had) {
      void Promise.resolve(deps.replan(d.date, d.taskId))
        .catch((e) => console.warn('[Questions] tripOrigin: route not re-planned from home', e));
    }
    return {
      result: {
        ok: true, savedLocally: true,
        effect: { en: 'OK — tomorrow starts from home.', he: 'בסדר — מחר יוצאים מהבית.' },
      },
    };
  }

  // "From here": the position she was SHOWN — what the button said — not a
  // fresh fix that may be somewhere else by the time she taps.
  const task = await deps.findTask(d.taskId).catch((e) => {
    console.warn('[Questions] tripOrigin: could not read the task', e);
    return undefined;
  });
  if (task === undefined) return local();
  // A missing id would plan nothing and say nothing: "saved" would be a lie.
  if (task === null) return { result: { ok: false, savedLocally: false, reason: 'task_gone' } };

  const label = String(d.hereLabel ?? '').trim();
  const start: DayStart = {
    lat: d.here.lat, lng: d.here.lng, ...(label ? { label } : {}), setAt: (deps.now ?? Date.now)(),
  };
  try {
    await deps.saveStart(d.date, start);
  } catch (e) {
    console.warn('[Questions] tripOrigin: day start not saved', e);
    return local();
  }
  // Read it back before saying so: a write that did not land must not read ✓.
  const back = await deps.readStart(d.date).catch((e) => {
    console.warn('[Questions] tripOrigin: day start not readable after saving', e);
    return null;
  });
  if (!back || back.lat !== start.lat || back.lng !== start.lng) {
    console.warn('[Questions] tripOrigin: day start did not stick');
    return local();
  }

  // The way there, planned again from the new start. Started, not awaited: a
  // route takes seconds — and when it fails the chain writes the reason on the
  // card itself, and the next sweep retries (the stored plan's origin is home,
  // the day's start is not: that is a stale plan to ensureTravelChain).
  void Promise.resolve(deps.replan(d.date, d.taskId))
    .catch((e) => console.warn('[Questions] tripOrigin: route not re-planned after the answer', e));

  const where = hereLabelText(d, false);
  const whereHe = hereLabelText(d, true);
  return {
    result: {
      ok: true, savedLocally: true,
      effect: {
        en: `Saved: tomorrow starts from ${where}. Planning the way there.`,
        he: `נשמר: מחר יוצאים ${hePrefix('מ', whereHe)}. מתכננת את הדרך.`,
      },
    },
  };
}
