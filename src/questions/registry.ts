/**
 * The kinds of question Meira asks, in one place: detect → apply → resend.
 * A new kind (same-meeting twins, a clash choice) joins here and gets the
 * popup, the limits, the outbox and the learning for free. Consumed by
 * services/QuestionService.
 *
 * Three kinds so far:
 *   routineDays  detected from her routines (sync) — "every day, or which days?"
 *   place        detected where a task's place could not be found (kinds/place,
 *                queued by GoogleSync.ensureTravelChain) — "Where is X?"
 *   tripOrigin   derived from tomorrow's tasks and her position (kinds/tripOrigin)
 *                — "Tomorrow at 10:34 you leave for X. Where will you leave from?"
 *                Phone-only: the answer is a day start, not a server record.
 */
import type { PlaceAnswerInput } from './types';
import type { QuestionAnswerInput, RoutineDaysAnswer } from '../services/LumiServer';
import type { Routine } from '../utils/routines';
import { applyRoutineDays, detectRoutineDays, resendRoutineDays } from './kinds/routineDays';
import { applyPlace, resendPlace } from './kinds/place';
import { applyDeps as placeApplyDeps, detectPlaces as detectQueuedPlaces, sendPlaceAnswer } from './kinds/placeDeps';
import { applyTripOrigin } from './kinds/tripOrigin';
import { applyDeps as tripApplyDeps, detectTripOrigin as detectTomorrowStart } from './kinds/tripOriginDeps';
import { applyRoutineOrigin } from './kinds/routineOrigin';
import { applyDeps as routineOriginApplyDeps, detectRoutineOrigin as detectRoutineOriginQs } from './kinds/routineOriginDeps';
import type { MeiraQuestion, QuestionAnswer, QuestionApply } from './types';

/** The questions that come from her routines. */
export function detectAll(routines: Routine[]): MeiraQuestion[] {
  return [...detectRoutineDays(routines)];
}

/** The 'place' questions still waiting for her (read from the phone's queue; stale ones are dropped). */
export function detectPlaces(today: string): Promise<MeiraQuestion[]> {
  return detectQueuedPlaces(today);
}

/** The 'tripOrigin' question, when tomorrow's first trip may start somewhere other than home. */
export function detectTripOrigin(answered: Record<string, unknown>): Promise<MeiraQuestion[]> {
  return detectTomorrowStart(answered);
}

/** The 'routineOrigin' question: a routine with a place follows the day's last trip — home first, or straight there? */
export function detectRoutineOrigin(): Promise<MeiraQuestion[]> {
  return detectRoutineOriginQs();
}

export function applyAnswer(q: MeiraQuestion, a: QuestionAnswer): Promise<QuestionApply> {
  switch (q.kind) {
    case 'routineDays':
      // The sheet only offers day answers for a routine; anything else is a bug, said as one.
      if (a.choice === 'pick' || a.choice === 'edit' || a.choice === 'here' || a.choice === 'home') break;
      return applyRoutineDays(q, a as RoutineDaysAnswer);
    case 'place':
      if (a.choice !== 'pick' && a.choice !== 'edit') break;
      return applyPlace(q, a, placeApplyDeps);
    case 'tripOrigin':
      if (a.choice !== 'here' && a.choice !== 'home') break;
      return applyTripOrigin(q, a, tripApplyDeps);
    case 'routineOrigin':
      if (a.choice !== 'direct' && a.choice !== 'home' && a.choice !== 'skip') break;
      return applyRoutineOrigin(q, a, routineOriginApplyDeps);
    default:
      break;
  }
  console.warn('[Questions] an answer that does not fit its question was ignored:', q.kind, a.choice);
  return Promise.resolve({ result: { ok: false, savedLocally: false, reason: 'local' } });
}

export function resend(input: QuestionAnswerInput | PlaceAnswerInput): Promise<'done' | 'retry' | 'drop'> {
  if (input.kind === 'routine_days') return resendRoutineDays(input);
  if (input.kind === 'place') return resendPlace(input, sendPlaceAnswer);
  return Promise.resolve('drop');
}
