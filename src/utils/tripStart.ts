/**
 * tripStart — where today's next journey starts.
 *
 * Koral, 13.10, after a Haifa interview planned from the wrong city: "it
 * doesn't matter my home address!! it matters where I am now — if I was in
 * place X about 3-4 hours before, you need to calculate the travel from my
 * current place."
 *
 * The travel chain started every day at home, today included, so the phone's
 * own GPS — which knew exactly where she was — never reached the route. Home
 * is the right start for a day that has not begun (tomorrow, next week) and
 * the fallback when the position is unknown; it is not where she is at 11:00.
 *
 * TODAY: the first trip still ahead starts from her last known position.
 * Standing within HOME_RADIUS_M of home it is home — the same journey, and a
 * stable origin, so a GPS wobble does not re-route the day every sweep.
 *
 * Every plan says which start it used (rule 1 of the silent-state rule): "from
 * where you are now" and "from home — I don't know where you are" are
 * different facts, and only one of them was true on the morning she asked.
 *
 * TOMORROW (17.10, Koral: "tomorrow I have an interview but my location is
 * different from what is already calculated — Meira needs to ask: will you
 * leave tomorrow from your current location?"): home is only a GUESS for a
 * day that has not begun. When Meira has asked and she answered "from here",
 * the answer is a DayStart override (services/DayStartStore) and the start is
 * hers, kind 'set' — said on the plan in her own words.
 *
 * The override rules a day that is not today. TODAY the phone's own position
 * wins whenever it is known (she may have driven home since she said it); the
 * override is the fallback only when the fix is unknown.
 *
 * Pure. Consumed by services/GoogleSync.ensureTravelChain; tested by
 * tests/run-haifa-interview.ts and tests/run-tomorrow-start.ts.
 */
import { AppLanguage } from '../types/index';
import { straightKm } from './travelLadder';
import { hasRealCoords } from './placeCoords';

type LatLng = { lat: number; lng: number };

/**
 * Where she said a day starts ("tomorrow I leave from here"). Kept on the
 * phone only (services/DayStartStore, encrypted) — where she IS is used,
 * never synced (utils/cloudPrivacy).
 */
export interface DayStart {
  lat: number;
  lng: number;
  /** The place in words, as the Today header names it. May be missing: then the plan says "where you said". */
  label?: string;
  setAt?: number;
}

/** Closer than this to home, she is at home. */
export const HOME_RADIUS_M = 300;
/** Two coordinate origins this close are one origin — no re-route for a wobble. */
export const SAME_ORIGIN_M = 1000;

export type StartKind = 'here' | 'home' | 'home_unknown_here' | 'set';

export interface TripStart {
  /** What the route is asked from: an address, or "lat,lng". */
  origin: string;
  coords?: { lat?: number; lng?: number } | null;
  kind: StartKind;
  /** Only for kind 'set': the place as she was shown it. */
  label?: string;
}

const coordsOrigin = (p: LatLng): string => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;

/**
 * Where the next trip starts. `here` is the last known GPS fix (null when
 * unknown or refused); `isToday` false starts at home — unless she said
 * otherwise (`override`, see DayStart).
 */
export function tripStart(
  here: LatLng | null | undefined,
  home: { lat?: number; lng?: number } | null | undefined,
  homeOrigin: string,
  isToday: boolean,
  override?: DayStart | null,
): TripStart {
  // Her word for a day that has not begun — or for today when the phone cannot
  // say where she is. A 0,0 "override" is the unknown placeholder, not a place.
  const said = override && hasRealCoords(override.lat, override.lng) ? override : null;
  if (said && (!isToday || !here)) {
    const coords = { lat: said.lat, lng: said.lng };
    return { origin: coordsOrigin(coords), coords, kind: 'set', ...(said.label ? { label: said.label } : {}) };
  }
  if (!isToday) return { origin: homeOrigin, coords: home, kind: 'home' };
  if (!here) return { origin: homeOrigin, coords: home, kind: 'home_unknown_here' };
  const km = straightKm(here, home);
  if (km !== undefined && km * 1000 <= HOME_RADIUS_M) return { origin: homeOrigin, coords: home, kind: 'home' };
  return { origin: coordsOrigin(here), coords: here, kind: 'here' };
}

/** "32.16240,34.84470" → the point; anything that is not bare coordinates → null. */
export const asCoords = (s?: string): LatLng | null => {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(s ?? '');
  return m ? { lat: Number(m[1]), lng: Number(m[2]) } : null;
};

/**
 * Was this plan made from the same start? Addresses compare as text; two
 * coordinate starts within SAME_ORIGIN_M are one — she moved across the room,
 * not to another town, and the route stays.
 */
export function sameOrigin(a?: string, b?: string): boolean {
  if ((a ?? '') === (b ?? '')) return true;
  const pa = asCoords(a);
  const pb = asCoords(b);
  if (!pa || !pb) return false;
  const km = straightKm(pa, pb);
  return km !== undefined && km * 1000 < SAME_ORIGIN_M;
}

const HEBREW_FIRST = /^[֐-׿]/;

/**
 * A Hebrew one-letter preposition (ל, מ, ב) on a name: glued to a Hebrew word
 * ("מנהריה"), hyphenated to a Latin one ("מ-Haganim") — "לSpace Gym" is not
 * how anyone writes it.
 */
export function hePrefix(prefix: string, word: string): string {
  const w = String(word ?? '').trim();
  if (!w) return prefix;
  return HEBREW_FIRST.test(w) ? `${prefix}${w}` : `${prefix}-${w}`;
}

/** The sentence a 'set' start says about itself — the cloud copy drops it (utils/cloudPrivacy). */
export const SET_START_LINE_RE = /(?:כמו שאמרת|מהמקום שאמרת|, as you said|from where you said)$/;

/** The first line of "Why this way?": which start this journey was planned from. */
export function startLine(kind: StartKind, lang: AppLanguage, label?: string): string {
  const he = lang === 'he';
  if (kind === 'set') {
    const name = String(label ?? '').trim();
    if (!name) return he ? '📍 מחושב מהמקום שאמרת' : '📍 Planned from where you said';
    return he ? `📍 מחושב ${hePrefix('מ', name)} — כמו שאמרת` : `📍 From ${name}, as you said`;
  }
  if (kind === 'here') return he ? '📍 מחושב מהמקום שבו את עכשיו' : '📍 Planned from where you are now';
  if (kind === 'home_unknown_here') {
    return he ? '🏠 מחושב מהבית — אין לי את המיקום שלך עכשיו' : "🏠 Planned from home — I don't have your location right now";
  }
  return he ? '🏠 מחושב מהבית' : '🏠 Planned from home';
}
