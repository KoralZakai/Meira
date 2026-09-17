/**
 * One normalizer between the two UserProfile shapes this app carries.
 *
 * `src/models/UserProfile.ts` is what `UserProfileStorage.loadProfile()`
 * actually returns and what onboarding writes. `src/types/index.ts` is the
 * shape CLAUDE.md documents and that the planning code, the LLM prompt and the
 * travel chain all read. They disagree on almost every field name:
 *
 *     models                        types
 *     transportMode ('transit')     transportType ('bus')
 *     totalMorningRoutineMinutes    morningRoutineMinutes
 *     homeLatLng { lat, lng }       homeLat / homeLng
 *     workStartTime                 defaultWakeTime
 *     (absent)                      wakeBufferMinutes
 *
 * Reading a types/ name off a stored profile yields `undefined` silently, and
 * TypeScript never complains because every call site casts to `any` first.
 * The damage was real: LLMService.getSystemPrompt rendered four of its six
 * profile lines as the literal string "undefined", so the agent planned days
 * for a user with no transport, no routine and no wake time.
 *
 * Every consumer that wants types/ names must go through here.
 */
import { TransportType, UserProfile } from '../types';
import { subtractMinutes } from './timeUtils';

const MODE_TO_TYPE: Record<string, TransportType> = {
  transit: 'bus',
  car: 'car',
  foot: 'walk',
  bicycle: 'bike',
};

/** Fallback when neither shape carries a routine length. Matches CLAUDE.md. */
const DEFAULT_ROUTINE_MINUTES = 45;
/** Nothing writes wakeBufferMinutes in either shape; this is the documented default. */
const DEFAULT_WAKE_BUFFER = 15;

/**
 * A stored profile of either shape → the `types/UserProfile` names.
 *
 * Safe to call on an already-normalized profile: every mapping prefers a
 * types/ value that is already present.
 */
export function normalizeProfile(stored: any): UserProfile | null {
  if (!stored) return null;

  const morningRoutineMinutes =
    stored.morningRoutineMinutes ??
    stored.totalMorningRoutineMinutes ??
    DEFAULT_ROUTINE_MINUTES;

  return {
    ...stored,
    transportType:
      stored.transportType || MODE_TO_TYPE[stored.transportMode] || 'bus',
    morningRoutineMinutes,
    wakeBufferMinutes: stored.wakeBufferMinutes ?? DEFAULT_WAKE_BUFFER,
    homeLat: stored.homeLat ?? stored.homeLatLng?.lat,
    homeLng: stored.homeLng ?? stored.homeLatLng?.lng,
    // Nothing has ever WRITTEN defaultWakeTime — it is read in six places and
    // set in none, so it was always undefined and every caller fell back to a
    // hardcoded 08:00. Derive it the way the rest of the app reasons about
    // time: backwards from the first commitment, minus the morning routine.
    defaultWakeTime:
      stored.defaultWakeTime ||
      (stored.workStartTime
        ? subtractMinutes(stored.workStartTime, morningRoutineMinutes)
        : '07:00'),
    learnedLeadMinutes: stored.learnedLeadMinutes || undefined,
  } as UserProfile;
}
