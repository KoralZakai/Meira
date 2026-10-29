/**
 * KnownPlacesStore — storage for utils/knownPlaces, and nothing else.
 *
 * The judgement lives in the pure module; this file holds the AsyncStorage
 * read/write and two call sites: learn when a task gets a real, placed
 * address, resolve when a new task names an activity and no address at all.
 *
 * ON THE DEVICE. The server keeps its own copy for the WhatsApp path
 * (server/known_places.py, encrypted at rest). Where her gym is, is a movement
 * pattern; two independent local memories of one rule beat syncing one.
 *
 * Never throws. A place we cannot read is a place we do not know, and asking
 * is the correct behaviour for that.
 */
import AsyncStorage from './EncryptedStorage';  // AES-256-GCM at rest (7.10)
import {
  KnownPlaces, rememberPlace, resolvePlace, ResolvedPlace,
} from '../utils/knownPlaces';

const KEY = 'lumi.knownPlaces.v1';

export async function loadKnownPlaces(): Promise<KnownPlaces> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as KnownPlaces) : {};
  } catch {
    return {};
  }
}

/**
 * Record that this activity happens at this address.
 *
 * Only a CONFIRMED address is worth learning — one that geocoded, or that a
 * route was actually built to. Learning from a string nobody could resolve is
 * how a typo becomes a permanent wrong answer.
 */
export async function learnPlace(
  activity: string, address: string, coords?: { lat?: number; lng?: number },
): Promise<void> {
  if (!activity?.trim() || !address?.trim()) return;
  try {
    const next = rememberPlace(await loadKnownPlaces(), activity, address, coords);
    await AsyncStorage.setItem(KEY, JSON.stringify(next));
  } catch (e) {
    console.warn('[KnownPlaces] could not record a place', e);
  }
}

/** Where this activity usually happens, or null to ask. */
export async function recallPlace(activity: string): Promise<ResolvedPlace | null> {
  try {
    return resolvePlace(await loadKnownPlaces(), activity);
  } catch {
    return null;
  }
}
