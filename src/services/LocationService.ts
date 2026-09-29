/**
 * LocationService — thin wrappers over expo-location: current position,
 * (reverse) geocoding and distance.
 *
 * Dependencies: expo-location (foreground permissions).
 * Used for GPS arrival verification and nearby-task reminders.
 */
import * as Location from 'expo-location';

/** Current GPS position (asks foreground permission); null if denied/unavailable. */
export async function getCurrentLocation(): Promise<{ lat: number; lng: number } | null> {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      console.log('[LocationService] Permission denied');
      return null;
    }

    const location = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });

    return {
      lat: location.coords.latitude,
      lng: location.coords.longitude,
    };
  } catch (error) {
    console.error('[LocationService] Failed to get current location:', error);
    return null;
  }
}

export type HereResult =
  | { ok: true; lat: number; lng: number; fresh: boolean }
  | { ok: false; error: 'denied' | 'unavailable'; detail?: string };

/**
 * Where she is, with the REASON when we cannot say.
 *
 * `getCurrentLocation` answers `null` for "she said no to location" and for
 * "the GPS had no fix in time" alike, and those need different words on screen:
 * one is a setting she can change, the other is a moment indoors. The voice
 * planner plans from here, so it has to be able to say which one happened.
 *
 * Tries the OS's cached fix first (instant); a fresh fix only when there is
 * none, bounded by `timeoutMs` so a slow radio cannot hold up her plan.
 */
export async function getHereDetailed(timeoutMs = 8000): Promise<HereResult> {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return { ok: false, error: 'denied' };
    const cached = await Location.getLastKnownPositionAsync({ maxAge: 5 * 60 * 1000 });
    if (cached) {
      return { ok: true, lat: cached.coords.latitude, lng: cached.coords.longitude, fresh: false };
    }
    const fix = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    if (!fix) return { ok: false, error: 'unavailable', detail: `no GPS fix in ${timeoutMs / 1000}s` };
    return { ok: true, lat: fix.coords.latitude, lng: fix.coords.longitude, fresh: true };
  } catch (error) {
    console.warn('[LocationService] getHereDetailed failed', error);
    return { ok: false, error: 'unavailable', detail: String(error).slice(0, 120) };
  }
}

/**
 * Where she is, cheaply — the fix the OS already has.
 *
 * `getCurrentPositionAsync` powers up the radio and can take several seconds,
 * which is why nothing on a fast path (a chat message, a screen opening) asked
 * for a position at all, and every route was therefore planned from her stored
 * home however far from it she was standing. `getLastKnownPositionAsync`
 * returns Android's cached fix immediately and costs nothing, so "roughly
 * where she is" can be known on every turn instead of never.
 *
 * `maxAgeMs` is the honesty bound: a fix older than this is refused rather
 * than returned as if current. Ten minutes is the default — long enough to
 * survive a walk indoors, short enough that it cannot claim she is in a city
 * she left. When it comes back null, ask for a real fix only if the answer
 * actually depends on the position.
 */
export async function getLastKnownLocation(
  maxAgeMs = 10 * 60 * 1000,
): Promise<{ lat: number; lng: number } | null> {
  try {
    const { status } = await Location.getForegroundPermissionsAsync();
    if (status !== 'granted') return null;   // never prompts — this is the quiet path
    const last = await Location.getLastKnownPositionAsync({ maxAge: maxAgeMs });
    if (!last) return null;
    return { lat: last.coords.latitude, lng: last.coords.longitude };
  } catch {
    return null;
  }
}

/**
 * Does this message's answer depend on where she is standing?
 *
 * Used to decide whether a chat turn is worth a real GPS fix (seconds, radio)
 * on top of the cached one. Hebrew first: "מכאן", "איך מגיעים", "מאיפה שאני".
 */
export function asksAboutHere(message: string): boolean {
  const m = (message || '').toLowerCase();
  return /\b(from here|where i am|how do i get|how to get|route|directions|nearest|near me)\b/.test(m)
    || /(מכאן|מפה|איפה אני|איך מגיע|איך להגיע|איך אני מגיע|מאיפה שאני|הכי קרוב|קרוב אלי|מסלול|נסיעה)/.test(m);
}

/** Reverse-geocode via expo-location; null on failure. */
export async function getAddressFromCoordinates(lat: number, lng: number): Promise<string | null> {
  try {
    const addresses = await Location.reverseGeocodeAsync({ latitude: lat, longitude: lng });
    if (addresses && addresses.length > 0) {
      const addr = addresses[0];
      return `${addr.street || ''} ${addr.city || ''} ${addr.region || ''}`.trim();
    }
    return null;
  } catch (error) {
    console.error('[LocationService] Failed to reverse geocode:', error);
    return null;
  }
}

/**
 * "Where am I", as a short name — cached, so a 90-second loop can ask on every
 * tick.
 *
 * The presence chip could say "🚆 בדרך" and nothing more: in transit between
 * two unnamed points, which is the least useful moment to be told only that.
 * The user asked to "always show and know the location", and the missing piece
 * was never the fix — it was that nothing turned the fix into words.
 *
 * Reverse geocoding is a real call (and on Android a rate-limited one), so the
 * answer is remembered and only recomputed once she has actually moved. 150 m
 * is well under the 300 m that triggers a re-plan and well over indoor GPS
 * drift, so the label is stable while she sits still and current once she is
 * not.
 *
 * Returns the street and city when the geocoder answers, and null when it does
 * not — never a coordinate pair dressed up as a place.
 */
let hereCache: { point: { lat: number; lng: number }; label: string | null } | null = null;

export async function describeHere(
  point: { lat: number; lng: number } | null | undefined,
  minMoveMetres = 150,
): Promise<string | null> {
  if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return null;
  if (hereCache) {
    const moved = await calculateDistance(hereCache.point, point).catch(() => null);
    if (moved !== null && moved < minMoveMetres) return hereCache.label;
  }
  const label = await getAddressFromCoordinates(point.lat, point.lng).catch(() => null);
  hereCache = { point, label: label || null };
  return hereCache.label;
}

/** Forward-geocode via expo-location; null on failure. */
export async function getCoordinatesFromAddress(address: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const geocoded = await Location.geocodeAsync(address);
    if (geocoded && geocoded.length > 0) {
      return {
        lat: geocoded[0].latitude,
        lng: geocoded[0].longitude,
      };
    }
    return null;
  } catch (error) {
    console.error('[LocationService] Failed to geocode address:', error);
    return null;
  }
}

/** Haversine distance in meters between two lat/lng points. */
export async function calculateDistance(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number }
): Promise<number | null> {
  try {
    // Using simple Haversine formula for distance calculation
    const earthRadiusKm = 6371;
    const dLat = toRad(to.lat - from.lat);
    const dLng = toRad(to.lng - from.lng);

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(from.lat)) *
        Math.cos(toRad(to.lat)) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distanceKm = earthRadiusKm * c;

    return distanceKm * 1000; // Return in meters
  } catch (error) {
    console.error('[LocationService] Failed to calculate distance:', error);
    return null;
  }
}

function toRad(degrees: number): number {
  return (degrees * Math.PI) / 180;
}
