/**
 * homeFromHere — "📍 my home is here", in two steps that cannot be one.
 *
 * The chat's 📍 sat right beside the 🎤 and saved the GPS fix as home on a
 * single tap, with no question. On 7.10 a mis-tap while reaching for the mic
 * did exactly that on Koral's phone. Home is the origin of every route, the
 * wake time and "how do I get home", so a write she did not mean is a wrong
 * plan she cannot see.
 *
 * So finding and saving are separate functions, and `findHomeHere` is not
 * even GIVEN the save: step 1 cannot write home, by construction. Step 2 runs
 * only from her "yes" on the card (components/HomeConfirmCard), and reads the
 * store back before it says ✓ (a "saved" that did not land is the
 * fake-confirmation bug again — silent-state rule 3).
 *
 * Pure apart from the injected calls, so it runs under tsx with no expo
 * modules: tests/run-home-from-here.ts.
 */
import type { UserProfile } from '../models/UserProfile';
import { distanceMetres } from './positionDrift';

/** The chip that asks; the coach engine names it when it needs her home. */
export const HOME_HERE_CHIP = { en: '📍 Home is here', he: '📍 הבית שלי = כאן' } as const;

/**
 * A fix this close to the saved home IS the saved home: nothing to ask.
 * Android's Balanced fix is good to ~100 m indoors; the next building over is
 * further than this, a different street is much further.
 */
export const SAME_HOME_M = 150;

export interface HomeAsk {
  address: string;
  /** The fix. Dropped from the kept chat once she answers — history keeps no position (7.10 privacy). */
  lat?: number;
  lng?: number;
  /** The home already saved, so she sees what a yes would replace. */
  current?: string;
  /** Within SAME_HOME_M of the saved home (or the same words): nothing to save. */
  same?: boolean;
  /** Her answer. Kept on the chat message, so a reopened chat shows it, not the buttons again. */
  outcome?: 'saved' | 'declined';
}

export type FindHomeResult =
  | { ok: true; ask: HomeAsk }
  /** 'nofix': no position at all — permission refused or no GPS fix. */
  | { ok: false; error: 'nofix' };

export interface FindHomeDeps {
  locate: () => Promise<{ lat: number; lng: number } | null>;
  addressOf: (lat: number, lng: number) => Promise<string | null>;
  load: () => Promise<UserProfile | null>;
}

export interface SaveHomeDeps {
  load: () => Promise<UserProfile | null>;
  save: (profile: UserProfile) => Promise<void>;
  blank: () => UserProfile;
}

const norm = (s: string) => s.replace(/[\s,.״"'׳-]+/g, ' ').trim().toLowerCase();

/** Step 1: where she is, as a proposal. Never writes anything. */
export async function findHomeHere(deps: FindHomeDeps): Promise<FindHomeResult> {
  const coords = await deps.locate();
  if (!coords) return { ok: false, error: 'nofix' };
  const named = await deps.addressOf(coords.lat, coords.lng);
  const address = named?.trim() || `${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}`;
  const profile = await deps.load();
  const current = profile?.homeAddress?.trim() || undefined;
  const near = profile?.homeLatLng ? distanceMetres(profile.homeLatLng, coords) <= SAME_HOME_M : false;
  const sameWords = Boolean(current && named?.trim() && norm(current) === norm(named));
  return {
    ok: true,
    ask: { address, lat: coords.lat, lng: coords.lng, ...(current ? { current } : {}), ...(near || sameWords ? { same: true } : {}) },
  };
}

/** Step 2, only on her yes: write home, then read it back before calling it saved. */
export async function saveHomeHere(
  ask: HomeAsk,
  deps: SaveHomeDeps,
  now: Date = new Date(),
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (ask.lat == null || ask.lng == null) return { ok: false, reason: 'no fix' };
  try {
    const base = (await deps.load()) ?? deps.blank();
    await deps.save({
      ...base,
      homeAddress: ask.address,
      homeLatLng: { lat: ask.lat, lng: ask.lng },
      lastUpdated: now.toISOString(),
    });
    const back = await deps.load();
    if (back?.homeAddress !== ask.address) {
      console.warn('[homeFromHere] saved, but the store reads back a different home');   // no address in logs
      return { ok: false, reason: 'not stored' };
    }
    return { ok: true };
  } catch (e) {
    console.warn('[homeFromHere] save failed', e);
    return { ok: false, reason: String((e as Error)?.message ?? e).slice(0, 80) };
  }
}
