/**
 * UserProfileStorage — persists the UserProfile (AsyncStorage; secrets in
 * expo-secure-store) and geocodes the home address on save.
 *
 * Dependencies: NearbyTaskReminderService.geocodeTaskLocation.
 * loadProfile() is the read path used by LumiCoachEngine and most screens;
 * null means onboarding hasn't finished.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { UserProfile } from '../models/UserProfile';
import { geocodeTaskLocation } from './NearbyTaskReminderService';
import * as repo from './supabaseRepo';
import { isSupabaseConfigured } from './supabaseClient';
import { getUserId } from './SupabaseAuthService';

const USER_PROFILE_KEY = 'lumi_user_profile';
const HOME_SENSITIVE_KEY = 'lumi_home_sensitive';

type HomeSensitivePayload = {
  homeAddress: string;
  homeLatLng: { lat: number; lng: number } | null;
};

/** The signed-in user, or null when there is no cloud to mirror to. */
async function cloudUserId(): Promise<string | null> {
  if (!isSupabaseConfigured) return null;
  try {
    return await getUserId();
  } catch {
    return null;
  }
}

/**
 * Mirror the profile to Supabase — best effort, never blocks the local save.
 *
 * This store had NO cloud path at all: every screen saves through here, while
 * the only cloud-aware profile pair lived in TaskStorage and nothing called it.
 * `user_profiles` therefore held zero rows for an account with 96 tasks, and
 * the profile existed on exactly one device — half of it (the home address) in
 * SecureStore, which a reinstall or a restore does not carry over. Lose it and
 * homeAddress is '', which is the state where the travel chain plans nothing:
 * no leave time, no bus line, no wake alarm, and no way to tell why.
 */
async function mirrorProfile(profile: UserProfile): Promise<void> {
  const userId = await cloudUserId();
  if (!userId) return;
  try {
    await repo.upsertProfile(userId, profile);
  } catch (e) {
    console.warn('[UserProfileStorage] cloud profile mirror failed', e);
  }
}

/** Persist the profile (secrets to SecureStore) and geocode the home address. */
export async function saveProfile(profile: UserProfile): Promise<void> {
  let homeLatLng = profile.homeLatLng;
  const homeAddress = profile.homeAddress;

  if (!homeLatLng && homeAddress.trim()) {
    homeLatLng = await geocodeTaskLocation(homeAddress.trim());
  }

  const { homeAddress: _omitHomeAddress, homeLatLng: _omitHomeLatLng, ...safeProfile } = profile;

  await AsyncStorage.setItem(
    USER_PROFILE_KEY,
    JSON.stringify({
      ...safeProfile,
      homeAddress: '',
      homeLatLng: null,
    }),
  );

  const sensitivePayload: HomeSensitivePayload = {
    homeAddress,
    homeLatLng,
  };

  await SecureStore.setItemAsync(HOME_SENSITIVE_KEY, JSON.stringify(sensitivePayload));

  // Fire-and-forget: the local save has already happened and must not wait on
  // the network, but without this the profile never leaves the device.
  mirrorProfile({ ...profile, homeAddress, homeLatLng }).catch(() => {});
}

/** Stored UserProfile or null before onboarding. Read path for LumiCoachEngine + screens. */
export async function loadProfile(): Promise<UserProfile | null> {
  const [rawProfile, rawSensitive] = await Promise.all([
    AsyncStorage.getItem(USER_PROFILE_KEY),
    SecureStore.getItemAsync(HOME_SENSITIVE_KEY),
  ]);

  if (!rawProfile) {
    // Nothing local — a fresh install, or storage that did not survive a
    // restore. The cloud copy is what makes that recoverable instead of a
    // silent reset to "no home address, no routes".
    return restoreFromCloud();
  }

  try {
    const parsedProfile = JSON.parse(rawProfile) as UserProfile;
    let sensitive: HomeSensitivePayload = {
      homeAddress: '',
      homeLatLng: null,
    };

    if (rawSensitive) {
      try {
        sensitive = JSON.parse(rawSensitive) as HomeSensitivePayload;
      } catch {
        sensitive = { homeAddress: '', homeLatLng: null };
      }
    }

    return {
      ...parsedProfile,
      homeAddress: sensitive.homeAddress ?? '',
      homeLatLng: sensitive.homeLatLng ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Rebuild the local profile from the cloud row, in the shape this store speaks.
 * Returns null when there is no session or no row — the caller then behaves
 * exactly as it did before (onboarding).
 */
async function restoreFromCloud(): Promise<UserProfile | null> {
  const userId = await cloudUserId();
  if (!userId) return null;
  try {
    const cloud: any = await repo.fetchProfile(userId);
    if (!cloud) return null;
    const restored: UserProfile = {
      name: cloud.name ?? '',
      homeAddress: cloud.homeAddress ?? '',
      homeLatLng: (cloud.homeLat != null && cloud.homeLng != null)
        ? { lat: cloud.homeLat, lng: cloud.homeLng }
        : null,
      transportMode: cloud.transportMode
        ?? ({ bus: 'transit', train: 'transit', car: 'car', walk: 'foot', bike: 'bicycle' } as any)[cloud.transportType]
        ?? 'transit',
      morningHabits: cloud.morningHabits ?? [],
      totalMorningRoutineMinutes: cloud.morningRoutineMinutes ?? 20,
      workStartTime: cloud.defaultWakeTime ?? '09:00',
      sleepTime: cloud.sleepTime ?? '23:00',
      onboardingComplete: Boolean(cloud.homeAddress),
      createdAt: new Date(cloud.createdAt ?? Date.now()).toISOString(),
      lastUpdated: new Date().toISOString(),
    };
    // Put it back on the device so the next read is local and instant.
    await saveProfile(restored).catch(() => {});
    return restored;
  } catch (e) {
    console.warn('[UserProfileStorage] cloud profile restore failed', e);
    return null;
  }
}

/** True once a profile with the required fields exists. */
export async function isOnboardingComplete(): Promise<boolean> {
  const profile = await loadProfile();
  return Boolean(profile?.onboardingComplete);
}

/** Wipe the stored profile (sign-out / reset). */
export async function clearProfile(): Promise<void> {
  await Promise.all([
    AsyncStorage.removeItem(USER_PROFILE_KEY),
    SecureStore.deleteItemAsync(HOME_SENSITIVE_KEY),
  ]);
}
