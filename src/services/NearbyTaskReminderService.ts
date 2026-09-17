/**
 * NearbyTaskReminderService — geocoding helpers (Google), maps deep links,
 * "you're near a task location" nudges, and travel-time learning hooks.
 *
 * Dependencies: NotificationService (sendInstantNotification),
 * MorningRoutineService (travel learning), react-native Linking/Platform,
 * EXPO_PUBLIC_GOOGLE_MAPS_API_KEY. geocodeTaskLocation is also used by
 * UserProfileStorage to geocode the home address on save.
 */
import { Linking, Platform } from 'react-native';
import { UserProfile } from '../models/UserProfile';
import { completeAddress } from '../utils/addressCompletion';
import { Task } from '../types/models';
import { arrivedOnTime, learnTravelProfileFromTask } from './MorningRoutineService';
import { sendInstantNotification } from './NotificationService';
import { geocodeAddress } from './LumiServer';

const NEARBY_RADIUS_METERS = 350;
const MIN_REMINDER_INTERVAL_MS = 90 * 60 * 1000;
const HOME_DEPARTURE_RADIUS_METERS = 180;

type LocationModule = typeof import('expo-location');

let Location: LocationModule | null = null;

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Location = require('expo-location') as LocationModule;
} catch (error) {
  console.log('[LOCATION] expo-location unavailable:', error);
}

/** One geocoding candidate shown to the user for confirmation (label + coords). */
export interface LocationCandidate {
  label: string;
  lat: number;
  lng: number;
}

function buildMapUrls(label: string, coords?: { lat: number; lng: number }): string[] {
  const query = encodeURIComponent(label.trim() || 'near me');

  if (Platform.OS === 'android') {
    if (coords) {
      return [
        `geo:${coords.lat},${coords.lng}?q=${query}`,
        `https://www.google.com/maps/search/?api=1&query=${coords.lat},${coords.lng}`,
      ];
    }

    return [
      `geo:0,0?q=${query}`,
      `https://www.google.com/maps/search/?api=1&query=${query}`,
    ];
  }

  if (coords) {
    return [
      `http://maps.apple.com/?ll=${coords.lat},${coords.lng}&q=${query}`,
      `https://www.google.com/maps/search/?api=1&query=${coords.lat},${coords.lng}`,
    ];
  }

  return [
    `http://maps.apple.com/?q=${query}`,
    `https://www.google.com/maps/search/?api=1&query=${query}`,
  ];
}

/** Deep-link an address (or coords) into Google/Apple Maps; false if no handler. */
export async function openLocationInMaps(label: string, coords?: { lat: number; lng: number }): Promise<boolean> {
  const urls = buildMapUrls(label, coords);
  console.log('[LOCATION] openLocationInMaps request:', { label, coords, urls });

  for (const url of urls) {
    try {
      console.log('[LOCATION] attempting map url:', url);
      await Linking.openURL(url);
      console.log('[LOCATION] opened map url:', url);
      return true;
    } catch (error) {
      console.log('[LOCATION] openLocationInMaps failed for url:', url, error);
    }
  }

  console.log('[LOCATION] no map url opened for request:', { label, coords });
  return false;
}

/**
 * Address -> lat/lng. Also used by UserProfileStorage for the home address.
 *
 * This used to be one line — `Location.geocodeAsync(location)` — and its own
 * comment claimed it used Google Geocoding. It did not: that is expo-location's
 * PLATFORM geocoder, with no country, no region and no idea where she lives.
 * Every other Google call in this app carries `region=il`; the one call that
 * decides WHERE a task is carried nothing.
 *
 * Koral, 2026-09-17: "i added 'יוגה ב 11 בבוקר ביגאל אלון 94' — i didn't write
 * tel aviv but Meira needs to know that, this is my gym address."
 *
 * A street with no city is not ambiguous to someone who lives in one city. It
 * is ambiguous to a geocoder nobody told. Israel has a Yigal Alon street in
 * several towns and the failure is not an error — it is a confident route to
 * the wrong one, with a leave time and an alarm built on top.
 *
 * So, in order:
 *   1. complete the address from her home city when it is plainly incomplete
 *      (utils/addressCompletion — conservative, and a no-op for anything that
 *      already names a town);
 *   2. ask GOOGLE, with region=il and a bias toward her home, which is what
 *      the comment always claimed;
 *   3. fall back to the device geocoder, so this never gets WORSE than before.
 */
