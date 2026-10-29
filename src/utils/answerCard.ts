/**
 * answerCard — the pure half of the answer card (components/AnswerCard).
 *
 * Koral, 7.10: "how do I get home from here?" should show the options — on
 * foot, which bus from where and when, a taxi with a Gett link — and "which
 * beach is fastest by car?" the winner with drive + parking + walk, and both
 * should let her act on it. The server's place_ranker computes every number;
 * this file only orders, words and links them, so it is testable without a
 * phone (tests/run-answer-card.ts).
 *
 * Picks made from the mockup (7.10): the winner on gold, the rest as rows with
 * minutes on the side; the main button is "leaving now"; a taxi is always
 * offered with a Gett button and never a price.
 */

export type AnswerMode = 'car' | 'bike' | 'bus' | 'train' | 'walk' | 'taxi';

export interface AnswerLeg {
  mode: AnswerMode;
  total_min: number;
  ride_min?: number;
  wait_min?: number;
  wait_is_estimate?: boolean;
  park_min?: number;
  walk_from_parking_min?: number;
  parking?: string;
  parking_is_estimate?: boolean;
  lock_min?: number;
  line?: string;
  from_stop?: string;
  board_at?: string;
  leave_at?: string;
  arrive_at?: string;
  walk_to_stop_min?: number;
}

export interface AnswerRow {
  name: string;
  address?: string;
  lat?: number;
  lng?: number;
  place_id?: string;
  distance_km?: number;
  best: AnswerLeg;
  by_mode?: Partial<Record<AnswerMode, AnswerLeg>>;
  open_now?: boolean | null;
  hours_today?: string | null;
}

/** POST /agent/chat → `answer`: place_ranker.lookup's result. */
export interface LookupAnswer {
  ok: true;
  kind: 'places' | 'route';
  results: AnswerRow[];
  query?: string;
  modes?: AnswerMode[];
  origin_used?: 'here' | 'home' | 'named';
  origin_note?: string;
  origin?: { name?: string; lat?: number; lng?: number };
  destination?: { name?: string; address?: string; lat?: number; lng?: number };
  to_home?: boolean;
}

/** A server payload we can draw, or null — never a half-card. */
export function asLookupAnswer(raw: unknown): LookupAnswer | null {
  const a = raw as LookupAnswer | null;
  if (!a || a.ok !== true || (a.kind !== 'places' && a.kind !== 'route')) return null;
  if (!Array.isArray(a.results) || !a.results.length) return null;
  if (!a.results.every((r) => r && r.best && typeof r.best.total_min === 'number')) return null;
  return a;
}

/** One row of the card: a way (route) or a place (places). */
export interface CardOption {
  key: string;
  title: string;
  detail: string;
  minutes: number;
  mode: AnswerMode;
  lat?: number;
  lng?: number;
  /** Google's id for the place — its own page in Maps (reviews, photos, the beach itself). */
  placeId?: string;
  closed?: boolean;
}

const MODE_LABEL: Record<AnswerMode, { he: string; en: string }> = {
  car: { he: 'אוטו', en: 'Car' },
  bike: { he: 'אופניים', en: 'Bike' },
  bus: { he: 'אוטובוס', en: 'Bus' },
  train: { he: 'רכבת', en: 'Train' },
  walk: { he: 'ברגל', en: 'Walk' },
  taxi: { he: 'מונית', en: 'Taxi' },
};

export const modeLabel = (m: AnswerMode, he: boolean) => MODE_LABEL[m]?.[he ? 'he' : 'en'] ?? m;

/** What the total is made of, in her language: "17 נסיעה · ~5 חניה · 2 הליכה". */
export function legDetail(leg: AnswerLeg, he: boolean): string {
  const parts: string[] = [];
  const w = (he_: string, en: string) => (he ? he_ : en);
  if (leg.mode === 'bus' || leg.mode === 'train') {
    if (leg.walk_to_stop_min) parts.push(`${leg.walk_to_stop_min} ${w('דק׳ הליכה', 'min walk')}`
      + (leg.from_stop ? ` ${w('ל', 'to ')}${leg.from_stop}` : ''));
    else if (leg.from_stop) parts.push(`${w('מ', 'from ')}${leg.from_stop}`);
    if (leg.board_at) parts.push(`${w('יוצא', 'leaves')} ${leg.board_at}`);
    if (leg.arrive_at) parts.push(`${w('הגעה', 'arrive')} ${leg.arrive_at}`);
    return parts.join(' · ');
  }
  if (leg.mode === 'taxi') {
    return `~${leg.wait_min ?? 0} ${w('המתנה', 'wait')} + ${leg.ride_min ?? 0} ${w('נסיעה', 'ride')}`;
  }
  if (leg.mode === 'walk') return `${leg.ride_min ?? leg.total_min} ${w('הליכה', 'walk')}`;
  parts.push(`${leg.ride_min ?? leg.total_min} ${leg.mode === 'car' ? w('נסיעה', 'drive') : w('רכיבה', 'ride')}`);
  if (leg.park_min) {
    parts.push(`~${leg.park_min} ${w('חניה', 'parking')}`);
  }
  if (leg.walk_from_parking_min) parts.push(`${leg.walk_from_parking_min} ${w('הליכה', 'walk')}`);
  if (leg.lock_min) parts.push(`${leg.lock_min} ${w('נעילה', 'lock')}`);
  return parts.join(' · ');
}

/**
 * The rows, best first. Route: one per way of getting there. Places: one per
 * place, by its best way. An open place outranks a closed one only when the
 * server said which is which (open_now); otherwise minutes decide.
 */
