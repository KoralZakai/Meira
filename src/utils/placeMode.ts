/**
 * placeMode — how she usually gets to a particular place.
 *
 * The coach asks "איך תגיע לנהריה?" every single time, because the only
 * transport memory the phone had was one GLOBAL default on the profile and one
 * override per TASK. Neither survives to the next trip to the same town, so a
 * question she has already answered a dozen times gets asked a dozen times —
 * which is the difference between an assistant and a form.
 *
 * The server keeps the same idea in travel_prefs.py for the WhatsApp side.
 * This is the phone's copy so the answer is available offline and instantly,
 * where the question is actually asked.
 *
 * A count, not a flag: one trip to Nahariya by car does not make Nahariya a
 * driving town. The winner needs a clear majority, so a single outlier never
 * flips a settled habit, and nothing is "learned" from one data point.
 *
 * Pure except for storage; the matching and the winner rule are exported so
 * tests/run-place-mode.ts can drive them without AsyncStorage.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { TransportType } from '../types/index';

const KEY = 'lumi.placeMode.v1';
/** Below this many trips a place has no habit worth acting on. */
export const MIN_TRIPS = 2;

export type PlaceModeCounts = Record<string, Partial<Record<TransportType, number>>>;

/**
 * Places are matched loosely on purpose: "נהריה", "בנהריה", "Nahariya" and
 * "תחנת רכבת נהריה" are one town, and a memory that only fires on an exact
 * string match would never fire at all.
 */
export function placeKey(place: string): string {
  return (place || '')
    .toLowerCase()
    .replace(/^ב-?/, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The habit for a place, or null when there isn't one yet. */
export function winnerOf(
  counts: Partial<Record<TransportType, number>> | undefined,
): TransportType | null {
  if (!counts) return null;
  const ranked = (Object.entries(counts) as [TransportType, number][])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return null;
  const [top, next] = ranked;
  const total = ranked.reduce((sum, [, n]) => sum + n, 0);
  if (total < MIN_TRIPS) return null;
  // A tie is not a habit.
  return !next || top[1] > next[1] ? top[0] : null;
}

async function read(): Promise<PlaceModeCounts> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

/** Record that she travelled to `place` by `mode`. */
export async function rememberPlaceMode(place: string, mode: TransportType): Promise<void> {
  const key = placeKey(place);
  if (!key || !mode) return;
  try {
    const all = await read();
    const entry = all[key] ?? {};
    entry[mode] = (entry[mode] ?? 0) + 1;
    all[key] = entry;
    await AsyncStorage.setItem(KEY, JSON.stringify(all));
  } catch { /* a habit we could not store is not worth failing a trip over */ }
}

/** How she usually gets to `place`, or null when we should ask. */
export async function preferredPlaceMode(place: string): Promise<TransportType | null> {
  const key = placeKey(place);
  if (!key) return null;
  const all = await read();
  if (all[key]) return winnerOf(all[key]);
  // "תחנת רכבת נהריה" should still find "נהריה".
  const hit = Object.keys(all).find((k) => k.includes(key) || key.includes(k));
  return hit ? winnerOf(all[hit]) : null;
}