export async function geocodeTaskLocation(location: string): Promise<{ lat: number; lng: number } | null> {
  const raw = String(location || '').trim();
  if (!raw) return null;

  let query = raw;
  let home: { lat?: number; lng?: number } | null = null;
  try {
    const profile: any = await loadProfileForGeocode();
    query = completeAddress(raw, profile?.homeAddress);
    if (query !== raw) {
      console.warn('[LOCATION] completed', raw, '→', query, '(from her home city)');
    }
    home = profile?.homeLatLng || null;
  } catch {
    /* no profile is not a reason to refuse to geocode */
  }

  // Ask the SERVER, which holds a Maps key that is actually allowed to
  // geocode. This used to call Google directly with the APK's key — restricted
  // to four APIs that do not include Geocoding — so it returned REQUEST_DENIED
  // every time and silently dropped to the device geocoder below, losing both
  // the Israel region hint and the home bias this function exists for.
  try {
    // `bounds` keeps a bare street near where she actually is without FORCING
    // it: Google still returns a distant match when that is the only one,
    // which is what makes this a bias rather than a filter.
    const around = home?.lat && home?.lng
      ? `${home.lat - 0.35},${home.lng - 0.35}|${home.lat + 0.35},${home.lng + 0.35}`
      : undefined;
    const hit = await geocodeAddress(query, around);
    if (hit) return { lat: hit.lat, lng: hit.lng };
    console.warn('[LOCATION] server geocode found nothing for', query);
  } catch (e) {
    console.warn('[LOCATION] server geocode failed, falling back', e);
  }

  if (!Location) return null;
  try {
    const results = await Location.geocodeAsync(query);
    if (!results.length) return null;
    return { lat: results[0].latitude, lng: results[0].longitude };
  } catch (error) {
    console.warn('[LOCATION] geocode failed:', error);
    return null;
  }
}

/**
 * The profile, read lazily and defensively.
 *
 * UserProfileStorage imports THIS module for the home geocode, so importing it
 * back at module scope is a cycle — and a cycle here resolves to `undefined` at
 * call time rather than failing loudly, which would silently remove the home
 * bias this function exists for.
 */
async function loadProfileForGeocode(): Promise<any> {
  const mod = await import('./UserProfileStorage');
  return mod.loadProfile();
}

/** Best single geocoding match with a display label, or null. */
export async function findLocationOnMap(location: string): Promise<{ label: string; lat: number; lng: number } | null> {
  if (!Location || !location.trim()) {
    return null;
  }

  try {
    const coords = await geocodeTaskLocation(location);
    if (!coords) {
      return null;
    }

    const reverse = await Location.reverseGeocodeAsync({
      latitude: coords.lat,
      longitude: coords.lng,
    });
    const first = reverse[0];
    const label = [
      first?.name,
      first?.street,
      first?.city,
      first?.region,
    ].filter(Boolean).join(', ');

    return {
      label: label || location.trim(),
      lat: coords.lat,
      lng: coords.lng,
    };
  } catch (error) {
    console.log('[LOCATION] findLocationOnMap failed:', error);
    return null;
  }
}

/** Up to maxResults geocoding candidates for the user to pick from. */
export async function searchLocationCandidates(location: string, maxResults: number = 4): Promise<LocationCandidate[]> {
  if (!Location || !location.trim()) {
    return [];
  }

  try {
    const results = await Location.geocodeAsync(location.trim());
    if (!results.length) {
      return [];
    }

    const candidates = await Promise.all(results.slice(0, maxResults * 2).map(async (entry) => {
      try {
        const reverse = await Location.reverseGeocodeAsync({
          latitude: entry.latitude,
          longitude: entry.longitude,
        });
        const first = reverse[0];
        const label = [
          first?.name,
          first?.street,
          first?.city,
          first?.region,
        ].filter(Boolean).join(', ');

        return {
          label: label || location.trim(),
          lat: entry.latitude,
          lng: entry.longitude,
        };
      } catch {
        return {
          label: location.trim(),
          lat: entry.latitude,
          lng: entry.longitude,
        };
      }
    }));

    const deduped = candidates.filter((candidate, index, all) => {
      const key = `${candidate.label.toLowerCase()}|${candidate.lat.toFixed(4)}|${candidate.lng.toFixed(4)}`;
      return all.findIndex((entry) => `${entry.label.toLowerCase()}|${entry.lat.toFixed(4)}|${entry.lng.toFixed(4)}` === key) === index;
    });

    return deduped.slice(0, maxResults);
  } catch (error) {
    console.log('[LOCATION] searchLocationCandidates failed:', error);
    return [];
  }
}

/** Current GPS position reverse-geocoded to a label; null if permission denied. */
export async function getCurrentLocationDetails(): Promise<{ label: string; lat: number; lng: number } | null> {
  const currentPoint = await getCurrentPoint();
  if (!Location || !currentPoint) {
    return null;
  }

  try {
    const details = await Location.reverseGeocodeAsync({
      latitude: currentPoint.lat,
      longitude: currentPoint.lng,
    });
    const first = details[0];
    const label = [
      first?.name,
      first?.street,
      first?.city,
      first?.region,
    ].filter(Boolean).join(', ');

    return {
      label: label || 'Current location',
      lat: currentPoint.lat,
      lng: currentPoint.lng,
    };
  } catch (error) {
    console.log('[LOCATION] reverse geocode failed:', error);
    return {
      label: 'Current location',
      lat: currentPoint.lat,
      lng: currentPoint.lng,
    };
  }
}

