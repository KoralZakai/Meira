/**
 * Meira's questions — the shared shape (6.10).
 *
 * Koral: "Meira should ask about anything unclear — a popup. After each one,
 * record what happened and how I answered, learn from it, and update the
 * rules / memory / data." Each KIND of question (src/questions/kinds/*) says
 * how to detect it, how to word it, and how to apply an answer; the registry
 * runs them, QuestionService decides when one may pop up, MeiraAskSheet shows it.
 */
import type { QuestionAnswerInput, RoutineDaysAnswer, RuleProposal } from '../services/LumiServer';
import type { RoutineOriginData } from '../utils/routineOrigin';

export type QuestionKind = 'routineDays' | 'place' | 'tripOrigin' | 'routineOrigin';

/** One place Google found for a name Meira could not place by itself. */
export interface PlaceCandidate {
  name: string;
  address: string;
  lat: number;
  lng: number;
}

/** What a 'place' question is about (15.10: "Where is X?"). */
export interface PlaceQuestionData {
  taskId: string;
  /** The task's day — the route is re-planned for it once she answers. Shown too: it may not be today (rule 4). */
  date: string;
  /** The task's words ("אימון") and its hour, so the sheet can say WHICH task is asking. */
  taskText: string;
  time?: string;
  /** What was asked of Places: her words plus the city hint. */
  query: string;
  /** Her words as the task has them ("Space Gym"). A changed text voids the question. */
  placeText: string;
  /** At most 3, best first, every one with real coordinates. */
  candidates: PlaceCandidate[];
}

/**
 * What a 'tripOrigin' question is about (17.10: "Tomorrow at 10:34 you leave
 * for the interview. Where will you leave from?"). Derived from tomorrow's
 * tasks and her position every time — nothing is queued, so it cannot go stale.
 */
export interface TripOriginQuestionData {
  /** Tomorrow, YYYY-MM-DD — the question's key is `tripOrigin:<date>`. */
  date: string;
  /** The first located trip of that day: the one the answer re-plans. */
  taskId: string;
  taskTitle: string;
  /** The appointment's own hour. */
  time?: string;
  /** When she leaves, from the stored plan (HH:MM). Missing: no plan yet, and the question says the appointment's hour instead. */
  leaveAt?: string;
  /** Where she is, in words ("" when the geocoder had nothing — the sheet falls back to "where you are now"). */
  hereLabel: string;
  /** Where she is. Held on the phone only; never sent anywhere by this question. */
  here: { lat: number; lng: number };
}

export interface MeiraQuestion {
  /** Stable across reloads: `${kind}:${subject}`. What "Not now" and the answer are kept under. */
  key: string;
  kind: QuestionKind;
  /** What it is about — for a routine, the key its row has ("קיקבוקס|20:30"); for a place, the task id. */
  subject: string;
  /** Her own words, short: "קיקבוקס · 20:30–21:30" / "Space Gym". */
  title: string;
  ask: { en: string; he: string };
  context: {
    /** Her line exactly as it reads now (a place: the words she wrote for it). */
    line: string;
    /** Where the line lives: her Routines box, what she told Meira, or both. */
    origin: ('box' | 'told')[];
    /** "twice a week" — the days are still hers to name. */
    perWeek?: number;
  };
  /** Only for kind 'place'. */
  place?: PlaceQuestionData;
  /** Only for kind 'tripOrigin'. */
  tripOrigin?: TripOriginQuestionData;
  /** Only for kind 'routineOrigin'. */
  routineOrigin?: RoutineOriginData;
}

/** One of the candidate rows, or "Something else" (→ she edits the task herself). */
export type PlaceAnswer =
  | { choice: 'pick'; index: number }
  | { choice: 'edit' };

/** "Where will you leave from?" — here (the position she was shown) or home. "Later" is the sheet's own snooze. */
export type TripOriginAnswer =
  | { choice: 'here' }
  | { choice: 'home' };

/** "Home first, or straight to the routine?" — 'later' is the sheet's own snooze. */
export type RoutineOriginAnswer =
  | { choice: 'home' }
  | { choice: 'direct' }
  | { choice: 'skip' };

export type QuestionAnswer = RoutineDaysAnswer | PlaceAnswer | TripOriginAnswer | RoutineOriginAnswer;

/** Why an answer did not fully land — each one reads differently to her (rule 3). */
export type AnswerFailure = 'offline' | 'auth' | 'deploy' | 'line_changed' | 'server' | 'local' | 'task_gone';

export interface AnswerResult {
  /** Every part saved, on the phone and with Meira. Only then is ✓ shown. */
  ok: boolean;
  /** The part that lives on this phone was saved (a routine: her Routines box; a place: the task) — true even when the server part waits. */
  savedLocally: boolean;
  /** The server part is queued and will be retried (QuestionService outbox). */
  queued?: boolean;
  effect?: { en: string; he: string };
  reason?: AnswerFailure;
  proposal?: RuleProposal;
  /** She chose to deal with it herself ("Something else"): nothing was saved, and none is claimed. */
  skipped?: 'edit';
}

/** What a kind's apply step returns: the result, and the server part to retry when it must be. */
export interface QuestionApply {
  result: AnswerResult;
  retry?: QuestionAnswerInput | PlaceAnswerInput;
}

/** The record of a place answer, as the server takes it (server/questions_store.py, kind 'place'). */
export interface PlaceAnswerInput {
  kind: 'place';
  /** The task id — one answer per task. */
  subject: string;
  /** The task's words: the ACTIVITY the server learns the place for. */
  line: string;
  answer:
    | { choice: 'pick'; query: string; name: string; address: string; lat: number; lng: number }
    | { choice: 'edit'; query: string };
  rewrite_told: false;
}

/** A server "reason" string (LumiServer.request) → the failure she is told about. */
export function failureOf(reason: string): AnswerFailure {
  if (/sign in|401|403/i.test(reason)) return 'auth';
  if (/does not have this yet|404/i.test(reason)) return 'deploy';
  if (/could not reach|network|abort|timed? ?out|no server address/i.test(reason)) return 'offline';
  if (/line_changed/.test(reason)) return 'line_changed';
  return 'server';
}