export function cardOptions(a: LookupAnswer, he: boolean): CardOption[] {
  if (a.kind === 'route') {
    const row = a.results[0];
    const legs = Object.values(row.by_mode ?? {}).filter(Boolean) as AnswerLeg[];
    return (legs.length ? legs : [row.best])
      .slice()
      .sort((x, y) => x.total_min - y.total_min)
      .map((leg) => ({
        key: leg.mode,
        title: (leg.mode === 'bus' || leg.mode === 'train') && leg.line
          ? `${modeLabel(leg.mode, he)} ${he ? 'קו' : 'line'} ${leg.line}`
          : modeLabel(leg.mode, he),
        detail: legDetail(leg, he),
        minutes: leg.total_min,
        mode: leg.mode,
        lat: a.destination?.lat ?? row.lat,
        lng: a.destination?.lng ?? row.lng,
      }));
  }
  return a.results.map((r, i) => ({
    key: `${i}-${r.name}`,
    title: r.name,
    // "Bike or bus?" — the best way, and the other ways' minutes beside it.
    detail: legDetail(r.best, he)
      + Object.values(r.by_mode ?? {})
        .filter((l): l is AnswerLeg => Boolean(l) && l!.mode !== r.best.mode)
        .map((l) => ` · ${modeLabel(l.mode, he)} ${l.total_min}`).join('')
      + (r.open_now === false ? (he ? ' · סגור עכשיו' : ' · closed now') : ''),
    minutes: r.best.total_min,
    mode: r.best.mode,
    lat: r.lat,
    lng: r.lng,
    ...(r.place_id ? { placeId: r.place_id } : {}),
    closed: r.open_now === false,
  }));
}

/** The card's heading and the line under it — where from, what was checked. */
export function cardHeading(a: LookupAnswer, he: boolean): { title: string; sub: string } {
  const from = a.origin_used === 'home' ? (he ? 'מהבית' : 'from home')
    : a.origin_used === 'here' ? (he ? 'מהמקום שלך' : 'from where you are')
      : (a.origin?.name ? `${he ? 'מ-' : 'from '}${a.origin.name}` : '');
  const noHome = a.origin_note === 'no_home_saved' ? (he ? ' · אין כתובת בית שמורה' : ' · no home saved') : '';
  if (a.kind === 'route') {
    const to = a.to_home ? (he ? 'הביתה' : 'Home') : (a.destination?.name ?? '');
    const n = Object.keys(a.results[0].by_mode ?? {}).length;
    return { title: `${to} · ${he ? 'יוצאת עכשיו' : 'leaving now'}`,
      sub: `${from}${noHome} · ${he ? `בדקתי ${n} דרכים` : `checked ${n} ways`}` };
  }
  const best = a.results[0].best.mode;
  return { title: `${a.query ?? ''} · ${modeLabel(best, he)}`.trim(),
    sub: `${from}${noHome} · ${he ? `בדקתי ${a.results.length} מקומות` : `checked ${a.results.length} places`}` };
}

const enc = encodeURIComponent;

/** Waze, driving to the place — the app most Israeli drivers already use. */
export const wazeLink = (lat: number, lng: number) => `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`;

const GOOGLE_MODE: Record<AnswerMode, string> = {
  car: 'driving', taxi: 'driving', bus: 'transit', train: 'transit', walk: 'walking', bike: 'bicycling',
};

/** Google Maps directions, in the chosen way — the "map" button. */
export function mapsLink(dest: { lat: number; lng: number }, mode: AnswerMode,
  origin?: { lat?: number; lng?: number }): string {
  const o = origin?.lat != null && origin?.lng != null ? `&origin=${origin.lat},${origin.lng}` : '';
  return `https://www.google.com/maps/dir/?api=1${o}&destination=${dest.lat},${dest.lng}&travelmode=${GOOGLE_MODE[mode]}`;
}

/**
 * The place itself on Google Maps — "where IS this beach?" (Koral, 7.10: the
 * answer was nice but had no map to see where the beaches are). The place id
 * opens Google's own page for it; coordinates alone still land on the spot.
 */
export function placeLink(p: { lat?: number; lng?: number; title: string; placeId?: string }): string {
  const q = p.lat != null && p.lng != null ? `${p.lat},${p.lng}` : enc(p.title);
  return `https://www.google.com/maps/search/?api=1&query=${q}${p.placeId ? `&query_place_id=${p.placeId}` : ''}`;
}

/**
 * Gett, with the drop-off filled in and pickup at her location. The scheme is
 * Gett's own (developer.gett.com/docs/ride-request); when the app is not
 * installed the store page opens instead.
 */
export function gettLink(dest: { lat: number; lng: number }, name?: string): string {
  const poi = name ? `&dropoffpoi_name_optional=${enc(name)}` : '';
  return `gett://order?pickup=my_location&dropoff_latitude=${dest.lat}&dropoff_longitude=${dest.lng}${poi}`;
}
export const GETT_STORE = 'https://play.google.com/store/apps/details?id=com.gettaxi.android';

/** The main button's words for the chosen row. */
export function primaryLabel(a: LookupAnswer, opt: CardOption, he: boolean): string {
  if (a.kind === 'places') return he ? `נווטי ל${opt.title}` : `Go to ${opt.title}`;
  if (opt.mode === 'taxi') return he ? 'יוצאת עכשיו · Gett' : 'Leaving now · Gett';
  return he ? `יוצאת עכשיו · ${opt.title}` : `Leaving now · ${opt.title}`;
}

/** The trip she is about to take, as the app's travel mode. A taxi is a car ride. */
export function travelModeOf(mode: AnswerMode): 'car' | 'bike' | 'bus' | 'train' | 'walk' {
  return mode === 'taxi' ? 'car' : mode;
}