function distanceMeters(
  left: { lat: number; lng: number },
  right: { lat: number; lng: number },
): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const earthRadius = 6371000;

  const dLat = toRadians(right.lat - left.lat);
  const dLng = toRadians(right.lng - left.lng);

  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos(toRadians(left.lat)) * Math.cos(toRadians(right.lat))
    * Math.sin(dLng / 2) * Math.sin(dLng / 2);

  return earthRadius * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

/** If the user is near a pending task's location, fire an instant 'you're nearby' nudge. */
export async function checkAndNotifyNearbyTasks(
  tasks: Task[],
  onTaskReminded: (taskId: string, timestamp: number) => Promise<void>,
): Promise<number> {
  if (!Location) {
    return 0;
  }

  try {
    const permissions = await Location.requestForegroundPermissionsAsync();
    if (!permissions.granted) {
      return 0;
    }

    const current = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });

    const currentPoint = {
      lat: current.coords.latitude,
      lng: current.coords.longitude,
    };

    const now = Date.now();
    let reminderCount = 0;

    for (const task of tasks) {
      if (task.status !== 'pending' || !task.locationLat || !task.locationLng) {
        continue;
      }

      if (task.lastNearbyReminderAt && now - task.lastNearbyReminderAt < MIN_REMINDER_INTERVAL_MS) {
        continue;
      }

      const meters = distanceMeters(currentPoint, {
        lat: task.locationLat,
        lng: task.locationLng,
      });

      if (meters > NEARBY_RADIUS_METERS) {
        continue;
      }

      await sendInstantNotification(
        'Nearby task reminder',
        `You are close to ${task.location ?? 'a task location'}. You can complete "${task.text}".`,
        { taskId: task.id, type: 'nearby-task' },
      );

      await onTaskReminded(task.id, now);
      reminderCount += 1;
    }

    return reminderCount;
  } catch (error) {
    console.log('[LOCATION] nearby reminder check failed:', error);
    return 0;
  }
}

async function getCurrentPoint(): Promise<{ lat: number; lng: number } | null> {
  if (!Location) {
    return null;
  }

  try {
    const permissions = await Location.requestForegroundPermissionsAsync();
    if (!permissions.granted) {
      return null;
    }

    const current = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });

    return {
      lat: current.coords.latitude,
      lng: current.coords.longitude,
    };
  } catch (error) {
    console.log('[LOCATION] current position failed:', error);
    return null;
  }
}

/** On arrival, feed the actual travel time into MorningRoutineService learning. */
export async function trackTaskTravelLearning(
  profile: UserProfile,
  tasks: Task[],
  onTaskPatched: (taskId: string, patch: Partial<Task>) => Promise<void>,
  onProfileLearned: (profile: UserProfile) => Promise<void>,
): Promise<void> {
  if (!Location || !profile.homeLatLng) {
    return;
  }

  const currentPoint = await getCurrentPoint();
  if (!currentPoint) {
    return;
  }

  const homeDistance = distanceMeters(currentPoint, profile.homeLatLng);
  const now = Date.now();
  let nextProfile = profile;

  for (const task of tasks) {
    if (task.status !== 'pending' || !task.locationLat || !task.locationLng || !task.dueDate) {
      continue;
    }

    const taskDistance = distanceMeters(currentPoint, {
      lat: task.locationLat,
      lng: task.locationLng,
    });

    if (!task.lastDepartureDetectedAt && homeDistance > HOME_DEPARTURE_RADIUS_METERS) {
      await onTaskPatched(task.id, { lastDepartureDetectedAt: now });
      continue;
    }

    if (!task.lastDepartureDetectedAt || task.lastArrivalDetectedAt || taskDistance > NEARBY_RADIUS_METERS) {
      continue;
    }

    const actualTravelMinutes = Math.max(1, Math.round((now - task.lastDepartureDetectedAt) / 60000));
    const onTime = arrivedOnTime(now, task.dueDate);

    await onTaskPatched(task.id, { lastArrivalDetectedAt: now });
    nextProfile = learnTravelProfileFromTask(nextProfile, task, actualTravelMinutes, onTime);

    await sendInstantNotification(
      onTime ? 'Lumi points earned' : 'Lumi learned your travel time',
      onTime
        ? `You arrived on time for "${task.text}". +5 effort points.`
        : `You got to "${task.text}" late. Lumi will allow more travel time next time.`,
      { taskId: task.id, type: 'travel-learning', onTime, actualTravelMinutes },
    );
  }

  if (nextProfile !== profile) {
    await onProfileLearned(nextProfile);
  }
}
