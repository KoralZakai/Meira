export type TransportMode = 'car' | 'foot' | 'bicycle' | 'transit';

export interface MorningHabit {
  habit: string;
  estimatedMinutes: number;
}

export interface LearnedTravelProfile {
  key: string;
  label: string;
  averageMinutes: number;
  samples: number;
  onTimeCount: number;
  lateCount: number;
}

export interface UserProfile {
  name: string;
  homeAddress: string;
  homeLatLng: { lat: number; lng: number } | null;
  /** Where they commute TO. The opening question asks for it, so it must have
   *  somewhere to land — otherwise Lumi asks and then forgets. */
  workAddress?: string;
  transportMode: TransportMode;
  morningHabits: MorningHabit[];
  totalMorningRoutineMinutes: number;
  workStartTime: string;
  sleepTime: string;
  learnedTravelProfiles?: LearnedTravelProfile[];
  effortPoints?: number;
  /** Free-text hobbies ("climbing, guitar, cooking") — Lumi uses these for free-time suggestions. */
  hobbies?: string;
  /** Free-text routines ("gym Mon/Wed 18:00, weekly review Sunday") — context for planning. */
  routinesNotes?: string;
  /** Does she have a car to drive? Unset until she says — see utils/travelLadder.hasCarOf. */
  hasCar?: boolean;
  /** How pushy Meira is around a study block — utils/nudgeLevel; the server reads it (reschedule.nudges_for). */
  nudgeLevel?: 'alarm' | 'gentle' | 'motivating';
  /** HH:MM — the earliest she is willing to be woken (utils/dayFeasibility, WAKE_CONFLICT). */
  earliestWakeTime?: string;
  /** Minutes of slack she wants on arrival. */
  travelBufferMinutes?: number;
  /** How late she habitually leaves — learned, never typed (utils/leadLearning). */
  departDelayMinutes?: number;
  onboardingComplete: boolean;
  createdAt: string;
  lastUpdated: string;
}

/**
 * An empty profile to merge edits into. Needed because loadProfile() returns
 * null until onboarding completes, and every "save one field" path used to
 * give up silently in that state — which is exactly the state a user is in
 * when they open Profile to set their home address for the first time.
 */
export function blankProfile(): UserProfile {
  const now = new Date().toISOString();
  return {
    name: '',
    homeAddress: '',
    homeLatLng: null,
    transportMode: 'transit',
    morningHabits: [],
    totalMorningRoutineMinutes: 20,
    workStartTime: '09:00',
    sleepTime: '23:00',
    onboardingComplete: false,
    createdAt: now,
    lastUpdated: now,
  };
}

export interface OnboardingExtraction {
  name?: string;
  transportMode?: TransportMode;
  homeAddress?: string;
  workAddress?: string;
  /** Constraints and habits in the user's own words — the things a calendar
   *  never shows and that make an otherwise valid plan wrong. */
  routinesNotes?: string;
  morningHabits?: MorningHabit[];
  totalMorningMinutesEstimate?: number;
  workStartTime?: string;
  sleepTime?: string;
  missingFields: string[];
  followUpQuestion: string;
  isComplete: boolean;
}
