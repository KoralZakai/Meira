/**
 * TravelPreferenceStore — where utils/travelPreference keeps what it learned.
 *
 * Deliberately thin: all the judgement lives in the pure module, and this file
 * holds only the AsyncStorage read/write and the one call site that turns a
 * tap on a transport chip into a recorded fact.
 *
 * ON THE DEVICE ONLY. How someone moves around a city is a movement pattern,
 * which is the most sensitive thing this app holds after her location itself.
 * The server keeps its own copy for the WhatsApp path (server/travel_prefs.py,
 * encrypted at rest), and this one is not synced to it: two independent local
 * memories of the same rule is a smaller risk than a movement log in flight.
 *
 * Never throws. A preference that cannot be read is a preference we do not
 * have, and the profile's mode covers that case by design.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { TaskCategory, TransportType } from '../types/index';
import {
  TravelPreferences, EMPTY_PREFERENCES, rememberMode, preferredMode, ModeChoice,
} from '../utils/travelPreference';

const KEY = 'lumi.travelPrefs.v1';

export async function loadTravelPreferences(): Promise<TravelPreferences> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return EMPTY_PREFERENCES;
    const parsed = JSON.parse(raw);
    // A store written by a future version, or a half-written one, must not
    // take the router down — fall back to knowing nothing.
    return parsed && typeof parsed === 'object' && parsed.places && parsed.categories
      ? (parsed as TravelPreferences)
      : EMPTY_PREFERENCES;
  } catch {
    return EMPTY_PREFERENCES;
  }
}

/**
 * Record one mode SHE CHOSE.
 *
 * Only a deliberate choice — a tap on a transport chip — reaches here. The
 * mode a route happened to be planned with is not evidence of anything except
 * what the app assumed last time, and learning from that would let one wrong
 * guess reinforce itself forever.
 */
export async function rememberTravelChoice(
  mode: TransportType, place?: string | null, category?: TaskCategory | string | null,
): Promise<void> {
  try {
    const next = rememberMode(await loadTravelPreferences(), { mode, place, category });
    await AsyncStorage.setItem(KEY, JSON.stringify(next));
  } catch (e) {
    console.warn('[TravelPrefs] could not record a travel choice', e);
  }
}

/** The mode to plan this trip with, and where that answer came from. */
export async function modeFor(
  context: { place?: string | null; category?: TaskCategory | string | null },
  fallback: TransportType,
): Promise<ModeChoice> {
  return preferredMode(await loadTravelPreferences(), context, fallback);
}

/** Forget everything — used by account deletion and by the settings reset. */
export async function clearTravelPreferences(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY);
  } catch {
    /* nothing to clear is not an error */
  }
}
