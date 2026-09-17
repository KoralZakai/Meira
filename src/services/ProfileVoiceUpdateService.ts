/**
 * ProfileVoiceUpdateService — merges voice-extracted profile changes
 * (OnboardingExtraction) into the stored UserProfile and produces a short
 * human-readable summary of what changed.
 *
 * Dependencies: models/UserProfile, MorningRoutineService
 * (calculateMorningRoutineMinutes). Consumed by ProfileEditScreen.
 */
import { OnboardingExtraction, UserProfile } from '../models/UserProfile';
import { calculateMorningRoutineMinutes } from './MorningRoutineService';

/** Project the current profile into the shape the onboarding extractor expects (so it can diff). */
export function toOnboardingExtractionInput(profile: UserProfile): Partial<{
  name: string;
  transportMode: UserProfile['transportMode'];
  homeAddress: string;
  morningHabits: Array<{ habit: string; estimatedMinutes: number }>;
  totalMorningMinutesEstimate: number;
  workStartTime: string;
  sleepTime: string;
}> {
  return {
    name: profile.name,
    transportMode: profile.transportMode,
    homeAddress: profile.homeAddress,
    morningHabits: profile.morningHabits,
    totalMorningMinutesEstimate: profile.totalMorningRoutineMinutes,
    workStartTime: profile.workStartTime,
    sleepTime: profile.sleepTime,
  };
}

function mergeHabits(
  existing: UserProfile['morningHabits'],
  incoming: UserProfile['morningHabits'] | undefined,
): UserProfile['morningHabits'] {
  if (!incoming?.length) {
    return existing;
  }

  const byHabit = new Map<string, number>();

  for (const habit of existing) {
    byHabit.set(habit.habit.trim().toLowerCase(), Math.round(habit.estimatedMinutes));
  }

  for (const habit of incoming) {
    const key = habit.habit.trim().toLowerCase();
    if (!key) {
      continue;
    }
    byHabit.set(key, Math.round(habit.estimatedMinutes));
  }

  return Array.from(byHabit.entries()).map(([habit, estimatedMinutes]) => ({
    habit: habit.charAt(0).toUpperCase() + habit.slice(1),
    estimatedMinutes,
  }));
}

/** Apply extracted changes onto the profile, recomputing routine minutes (pure). */
export function mergeProfileUpdate(profile: UserProfile, extraction: OnboardingExtraction): UserProfile {
  const nextHabits = mergeHabits(profile.morningHabits, extraction.morningHabits);
  const totalFromHabits = nextHabits.reduce((sum, item) => sum + item.estimatedMinutes, 0);
  const baselineTotal = extraction.totalMorningMinutesEstimate
    ?? (totalFromHabits > 0 ? totalFromHabits : profile.totalMorningRoutineMinutes);

  const totalMinutes = calculateMorningRoutineMinutes({
    ...profile,
    morningHabits: nextHabits,
    totalMorningRoutineMinutes: baselineTotal,
  });

  return {
    ...profile,
    ...(extraction.name ? { name: extraction.name } : {}),
    ...(extraction.transportMode ? { transportMode: extraction.transportMode } : {}),
    ...(extraction.homeAddress ? { homeAddress: extraction.homeAddress } : {}),
    ...(extraction.workStartTime ? { workStartTime: extraction.workStartTime } : {}),
    ...(extraction.sleepTime ? { sleepTime: extraction.sleepTime } : {}),
    morningHabits: nextHabits,
    totalMorningRoutineMinutes: totalMinutes,
    lastUpdated: new Date().toISOString(),
  };
}

/** Human-readable one-liner of what changed between two profiles, for Lumi to confirm. */
export function summarizeProfileUpdate(previous: UserProfile, next: UserProfile): string {
  const changes: string[] = [];

  if (previous.transportMode !== next.transportMode) {
    changes.push(`transport: ${next.transportMode}`);
  }
  if (previous.workStartTime !== next.workStartTime) {
    changes.push(`work start: ${next.workStartTime}`);
  }
  if (previous.sleepTime !== next.sleepTime) {
    changes.push(`sleep: ${next.sleepTime}`);
  }
  if (previous.totalMorningRoutineMinutes !== next.totalMorningRoutineMinutes) {
    changes.push(`morning routine: ${next.totalMorningRoutineMinutes} min`);
  }
  if (previous.homeAddress !== next.homeAddress && next.homeAddress) {
    changes.push('home address');
  }

  if (!changes.length) {
    return 'I heard you. Your profile is still the same, so I did not change anything.';
  }

  return `Updated your profile: ${changes.join(', ')}.`;
}
