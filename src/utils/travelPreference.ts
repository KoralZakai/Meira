/**
 * travelPreference — how SHE gets to THIS place, learned from what she did.
 *
 * Koral, 2026-09-17: "start learning about the user's preferences, like
 * habits, ways of transportation, usual things he does."
 *
 * The app already knows one thing about transport: `profile.transportType`,
 * a single global answer given once during onboarding. Every route in the app
 * is planned with it. That is wrong in the ordinary case rather than the
 * exotic one — she cycles to yoga, and she does not cycle to an interview in
 * Herzliya — so a global mode is guaranteed to be wrong for some part of every
 * week, and each wrong mode is a wrong leave time, which is a wrong alarm.
 *
 * The server has had this since 2026-09-08 (server/travel_prefs.py), on the
 * WhatsApp path only. This is the same rule, on the phone, where the mode
 * chips actually live — and deliberately the SAME rule, key normalisation
 * included, so the two stores cannot drift into disagreeing about how she
 * travels.
 *
 * TWO LEVELS, because both are true at different times:
 *
 *   place       "11א, Kaufmann Street" → bike. The most specific thing we
 *               know, and it wins whenever we have it.
 *   category    "hobby_class" → bike. Carries to a class she has never been
 *               to, which is the case where asking again is forgetting.
 *
 * WHAT COUNTS AS EVIDENCE is narrow on purpose. Only a mode she CHOSE — a tap
 * on a transport chip — is recorded. The mode a route was planned with is not
 * evidence of anything except what the app assumed last time, and learning
 * from it would let one wrong guess reinforce itself forever.
 *
 * AND IT IS ALWAYS SAID OUT LOUD. `describeAssumption` exists so a remembered
 * mode arrives as "assuming by bike, like last time" rather than silently. A
 * stated assumption costs one correction; a silent one costs a missed class.
 *
 * Pure: the store is passed in and the updated store is returned. Storage is
 * services/TravelPreferenceStore. Tested by tests/run-travel-preference.ts.
 */
import { AppLanguage, TaskCategory, TransportType } from '../types/index';

export const VALID_MODES: TransportType[] = ['bus', 'train', 'bike', 'walk', 'car'];

export interface TravelPreferences {
  places: Record<string, Partial<Record<TransportType, number>>>;
  categories: Record<string, Partial<Record<TransportType, number>>>;
  updatedAt?: number;
}

export const EMPTY_PREFERENCES: TravelPreferences = { places: {}, categories: {} };

/**
 * A stable key for an address — the Python port, character for character.
 *
 * Normalised hard on purpose: "יגאל אלון 94", "יגאל אלון 94, תל אביב" and
 * "Yigal Alon 94" must not each start learning from scratch. The house number
 * is KEPT: it is what tells two gyms on one street apart.
 */
export function placeKeyFor(place?: string | null): string {
  const raw = String(place || '').trim().toLowerCase();
  // Everything before the first comma. Google formats as "street number, city,
  // district, country" and a person types just the street, so the head is the
  // part both forms agree on.
  const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
  let s = parts[0] || '';
  // Google sometimes leads with the house number ("11א, Kaufmann Street, …").
  // A bare number is not a place — it would collide with every other "11" in
  // the city — so pull in the street that follows it.
  if (parts.length > 1 && /^\d+[a-zא-ת]?$/.test(s)) s = `${s} ${parts[1]}`;
  return s.replace(/[.،]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

const bump = (
  counts: Partial<Record<TransportType, number>> | undefined, mode: TransportType,
): Partial<Record<TransportType, number>> => ({ ...(counts || {}), [mode]: ((counts || {})[mode] || 0) + 1 });

/** Record ONE choice she actually made, against the place and its category. */
export function rememberMode(
  prefs: TravelPreferences | null | undefined,
  choice: { mode: TransportType; place?: string | null; category?: TaskCategory | string | null },
  now = Date.now(),
): TravelPreferences {
  const base: TravelPreferences = {
    places: { ...(prefs?.places || {}) },
    categories: { ...(prefs?.categories || {}) },
    updatedAt: prefs?.updatedAt,
  };
  if (!VALID_MODES.includes(choice.mode)) return base;

  const pk = placeKeyFor(choice.place);
  if (pk) base.places[pk] = bump(base.places[pk], choice.mode);
  if (choice.category) {
    const ck = String(choice.category);
    base.categories[ck] = bump(base.categories[ck], choice.mode);
  }
  base.updatedAt = now;
  return base;
}

/** Most-used mode, ties broken by name so the answer is stable across reads. */
function winner(counts?: Partial<Record<TransportType, number>>): TransportType | null {
  const entries = Object.entries(counts || {}) as Array<[TransportType, number]>;
  if (!entries.length) return null;
  const best = entries.sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))[0];
  return best[1] > 0 ? best[0] : null;
}

export interface ModeChoice {
  mode: TransportType;
  /** Where the answer came from — what makes the assumption sayable. */
  from: 'place' | 'category' | 'default';
  /** How many times she has actually done it this way. 0 for 'default'. */
  timesSeen: number;
}

/**
 * The mode to plan with, and why.
 *
 * Place beats category: how she gets to THIS address is better evidence than
 * how she usually gets to places like it. `fallback` is the profile's global
 * answer and is returned as 'default', never dressed up as something learned.
 */
export function preferredMode(
  prefs: TravelPreferences | null | undefined,
  context: { place?: string | null; category?: TaskCategory | string | null },
  fallback: TransportType,
): ModeChoice {
  const pk = placeKeyFor(context.place);
  if (pk) {
    const counts = prefs?.places?.[pk];
    const got = winner(counts);
    if (got) return { mode: got, from: 'place', timesSeen: counts?.[got] || 0 };
  }
  if (context.category) {
    const counts = prefs?.categories?.[String(context.category)];
    const got = winner(counts);
    if (got) return { mode: got, from: 'category', timesSeen: counts?.[got] || 0 };
  }
  return { mode: fallback, from: 'default', timesSeen: 0 };
}

const LABEL: Record<TransportType, [string, string]> = {
  bus:   ['🚌 באוטובוס', '🚌 by bus'],
  train: ['🚆 ברכבת',    '🚆 by train'],
  bike:  ['🚲 באופניים', '🚲 by bike'],
  walk:  ['🚶 ברגל',     '🚶 on foot'],
  car:   ['🚗 ברכב',     '🚗 by car'],
};

/**
 * "assuming by bike, like last time" — or nothing at all.
 *
 * Returns undefined for 'default', because the profile's global mode is not an
 * assumption Lumi made about this trip and claiming it as one ("like last
 * time" for a place she has never been) is a small lie that makes every other
 * assumption less trustworthy.
 */
export function describeAssumption(
  choice: ModeChoice, lang: AppLanguage,
): string | undefined {
  if (choice.from === 'default') return undefined;
  const he = lang === 'he';
  const label = LABEL[choice.mode][he ? 0 : 1];
  if (choice.from === 'place') {
    return he ? `${label}, כמו בפעם הקודמת לכאן` : `${label}, like last time here`;
  }
  return he ? `${label}, כמו שאת בדרך כלל מגיעה לדברים כאלה` : `${label}, like you usually get to these`;
}
